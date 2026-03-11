export interface TabInfo {
  url: string;
  title: string;
}

export interface RefEntry {
  role: string;
  name: string;
  level?: number;
  description?: string;
  nth?: number;
  backendDOMNodeId?: number;
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  found: boolean;
  description: string;
}

export interface ActionabilityCheckResult {
  ok: boolean;
  reason: string;
  hitTag?: string;
}

export interface CoordsTarget {
  by: "coords";
  x: number;
  y: number;
}

export type BlockerClass =
  | "none"
  | "security_gate"
  | "system_permission"
  | "modal_dialog"
  | "cookie_banner"
  | "onboarding_tour"
  | "popover_menu"
  | "loading_mask"
  | "click_intercept"
  | "unknown_overlay";

export interface BlockerPoint {
  x: number;
  y: number;
  label: string;
}

export interface UiBlockerScan {
  blockerClass: BlockerClass;
  reason: string;
  closePoints: BlockerPoint[];
  backdropPoint: BlockerPoint | null;
  targetCovered: boolean;
  hitTag: string;
}

export interface BlockerResolutionResult {
  status: "cleared" | "waiting" | "escalate" | "failed";
  blockerClass: BlockerClass;
  details: string;
}

export interface AXNode {
  nodeId: string;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
}

export type ExtensionErrorCode =
  | "NOT_FOUND"
  | "ELEMENT_AMBIGUOUS"
  | "TIMEOUT"
  | "STALE_REF"
  | "NOT_ACTIONABLE"
  | "BLOCKED_UI"
  | "SECURITY_GATE"
  | "INFOBAR_INTERCEPT"
  | "INVALID_ACTION"
  | "EXECUTION_ERROR";
