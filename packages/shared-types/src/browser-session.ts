export type BrowserSessionOrigin = "local_runner" | "server_runner";
export type BrowserSessionStatus = "idle" | "starting" | "ready" | "busy" | "stopped" | "error";
export type ControllerActorType = "web" | "mobile" | "desktop" | "system";

export interface BrowserViewport {
  width: number;
  height: number;
  dpr: number;
}

export interface BrowserPageRecord {
  page_id: string;
  url: string;
  title: string;
  is_active: boolean;
}

export interface ControllerLockRecord {
  actor_id: string;
  actor_type: ControllerActorType;
  acquired_at: string;
  expires_at: string;
  priority: number;
}

export interface BrowserSessionRecord {
  session_id: string;
  user_id: string;
  origin: BrowserSessionOrigin;
  provider: string;
  status: BrowserSessionStatus;
  browser_session_id?: string | null;
  browser_version?: string | null;
  runner_id?: string | null;
  runner_label?: string | null;
  page_id?: string | null;
  pages: BrowserPageRecord[];
  viewport?: BrowserViewport | null;
  controller_lock?: ControllerLockRecord | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface SessionControlAuditRecord {
  audit_id: string;
  session_id: string;
  actor_id: string;
  actor_type: ControllerActorType;
  action: "acquire" | "release" | "navigate" | "refresh_stream" | "input";
  input_type?: string | null;
  target_url?: string | null;
  outcome: "accepted" | "rejected";
  detail?: string | null;
  created_at: string;
}
