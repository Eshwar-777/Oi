type RuntimeSummary = {
  sawToolEvent: boolean;
  sawBrowserToolEvent: boolean;
  sawToolError: boolean;
  sawAssistantText: boolean;
  assistantText: string;
  lifecyclePhase: string;
  toolNames: string[];
  browserOperations: string[];
  sawMutatingBrowserAction: boolean;
};

type TranscriptSummary = {
  toolCalls: number;
  browserToolCalls: number;
  browserMutatingToolCalls: number;
  browserExtractToolCalls: number;
  toolResults: number;
  toolErrors: number;
  browserSuccessfulMutationResults: number;
  browserSuccessfulExtractResults: number;
  browserRecoverableFailures: number;
  browserTerminalFailures: number;
  assistantText: string;
};

export type BridgeOutcomeInput = {
  requestText: string;
  payloadText: string;
  assistantOutcomeText: string;
  stopReason: string;
  transcriptSummary: TranscriptSummary;
  runtimeSummary: RuntimeSummary;
  failedPayloadPresent: boolean;
  resultMetaErrorPresent: boolean;
  terminalFailureDetected: boolean;
};

export type BridgeOutcomeDecision = {
  browserEngaged: boolean;
  browserTaskSucceeded: boolean;
  browserBoundaryStopSucceeded: boolean;
  browserBlockedResponse: boolean;
  browserNotEngaged: boolean;
  assistantOnlyResponse: boolean;
  browserObservationOnlyResponse: boolean;
  success: boolean;
  terminalCode: string;
};

function normalizeText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function requestAllowsBoundaryStop(requestText: string): boolean {
  const text = normalizeText(requestText);
  if (!text) {
    return false;
  }
  const explicitStopMarkers = [
    "until a critical step",
    "until critical step",
    "stop at a critical step",
    "stop at critical step",
    "stop before payment",
    "stop before final confirmation",
    "stop before confirming",
    "stop before placing the order",
    "stop at checkout",
    "stop at login",
    "proceed until a critical step",
    "proceed until critical step",
    "report the stopping point",
    "stopping point",
    "proceed until the next step requires",
    "until the next step requires",
    "until login",
    "until payment",
    "until address",
    "until final confirmation",
    "until confirmation",
    "until human intervention",
  ];
  return explicitStopMarkers.some((marker) => text.includes(marker));
}

function looksLikeDeliberateBoundaryStop(value: string): boolean {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  const stopMarkers = [
    "critical step",
    "must stop",
    "i have stopped",
    "stopped at",
    "stopped here",
    "human intervention",
    "requires human intervention",
    "requires user intervention",
    "cannot proceed with",
    "cannot continue with",
    "i cannot proceed",
    "i cannot continue",
  ];
  const boundaryMarkers = [
    "login",
    "sign in",
    "payment",
    "address",
    "confirmation",
    "confirm",
    "otp",
    "captcha",
    "verification",
    "permission",
    "approval",
  ];
  const hasStopMarker = stopMarkers.some((marker) => text.includes(marker));
  const hasBoundaryMarker = boundaryMarkers.some((marker) => text.includes(marker));
  return text.includes("critical step") || (hasStopMarker && hasBoundaryMarker);
}

function looksLikeExplicitExecutionBlock(value: string): boolean {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  const blockMarkers = [
    "i am blocked",
    "i'm blocked",
    "unable to complete",
    "cannot complete",
    "can't complete",
    "cannot programmatically interact",
    "unable to interact",
    "unable to locate",
    "could not locate",
    "couldn't locate",
    "cannot locate",
    "not able to locate",
    "preventing me from",
    "failed to",
  ];
  return blockMarkers.some((marker) => text.includes(marker));
}

function looksLikeExplicitTerminalSuccess(value: string): boolean {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  const successMarkers = [
    "message sent",
    "sent successfully",
    "successfully sent",
    "email has been sent",
    "email sent",
    "submitted successfully",
    "successfully submitted",
    "posted successfully",
    "successfully posted",
    "saved successfully",
    "successfully saved",
    "completed successfully",
    "successfully completed",
  ];
  return successMarkers.some((marker) => text.includes(marker));
}

export function classifyBridgeOutcome(input: BridgeOutcomeInput): BridgeOutcomeDecision {
  const browserEngaged =
    input.transcriptSummary.browserToolCalls > 0 || input.runtimeSummary.sawBrowserToolEvent;
  const explicitExecutionBlock =
    looksLikeExplicitExecutionBlock(input.assistantOutcomeText || input.payloadText);
  const explicitTerminalSuccess =
    browserEngaged &&
    looksLikeExplicitTerminalSuccess(
      [input.assistantOutcomeText, input.payloadText].filter(Boolean).join("\n\n"),
    );
  const assistantOnlyResponse =
    !browserEngaged &&
    input.transcriptSummary.toolCalls === 0 &&
    Boolean(input.assistantOutcomeText) &&
    !input.failedPayloadPresent &&
    !input.resultMetaErrorPresent &&
    input.stopReason !== "error";
  const browserObservationOnlyResponse =
    browserEngaged &&
    Boolean(input.assistantOutcomeText) &&
    input.transcriptSummary.browserMutatingToolCalls === 0 &&
    !input.failedPayloadPresent &&
    !input.resultMetaErrorPresent &&
    input.stopReason !== "error";
  const browserBlockedResponse =
    browserEngaged &&
    Boolean(input.assistantOutcomeText) &&
    !input.failedPayloadPresent &&
    (
      (looksLikeDeliberateBoundaryStop(input.assistantOutcomeText) &&
        !requestAllowsBoundaryStop(input.requestText))
      || explicitExecutionBlock
    );
  const browserBoundaryStopSucceeded =
    browserEngaged &&
    requestAllowsBoundaryStop(input.requestText) &&
    looksLikeDeliberateBoundaryStop(input.assistantOutcomeText || input.payloadText) &&
    (input.transcriptSummary.browserSuccessfulMutationResults > 0 ||
      input.transcriptSummary.browserSuccessfulExtractResults > 0) &&
    !input.runtimeSummary.sawToolError &&
    !input.failedPayloadPresent &&
    !input.resultMetaErrorPresent &&
    input.stopReason !== "error";
  const browserTaskSucceeded =
    browserEngaged &&
    !browserBlockedResponse &&
    !browserBoundaryStopSucceeded &&
    !explicitExecutionBlock &&
    input.stopReason !== "error" &&
    (
      explicitTerminalSuccess
        ? input.transcriptSummary.browserSuccessfulMutationResults > 0 ||
          input.transcriptSummary.browserSuccessfulExtractResults > 0
        : Boolean(input.payloadText) &&
          (input.transcriptSummary.browserSuccessfulMutationResults > 0 ||
            input.transcriptSummary.browserSuccessfulExtractResults > 0) &&
          !input.terminalFailureDetected &&
          !input.runtimeSummary.sawToolError &&
          !input.failedPayloadPresent &&
          !input.resultMetaErrorPresent &&
          input.stopReason !== "tool_calls"
    );
  const browserNotEngaged =
    !browserEngaged &&
    !input.failedPayloadPresent &&
    !input.resultMetaErrorPresent &&
    input.stopReason !== "error";
  const success = browserTaskSucceeded || browserBoundaryStopSucceeded;
  const terminalCode = success
    ? "COMPLETED"
    : input.terminalFailureDetected
      ? "EXECUTION_FAILED"
      : explicitExecutionBlock
        ? "EXECUTION_FAILED"
      : browserBlockedResponse
        ? "HUMAN_REQUIRED"
        : browserNotEngaged
          ? "BROWSER_NOT_ENGAGED"
          : browserEngaged
            ? "BROWSER_ACTION_FAILED"
            : assistantOnlyResponse || browserObservationOnlyResponse
              ? "HUMAN_REQUIRED"
              : "EXECUTION_FAILED";
  return {
    browserEngaged,
    browserTaskSucceeded,
    browserBoundaryStopSucceeded,
    browserBlockedResponse,
    browserNotEngaged,
    assistantOnlyResponse,
    browserObservationOnlyResponse,
    success,
    terminalCode,
  };
}
