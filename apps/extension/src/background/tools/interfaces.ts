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

export interface StateAssertionInput {
  expectedUrlContains?: string[];
  expectedTitleContains?: string[];
  requiredMarkers?: string[];
}

export interface StateAssertionResult {
  ok: boolean;
  evidence: string;
}

export interface LocateTargetResult {
  ok: boolean;
  reason: string;
  box?: ElementBox;
  x?: number;
  y?: number;
}

export interface ClickableAssertionResult {
  ok: boolean;
  reason: string;
  hitTag?: string;
}

export interface VerifyPostconditionInput {
  action: "click" | "type" | "select" | "hover";
  target: unknown;
  intendedValue?: string;
}

export interface VerifyPostconditionResult {
  ok: boolean;
  reason: string;
}

export interface RepairContext {
  action: "click" | "type" | "select" | "hover";
  target: unknown;
  failureReason: string;
}

export interface RepairPlan {
  status: "applied" | "skipped";
  reason: string;
}

export interface UiToolRuntime {
  cdp: (tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>;
  cdpEval: (tabId: number, expression: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  pressKey: (tabId: number, key: string) => Promise<void>;
  clickPoint: (tabId: number, x: number, y: number) => Promise<void>;
}
