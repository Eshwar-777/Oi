"use client";

import { useCallback, useMemo, useReducer, useState } from "react";
import {
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
  const agentStream = useBrowserAgentStream();
  const agentResume = useBrowserAgentResume();

  const [prompt, setPrompt] = useState("");
  const [localError, setLocalError] = useState("");
  const [localInfo, setLocalInfo] = useState("");
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
  }, []);

  const runAgent = useCallback(async () => {
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
    dispatchRunUi({ type: "START_PLANNING" });

    try {
      await agentStream.run({
        prompt: prompt.trim(),
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
  }, [allTabs.length, prompt, agentStream, handleEvent]);

  const stopAgent = useCallback(() => {
    agentStream.stop();
  }, [agentStream]);

  const rerunAgent = useCallback(() => {
    runAgent();
  }, [runAgent]);

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

  const isRunning = runUi.phase === "planning" || runUi.phase === "running";
  const canStop = runUi.phase === "running";
  const effectiveError = localError || (runUi.ok === false ? runUi.message : "");
  const effectiveSuccess = !effectiveError ? localInfo || (runUi.ok === true ? runUi.message : "") : "";

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
            }}
            rows={3}
            placeholder="e.g. Compose an email to john@example.com with subject 'Update' and a short body."
            className="flex-1 px-3 py-2 rounded-lg border border-neutral-200 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-500 resize-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={runAgent}
            disabled={isRunning || allTabs.length === 0}
            className="px-4 py-2 rounded-lg bg-maroon-600 text-white text-sm font-medium hover:bg-maroon-700 disabled:opacity-50 disabled:pointer-events-none"
          >
            {runUi.phase === "planning" ? "Planning…" : runUi.phase === "running" ? "Running…" : "Run"}
          </button>
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

      {isLoading && allTabs.length === 0 && (
        <p className="text-sm text-neutral-500">Checking connection…</p>
      )}
    </div>
  );
}
