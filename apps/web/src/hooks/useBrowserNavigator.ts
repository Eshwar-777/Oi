import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { isRunEvent } from "@oi/shared-types";
import type { RunAgentStep, RunEvent, StepStatus as SharedStepStatus } from "@oi/shared-types";

export interface AttachedTab {
  tab_id: number;
  url?: string;
  title?: string;
}

export interface BrowserTabState {
  device_id: string;
  connected: boolean;
  attached: boolean;
  attached_tab_count?: number;
  tabs?: AttachedTab[];
  target?: {
    tab_id?: number;
    url?: string;
    title?: string;
  } | null;
}

export interface BrowserTabsResponse {
  items: BrowserTabState[];
}

export function useBrowserTabs() {
  return useQuery({
    queryKey: ["browser-tabs"],
    queryFn: async (): Promise<BrowserTabsResponse> => {
      const res = await fetch("/api/browser/tabs", { headers: { "Content-Type": "application/json" } });
      if (!res.ok) return { items: [] };
      return res.json();
    },
  });
}

export function useBrowserNavigate() {
  return useMutation({
    mutationFn: async ({ url, deviceId, tabId }: { url: string; deviceId?: string; tabId?: number }) => {
      const res = await fetch("/api/browser/navigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, device_id: deviceId, tab_id: tabId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { detail?: string }).detail || "Navigation failed");
      }
      return res.json();
    },
  });
}

export function useBrowserSnapshot() {
  return useMutation({
    mutationFn: async ({ deviceId, tabId }: { deviceId?: string; tabId?: number } = {}) => {
      const res = await fetch("/api/browser/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: deviceId, tab_id: tabId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { detail?: string }).detail || "Snapshot failed");
      }
      return res.json();
    },
  });
}

export interface BrowserAgentResponse {
  ok: boolean;
  run_id: string;
  message: string;
  selected_target?: { device_id?: string; tab_id?: number };
  requires_user_action?: boolean;
  resume_token?: string;
  plan?: {
    steps?: Array<Record<string, unknown>>;
    requires_browser?: boolean;
    estimated_duration_seconds?: number;
  };
  steps_executed?: Array<Record<string, unknown>>;
}

export interface NavigatorRunHistoryItem {
  run_id: string;
  prompt?: string;
  rewritten_prompt?: string;
  status: string;
  message?: string;
  requires_user_action?: boolean;
  device_id?: string;
  tab_id?: number | null;
  target_url?: string;
  page_title?: string;
  steps_executed?: Array<Record<string, unknown>>;
  created_at?: string;
  updated_at?: string;
}

export interface NavigatorRunHistoryResponse {
  items: NavigatorRunHistoryItem[];
}

export type AgentStep = RunAgentStep;

export interface BrowserAgentPlanResponse {
  ok: boolean;
  selected_target?: { device_id?: string; tab_id?: number };
  rewritten_prompt?: string;
  plan: {
    steps: AgentStep[];
    requires_browser?: boolean;
    estimated_duration_seconds?: number;
  };
}

function getApiErrorDetail(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "detail" in err && typeof (err as { detail?: unknown }).detail === "string")
    return (err as { detail: string }).detail;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string")
    return (err as { message: string }).message;
  return fallback;
}

export function useBrowserAgentPlan() {
  return useMutation({
    mutationFn: async ({
      prompt,
      deviceId,
      tabId,
      signal,
    }: {
      prompt: string;
      deviceId?: string;
      tabId?: number;
      signal?: AbortSignal;
    }): Promise<BrowserAgentPlanResponse> => {
      const res = await fetch("/api/browser/agent/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, device_id: deviceId, tab_id: tabId }),
        signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(getApiErrorDetail(body, "Could not plan steps"));
      }
      return body as BrowserAgentPlanResponse;
    },
  });
}

export function useBrowserAgentAction() {
  return useMutation({
    mutationFn: async ({
      prompt,
      deviceId,
      tabId,
      signal,
    }: {
      prompt: string;
      deviceId?: string;
      tabId?: number;
      signal?: AbortSignal;
    }): Promise<BrowserAgentResponse> => {
      const res = await fetch("/api/browser/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, device_id: deviceId, tab_id: tabId }),
        signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(getApiErrorDetail(body, "Agent action failed"));
      }
      return body as BrowserAgentResponse;
    },
  });
}

// ---------------------------------------------------------------------------
// Streaming agent hook — real-time per-step updates via SSE
// ---------------------------------------------------------------------------

export type StreamStepEvent = RunEvent;
export type StepStatus = SharedStepStatus;

export function useBrowserAgentResume() {
  return useMutation({
    mutationFn: async ({
      resumeToken,
      signal,
    }: {
      resumeToken: string;
      signal?: AbortSignal;
    }): Promise<BrowserAgentResponse> => {
      const res = await fetch("/api/browser/agent/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume_token: resumeToken }),
        signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(getApiErrorDetail(body, "Resume failed"));
      }
      return body as BrowserAgentResponse;
    },
  });
}

export function useBrowserAgentStream() {
  const abortRef = useRef<AbortController | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const STREAM_HARD_TIMEOUT_MS = 260000;

  const run = useCallback(
    async ({
      prompt,
      deviceId,
      tabId,
      onEvent,
    }: {
      prompt: string;
      deviceId?: string;
      tabId?: number;
      onEvent: (event: StreamStepEvent) => void;
    }) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setIsStreaming(true);
      const hardTimeout = setTimeout(() => ac.abort(), STREAM_HARD_TIMEOUT_MS);

      try {
        const res = await fetch("/api/browser/agent/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, device_id: deviceId, tab_id: tabId }),
          signal: ac.signal,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(getApiErrorDetail(body, "Agent stream failed"));
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let shouldStop = false;

        while (true) {
          const { value, done } = await reader.read();
          if (done || shouldStop) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(line.slice(6)) as unknown;
                if (!isRunEvent(parsed)) continue;
                onEvent(parsed);
                if (parsed.type === "done") {
                  shouldStop = true;
                  ac.abort();
                  break;
                }
              } catch { /* malformed SSE line */ }
            }
          }
        }
      } finally {
        clearTimeout(hardTimeout);
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { run, stop, isStreaming };
}

export function useBrowserAgentHistory(limit = 20) {
  return useQuery({
    queryKey: ["browser-agent-history", limit],
    queryFn: async (): Promise<NavigatorRunHistoryResponse> => {
      const res = await fetch(`/api/browser/agent/history?limit=${encodeURIComponent(String(limit))}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) return { items: [] };
      const body = await res.json().catch(() => ({ items: [] }));
      return {
        items: Array.isArray(body?.items) ? (body.items as NavigatorRunHistoryItem[]) : [],
      };
    },
    enabled: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
