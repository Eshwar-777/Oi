import test from "node:test";
import assert from "node:assert/strict";

import { classifyBridgeOutcome } from "./runtime-bridge-outcome.js";

test("classifyBridgeOutcome treats requested human-boundary stop as completed", () => {
  const outcome = classifyBridgeOutcome({
    requestText:
      "Find a maroon men's shirt on Myntra under ₹1000 in size M, add it to cart, proceed to checkout until a critical step, and report product details and the stopping point.",
    payloadText:
      "I have clicked the \"PLACE ORDER\" button. The next step would typically involve entering delivery address and payment information. This is the critical step where I must stop.",
    assistantOutcomeText:
      "I have clicked the \"PLACE ORDER\" button. The next step would typically involve entering delivery address and payment information. This is the critical step where I must stop.",
    stopReason: "stop",
    transcriptSummary: {
      toolCalls: 8,
      browserToolCalls: 8,
      browserMutatingToolCalls: 4,
      browserExtractToolCalls: 0,
      toolResults: 8,
      toolErrors: 0,
      browserSuccessfulMutationResults: 3,
      browserSuccessfulExtractResults: 0,
      browserRecoverableFailures: 0,
      browserTerminalFailures: 0,
      assistantText:
        "I have clicked the \"PLACE ORDER\" button. The next step would typically involve entering delivery address and payment information. This is the critical step where I must stop.",
    },
    runtimeSummary: {
      sawToolEvent: true,
      sawBrowserToolEvent: true,
      sawToolError: false,
      sawAssistantText: true,
      assistantText:
        "I have clicked the \"PLACE ORDER\" button. The next step would typically involve entering delivery address and payment information. This is the critical step where I must stop.",
      lifecyclePhase: "end",
      toolNames: ["browser"],
      browserOperations: ["snapshot", "click"],
      sawMutatingBrowserAction: true,
    },
    failedPayloadPresent: false,
    resultMetaErrorPresent: false,
    terminalFailureDetected: true,
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.browserBoundaryStopSucceeded, true);
  assert.equal(outcome.terminalCode, "COMPLETED");
});

test("classifyBridgeOutcome keeps unrequested browser blockage as non-success", () => {
  const outcome = classifyBridgeOutcome({
    requestText: "Send an email now.",
    payloadText: "",
    assistantOutcomeText: "I must stop because login is required before I can continue.",
    stopReason: "stop",
    transcriptSummary: {
      toolCalls: 2,
      browserToolCalls: 2,
      browserMutatingToolCalls: 1,
      browserExtractToolCalls: 0,
      toolResults: 2,
      toolErrors: 0,
      browserSuccessfulMutationResults: 1,
      browserSuccessfulExtractResults: 0,
      browserRecoverableFailures: 0,
      browserTerminalFailures: 0,
      assistantText: "I must stop because login is required before I can continue.",
    },
    runtimeSummary: {
      sawToolEvent: true,
      sawBrowserToolEvent: true,
      sawToolError: false,
      sawAssistantText: true,
      assistantText: "I must stop because login is required before I can continue.",
      lifecyclePhase: "end",
      toolNames: ["browser"],
      browserOperations: ["click"],
      sawMutatingBrowserAction: true,
    },
    failedPayloadPresent: false,
    resultMetaErrorPresent: false,
    terminalFailureDetected: true,
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.browserBlockedResponse, true);
  assert.equal(outcome.terminalCode, "EXECUTION_FAILED");
});

test("classifyBridgeOutcome treats explicit execution blockage as failed, not completed", () => {
  const outcome = classifyBridgeOutcome({
    requestText: "Send an email now to yandrapueshwar2000@gmail.com subject hi body how are you.",
    payloadText:
      "I am unable to complete this task. I am blocked because I cannot programmatically interact with the email compose fields.",
    assistantOutcomeText:
      "I am unable to complete this task. I am blocked because I cannot programmatically interact with the email compose fields.",
    stopReason: "stop",
    transcriptSummary: {
      toolCalls: 11,
      browserToolCalls: 11,
      browserMutatingToolCalls: 5,
      browserExtractToolCalls: 1,
      toolResults: 11,
      toolErrors: 0,
      browserSuccessfulMutationResults: 1,
      browserSuccessfulExtractResults: 0,
      browserRecoverableFailures: 4,
      browserTerminalFailures: 0,
      assistantText:
        "I am unable to complete this task. I am blocked because I cannot programmatically interact with the email compose fields.",
    },
    runtimeSummary: {
      sawToolEvent: true,
      sawBrowserToolEvent: true,
      sawToolError: false,
      sawAssistantText: true,
      assistantText:
        "I am unable to complete this task. I am blocked because I cannot programmatically interact with the email compose fields.",
      lifecyclePhase: "end",
      toolNames: ["browser"],
      browserOperations: ["snapshot", "fill", "click"],
      sawMutatingBrowserAction: true,
    },
    failedPayloadPresent: false,
    resultMetaErrorPresent: false,
    terminalFailureDetected: false,
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.browserTaskSucceeded, false);
  assert.equal(outcome.terminalCode, "EXECUTION_FAILED");
});

test("classifyBridgeOutcome treats explicit terminal success as completed even after earlier recoverable browser failures", () => {
  const outcome = classifyBridgeOutcome({
    requestText: "Send an email now to yandrapueshwar2000@gmail.com subject hi body how are you.",
    payloadText: "The email has been sent successfully.",
    assistantOutcomeText: "The email has been sent successfully.",
    stopReason: "stop",
    transcriptSummary: {
      toolCalls: 16,
      browserToolCalls: 16,
      browserMutatingToolCalls: 5,
      browserExtractToolCalls: 1,
      toolResults: 16,
      toolErrors: 3,
      browserSuccessfulMutationResults: 1,
      browserSuccessfulExtractResults: 1,
      browserRecoverableFailures: 3,
      browserTerminalFailures: 1,
      assistantText: "The email has been sent successfully.",
    },
    runtimeSummary: {
      sawToolEvent: true,
      sawBrowserToolEvent: true,
      sawToolError: true,
      sawAssistantText: true,
      assistantText: "The email has been sent successfully.",
      lifecyclePhase: "end",
      toolNames: ["browser"],
      browserOperations: ["snapshot", "type", "navigate", "click"],
      sawMutatingBrowserAction: true,
    },
    failedPayloadPresent: false,
    resultMetaErrorPresent: true,
    terminalFailureDetected: true,
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.browserTaskSucceeded, true);
  assert.equal(outcome.terminalCode, "COMPLETED");
});

test("classifyBridgeOutcome treats read-only browser navigation plus answer as completed", () => {
  const outcome = classifyBridgeOutcome({
    requestText: "Open example.com in the current browser tab and report the page title.",
    payloadText: "The page title is \"Example Domain\".",
    assistantOutcomeText: "The page title is \"Example Domain\".",
    stopReason: "stop",
    transcriptSummary: {
      toolCalls: 1,
      browserToolCalls: 1,
      browserMutatingToolCalls: 0,
      browserExtractToolCalls: 0,
      toolResults: 1,
      toolErrors: 0,
      browserSuccessfulMutationResults: 0,
      browserSuccessfulExtractResults: 0,
      browserRecoverableFailures: 0,
      browserTerminalFailures: 0,
      assistantText: "The page title is \"Example Domain\".",
    },
    runtimeSummary: {
      sawToolEvent: true,
      sawBrowserToolEvent: true,
      sawToolError: false,
      sawAssistantText: true,
      assistantText: "The page title is \"Example Domain\".",
      lifecyclePhase: "end",
      toolNames: ["browser"],
      browserOperations: ["navigate"],
      sawMutatingBrowserAction: false,
    },
    failedPayloadPresent: false,
    resultMetaErrorPresent: false,
    terminalFailureDetected: false,
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.browserReadOnlyTaskSucceeded, true);
  assert.equal(outcome.terminalCode, "COMPLETED");
});

test("classifyBridgeOutcome does not treat commerce navigation with only observation as completed", () => {
  const outcome = classifyBridgeOutcome({
    requestText:
      "On Myntra, search for black running shoes for men, apply filters, open the first valid product, add it to cart, and stop at payment confirmation.",
    payloadText: "I am preparing the browser session.",
    assistantOutcomeText: "I am preparing the browser session.",
    stopReason: "stop",
    transcriptSummary: {
      toolCalls: 1,
      browserToolCalls: 1,
      browserMutatingToolCalls: 0,
      browserExtractToolCalls: 0,
      toolResults: 1,
      toolErrors: 0,
      browserSuccessfulMutationResults: 0,
      browserSuccessfulExtractResults: 0,
      browserRecoverableFailures: 0,
      browserTerminalFailures: 0,
      assistantText: "I am preparing the browser session.",
    },
    runtimeSummary: {
      sawToolEvent: true,
      sawBrowserToolEvent: true,
      sawToolError: false,
      sawAssistantText: true,
      assistantText: "I am preparing the browser session.",
      lifecyclePhase: "end",
      toolNames: ["browser"],
      browserOperations: [],
      sawMutatingBrowserAction: false,
    },
    failedPayloadPresent: false,
    resultMetaErrorPresent: false,
    terminalFailureDetected: false,
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.browserReadOnlyTaskSucceeded, false);
  assert.equal(outcome.terminalCode, "BROWSER_ACTION_FAILED");
});
