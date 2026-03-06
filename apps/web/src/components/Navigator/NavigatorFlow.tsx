"use client";

import { useCallback, useMemo, useReducer, useState } from "react";
import {
  useBrowserAgentDeleteAllHistory,
  useBrowserAgentDeleteHistory,
  useBrowserAgentPlan,
  useBrowserAgentHistory,
  useBrowserAgentStream,
  useBrowserAgentResume,
  useBrowserSnapshot,
  useBrowserTabs,
} from "../../hooks/useBrowserNavigator";
import type {
  AgentStep,
  AttachedTab,
  StepStatus,
  StreamStepEvent,
} from "../../hooks/useBrowserNavigator";
import {
  createInitialRunUiState,
  runUiReducer,
} from "../../hooks/runEventReducer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function friendlyTabName(tab: AttachedTab | undefined): string {
  if (!tab) return "";
  const title = tab.title?.trim();
  if (title) return title;
  const url = tab.url || "";
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const site = host.split(".")[0];
    return site ? site.charAt(0).toUpperCase() + site.slice(1) : "Web page";
  } catch {
    return "Web page";
  }
}

// ---------------------------------------------------------------------------
// Step row — displays a single step with status icon
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<StepStatus, { icon: string; color: string; bg: string; label: string }> = {
  waiting: { icon: "○", color: "text-neutral-400", bg: "", label: "Waiting" },
  processing: { icon: "⋯", color: "text-maroon-600", bg: "bg-maroon-50", label: "Processing" },
  success: { icon: "✓", color: "text-green-600", bg: "", label: "Success" },
  error: { icon: "✕", color: "text-red-600", bg: "", label: "Error" },
};

function StepRow({
  step,
  status,
  data,
}: {
  step: AgentStep;
  index: number;
  status: StepStatus;
  data?: string;
}) {
  const cfg = STATUS_CONFIG[status];
  const targetSuffix = step.target ? ` · ${String(step.target)}` : "";
  const label =
    step.description ||
    step.reason ||
    (step.action ? `${step.action}${targetSuffix}` : "") ||
    "Step";

  return (
    <div className="flex items-start gap-3 py-2.5 px-1 border-b border-neutral-100 last:border-0">
      <span
        className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${cfg.color} ${cfg.bg} ${status === "processing" ? "animate-pulse" : ""}`}
      >
        {cfg.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-neutral-800">{label}</p>
          <span
            className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
              status === "success"
                ? "bg-green-50 text-green-700"
                : status === "error"
                ? "bg-red-50 text-red-700"
                : status === "processing"
                ? "bg-amber-50 text-amber-700"
                : "bg-neutral-100 text-neutral-500"
            }`}
          >
            {cfg.label}
          </span>
        </div>
        {step.type === "browser" && step.action && (
          <p className="text-xs text-neutral-500 mt-0.5">{step.action}</p>
        )}
        {data && (
          <p className="text-xs text-neutral-400 mt-1 line-clamp-2">{data}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab pill — represents one attached tab in the selector
// ---------------------------------------------------------------------------

function TabPill({
  tab,
}: {
  tab: AttachedTab;
}) {
  return (
    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-neutral-100 text-neutral-700">
      <span className="w-2 h-2 rounded-full flex-shrink-0 bg-green-500" />
      <span className="truncate max-w-[160px]">{friendlyTabName(tab)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function NavigatorFlow() {
  const { data, isLoading, refetch } = useBrowserTabs();
  const snapshotMutation = useBrowserSnapshot();
  const agentPlan = useBrowserAgentPlan();
  const agentStream = useBrowserAgentStream();
  const agentResume = useBrowserAgentResume();
  const historyQuery = useBrowserAgentHistory(20);
  const deleteRunMutation = useBrowserAgentDeleteHistory(20);
  const deleteAllRunsMutation = useBrowserAgentDeleteAllHistory(20);

  const [prompt, setPrompt] = useState("");
  const [localError, setLocalError] = useState("");
  const [localInfo, setLocalInfo] = useState("");
  const [latestScreenshot, setLatestScreenshot] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    prompt: string;
    rewrittenPrompt: string;
    steps: AgentStep[];
    selectedTarget?: { device_id?: string; tab_id?: number };
  } | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<"all" | "completed" | "failed" | "blocked" | "stopped">("all");
  const [expandedRunIds, setExpandedRunIds] = useState<Record<string, boolean>>({});
  const [runUi, dispatchRunUi] = useReducer(
    runUiReducer,
    undefined,
    createInitialRunUiState,
  );

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const connectedCount = useMemo(() => items.filter((i) => i.connected).length, [items]);

  const allTabs = useMemo(() => {
    const result: (AttachedTab & { device_id: string })[] = [];
    for (const item of items) {
      if (item.tabs && item.tabs.length > 0) {
        for (const tab of item.tabs) {
          result.push({ ...tab, device_id: item.device_id });
        }
      } else if (item.target) {
        result.push({ ...item.target, tab_id: item.target.tab_id ?? 0, device_id: item.device_id });
      }
    }
    return result;
  }, [items]);

  const activeTab = useMemo(() => allTabs[0], [allTabs]);

  const statusBadge = useMemo(() => {
    if (connectedCount === 0)
      return { label: "Relay disconnected", tone: "error" as const };
    if (allTabs.length === 0)
      return { label: "No tab attached", tone: "warning" as const };
    return {
      label: `${allTabs.length} tab${allTabs.length > 1 ? "s" : ""} in OI group`,
      tone: "ok" as const,
    };
  }, [connectedCount, allTabs.length]);

  // -----------------------------------------------------------------------
  // Run agent via streaming endpoint
  // -----------------------------------------------------------------------

  const handleEvent = useCallback((event: StreamStepEvent) => {
    dispatchRunUi({ type: "APPLY_EVENT", event });
    if (event.type === "step_end" && typeof event.screenshot === "string" && event.screenshot) {
      setLatestScreenshot(event.screenshot);
    }
    if (event.type === "done" && typeof event.screenshot === "string" && event.screenshot) {
      setLatestScreenshot(event.screenshot);
    }
    if (event.type === "done") {
      setAwaitingConfirmation(false);
    }
  }, []);

  const executeAgent = useCallback(async (promptToRun: string) => {
    if (allTabs.length === 0) {
      setLocalError("No tab attached. Attach a tab via the OI extension.");
      return;
    }
    if (!promptToRun.trim()) {
      setLocalError("Enter what you want to do.");
      return;
    }
    setLocalError("");
    setLocalInfo("");
    setLatestScreenshot("");
    dispatchRunUi({ type: "START_PLANNING" });

    try {
      await agentStream.run({
        prompt: promptToRun.trim(),
        onEvent: handleEvent,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort) {
        dispatchRunUi({ type: "MARK_STOPPED" });
      } else {
        setLocalError(err instanceof Error ? err.message : "Agent action failed");
      }
    }
  }, [allTabs.length, agentStream, handleEvent]);

  const draftConfirmation = useCallback(async () => {
    if (allTabs.length === 0) {
      setLocalError("No tab attached. Attach a tab via the OI extension.");
      return;
    }
    if (!prompt.trim()) {
      setLocalError("Enter what you want to do.");
      return;
    }
    setLocalError("");
    setLocalInfo("");
    dispatchRunUi({ type: "RESET" });
    setPendingConfirmation(null);
    setAwaitingConfirmation(false);
    try {
      const plan = await agentPlan.mutateAsync({ prompt: prompt.trim() });
      const steps = plan.plan?.steps ?? [];
      if (steps.length === 0) {
        setLocalError("Could not draft a clear action plan. Please add more detail and try again.");
        return;
      }
      setPendingConfirmation({
        prompt: prompt.trim(),
        rewrittenPrompt: plan.rewritten_prompt || prompt.trim(),
        steps,
        selectedTarget: plan.selected_target,
      });
      setAwaitingConfirmation(true);
      setLocalInfo("Please confirm this understanding before execution.");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Could not draft confirmation.");
    }
  }, [allTabs.length, prompt, agentPlan]);

  const confirmAndRun = useCallback(async () => {
    if (!pendingConfirmation) return;
    const promptToRun = pendingConfirmation.prompt;
    setPendingConfirmation(null);
    setAwaitingConfirmation(false);
    await executeAgent(promptToRun);
  }, [pendingConfirmation, executeAgent]);

  const stopAgent = useCallback(() => {
    agentStream.stop();
  }, [agentStream]);

  const rerunAgent = useCallback(() => {
    draftConfirmation();
  }, [draftConfirmation]);

  const resumeAfterUserAction = useCallback(async () => {
    if (!runUi.resumeToken) return;
    setLocalError("");
    setLocalInfo("");
    try {
      const result = await agentResume.mutateAsync({ resumeToken: runUi.resumeToken });
      dispatchRunUi({ type: "RESUME_SUCCESS", message: result.message || "Resumed actions completed." });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Resume failed.");
    }
  }, [agentResume, runUi.resumeToken]);

  const isRunning = (runUi.phase === "planning" || runUi.phase === "running") && !awaitingConfirmation;
  const isDraftingPlan = agentPlan.isPending;
  const canStop = runUi.phase === "running";
  const effectiveError = localError || (runUi.ok === false ? runUi.message : "");
  const effectiveSuccess = !effectiveError ? localInfo || (runUi.ok === true ? runUi.message : "") : "";
  const historyItems = useMemo(() => historyQuery.data?.items ?? [], [historyQuery.data?.items]);
  const filteredHistoryItems = useMemo(() => {
    if (historyFilter === "all") return historyItems;
    return historyItems.filter((run) => String(run.status || "").toLowerCase() === historyFilter);
  }, [historyFilter, historyItems]);

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header + badge */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold text-neutral-900">Navigator</h1>
        <span
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${
            statusBadge.tone === "ok"
              ? "bg-green-100 text-green-800"
              : statusBadge.tone === "warning"
              ? "bg-amber-100 text-amber-800"
              : "bg-red-100 text-red-800"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              statusBadge.tone === "ok"
                ? "bg-green-500"
                : statusBadge.tone === "warning"
                ? "bg-amber-500"
                : "bg-red-500"
            }`}
          />
          {statusBadge.label}
        </span>
        <button
          type="button"
          onClick={() => refetch()}
          className="text-xs text-neutral-500 hover:text-neutral-700"
        >
          Refresh
        </button>
      </div>

      <p className="text-sm text-neutral-500 mb-4">
        Attach browser tabs to the OI group, then describe what you want in plain language.
      </p>

      {/* Tab selector */}
      {allTabs.length > 0 && (
        <section className="flex flex-wrap gap-2 mb-5">
          {allTabs.map((tab) => (
            <TabPill
              key={tab.tab_id}
              tab={tab}
            />
          ))}
        </section>
      )}

      {allTabs.length > 0 && (
        <div className="flex items-center gap-2 mb-5 text-xs text-neutral-500">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          Auto-targeting tab based on your prompt and attached tab context.
          {runUi.resolvedTarget?.tab_id != null && (
            <span className="text-neutral-600">
              Selected tab #{runUi.resolvedTarget.tab_id}
              {runUi.resolvedTarget.device_id ? ` on ${runUi.resolvedTarget.device_id}` : ""}
            </span>
          )}
          {runUi.planRound > 0 && (
            <span className="text-neutral-600">Dynamic plan updates: {runUi.planRound}</span>
          )}
        </div>
      )}

      {/* Prompt + actions */}
      <section className="bg-white border border-neutral-200 rounded-2xl p-5 mb-6">
        <h2 className="text-sm font-semibold text-neutral-700 mb-2">What do you want to do?</h2>
        <div className="flex gap-2 mb-3">
          <textarea
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setLocalError("");
              setLocalInfo("");
              setPendingConfirmation(null);
            }}
            rows={3}
            placeholder="e.g. Compose an email to john@example.com with subject 'Update' and a short body."
            className="flex-1 px-3 py-2 rounded-lg border border-neutral-200 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-500 resize-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={draftConfirmation}
            disabled={isRunning || isDraftingPlan || allTabs.length === 0}
            className="px-4 py-2 rounded-lg bg-maroon-600 text-white text-sm font-medium hover:bg-maroon-700 disabled:opacity-50 disabled:pointer-events-none"
          >
            {isDraftingPlan ? "Drafting…" : runUi.phase === "running" ? "Running…" : pendingConfirmation ? "Redraft" : "Run"}
          </button>
          {pendingConfirmation && (
            <button
              onClick={confirmAndRun}
              disabled={isDraftingPlan}
              className="px-4 py-2 rounded-lg border border-blue-300 text-blue-700 text-sm font-medium hover:bg-blue-50"
            >
              Confirm & Run
            </button>
          )}
          {canStop && (
            <button
              onClick={stopAgent}
              className="px-4 py-2 rounded-lg border border-red-300 text-red-700 text-sm font-medium hover:bg-red-50"
            >
              Stop
            </button>
          )}
          {runUi.phase === "done" && runUi.steps.length > 0 && (
            <button
              onClick={rerunAgent}
              disabled={allTabs.length === 0}
              className="px-4 py-2 rounded-lg border border-neutral-200 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
            >
              Rerun
            </button>
          )}
          {runUi.resumeToken && (
            <button
              onClick={resumeAfterUserAction}
              disabled={agentResume.isPending}
              className="px-4 py-2 rounded-lg border border-blue-300 text-blue-700 text-sm font-medium hover:bg-blue-50 disabled:opacity-50"
            >
              {agentResume.isPending ? "Resuming…" : "Confirm & Resume"}
            </button>
          )}
          <button
            onClick={async () => {
              setLocalError("");
              setLocalInfo("");
              try {
                await snapshotMutation.mutateAsync({
                  deviceId: activeTab?.device_id,
                  tabId: activeTab?.tab_id,
                });
                setLocalInfo("Snapshot captured.");
              } catch (err) {
                setLocalError(err instanceof Error ? err.message : "Snapshot failed.");
              }
            }}
            disabled={snapshotMutation.isPending || !activeTab}
            className="px-4 py-2 rounded-lg border border-neutral-200 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
          >
            Snapshot
          </button>
        </div>
        {effectiveError && (
          <p className="text-sm text-red-600 mt-3" role="alert">
            {effectiveError}
          </p>
        )}
        {effectiveSuccess && !effectiveError && (
          <p className="text-sm text-green-700 mt-3">{effectiveSuccess}</p>
        )}
        {latestScreenshot ? (
          <div className="mt-3">
            <p className="text-xs text-neutral-600 mb-1">Captured screenshot</p>
            <img
              src={latestScreenshot}
              alt="Navigator captured screenshot"
              className="w-full max-h-72 object-contain rounded-lg border border-neutral-200 bg-neutral-50"
            />
          </div>
        ) : null}
        {pendingConfirmation ? (
          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
            <p className="text-xs font-semibold text-blue-800 mb-1">Confirmation Required</p>
            <p className="text-xs text-blue-900">
              I understood this as: <span className="font-medium">{pendingConfirmation.rewrittenPrompt}</span>
            </p>
            {pendingConfirmation.selectedTarget?.tab_id != null && (
              <p className="text-xs text-blue-900 mt-1">
                Target: tab #{pendingConfirmation.selectedTarget.tab_id}
                {pendingConfirmation.selectedTarget.device_id ? ` on ${pendingConfirmation.selectedTarget.device_id}` : ""}
              </p>
            )}
            <div className="mt-2 max-h-36 overflow-auto rounded border border-blue-100 bg-white p-2">
              {pendingConfirmation.steps.slice(0, 8).map((step, idx) => (
                <p key={`confirm-step-${idx}`} className="text-xs text-neutral-700">
                  {idx + 1}. {step.description || step.action || "Step"}
                </p>
              ))}
              {pendingConfirmation.steps.length > 8 && (
                <p className="text-xs text-neutral-500 mt-1">+ {pendingConfirmation.steps.length - 8} more steps</p>
              )}
            </div>
          </div>
        ) : null}
      </section>

      {/* Steps with real-time statuses */}
      {runUi.steps.length > 0 && (
        <section className="bg-white border border-neutral-200 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-neutral-700">Steps</h2>
            <div className="flex items-center gap-3 text-xs text-neutral-500">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                {runUi.stepStatuses.filter((s) => s === "success").length} done
              </span>
              {runUi.stepStatuses.some((s) => s === "error") && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  {runUi.stepStatuses.filter((s) => s === "error").length} failed
                </span>
              )}
              {runUi.stepStatuses.some((s) => s === "processing") && (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                  Running
                </span>
              )}
            </div>
          </div>
          <div className="space-y-0 divide-y divide-neutral-100">
            {runUi.steps.map((step, i) => (
              <StepRow
                key={i}
                step={step}
                index={i}
                status={runUi.stepStatuses[i] ?? "waiting"}
                data={runUi.stepData[i]}
              />
            ))}
          </div>
        </section>
      )}

      <section className="bg-white border border-neutral-200 rounded-2xl p-5 mt-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-neutral-700">Recent Runs</h2>
          <button
            type="button"
            onClick={() => historyQuery.refetch()}
            className="text-xs text-neutral-500 hover:text-neutral-700"
          >
            {historyQuery.isFetching ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => deleteAllRunsMutation.mutate()}
            disabled={deleteAllRunsMutation.isPending}
            className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            {deleteAllRunsMutation.isPending ? "Clearing…" : "Clear all"}
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {(["all", "completed", "failed", "blocked", "stopped"] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setHistoryFilter(filter)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
                historyFilter === filter
                  ? "border-maroon-600 bg-maroon-50 text-maroon-700"
                  : "border-neutral-200 text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>
        {!historyItems.length ? (
          <p className="text-sm text-neutral-500">No navigator runs yet.</p>
        ) : !filteredHistoryItems.length ? (
          <p className="text-sm text-neutral-500">No runs match this filter.</p>
        ) : (
          <div className="space-y-2">
            {filteredHistoryItems.map((run) => {
              const status = String(run.status || "unknown").toLowerCase();
              const tone =
                status === "completed"
                  ? "bg-green-50 text-green-700"
                  : status === "blocked"
                  ? "bg-amber-50 text-amber-700"
                  : status === "stopped"
                  ? "bg-neutral-100 text-neutral-700"
                  : "bg-red-50 text-red-700";
              const when = run.created_at ? new Date(run.created_at).toLocaleString() : "";
              const stepCount = Array.isArray(run.steps_executed) ? run.steps_executed.length : 0;
              const isExpanded = Boolean(expandedRunIds[run.run_id]);
              return (
                <div key={run.run_id} className="rounded-xl border border-neutral-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-neutral-900 truncate">
                      {run.prompt || run.rewritten_prompt || "Navigator task"}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => deleteRunMutation.mutate({ runId: run.run_id })}
                        disabled={deleteRunMutation.isPending}
                        className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        Delete
                      </button>
                      <span className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${tone}`}>
                        {status}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">
                    {stepCount} step{stepCount === 1 ? "" : "s"} · {when}
                  </p>
                  {run.message ? <p className="text-xs text-neutral-600 mt-1 line-clamp-2">{run.message}</p> : null}
                  {stepCount > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRunIds((prev) => ({
                          ...prev,
                          [run.run_id]: !prev[run.run_id],
                        }))
                      }
                      className="mt-2 text-xs text-maroon-700 hover:text-maroon-800 font-medium"
                    >
                      {isExpanded ? "Hide timeline" : "Show timeline"}
                    </button>
                  )}
                  {isExpanded && Array.isArray(run.steps_executed) && (
                    <div className="mt-2 space-y-1.5 border-t border-neutral-100 pt-2">
                      {run.steps_executed.map((rawStep, idx) => {
                        const step = (rawStep ?? {}) as Record<string, unknown>;
                        const stepStatus = String(step.status || "waiting").toLowerCase();
                        const stepTone =
                          stepStatus === "success"
                            ? "text-green-700 bg-green-50"
                            : stepStatus === "error"
                            ? "text-red-700 bg-red-50"
                            : "text-neutral-600 bg-neutral-100";
                        const description =
                          String(step.description || "").trim() ||
                          String(step.action || "").trim() ||
                          `Step ${idx + 1}`;
                        return (
                          <div key={`${run.run_id}-step-${idx}`} className="rounded-lg border border-neutral-200 px-2 py-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs text-neutral-800 truncate">{description}</p>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase ${stepTone}`}>
                                {stepStatus}
                              </span>
                            </div>
                            {step.data ? (
                              <p className="text-[11px] text-neutral-500 mt-1 line-clamp-2">{String(step.data)}</p>
                            ) : null}
                            {typeof step.screenshot === "string" && step.screenshot ? (
                              <img
                                src={step.screenshot}
                                alt="Step screenshot"
                                className="mt-1.5 w-full max-h-52 object-contain rounded border border-neutral-200 bg-neutral-50"
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {isLoading && allTabs.length === 0 && (
        <p className="text-sm text-neutral-500">Checking connection…</p>
      )}
    </div>
  );
}
