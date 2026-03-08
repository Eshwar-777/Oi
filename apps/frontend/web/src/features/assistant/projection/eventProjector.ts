import type {
  AssistantMessage,
  AutomationStreamEvent,
  ChatTurnResponse,
  ConfirmResponse,
  IntentDraft,
  ResolveExecutionResponse,
} from "@/domain/automation";
import type { Dispatch, MutableRefObject } from "react";
import { createMockRunEvents, mockGetRun } from "@/mocks/automationMock";
import { decisionLabel, errorCopy, runStateLabel } from "../uiCopy";
import {
  buildRunBody,
  createDraftScheduleCard,
  createScheduleCard,
  createTimelineId,
  now,
  shouldCreateDraftSchedule,
  type AssistantAction,
  type AssistantState,
} from "../store/assistantStore";

interface ProjectionContext {
  dispatch: Dispatch<AssistantAction>;
  stateRef: MutableRefObject<AssistantState>;
  refreshRunDetail: (runId: string) => Promise<unknown>;
  appendAssistantMessage: (message: AssistantMessage) => void;
  sessionId: string;
}

export function createEventProjector({
  appendAssistantMessage,
  dispatch,
  refreshRunDetail,
  sessionId,
  stateRef,
}: ProjectionContext) {
  async function applyIntentResponse(response: ChatTurnResponse, timezone: string) {
    appendAssistantMessage(response.assistant_message);
    dispatch({ type: "SET_PENDING_INTENT", intent: response.intent_draft });

    if (response.intent_draft.decision === "GENERAL_CHAT") {
      dispatch({ type: "SET_PLAN", plan: null });
      return;
    }

    if (shouldCreateDraftSchedule(response.intent_draft)) {
      dispatch({
        type: "UPSERT_SCHEDULE",
        card: createDraftScheduleCard(response.intent_draft, timezone),
      });
    }

    if (
      response.intent_draft.decision !== "ASK_CLARIFICATION" &&
      response.intent_draft.decision !== "ASK_EXECUTION_MODE" &&
      response.intent_draft.decision !== "REQUIRES_CONFIRMATION"
    ) {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("intent"),
          type: "status",
          timestamp: now(),
          title: decisionLabel(response.intent_draft.decision),
          body: response.intent_draft.user_goal,
        },
      });
    }

    if (response.intent_draft.decision === "ASK_CLARIFICATION") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("clarify"),
          type: "clarification",
          timestamp: now(),
          question:
            response.intent_draft.clarification_question ||
            "I need one more detail before I can continue.",
          missingFields: response.intent_draft.missing_fields,
        },
      });
    }

    if (response.intent_draft.decision === "ASK_EXECUTION_MODE") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("mode"),
          type: "execution_mode",
          timestamp: now(),
          question:
            response.intent_draft.execution_mode_question ||
            "Choose how you want this to run.",
          allowedModes: ["immediate", "once", "interval", "multi_time"],
        },
      });
    }

    if (response.intent_draft.decision === "REQUIRES_CONFIRMATION") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("confirm"),
          type: "confirmation",
          timestamp: now(),
          message:
            response.intent_draft.confirmation_message ||
            "Please confirm before I continue.",
        },
      });
    }
  }

  async function applyResolveResponse(
    response: ResolveExecutionResponse | ConfirmResponse,
    intent: IntentDraft,
    timezone: string,
    useMockEvents: boolean,
  ) {
    const plan = response.plan;
    if (!plan) {
      appendAssistantMessage(response.assistant_message);
      return;
    }

    appendAssistantMessage(response.assistant_message);
    dispatch({ type: "SET_PLAN", plan });
    dispatch({
      type: "APPEND_TIMELINE",
      item: {
        id: createTimelineId("plan"),
        type: "plan",
        timestamp: now(),
        summary: plan.summary,
        executionMode: plan.execution_mode,
        steps: plan.steps,
      },
    });

    if ("run" in response && response.run) {
      const run = response.run;
      dispatch({
        type: "SET_PENDING_INTENT",
        intent: run.state === "awaiting_confirmation" ? intent : null,
      });
      dispatch({ type: "SET_ACTIVE_RUN", run });
      await refreshRunDetail(run.run_id);
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run"),
          type: "run",
          timestamp: now(),
          runId: run.run_id,
          state: run.state,
          title: runStateLabel(run.state),
          body: buildRunBody(run),
        },
      });

      if (run.execution_mode !== "immediate") {
        dispatch({
          type: "UPSERT_SCHEDULE",
          card: createScheduleCard(intent, run, timezone),
        });
      }

      if (useMockEvents) {
        const mockEvents = createMockRunEvents(run, plan, sessionId);
        const refreshedDetail = await mockGetRun(run.run_id);
        dispatch({ type: "UPSERT_RUN_DETAIL", detail: refreshedDetail });
        mockEvents.forEach((event, index) => {
          window.setTimeout(() => {
            void applyStreamEvent(event);
          }, (index + 1) * 500);
        });
      }
    } else {
      dispatch({ type: "SET_PENDING_INTENT", intent: null });
    }
  }

  async function applyStreamEvent(event: AutomationStreamEvent) {
    const currentState = stateRef.current;
    const stepSource =
      (event.run_id ? currentState.runDetails[event.run_id]?.plan.steps : undefined) ??
      currentState.activePlan?.steps ??
      [];

    if (event.type === "run.created") {
      dispatch({ type: "SET_ACTIVE_RUN", run: event.payload.run });
      await refreshRunDetail(event.payload.run.run_id);
      return;
    }

    if (event.type === "assistant.message") {
      appendAssistantMessage({
        message_id: event.payload.message_id,
        role: "assistant",
        text: event.payload.text,
      });
      return;
    }

    if (event.type === "clarification.requested") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("clarify"),
          type: "clarification",
          timestamp: event.timestamp,
          question: event.payload.question,
          missingFields: event.payload.missing_fields,
        },
      });
      return;
    }

    if (event.type === "execution_mode.requested") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("mode"),
          type: "execution_mode",
          timestamp: event.timestamp,
          question: event.payload.question,
          allowedModes: event.payload.allowed_modes,
        },
      });
      return;
    }

    if (event.type === "confirmation.requested") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("confirm"),
          type: "confirmation",
          timestamp: event.timestamp,
          message: event.payload.message,
        },
      });
      return;
    }

    if (event.type === "run.queued") {
      dispatch({
        type: "SYNC_RUN",
        runId: event.payload.run_id,
        patch: { state: "queued", updated_at: event.timestamp },
      });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run-queued"),
          type: "run",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          state: "queued",
          title: "Run queued",
          body: "The automation is queued and will start shortly.",
        },
      });
      return;
    }

    if (event.type === "schedule.created") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("schedule"),
          type: "status",
          timestamp: event.timestamp,
          title: "Upcoming event saved",
          body:
            event.payload.run_times.length > 0
              ? `Next run: ${new Date(event.payload.run_times[0]).toLocaleString()}`
              : "The schedule is now available in the schedules tab.",
        },
      });
      return;
    }

    if (event.type === "run.started" || event.type === "run.resumed") {
      await refreshRunDetail(event.payload.run_id);
      dispatch({
        type: "SYNC_RUN",
        runId: event.payload.run_id,
        patch: { state: "running", updated_at: event.timestamp },
      });
      dispatch({ type: "SET_RUN_ACTION_REASON", runId: event.payload.run_id, reason: null });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run-start"),
          type: "run",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          state: "running",
          title: "Run in progress",
          body: "I am working through the automation steps.",
        },
      });
      return;
    }

    if (event.type === "run.paused") {
      dispatch({
        type: "SYNC_RUN",
        runId: event.payload.run_id,
        patch: { state: "paused", updated_at: event.timestamp },
      });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run-paused"),
          type: "run",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          state: "paused",
          title: "Run paused",
          body: event.payload.reason,
        },
      });
      return;
    }

    if (event.type === "step.started") {
      const refreshedDetail = await refreshRunDetail(event.payload.run_id);
      const refreshedStepSource =
        (refreshedDetail as { plan: { steps: Array<{ description?: string }> } }).plan.steps;
      dispatch({
        type: "SYNC_RUN",
        runId: event.payload.run_id,
        patch: { current_step_index: event.payload.index, updated_at: event.timestamp },
      });
      dispatch({
        type: "UPDATE_RUN_STEP",
        runId: event.payload.run_id,
        stepId: event.payload.step_id,
        patch: { status: "running", started_at: event.timestamp },
      });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("step"),
          type: "step",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          stepId: event.payload.step_id,
          status: "running",
          label: event.payload.label,
          body: refreshedStepSource[event.payload.index]?.description,
        },
      });
      return;
    }

    if (event.type === "step.completed") {
      await refreshRunDetail(event.payload.run_id);
      dispatch({
        type: "UPDATE_RUN_STEP",
        runId: event.payload.run_id,
        stepId: event.payload.step_id,
        patch: {
          status: "completed",
          completed_at: event.timestamp,
          screenshot_url: event.payload.screenshot_url ?? undefined,
        },
      });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("step"),
          type: "step",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          stepId: event.payload.step_id,
          status: "completed",
          label: stepSource[event.payload.index]?.label || "Step completed",
          screenshotUrl: event.payload.screenshot_url,
        },
      });
      return;
    }

    if (event.type === "step.failed") {
      await refreshRunDetail(event.payload.run_id);
      dispatch({
        type: "UPDATE_RUN_STEP",
        runId: event.payload.run_id,
        stepId: event.payload.step_id,
        patch: {
          status: "failed",
          error_code: event.payload.code,
          error_message: event.payload.message,
          completed_at: event.timestamp,
          screenshot_url: event.payload.screenshot_url ?? undefined,
        },
      });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("step"),
          type: "step",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          stepId: event.payload.step_id,
          status: "failed",
          label: "Step needs attention",
          body: errorCopy(event.payload.code),
          screenshotUrl: event.payload.screenshot_url,
          errorCode: event.payload.code,
          retryable: event.payload.retryable,
        },
      });
      return;
    }

    if (event.type === "run.completed") {
      await refreshRunDetail(event.payload.run_id);
      dispatch({
        type: "SYNC_RUN",
        runId: event.payload.run_id,
        patch: { state: "completed", updated_at: event.timestamp },
      });
      dispatch({ type: "SET_RUN_ACTION_REASON", runId: event.payload.run_id, reason: null });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run"),
          type: "run",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          state: "completed",
          title: "Run completed",
          body: event.payload.message,
        },
      });
      return;
    }

    if (event.type === "run.waiting_for_user_action") {
      await refreshRunDetail(event.payload.run_id);
      dispatch({
        type: "SYNC_RUN",
        runId: event.payload.run_id,
        patch: { state: "waiting_for_user_action", updated_at: event.timestamp },
      });
      dispatch({
        type: "SET_RUN_ACTION_REASON",
        runId: event.payload.run_id,
        reason: event.payload.reason,
      });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run-waiting"),
          type: "run",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          state: "waiting_for_user_action",
          title: "Waiting for you",
          body: event.payload.reason,
        },
      });
      return;
    }

    if (event.type === "run.waiting_for_human") {
      await refreshRunDetail(event.payload.run_id);
      dispatch({
        type: "SYNC_RUN",
        runId: event.payload.run_id,
        patch: { state: "waiting_for_human", updated_at: event.timestamp },
      });
      dispatch({
        type: "SET_RUN_ACTION_REASON",
        runId: event.payload.run_id,
        reason: event.payload.reason,
      });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run-waiting-human"),
          type: "run",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          state: "waiting_for_human",
          title: "Sensitive action blocked",
          body: event.payload.reason,
        },
      });
      return;
    }

    if (event.type === "run.interrupted_by_user") {
      dispatch({
        type: "SYNC_RUN",
        runId: event.payload.run_id,
        patch: { state: "paused", updated_at: event.timestamp },
      });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run-interrupt"),
          type: "run",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          state: "paused",
          title: "Run paused",
          body: event.payload.message,
        },
      });
      return;
    }

    if (event.type === "run.failed") {
      await refreshRunDetail(event.payload.run_id);
      dispatch({
        type: "SYNC_RUN",
        runId: event.payload.run_id,
        patch: {
          state: "failed",
          updated_at: event.timestamp,
          last_error: {
            code: event.payload.code,
            message: event.payload.message,
            retryable: event.payload.retryable,
          },
        },
      });
      dispatch({ type: "SET_RUN_ACTION_REASON", runId: event.payload.run_id, reason: null });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run"),
          type: "run",
          timestamp: event.timestamp,
          runId: event.payload.run_id,
          state: "failed",
          title: "Run needs attention",
          body: errorCopy(event.payload.code),
        },
      });
    }
  }

  return {
    applyIntentResponse,
    applyResolveResponse,
    applyStreamEvent,
  };
}
