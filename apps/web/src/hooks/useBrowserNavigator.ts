import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

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
  plan?: {
    steps?: Array<Record<string, unknown>>;
    requires_browser?: boolean;
    estimated_duration_seconds?: number;
  };
  steps_executed?: Array<Record<string, unknown>>;
}

export interface AgentStep {
  type: string;
  action?: string;
  description?: string;
  target?: unknown;
  value?: unknown;
  reason?: string;
}

export interface BrowserAgentPlanResponse {
  ok: boolean;
  selected_target?: { device_id?: string; tab_id?: number };
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

export type StepStatus = "waiting" | "processing" | "success" | "error";

export interface StreamStepEvent {
  type: "planned" | "step_start" | "step_end" | "done";
  selected_target?: { device_id?: string; tab_id?: number };
  steps?: AgentStep[];
  index?: number;
  status?: string;
  data?: string;
  ok?: boolean;
  message?: string;
  run_id?: string;
  steps_executed?: Array<Record<string, unknown>>;
}

export function useBrowserAgentStream() {
  const abortRef = useRef<AbortController | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

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

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6)) as StreamStepEvent;
                onEvent(event);
              } catch { /* malformed SSE line */ }
            }
          }
        }
      } finally {
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
