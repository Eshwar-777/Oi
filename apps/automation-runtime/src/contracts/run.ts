export type BrowserExecutionStep = {
  id?: string | null;
  command?: string | null;
  action?: string | null;
  description?: string | null;
  target?: unknown;
  value?: unknown;
  args?: string[];
  snapshot_id?: string | null;
  page_ref?: string | null;
  success_criteria?: Array<Record<string, unknown>>;
};

export type AutomationRuntimeRunRequest = {
  runId: string;
  sessionId: string;
  text: string;
  browserSessionId?: string | null;
  cwd?: string | null;
  model?: {
    provider?: string | null;
    name?: string | null;
  } | null;
  browser: {
    mode: "cdp";
    cdpUrl: string;
  };
  context: {
    userId: string;
    timezone?: string | null;
    locale?: string | null;
  };
  goalHints?: {
    taskMode?: "browser_automation" | "general_chat" | "unknown" | null;
    app?: string | null;
    entities?: Record<string, unknown> | null;
    executionContract?: Record<string, unknown> | null;
    predictedPlan?: Record<string, unknown> | null;
  } | null;
  resume?: Record<string, unknown> | null;
  steps?: BrowserExecutionStep[];
  pageRegistry?: Record<string, Record<string, unknown>>;
  activePageRef?: string | null;
};

export type AutomationRuntimeRunState =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type AutomationRuntimeRunRecord = {
  runId: string;
  sessionId: string;
  state: AutomationRuntimeRunState;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  result?: Record<string, unknown> | null;
};
