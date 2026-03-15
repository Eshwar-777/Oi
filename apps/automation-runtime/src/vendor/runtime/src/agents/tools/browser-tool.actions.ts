import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  browserAct,
  browserConsoleMessages,
  browserSnapshot,
  browserTabs,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
} from "../../browser/browser-core-surface.js";
import { loadBrowserConfig } from "../../config/browser-config.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { imageResultFromFile, jsonResult } from "./common.js";

type BrowserProxyRequest = (opts: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}) => Promise<unknown>;

type SnapshotGroundingState = {
  targetId?: string;
  refCount: number;
  refs?: Record<string, { role?: string; name?: string }>;
};

const latestSnapshotGroundingByProfile = new Map<string, SnapshotGroundingState>();
type LastTextEntryState = {
  kind: string;
  targetId?: string;
  signature: string;
};

const lastTextEntryByProfile = new Map<string, LastTextEntryState>();
const HELPER_FIELD_MARKERS = new Set([
  "search",
  "search field",
  "filter",
  "find",
  "lookup",
  "command",
  "prompt",
  "query",
]);

function snapshotGroundingKey(profile: string | undefined): string {
  return String(profile || "").trim().toLowerCase() || "__default__";
}

function rememberSnapshotGrounding(profile: string | undefined, snapshot: unknown): void {
  const record =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : null;
  if (!record) {
    return;
  }
  const refs =
    record.refs && typeof record.refs === "object" && !Array.isArray(record.refs)
      ? (record.refs as Record<string, unknown>)
      : null;
  latestSnapshotGroundingByProfile.set(snapshotGroundingKey(profile), {
    targetId: typeof record.targetId === "string" ? record.targetId.trim() : undefined,
    refCount: refs ? Object.keys(refs).length : 0,
    refs: refs
      ? Object.fromEntries(
          Object.entries(refs).map(([ref, value]) => {
            const refRecord =
              value && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {};
            return [
              normalizeSnapshotRef(ref),
              {
                role: typeof refRecord.role === "string" ? refRecord.role.trim() : undefined,
                name: typeof refRecord.name === "string" ? refRecord.name.trim() : undefined,
              },
            ];
          }),
        )
      : undefined,
  });
}

function normalizeSnapshotRef(ref: string | undefined): string {
  const trimmed = String(ref || "").trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function latestSnapshotHasActionableRefs(
  profile: string | undefined,
  request: Parameters<typeof browserAct>[1],
): boolean {
  const grounding = latestSnapshotGroundingByProfile.get(snapshotGroundingKey(profile));
  if (!grounding || grounding.refCount <= 0) {
    return false;
  }
  const requestTargetId =
    typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (!grounding.targetId || !requestTargetId) {
    return true;
  }
  return grounding.targetId === requestTargetId;
}

function latestSnapshotTargetId(profile: string | undefined): string | undefined {
  const grounding = latestSnapshotGroundingByProfile.get(snapshotGroundingKey(profile));
  const targetId = typeof grounding?.targetId === "string" ? grounding.targetId.trim() : "";
  return targetId || undefined;
}

function withLatestGroundedTargetId(
  request: Parameters<typeof browserAct>[1],
  profile: string | undefined,
): Parameters<typeof browserAct>[1] {
  const explicitTargetId =
    typeof request.targetId === "string" ? request.targetId.trim() : "";
  if (explicitTargetId) {
    return request;
  }
  const groundedTargetId = latestSnapshotTargetId(profile);
  if (!groundedTargetId) {
    return request;
  }
  return {
    ...request,
    targetId: groundedTargetId,
  };
}

function latestSnapshotRefRecord(
  profile: string | undefined,
  request: Parameters<typeof browserAct>[1],
): { role?: string; name?: string } | null {
  const grounding = latestSnapshotGroundingByProfile.get(snapshotGroundingKey(profile));
  if (!grounding?.refs) {
    return null;
  }
  const requestTargetId =
    typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (grounding.targetId && requestTargetId && grounding.targetId !== requestTargetId) {
    return null;
  }
  const ref = typeof request.ref === "string" ? normalizeSnapshotRef(request.ref) : "";
  if (!ref) {
    return null;
  }
  return grounding.refs[ref] ?? null;
}

function latestSnapshotLooksLikeResultsOrCatalogSurface(profile: string | undefined): boolean {
  const grounding = latestSnapshotGroundingByProfile.get(snapshotGroundingKey(profile));
  if (!grounding?.refs || grounding.refCount <= 0) {
    return false;
  }
  let editableCount = 0;
  let clickableCount = 0;
  let labeledClickableCount = 0;
  for (const value of Object.values(grounding.refs)) {
    const role = String(value?.role || "").trim().toLowerCase();
    const name = String(value?.name || "").trim();
    if (EDITABLE_ROLES.has(role)) {
      editableCount += 1;
    }
    if (CLICKABLE_ROLES.has(role)) {
      clickableCount += 1;
      if (name) {
        labeledClickableCount += 1;
      }
    }
  }
  if (editableCount >= 2) {
    return false;
  }
  return clickableCount >= 3 && labeledClickableCount >= 2;
}

function latestSnapshotEditableRefCount(
  profile: string | undefined,
  request: Parameters<typeof browserAct>[1],
): number {
  const grounding = latestSnapshotGroundingByProfile.get(snapshotGroundingKey(profile));
  if (!grounding?.refs || grounding.refCount <= 0) {
    return 0;
  }
  const requestTargetId =
    typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (grounding.targetId && requestTargetId && grounding.targetId !== requestTargetId) {
    return 0;
  }
  let count = 0;
  for (const value of Object.values(grounding.refs)) {
    const role = String(value?.role || "").trim().toLowerCase();
    if (EDITABLE_ROLES.has(role)) {
      count += 1;
    }
  }
  return count;
}

function latestSnapshotHasRichEditableSurface(
  profile: string | undefined,
  request: Parameters<typeof browserAct>[1],
): boolean {
  const grounding = latestSnapshotGroundingByProfile.get(snapshotGroundingKey(profile));
  if (!grounding?.refs || grounding.refCount <= 0) {
    return false;
  }
  const requestTargetId =
    typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (grounding.targetId && requestTargetId && grounding.targetId !== requestTargetId) {
    return false;
  }
  let editableCount = 0;
  let foregroundContainerCount = 0;
  for (const value of Object.values(grounding.refs)) {
    const role = String(value?.role || "").trim().toLowerCase();
    if (EDITABLE_ROLES.has(role)) {
      editableCount += 1;
    }
    if (role === "dialog" || role === "form" || role === "region") {
      foregroundContainerCount += 1;
    }
  }
  return editableCount >= 2 && foregroundContainerCount >= 1;
}

function latestSnapshotHasBetterNamedEditablePeer(
  profile: string | undefined,
  request: Parameters<typeof browserAct>[1],
): boolean {
  const grounding = latestSnapshotGroundingByProfile.get(snapshotGroundingKey(profile));
  if (!grounding?.refs || grounding.refCount <= 0) {
    return false;
  }
  const requestTargetId =
    typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (grounding.targetId && requestTargetId && grounding.targetId !== requestTargetId) {
    return false;
  }
  const ref = typeof request.ref === "string" ? normalizeSnapshotRef(request.ref) : "";
  const current = ref ? grounding.refs[ref] : null;
  const currentName = String(current?.name || "").trim();
  const currentRole = String(current?.role || "").trim().toLowerCase();
  const normalizedCurrentName = currentName.toLowerCase();
  const currentLooksHelperField =
    currentRole === "listbox" ||
    !currentName ||
    HELPER_FIELD_MARKERS.has(normalizedCurrentName) ||
    normalizedCurrentName.endsWith(" search") ||
    normalizedCurrentName.endsWith(" filter");
  for (const [candidateRef, value] of Object.entries(grounding.refs)) {
    if (candidateRef === ref) {
      continue;
    }
    const role = String(value?.role || "").trim().toLowerCase();
    const name = String(value?.name || "").trim();
    if (!EDITABLE_ROLES.has(role) || !name) {
      continue;
    }
    if (currentLooksHelperField) {
      return true;
    }
  }
  return false;
}

function latestSnapshotNamedEditableRefs(
  profile: string | undefined,
  request: Parameters<typeof browserAct>[1],
): Array<{ ref: string; role?: string; name?: string }> {
  const grounding = latestSnapshotGroundingByProfile.get(snapshotGroundingKey(profile));
  if (!grounding?.refs || grounding.refCount <= 0) {
    return [];
  }
  const requestTargetId =
    typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (grounding.targetId && requestTargetId && grounding.targetId !== requestTargetId) {
    return [];
  }
  return Object.entries(grounding.refs)
    .map(([ref, value]) => ({
      ref,
      role: typeof value?.role === "string" ? value.role.trim() : undefined,
      name: typeof value?.name === "string" ? value.name.trim() : undefined,
    }))
    .filter((entry) => EDITABLE_ROLES.has(String(entry.role || "").toLowerCase()) && entry.name)
    .slice(0, 8);
}

function namedEditableRefGuidance(
  profile: string | undefined,
  request: Parameters<typeof browserAct>[1],
): string {
  const refs = latestSnapshotNamedEditableRefs(profile, request);
  if (!refs.length) {
    return "";
  }
  const examples = refs
    .map((entry) => `${entry.ref}${entry.name ? ` "${entry.name}"` : ""}`)
    .join(", ");
  return ` Use one of the visible named editable refs from the latest snapshot, for example: ${examples}.`;
}

function textEntrySignature(request: Parameters<typeof browserAct>[1]): string {
  const kind = actKindOf(request);
  if (kind === "type") {
    return `${normalizeSnapshotRef(String(request.ref || ""))}::${String(request.text || "").trim()}`;
  }
  if (kind === "fill" && Array.isArray(request.fields)) {
    return request.fields
      .map((field) => {
        const record =
          field && typeof field === "object" && !Array.isArray(field)
            ? (field as Record<string, unknown>)
            : {};
        return `${normalizeSnapshotRef(String(record.ref || ""))}::${String(record.value || "").trim()}`;
      })
      .sort()
      .join("||");
  }
  return "";
}

function shouldRejectRepeatedTextEntry(
  request: Parameters<typeof browserAct>[1],
  profile: string | undefined,
): boolean {
  const kind = actKindOf(request);
  if (!(kind === "type" || kind === "fill")) {
    return false;
  }
  if (!latestSnapshotHasActionableRefs(profile, request)) {
    return false;
  }
  const previous = lastTextEntryByProfile.get(snapshotGroundingKey(profile));
  if (!previous) {
    return false;
  }
  const currentTargetId =
    typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  return (
    previous.kind === kind &&
    previous.targetId === currentTargetId &&
    previous.signature.length > 0 &&
    previous.signature === textEntrySignature(request)
  );
}

function rememberExecutedTextEntry(
  request: Parameters<typeof browserAct>[1],
  profile: string | undefined,
): void {
  const kind = actKindOf(request);
  if (!(kind === "type" || kind === "fill")) {
    if (isMutatingActRequest(request)) {
      lastTextEntryByProfile.delete(snapshotGroundingKey(profile));
    }
    return;
  }
  lastTextEntryByProfile.set(snapshotGroundingKey(profile), {
    kind,
    targetId: typeof request.targetId === "string" ? request.targetId.trim() : undefined,
    signature: textEntrySignature(request),
  });
}

const CONTAINER_ROLES = new Set([
  "alert",
  "article",
  "banner",
  "complementary",
  "contentinfo",
  "definition",
  "dialog",
  "document",
  "feed",
  "form",
  "generic",
  "grid",
  "group",
  "list",
  "listitem",
  "main",
  "navigation",
  "note",
  "region",
  "rowgroup",
  "section",
  "status",
  "table",
  "tabpanel",
  "term",
  "toolbar",
]);

const CLICKABLE_ROLES = new Set([
  "button",
  "checkbox",
  "gridcell",
  "link",
  "menuitem",
  "option",
  "radio",
  "row",
  "switch",
  "tab",
  "treeitem",
]);

const EDITABLE_ROLES = new Set([
  "combobox",
  "input",
  "searchbox",
  "spinbutton",
  "textarea",
  "textbox",
]);

function validateGroundedRefSpecificity(
  request: Parameters<typeof browserAct>[1],
  profile: string | undefined,
): { ok: true } | { ok: false; missing: string[]; reason: string } {
  const kind = actKindOf(request);
  if (!isMutatingActRequest(request) && kind !== "hover" && kind !== "scrollIntoView") {
    return { ok: true };
  }
  if (kind === "drag" || kind === "resize" || kind === "press") {
    return { ok: true };
  }
  if (kind === "fill" && Array.isArray(request.fields)) {
    if (latestSnapshotHasRichEditableSurface(profile, request)) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          `The active surface already exposes multiple editable fields. Do not use fill on this surface. Update one concrete named field ref at a time with type or select, then capture a fresh snapshot before moving to the next field.${namedEditableRefGuidance(profile, request)}`,
      };
    }
    const editableRefCount = latestSnapshotEditableRefCount(profile, request);
    if (editableRefCount >= 2) {
      return {
        ok: false,
        missing: ["kind"],
        reason:
          `The latest snapshot exposes multiple editable controls on this surface. Use concrete type or select actions on one named field ref at a time, then capture a fresh snapshot before moving to the next field.${namedEditableRefGuidance(profile, request)}`,
      };
    }
    for (const field of request.fields) {
      const record =
        field && typeof field === "object" && !Array.isArray(field)
          ? (field as Record<string, unknown>)
          : {};
      const ref = typeof record.ref === "string" ? record.ref.trim() : "";
      if (!ref) {
        return {
          ok: false,
          missing: ["fields[].ref"],
          reason:
            `Form filling must target concrete editable refs from the latest snapshot. Capture a fresh focused snapshot and choose the actual field refs instead of submitting an ungrounded form payload.${namedEditableRefGuidance(profile, request)}`,
        };
      }
      const fieldRequest = { ...request, ref, kind: "fill" } as Parameters<typeof browserAct>[1];
      const fieldRefRecord = latestSnapshotRefRecord(profile, fieldRequest);
      const fieldRole = String(fieldRefRecord?.role || "").trim().toLowerCase();
      if (!fieldRefRecord || !EDITABLE_ROLES.has(fieldRole)) {
        return {
          ok: false,
          missing: ["fields[].ref"],
          reason:
            `Form filling must target a concrete editable control from the latest snapshot. Capture a fresh focused snapshot and choose the actual textbox, combobox, or similar field ref.${namedEditableRefGuidance(profile, fieldRequest)}`,
        };
      }
    }
    return { ok: true };
  }
  if (kind === "fill") {
    if (latestSnapshotHasRichEditableSurface(profile, request)) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          `The active surface already exposes multiple editable fields. Do not use generic fill. Use one concrete type or select action on the intended named field ref, then capture a fresh snapshot before moving to the next control.${namedEditableRefGuidance(profile, request)}`,
      };
    }
    const editableRefCount = latestSnapshotEditableRefCount(profile, request);
    if (editableRefCount >= 2) {
      return {
        ok: false,
        missing: ["kind"],
        reason:
          `The latest snapshot exposes multiple editable controls on this surface. Do not use generic fill. Use one concrete type or select action on the intended named field ref, then capture a fresh snapshot before moving to the next control.${namedEditableRefGuidance(profile, request)}`,
      };
    }
  }
  const hasRef = typeof request.ref === "string" && request.ref.trim().length > 0;
  const hasSelector = typeof request.selector === "string" && request.selector.trim().length > 0;
  if ((isMutatingActRequest(request) || kind === "hover" || kind === "scrollIntoView") && !hasRef) {
    if (latestSnapshotHasActionableRefs(profile, request)) {
      return {
        ok: false,
        missing: ["ref"],
        reason: hasSelector
          ? `The latest interactive snapshot already exposes actionable refs for this surface. Do not mutate the UI with a selector-only action. Capture a fresh snapshot if needed and use one concrete ref from that observation.${namedEditableRefGuidance(profile, request)}`
          : `The latest interactive snapshot already exposes actionable refs for this surface. Do not mutate the UI without a concrete ref from that observation.${namedEditableRefGuidance(profile, request)}`,
      };
    }
  }
  if (!hasRef) {
    return { ok: true };
  }
  const refRecord = latestSnapshotRefRecord(profile, request);
  if (!refRecord) {
    if (latestSnapshotHasActionableRefs(profile, request)) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          `The requested browser ref is not grounded in the latest interactive snapshot for this surface. Capture a fresh snapshot and choose a visible ref from that observation before mutating the UI.${namedEditableRefGuidance(profile, request)}`,
      };
    }
    return { ok: true };
  }
  const role = String(refRecord.role || "").trim().toLowerCase();
  const name = String(refRecord.name || "").trim();
  if ((kind === "click" || kind === "hover" || kind === "scrollIntoView") && role) {
    if (CONTAINER_ROLES.has(role) && !CLICKABLE_ROLES.has(role)) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          "The chosen ref points to a structural container rather than a concrete interactive target. Capture a fresh scoped snapshot and choose the specific button, link, option, or field inside that surface.",
      };
    }
    if (!CLICKABLE_ROLES.has(role)) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          "The chosen ref is not a clickable target in the latest snapshot. Capture a fresh scoped snapshot and choose a concrete button, link, option, checkbox, radio, switch, or tab ref instead.",
      };
    }
    if (!name) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          "The chosen ref is too vague to mutate safely from the latest snapshot. Capture a fresh scoped snapshot and choose a concrete interactive target with a visible role or label.",
      };
    }
    if (
      (kind === "click" || kind === "scrollIntoView") &&
      latestSnapshotHasRichEditableSurface(profile, request) &&
      (role === "link" || role === "listbox" || role === "option")
    ) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          `The active surface already exposes multiple editable fields. Do not click auxiliary link, listbox, or option controls before filling the intended field. Capture a fresh focused snapshot and target the concrete editable field ref first.${namedEditableRefGuidance(profile, request)}`,
      };
    }
  }
  if ((kind === "type" || kind === "fill" || kind === "select") && role) {
    if (!EDITABLE_ROLES.has(role)) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          `Text entry and selection must target a concrete editable control from the latest snapshot. Capture a fresh focused snapshot and choose the actual textbox, combobox, or select-like field ref.${namedEditableRefGuidance(profile, request)}`,
      };
    }
    if (
      latestSnapshotHasRichEditableSurface(profile, request) &&
      latestSnapshotHasBetterNamedEditablePeer(profile, request)
    ) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          `The active surface already exposes better-labeled editable fields. Do not type into auxiliary or weakly labeled helper fields; target the concrete named field ref that matches the intended value, then capture a fresh snapshot.${namedEditableRefGuidance(profile, request)}`,
      };
    }
  }
  return { ok: true };
}

function countSnapshotRefs(snapshot: Record<string, unknown>): number {
  const refs =
    snapshot.refs && typeof snapshot.refs === "object" && !Array.isArray(snapshot.refs)
      ? (snapshot.refs as Record<string, unknown>)
      : null;
  return refs ? Object.keys(refs).length : 0;
}

function countSnapshotNodes(snapshot: Record<string, unknown>): number {
  if (Array.isArray(snapshot.nodes)) {
    return snapshot.nodes.length;
  }
  const stats =
    snapshot.stats && typeof snapshot.stats === "object" && !Array.isArray(snapshot.stats)
      ? (snapshot.stats as Record<string, unknown>)
      : null;
  const nodeCount = stats?.nodeCount;
  return typeof nodeCount === "number" && Number.isFinite(nodeCount) ? nodeCount : 0;
}

function snapshotRefEntries(
  snapshot: Record<string, unknown>,
): Array<{ ref: string; role?: string; name?: string }> {
  const refs =
    snapshot.refs && typeof snapshot.refs === "object" && !Array.isArray(snapshot.refs)
      ? (snapshot.refs as Record<string, unknown>)
      : null;
  if (!refs) {
    return [];
  }
  return Object.entries(refs).map(([ref, value]) => {
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return {
      ref,
      role: typeof record.role === "string" ? record.role.trim().toLowerCase() : undefined,
      name: typeof record.name === "string" ? record.name.trim() : undefined,
    };
  });
}

function snapshotControlRefCount(snapshot: Record<string, unknown>): number {
  return snapshotRefEntries(snapshot).filter((entry) => {
    const role = String(entry.role || "");
    return role === "checkbox" || role === "radio" || role === "switch" || role === "option" || role === "button";
  }).length;
}

function snapshotNamedCatalogCandidateCount(snapshot: Record<string, unknown>): number {
  return snapshotRefEntries(snapshot).filter((entry) => {
    const role = String(entry.role || "");
    const name = String(entry.name || "").trim();
    if (!name) {
      return false;
    }
    if (role === "heading" || role === "checkbox" || role === "radio" || role === "switch" || role === "option" || role === "button") {
      return true;
    }
    if (role === "generic" || role === "listitem") {
      return name.length <= 48;
    }
    return false;
  }).length;
}

function snapshotLooksLikeCatalogControlSurface(snapshot: Record<string, unknown>): boolean {
  const entries = snapshotRefEntries(snapshot);
  if (!entries.length) {
    return false;
  }
  let productLikeLinkCount = 0;
  let namedCandidateCount = 0;
  for (const entry of entries) {
    const role = String(entry.role || "");
    const name = String(entry.name || "").trim();
    if (!name) {
      continue;
    }
    if (role === "link" && name.length > 60) {
      productLikeLinkCount += 1;
    }
    if (
      role === "heading" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "switch" ||
      role === "option" ||
      role === "button" ||
      ((role === "generic" || role === "listitem") && name.length <= 48)
    ) {
      namedCandidateCount += 1;
    }
  }
  return productLikeLinkCount <= 2 && namedCandidateCount >= 3;
}

function snapshotCatalogRecoveryScore(snapshot: Record<string, unknown>): number {
  const refCount = countSnapshotRefs(snapshot);
  if (refCount <= 0) {
    return -1;
  }
  const controlCount = snapshotControlRefCount(snapshot);
  const namedCandidateCount = snapshotNamedCatalogCandidateCount(snapshot);
  const looksLikeResults = snapshotLooksLikeCatalogResultsSurface(snapshot);
  const looksLikeControls = snapshotLooksLikeCatalogControlSurface(snapshot);
  return controlCount * 10 + namedCandidateCount * 3 + (looksLikeResults ? 0 : 5) + (looksLikeControls ? 8 : 0);
}

function snapshotLooksLikeCatalogResultsSurface(snapshot: Record<string, unknown>): boolean {
  const entries = snapshotRefEntries(snapshot);
  if (!entries.length) {
    return false;
  }
  let editableCount = 0;
  let clickableCount = 0;
  let linkCount = 0;
  let labeledClickableCount = 0;
  let controlCount = 0;
  for (const entry of entries) {
    const role = String(entry.role || "");
    if (EDITABLE_ROLES.has(role)) {
      editableCount += 1;
    }
    if (CLICKABLE_ROLES.has(role)) {
      clickableCount += 1;
      if (entry.name) {
        labeledClickableCount += 1;
      }
    }
    if (role === "link") {
      linkCount += 1;
    }
    if (role === "checkbox" || role === "radio" || role === "switch" || role === "option" || role === "button") {
      controlCount += 1;
    }
  }
  return editableCount <= 1 && clickableCount >= 8 && labeledClickableCount >= 6 && linkCount >= 6 && controlCount === 0;
}

function isScopedInteractiveSnapshot(input: {
  interactive?: boolean;
  selector?: string;
  frame?: string;
}): boolean {
  return Boolean(input.interactive && (input.selector || input.frame));
}

function wrapBrowserExternalJson(params: {
  kind: "snapshot" | "console" | "tabs";
  payload: unknown;
  includeWarning?: boolean;
}): { wrappedText: string; safeDetails: Record<string, unknown> } {
  const extractedText = JSON.stringify(params.payload, null, 2);
  const wrappedText = wrapExternalContent(extractedText, {
    source: "browser",
    includeWarning: params.includeWarning ?? true,
  });
  return {
    wrappedText,
    safeDetails: {
      ok: true,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: params.kind,
        wrapped: true,
      },
    },
  };
}

function formatTabsToolResult(tabs: unknown[]): AgentToolResult<unknown> {
  const wrapped = wrapBrowserExternalJson({
    kind: "tabs",
    payload: { tabs },
    includeWarning: false,
  });
  const content: AgentToolResult<unknown>["content"] = [
    { type: "text", text: wrapped.wrappedText },
  ];
  return {
    content,
    details: { ...wrapped.safeDetails, tabCount: tabs.length },
  };
}

function isChromeStaleTargetError(profile: string | undefined, err: unknown): boolean {
  if (profile !== "chrome") {
    return false;
  }
  const msg = String(err);
  return msg.includes("404:") && msg.includes("tab not found");
}

function stripTargetIdFromActRequest(
  request: Parameters<typeof browserAct>[1],
): Parameters<typeof browserAct>[1] | null {
  const targetId = typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (!targetId) {
    return null;
  }
  const retryRequest = { ...request };
  delete retryRequest.targetId;
  return retryRequest as Parameters<typeof browserAct>[1];
}

function canRetryChromeActWithoutTargetId(request: Parameters<typeof browserAct>[1]): boolean {
  const typedRequest = request as Partial<Record<"kind" | "action", unknown>>;
  const kind =
    typeof typedRequest.kind === "string"
      ? typedRequest.kind
      : typeof typedRequest.action === "string"
        ? typedRequest.action
        : "";
  return kind === "hover" || kind === "scrollIntoView" || kind === "wait";
}

function actKindOf(request: Parameters<typeof browserAct>[1]): string {
  const typedRequest = request as Partial<Record<"kind" | "action", unknown>>;
  return typeof typedRequest.kind === "string"
    ? typedRequest.kind
    : typeof typedRequest.action === "string"
      ? typedRequest.action
      : "";
}

function isMutatingActRequest(request: Parameters<typeof browserAct>[1]): boolean {
  return new Set(["click", "type", "press", "drag", "select", "fill", "close"]).has(
    actKindOf(request),
  );
}

function isSequentialTextEntryActRequest(request: Parameters<typeof browserAct>[1]): boolean {
  const kind = actKindOf(request);
  return (kind === "type" || kind === "fill") && targetPresent(request);
}

function targetPresent(request: Parameters<typeof browserAct>[1]): boolean {
  return (
    (typeof request.ref === "string" && request.ref.trim().length > 0) ||
    (typeof request.selector === "string" && request.selector.trim().length > 0)
  );
}

function invalidActRecoveryResult(params: {
  request: Parameters<typeof browserAct>[1];
  missing: string[];
  reason: string;
  profile?: string;
}) {
  const kind = actKindOf(params.request);
  const prefersFocusedForeground =
    kind === "type" || kind === "fill" || kind === "select";
  const prefersCatalogSurface =
    !prefersFocusedForeground && latestSnapshotLooksLikeResultsOrCatalogSurface(params.profile);
  return jsonResult({
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason: params.reason,
    snapshotRequest: prefersFocusedForeground
      ? {
          interactive: true,
          compact: true,
          refs: "aria",
          selector:
            "[aria-modal='true']:has(:focus), [role='dialog']:has(:focus), dialog:has(:focus), form:has(:focus), [contenteditable='true']:focus, textarea:focus, input:focus, [role='textbox']:focus, [role='combobox']:focus",
          ambiguous: false,
        }
      : prefersCatalogSurface
        ? catalogSurfaceObservationRequest()
      : {
          interactive: true,
          compact: true,
          refs: "aria",
          selector:
            "[aria-modal='true'], [role='dialog'], dialog, form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox']",
          ambiguous: false,
        },
    retryGuidance: prefersFocusedForeground
      ? "Capture a fresh focused foreground snapshot and continue only from the actual editable control refs produced by that observation."
      : prefersCatalogSurface
        ? "Capture a fresh interactive snapshot of the filter rail, sidebar, complementary region, or results container. If the desired control is off-screen, use scrollIntoView on a concrete ref from that new observation instead of a generic page scroll."
      : "Capture a fresh scoped interactive snapshot of the active surface and continue only from concrete refs produced by that observation.",
    retryContract: prefersFocusedForeground
      ? {
          requiresFocusedForegroundSnapshot: true,
          refOnly: true,
          disallowGenericPageActionsUntilRefs: true,
        }
      : prefersCatalogSurface
        ? {
            requiresScopedObservation: true,
            refOnly: true,
            preferScrollIntoView: true,
            disallowGenericPageActionsUntilRefs: true,
          }
      : {
          requiresScopedObservation: true,
          refOnly: true,
          disallowGenericPageActionsUntilRefs: true,
        },
    invalidRequest: {
      kind,
      missing: params.missing,
    },
  });
}

async function recoverInvalidCatalogActWithSnapshot(params: {
  request: Parameters<typeof browserAct>[1];
  missing: string[];
  reason: string;
  profile?: string;
  baseUrl?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown> | null> {
  const kind = actKindOf(params.request);
  if (!latestSnapshotLooksLikeResultsOrCatalogSurface(params.profile)) {
    return null;
  }
  if (kind !== "scroll") {
    return null;
  }
  const recovery = invalidActRecoveryResult({
    request: params.request,
    missing: params.missing,
    reason: params.reason,
    profile: params.profile,
  });
  const details =
    recovery.details && typeof recovery.details === "object" && !Array.isArray(recovery.details)
      ? (recovery.details as Record<string, unknown>)
      : null;
  const snapshotRequest =
    details?.snapshotRequest && typeof details.snapshotRequest === "object" && !Array.isArray(details.snapshotRequest)
      ? (details.snapshotRequest as Record<string, unknown>)
      : null;
  if (!snapshotRequest) {
    return null;
  }
  const preferredQueries = catalogScopedSnapshotQueries({
    targetId:
      (typeof snapshotRequest.targetId === "string" ? snapshotRequest.targetId.trim() : "") ||
      latestSnapshotTargetId(params.profile),
  });
  let recoveredDetails: Record<string, unknown> | null = null;
  let recoveredContent: AgentToolResult<unknown>["content"] | undefined;

  for (const query of preferredQueries) {
    const recovered = await executeSnapshotAction({
      input: query,
      baseUrl: params.baseUrl,
      profile: params.profile,
      proxyRequest: params.proxyRequest,
    }).catch(() => null);
    const details =
      recovered?.details && typeof recovered.details === "object" && !Array.isArray(recovered.details)
        ? (recovered.details as Record<string, unknown>)
        : null;
    if (details?.ok !== true) {
      continue;
    }
    if (snapshotCatalogRecoveryScore(details) <= 0) {
      continue;
    }
    recoveredDetails = details;
    recoveredContent = recovered?.content;
    if (!snapshotLooksLikeCatalogResultsSurface(details) && snapshotControlRefCount(details) > 0) {
      break;
    }
  }

  if (!recoveredDetails) {
    const recovered = await executeSnapshotAction({
      input: snapshotRequest,
      baseUrl: params.baseUrl,
      profile: params.profile,
      proxyRequest: params.proxyRequest,
    });
    recoveredDetails =
      recovered.details && typeof recovered.details === "object" && !Array.isArray(recovered.details)
        ? (recovered.details as Record<string, unknown>)
        : null;
    if (recoveredDetails?.ok !== true) {
      return null;
    }
    recoveredContent = recovered.content;
  }
  return {
    content: recoveredContent,
    details: {
      ok: true,
      autoRecoveredFromInvalidAct: true,
      requiresObservation: true,
      reason: params.reason,
      retryGuidance:
        "A scoped results/filter snapshot was recovered. Replan from those visible refs now and do not issue another generic page scroll.",
      retryContract: {
        refOnly: true,
        preferScrollIntoView: true,
        disallowGenericPageActionsUntilRefs: true,
      },
      recoveredFromInvalidAct: true,
      recoveredObservation: recoveredDetails,
      recoveryReason: params.reason,
      invalidRequest: {
        kind,
        missing: params.missing,
      },
    },
  };
}

function snapshotRecoveryResult(params: {
  selector?: string;
  reason: string;
  error?: unknown;
  ambiguous?: boolean;
  snapshotRequest?: Record<string, unknown>;
  retryGuidance?: string;
  retryContract?: Record<string, unknown>;
}) {
  return jsonResult({
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason: params.reason,
    snapshotRequest:
      params.snapshotRequest ?? {
        selector: params.selector,
        ambiguous: params.ambiguous ?? false,
      },
    retryGuidance: params.retryGuidance,
    retryContract: params.retryContract,
    error: params.error ? String(params.error) : undefined,
  });
}

function noRefGroundingRecovery() {
  return {
    snapshotRequest: catalogSurfaceObservationRequest(),
    retryGuidance:
      "Retry with a narrower structural observation of the filter rail, sidebar, complementary region, or results container. If the desired control is off-screen, use scrollIntoView on a concrete ref from that scoped snapshot instead of a generic page scroll.",
    retryContract: {
      requiresScopedObservation: true,
      refOnly: true,
      preferScrollIntoView: true,
      disallowGenericPageActionsUntilRefs: true,
    },
  };
}

function catalogSurfaceObservationRequest() {
  return {
    snapshotFormat: "aria" as const,
    interactive: true,
    compact: true,
    refs: "aria" as const,
    selector:
      "[aria-modal='true'], [role='dialog'], dialog, aside, [role='complementary'], [role='search'], form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter']",
    ambiguous: false,
  };
}

function catalogScopedSnapshotQueries(params: { targetId?: string }) {
  const base = {
    snapshotFormat: "aria" as const,
    interactive: true,
    compact: true,
    refs: "aria" as const,
    targetId: params.targetId,
  };
  return [
    {
      ...base,
      selector:
        "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], [role='group'], section, label, li",
    },
    {
      ...base,
      selector: "[role='search'], form, [role='list'], [role='grid'], [role='table'], [role='listbox']",
    },
    { ...base, selector: "[role='main'], main" },
  ];
}

function structuredSnapshotRecoveryQueries(params: {
  targetId?: string;
  format?: "ai" | "aria";
  profile?: string;
}) {
  const base = {
    targetId: params.targetId,
    format: params.format,
    interactive: true,
    compact: true,
    refs: "aria" as const,
  };
  return [
    {
      ...base,
      selector:
        "[aria-modal='true']:has(:focus), [role='dialog']:has(:focus), dialog:has(:focus), form:has(:focus), [contenteditable='true']:focus, textarea:focus, input:focus, [role='textbox']:focus, [role='combobox']:focus, [role='searchbox']:focus",
    },
    {
      ...base,
      selector:
        "aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], [role='search'], form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox']",
    },
    {
      ...base,
      selector:
        "[aria-modal='true'], [role='dialog'], dialog, form, [role='search'], [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox']",
    },
    {
      ...base,
      selector:
        "input, textarea, [role='searchbox'], [role='textbox'], [role='combobox'], form",
    },
  ];
}

function extractRecoveryResult(params: {
  selector?: string;
  reason: string;
  error?: unknown;
}) {
  return jsonResult({
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason: params.reason,
    extractRequest: {
      selector: params.selector,
      mode: "visible_text",
    },
    error: params.error ? String(params.error) : undefined,
  });
}

function actRecoveryResult(params: {
  request: Parameters<typeof browserAct>[1];
  reason: string;
  error?: unknown;
}) {
  const kind = actKindOf(params.request);
  const prefersFocusedForeground =
    kind === "type" || kind === "fill" || kind === "select";
  return jsonResult({
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason: params.reason,
    failedAction: {
      kind: actKindOf(params.request),
      ref: params.request.ref,
      selector: params.request.selector,
      targetId:
        typeof params.request.targetId === "string" ? params.request.targetId : undefined,
    },
    snapshotRequest: prefersFocusedForeground
      ? {
          interactive: true,
          compact: true,
          refs: "aria",
          selector:
            "[aria-modal='true']:has(:focus), [role='dialog']:has(:focus), dialog:has(:focus), form:has(:focus), [contenteditable='true']:focus, textarea:focus, input:focus, [role='textbox']:focus, [role='combobox']:focus",
        }
      : {
          interactive: true,
          compact: true,
          refs: "aria",
        },
    retryGuidance: prefersFocusedForeground
      ? "Recover by snapshotting the currently focused foreground surface first. Prefer a focused dialog, form, editor, or active input over a full-page body snapshot."
      : "Recover by taking a fresh compact interactive snapshot of the active foreground surface before retrying.",
    retryContract: prefersFocusedForeground
      ? {
          refOnly: true,
          requiresFocusedForegroundSnapshot: true,
        }
      : undefined,
    error: params.error ? String(params.error) : undefined,
  });
}

function isStrictModeSnapshotError(err: unknown): boolean {
  const text = String(err || "");
  return text.includes("strict mode violation") && text.includes("ariaSnapshot");
}

function isRecoverableSnapshotTimeoutError(err: unknown): boolean {
  const text = String(err || "").toLowerCase();
  return (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("waiting for locator") ||
    text.includes("browserserviceerror")
  );
}

function isRecoverableDynamicFormActError(
  request: Parameters<typeof browserAct>[1],
  err: unknown,
): boolean {
  const kind = actKindOf(request);
  if (!new Set(["click", "type", "fill", "select"]).has(kind)) {
    return false;
  }
  const text = String(err || "").toLowerCase();
  return (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("not found or not visible") ||
    text.includes("strict mode violation") ||
    (text.includes("matched") && text.includes("elements")) ||
    text.includes("element is not attached") ||
    text.includes("element is outside of the viewport") ||
    text.includes("element is not editable") ||
    text.includes("waiting for locator")
  );
}

function dynamicFormActRecoveryReason(request: Parameters<typeof browserAct>[1]): string {
  const kind = actKindOf(request);
  if (kind === "type" || kind === "fill" || kind === "select") {
    return "The browser action could not reliably reach the active editable control after the UI changed or the current ref became ambiguous. Capture a fresh snapshot of the active foreground form, dialog, drawer, popup, or editor, then target the actual textbox, combobox, textarea, or select control instead of a container element. Do not fall back to broad selectors such as body, button, or generic role-button containers while a foreground surface is already open.";
  }
  return "The browser action could not reliably reach the active target after the UI changed or the current ref became ambiguous. Capture a fresh snapshot of the active foreground form, dialog, drawer, popup, or editor, then continue from that surface with fresh refs. Do not broaden back to body-level or generic button snapshots while the foreground surface is still visible.";
}

function validateActRequest(
  request: Parameters<typeof browserAct>[1],
  profile?: string,
): { ok: true } | { ok: false; missing: string[]; reason: string } {
  const kind = actKindOf(request);
  const missing: string[] = [];
  const hasRef = typeof request.ref === "string" && request.ref.trim().length > 0;
  const hasSelector =
    typeof request.selector === "string" && request.selector.trim().length > 0;
  switch (kind) {
    case "click":
      if (!targetPresent(request)) {
        missing.push("ref|selector");
      }
      break;
    case "hover":
    case "scrollIntoView":
      if (!targetPresent(request)) {
        missing.push("ref|selector");
      }
      break;
    case "type":
    case "select":
      if (!(hasRef || hasSelector)) {
        missing.push("ref|selector");
      }
      break;
    case "drag":
      if (!(typeof request.startRef === "string" && request.startRef.trim())) {
        missing.push("startRef");
      }
      if (!(typeof request.endRef === "string" && request.endRef.trim())) {
        missing.push("endRef");
      }
      break;
    case "fill":
      if (!Array.isArray(request.fields) || request.fields.length === 0) {
        missing.push("fields");
      }
      break;
    case "resize":
      if (!(typeof request.width === "number" && Number.isFinite(request.width))) {
        missing.push("width");
      }
      if (!(typeof request.height === "number" && Number.isFinite(request.height))) {
        missing.push("height");
      }
      break;
    case "press":
      if (!(typeof request.key === "string" && request.key.trim())) {
        missing.push("key");
      }
      break;
    default:
      break;
  }
  if (kind === "type" && typeof request.text !== "string") {
    missing.push("text");
  }
  if (kind === "select" && (!Array.isArray(request.values) || request.values.length === 0)) {
    missing.push("values");
  }
  if ((kind === "click" || kind === "type" || kind === "select") && !hasRef && hasSelector) {
    return {
      ok: false,
      missing: ["ref"],
      reason:
        `Mutating browser actions must use a ref from the latest interactive snapshot. Capture a fresh focused foreground snapshot and retry with a concrete ref instead of a selector or generic page target.${namedEditableRefGuidance(profile, request)}`,
    };
  }
  if (
    (kind === "click" ||
      kind === "hover" ||
      kind === "scrollIntoView" ||
      kind === "type" ||
      kind === "select") &&
    !hasRef &&
    latestSnapshotHasActionableRefs(profile, request)
  ) {
    return {
      ok: false,
      missing: ["ref"],
      reason:
        `The latest interactive snapshot already exposes actionable refs for this surface. Do not use a text-only, targetId-only, or generic page-level browser action here. Capture a fresh focused snapshot if needed and continue only with a concrete ref from that observation.${namedEditableRefGuidance(profile, request)}`,
    };
  }
  const groundedRefValidation = validateGroundedRefSpecificity(request, profile);
  if (!groundedRefValidation.ok) {
    return groundedRefValidation;
  }
  if (kind === "scroll" && hasRef) {
    return {
      ok: false,
      missing: ["kind"],
      reason:
        "Ref-based scrolling must use scrollIntoView on a concrete ref from the latest snapshot. Do not combine a ref with generic scroll coordinates on a ref-rich surface.",
    };
  }
  if (kind === "scroll" && !hasRef && latestSnapshotHasActionableRefs(profile, request)) {
    return {
      ok: false,
      missing: ["ref"],
      reason:
        "When the latest snapshot already exposes actionable refs, do not use a generic page-level scroll. Choose a concrete ref-backed target from the latest snapshot or capture a fresh observation if the target is no longer visible.",
    };
  }
  if (kind === "evaluate" && latestSnapshotHasActionableRefs(profile, request)) {
    return {
      ok: false,
      missing: ["ref"],
      reason:
        "When the latest snapshot already exposes actionable refs, do not use generic browser evaluate recovery. Choose a concrete ref-backed target from the latest snapshot or capture a fresh scoped observation if the target is no longer visible.",
    };
  }
  if (
    kind === "type" &&
    hasRef &&
    latestSnapshotLooksLikeResultsOrCatalogSurface(profile) &&
    !latestSnapshotHasRichEditableSurface(profile, request) &&
    typeof request.text === "string" &&
    request.text.trim().length > 0
  ) {
    const refRecord = latestSnapshotRefRecord(profile, request);
    const role = String(refRecord?.role || "").trim().toLowerCase();
    const name = String(refRecord?.name || "").trim().toLowerCase();
    const text = request.text.trim().toLowerCase();
    const likelySearchField =
      EDITABLE_ROLES.has(role) && (name.includes("search") || name.includes("search for"));
    if (!likelySearchField && text.length <= 40) {
      return {
        ok: false,
        missing: ["ref"],
        reason:
          "The latest snapshot already exposes a ref-rich results surface. Do not keep typing a short query into a generic field. Choose a concrete result, filter, or CTA ref from the latest snapshot, or capture a fresh focused search-field snapshot if the search control is truly the next target.",
      };
    }
  }
  if (kind === "fill" && Array.isArray(request.fields)) {
    const missingFieldRef = request.fields.some((field) => {
      const record = field as Record<string, unknown>;
      return !(typeof record.ref === "string" && record.ref.trim().length > 0);
    });
    if (missingFieldRef) {
      return {
        ok: false,
        missing: ["fields[].ref"],
        reason:
          "Form filling inside a dynamic form or focused foreground surface must use field refs from the latest interactive snapshot. Capture a fresh focused foreground snapshot and retry with field refs instead of selector-like field targets.",
      };
    }
  }
  if (shouldRejectRepeatedTextEntry(request, profile)) {
    return {
      ok: false,
      missing: ["ref"],
      reason:
        "The same text entry was just attempted on this live surface. Capture a fresh snapshot and choose the next unresolved editable control instead of re-entering the same value into the same field.",
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason:
        "The browser action request was incomplete for the current UI state. Capture a fresh snapshot and choose a fully specified action.",
    };
  }
  return { ok: true };
}

async function executeSingleActAction(params: {
  request: Parameters<typeof browserAct>[1];
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<unknown> {
  const { request, baseUrl, profile, proxyRequest } = params;
  const groundedRequest = withLatestGroundedTargetId(request, profile);
  return proxyRequest
    ? await proxyRequest({
        method: "POST",
        path: "/act",
        profile,
        body: groundedRequest,
      })
    : await browserAct(baseUrl, groundedRequest, {
        profile,
      });
}

export async function executeTabsAction(params: {
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { baseUrl, profile, proxyRequest } = params;
  if (proxyRequest) {
    const result = await proxyRequest({
      method: "GET",
      path: "/tabs",
      profile,
    });
    const tabs = (result as { tabs?: unknown[] }).tabs ?? [];
    return formatTabsToolResult(tabs);
  }
  const tabs = await browserTabs(baseUrl, { profile });
  return formatTabsToolResult(tabs);
}

export async function executeSnapshotAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const snapshotDefaults = loadBrowserConfig().browser?.snapshotDefaults;
  const selector = typeof input.selector === "string" ? input.selector.trim() : undefined;
  const frame = typeof input.frame === "string" ? input.frame.trim() : undefined;
  const interactive = typeof input.interactive === "boolean" ? input.interactive : true;
  const format: "ai" | "aria" | undefined =
    input.snapshotFormat === "ai" || input.snapshotFormat === "aria"
      ? input.snapshotFormat
      : interactive
        ? "aria"
        : undefined;
  const mode: "efficient" | undefined =
    input.mode === "efficient"
      ? "efficient"
      : format !== "aria" && snapshotDefaults?.mode === "efficient"
        ? "efficient"
        : undefined;
  const labelsRequested = typeof input.labels === "boolean" ? input.labels : undefined;
  // The embedded browser runtime currently uses Playwright CDP attachment, where
  // the optional DOM label overlay path is less stable than the snapshot path itself.
  // Keep snapshots available by degrading label requests to plain snapshots.
  const labels = false;
  const refs: "aria" | "role" | undefined =
    input.refs === "aria" || input.refs === "role"
      ? input.refs
      : interactive
          ? "aria"
          : undefined;
  const hasMaxChars = Object.hasOwn(input, "maxChars");
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : undefined;
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
  const maxChars =
    typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars > 0
      ? Math.floor(input.maxChars)
      : undefined;
  const compact = typeof input.compact === "boolean" ? input.compact : interactive ? true : undefined;
  const depth =
    typeof input.depth === "number" && Number.isFinite(input.depth) ? input.depth : undefined;
  const resolvedMaxChars =
    format === "ai"
      ? hasMaxChars
        ? maxChars
        : mode === "efficient"
          ? undefined
          : DEFAULT_AI_SNAPSHOT_MAX_CHARS
      : hasMaxChars
        ? maxChars
        : undefined;
  const snapshotQuery = {
    ...(format ? { format } : {}),
    targetId,
    limit,
    ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
    refs,
    interactive,
    compact,
    depth,
    selector,
    frame,
    labels,
    mode,
  };
  let snapshot: Awaited<ReturnType<typeof browserSnapshot>>;
  try {
    snapshot = proxyRequest
      ? ((await proxyRequest({
          method: "GET",
          path: "/snapshot",
          profile,
          query: snapshotQuery,
        })) as Awaited<ReturnType<typeof browserSnapshot>>)
      : await browserSnapshot(baseUrl, {
          ...snapshotQuery,
          snapshotFormat: format,
          profile,
        });
  } catch (err) {
    if (frame && isRecoverableSnapshotTimeoutError(err)) {
      return snapshotRecoveryResult({
        selector,
        error: err,
        reason:
          "The frame-scoped snapshot timed out before it could confirm the active target. Return to the main document and capture a fresh snapshot of the active foreground form, dialog, drawer, popup, sheet, or editor first. Only switch into a frame after a fresh observation explicitly shows the relevant interactive controls inside that frame.",
      });
    }
    if (selector && isStrictModeSnapshotError(err)) {
      return snapshotRecoveryResult({
        selector,
        ambiguous: true,
        error: err,
        reason:
          "The snapshot selector matched too many elements to observe safely. Capture a more specific snapshot of the active foreground surface, such as the visible dialog, composer, drawer, popup, or focused form, instead of a broad selector.",
      });
    }
    if (selector) {
      return snapshotRecoveryResult({
        selector,
        error: err,
        reason:
          "The scoped snapshot failed for the current UI. Capture a fresh snapshot of the active foreground surface and choose a narrower, more specific selector before acting.",
      });
    }
    if (isRecoverableSnapshotTimeoutError(err)) {
      return snapshotRecoveryResult({
        error: err,
        reason:
          "The browser snapshot timed out before stable refs could be produced. Capture a fresh snapshot of the active foreground form, dialog, drawer, popup, sheet, or editor first, and only broaden to the full page if no clear foreground surface exists.",
      });
    }
    throw err;
  }
  let refCount = countSnapshotRefs(snapshot as unknown as Record<string, unknown>);
  let nodeCount = countSnapshotNodes(snapshot as unknown as Record<string, unknown>);
  if (isScopedInteractiveSnapshot({ interactive, selector, frame }) && refCount === 0 && nodeCount === 0) {
    const targetId = typeof snapshot.targetId === "string" ? snapshot.targetId.trim() : undefined;
    for (const retryQuery of catalogScopedSnapshotQueries({ targetId })) {
      try {
        const retried = proxyRequest
          ? ((await proxyRequest({
              method: "GET",
              path: "/snapshot",
              profile,
              query: retryQuery,
            })) as Awaited<ReturnType<typeof browserSnapshot>>)
          : await browserSnapshot(baseUrl, {
              ...retryQuery,
              snapshotFormat:
                retryQuery.snapshotFormat === "ai" || retryQuery.snapshotFormat === "aria"
                  ? retryQuery.snapshotFormat
                  : undefined,
              profile,
            });
        const retriedRefCount = countSnapshotRefs(retried as unknown as Record<string, unknown>);
        const retriedNodeCount = countSnapshotNodes(retried as unknown as Record<string, unknown>);
        if (retriedRefCount > 0 || retriedNodeCount > 0) {
          snapshot = retried;
          refCount = retriedRefCount;
          nodeCount = retriedNodeCount;
          break;
        }
      } catch {
        // Try the next structural selector probe.
      }
    }
  }
  if (interactive && !selector && !frame && refCount > 0 && snapshotLooksLikeCatalogResultsSurface(snapshot as unknown as Record<string, unknown>)) {
    const baselineRecord = snapshot as unknown as Record<string, unknown>;
    const baselineControlCount = snapshotControlRefCount(baselineRecord);
    const baselineNamedCandidateCount = snapshotNamedCatalogCandidateCount(baselineRecord);
    for (const retryQuery of catalogScopedSnapshotQueries({ targetId })) {
      try {
        const retried = proxyRequest
          ? ((await proxyRequest({
              method: "GET",
              path: "/snapshot",
              profile,
              query: retryQuery,
            })) as Awaited<ReturnType<typeof browserSnapshot>>)
          : await browserSnapshot(baseUrl, {
              ...retryQuery,
              snapshotFormat:
                retryQuery.snapshotFormat === "ai" || retryQuery.snapshotFormat === "aria"
                  ? retryQuery.snapshotFormat
                  : undefined,
              profile,
            });
        const retriedRecord = retried as unknown as Record<string, unknown>;
        const retriedRefCount = countSnapshotRefs(retriedRecord);
        const retriedNodeCount = countSnapshotNodes(retriedRecord);
        const retriedControlCount = snapshotControlRefCount(retriedRecord);
        const retriedNamedCandidateCount = snapshotNamedCatalogCandidateCount(retriedRecord);
        if (
          retriedRefCount > 0 &&
          (retriedControlCount > baselineControlCount ||
            retriedNamedCandidateCount > baselineNamedCandidateCount ||
            snapshotLooksLikeCatalogControlSurface(retriedRecord) ||
            (retriedNodeCount > 0 && snapshotLooksLikeCatalogResultsSurface(baselineRecord) && !snapshotLooksLikeCatalogResultsSurface(retriedRecord)))
        ) {
          snapshot = retried;
          refCount = retriedRefCount;
          nodeCount = retriedNodeCount;
          break;
        }
      } catch {
        // Continue through structural catalog probes until one yields better grounded controls.
      }
    }
  }
  if (interactive && !selector && !frame && refCount === 0) {
    for (const retryQuery of structuredSnapshotRecoveryQueries({ targetId, format })) {
      try {
        const retried = proxyRequest
          ? ((await proxyRequest({
              method: "GET",
              path: "/snapshot",
              profile,
              query: retryQuery,
            })) as Awaited<ReturnType<typeof browserSnapshot>>)
          : await browserSnapshot(baseUrl, {
              ...retryQuery,
              snapshotFormat:
                retryQuery.format === "ai" || retryQuery.format === "aria"
                  ? retryQuery.format
                  : undefined,
              profile,
            });
        const retriedRefCount = countSnapshotRefs(retried as unknown as Record<string, unknown>);
        const retriedNodeCount = countSnapshotNodes(retried as unknown as Record<string, unknown>);
        if (retriedRefCount > 0) {
          snapshot = retried;
          refCount = retriedRefCount;
          nodeCount = retriedNodeCount;
          break;
        }
      } catch {
        // Fall through to the next structural retry and then the recoverable error.
      }
    }
  }
  if (interactive && !selector && !frame && refCount === 0) {
    return snapshotRecoveryResult({
      reason:
        "The interactive snapshot did not expose any actionable refs. Narrow the observation to the active surface or result region before acting, and do not continue with generic page-level scroll or click recovery from this snapshot.",
      ...noRefGroundingRecovery(),
    });
  }
  if (snapshot.format === "ai") {
    rememberSnapshotGrounding(profile, snapshot);
    const extractedText = snapshot.snapshot ?? "";
    const wrappedSnapshot = wrapExternalContent(extractedText, {
      source: "browser",
      includeWarning: true,
    });
    const safeDetails = {
      ok: true,
      format: snapshot.format,
      targetId: snapshot.targetId,
      url: snapshot.url,
      truncated: snapshot.truncated,
      stats: snapshot.stats,
      nodeCount,
      refs: snapshot.refs,
      refCount: refCount || undefined,
      labels: snapshot.labels,
      labelsCount: snapshot.labelsCount,
      labelsSkipped: snapshot.labelsSkipped,
      imagePath: snapshot.imagePath,
      imageType: snapshot.imageType,
      labelsRequested,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: "snapshot",
        format: "ai",
        wrapped: true,
      },
    };
    if (labelsRequested && snapshot.imagePath) {
      return await imageResultFromFile({
        label: "browser:snapshot",
        path: snapshot.imagePath,
        extraText: wrappedSnapshot,
        details: safeDetails,
      });
    }
    return {
      content: [{ type: "text" as const, text: wrappedSnapshot }],
      details: safeDetails,
    };
  }
  {
    rememberSnapshotGrounding(profile, snapshot);
    const wrappedSnapshot = wrapExternalContent(String(snapshot.snapshot ?? ""), {
      source: "browser",
      includeWarning: true,
    });
    return {
      content: [{ type: "text" as const, text: wrappedSnapshot }],
      details: {
        ok: true,
        format: "aria",
        targetId: snapshot.targetId,
        url: snapshot.url,
        truncated: snapshot.truncated,
        stats: snapshot.stats,
        nodeCount,
        refs: snapshot.refs,
        refCount: refCount || undefined,
        labels: snapshot.labels,
        labelsCount: snapshot.labelsCount,
        labelsSkipped: snapshot.labelsSkipped,
        imagePath: snapshot.imagePath,
        imageType: snapshot.imageType,
        labelsRequested,
        externalContent: {
          untrusted: true,
          source: "browser",
          kind: "snapshot",
          format: "aria",
          wrapped: true,
        },
      },
    };
  }
}

export async function executeExtractAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const selector = typeof input.selector === "string" ? input.selector.trim() : undefined;
  const frame = typeof input.frame === "string" ? input.frame.trim() : undefined;
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : undefined;
  const maxChars =
    typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars > 0
      ? Math.floor(input.maxChars)
      : 8_000;

  let snapshot: Awaited<ReturnType<typeof browserSnapshot>>;
  try {
  const snapshotQuery = {
      format: "ai" as const,
      targetId,
      selector,
      frame,
      maxChars,
      compact: false,
    };
    snapshot = proxyRequest
      ? ((await proxyRequest({
          method: "GET",
          path: "/snapshot",
          profile,
          query: snapshotQuery,
        })) as Awaited<ReturnType<typeof browserSnapshot>>)
      : await browserSnapshot(baseUrl, {
          ...snapshotQuery,
          snapshotFormat: "ai",
          profile,
        });
  } catch (err) {
    if (selector && isStrictModeSnapshotError(err)) {
      return extractRecoveryResult({
        selector,
        error: err,
        reason:
          "The extraction selector matched too many elements to read safely. Capture a more specific foreground surface first, then extract from that surface.",
      });
    }
    if (isRecoverableSnapshotTimeoutError(err)) {
      return extractRecoveryResult({
        selector,
        error: err,
        reason:
          "The browser extraction timed out before stable visible text could be recovered. Re-observe the active foreground surface first, then retry extraction from that narrower surface.",
      });
    }
    throw err;
  }

  const extractedText = typeof snapshot.snapshot === "string" ? snapshot.snapshot.trim() : "";
  if (!extractedText) {
    return extractRecoveryResult({
      selector,
      reason:
        "No visible text was recovered from the current surface. Capture a fresh snapshot of the active foreground surface or choose a narrower selector before retrying extraction.",
    });
  }
  const wrappedText = wrapExternalContent(extractedText, {
    source: "browser",
    includeWarning: true,
  });
  return {
    content: [{ type: "text" as const, text: wrappedText }],
    details: {
      ok: true,
      mode: "visible_text",
      format: "ai",
      targetId: snapshot.targetId,
      url: snapshot.url,
      extractedText,
      truncated: snapshot.truncated,
      stats: snapshot.stats,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: "extract",
        wrapped: true,
      },
    },
  };
}

export async function executeConsoleAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const level = typeof input.level === "string" ? input.level.trim() : undefined;
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : undefined;
  if (proxyRequest) {
    const result = (await proxyRequest({
      method: "GET",
      path: "/console",
      profile,
      query: {
        level,
        targetId,
      },
    })) as { ok?: boolean; targetId?: string; messages?: unknown[] };
    const wrapped = wrapBrowserExternalJson({
      kind: "console",
      payload: result,
      includeWarning: false,
    });
    return {
      content: [{ type: "text" as const, text: wrapped.wrappedText }],
      details: {
        ...wrapped.safeDetails,
        targetId: typeof result.targetId === "string" ? result.targetId : undefined,
        messageCount: Array.isArray(result.messages) ? result.messages.length : undefined,
      },
    };
  }
  const result = await browserConsoleMessages(baseUrl, { level, targetId, profile });
  const wrapped = wrapBrowserExternalJson({
    kind: "console",
    payload: result,
    includeWarning: false,
  });
  return {
    content: [{ type: "text" as const, text: wrapped.wrappedText }],
    details: {
      ...wrapped.safeDetails,
      targetId: result.targetId,
      messageCount: result.messages.length,
    },
  };
}

export async function executeActAction(params: {
  request: Parameters<typeof browserAct>[1] | Parameters<typeof browserAct>[1][];
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { request, baseUrl, profile, proxyRequest } = params;
  if (Array.isArray(request)) {
    const results: unknown[] = [];
    for (let index = 0; index < request.length; index += 1) {
      const step = request[index];
      const validation = validateActRequest(step, profile);
      if (!validation.ok) {
        return invalidActRecoveryResult({
          request: step,
          missing: validation.missing,
          reason: validation.reason,
          profile,
        });
      }
      let result: unknown;
      try {
        result = await executeSingleActAction({
          request: step,
          baseUrl,
          profile,
          proxyRequest,
        });
      } catch (err) {
        if (isRecoverableDynamicFormActError(step, err)) {
          return actRecoveryResult({
            request: step,
            error: err,
            reason: dynamicFormActRecoveryReason(step),
          });
        }
        throw err;
      }
      results.push(result);
      rememberExecutedTextEntry(step, profile);
      if (
        index < request.length - 1 &&
        isMutatingActRequest(step) &&
        !isSequentialTextEntryActRequest(step)
      ) {
        return jsonResult({
          ok: true,
          partial: true,
          requiresObservation: true,
          reason: "A mutating browser action changed the UI. Capture a fresh snapshot before continuing.",
          executed: results.length,
          stoppedAfterKind: actKindOf(step),
          results,
        });
      }
    }
    return jsonResult({
      ok: true,
      batched: true,
      executed: results.length,
      results,
    });
  }
  const validation = validateActRequest(request, profile);
  if (!validation.ok) {
    const recovered = await recoverInvalidCatalogActWithSnapshot({
      request,
      missing: validation.missing,
      reason: validation.reason,
      profile,
      baseUrl,
      proxyRequest,
    });
    if (recovered) {
      return recovered;
    }
    return invalidActRecoveryResult({
      request,
      missing: validation.missing,
      reason: validation.reason,
      profile,
    });
  }
  try {
    const result = await executeSingleActAction({
      request,
      baseUrl,
      profile,
      proxyRequest,
    });
    rememberExecutedTextEntry(request, profile);
    return jsonResult(result);
  } catch (err) {
    if (isRecoverableDynamicFormActError(request, err)) {
      return actRecoveryResult({
        request,
        error: err,
        reason: dynamicFormActRecoveryReason(request),
      });
    }
    if (isChromeStaleTargetError(profile, err)) {
      const retryRequest = stripTargetIdFromActRequest(request);
      const tabs = proxyRequest
        ? ((
            (await proxyRequest({
              method: "GET",
              path: "/tabs",
              profile,
            })) as { tabs?: unknown[] }
          ).tabs ?? [])
        : await browserTabs(baseUrl, { profile }).catch(() => []);
      // Some Chrome relay targetIds can go stale between snapshots and actions.
      // Only retry safe read-only actions, and only when exactly one tab remains attached.
      if (retryRequest && canRetryChromeActWithoutTargetId(request) && tabs.length === 1) {
        try {
          const retryResult = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/act",
                profile,
                body: retryRequest,
              })
            : await browserAct(baseUrl, retryRequest, {
                profile,
              });
          return jsonResult(retryResult);
        } catch {
          // Fall through to explicit stale-target guidance.
        }
      }
      if (!tabs.length) {
        throw new Error(
          "No Chrome tabs are attached via the Runtime Browser Relay extension. Click the toolbar icon on the tab you want to control (badge ON), then retry.",
          { cause: err },
        );
      }
      throw new Error(
        `Chrome tab not found (stale targetId?). Run action=tabs profile="chrome" and use one of the returned targetIds.`,
        { cause: err },
      );
    }
    throw err;
  }
}
