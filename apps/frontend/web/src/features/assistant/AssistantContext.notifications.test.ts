import test from "node:test";
import assert from "node:assert/strict";

import type { AutomationStreamEvent, RunDetailResponse } from "@/domain/automation";
import {
  buildNotificationRoute,
  getNotificationBody,
  shouldNotifyInBrowser,
} from "./notificationLogic.ts";

const waitingForHumanEvent: AutomationStreamEvent = {
  event_id: "evt_waiting",
  session_id: "sess_1",
  run_id: "run_1",
  type: "run.waiting_for_human",
  timestamp: "2026-03-13T12:00:00Z",
  payload: {
    run_id: "run_1",
    reason: "Payment confirmation is required.",
    reason_code: "SENSITIVE_ACTION_BLOCKED",
  },
};

test("waiting_for_human always notifies when browser notifications are enabled", () => {
  assert.equal(
    shouldNotifyInBrowser(waitingForHumanEvent, {
      browser_enabled: true,
      urgency_mode: "important_only",
    }),
    true,
  );
  assert.equal(
    shouldNotifyInBrowser(waitingForHumanEvent, {
      browser_enabled: false,
      urgency_mode: "all",
    }),
    false,
  );
});

test("runtime incidents only notify browser users in all-urgency mode", () => {
  const event: AutomationStreamEvent = {
    event_id: "evt_incident",
    session_id: "sess_1",
    run_id: "run_1",
    type: "run.runtime_incident",
    timestamp: "2026-03-13T12:00:00Z",
    payload: {
      run_id: "run_1",
      incident: {
        incident_id: "incident_1",
        category: "security",
        severity: "warning",
        code: "AUTH_REQUIRED",
        summary: "The site asked for additional verification.",
        visible_signals: [],
        requires_human: false,
        replannable: false,
        user_visible: true,
        created_at: "2026-03-13T12:00:00Z",
      },
    },
  };

  assert.equal(
    shouldNotifyInBrowser(event, {
      browser_enabled: true,
      urgency_mode: "important_only",
    }),
    false,
  );
  assert.equal(
    shouldNotifyInBrowser(event, {
      browser_enabled: true,
      urgency_mode: "all",
    }),
    true,
  );
});

test("notification body and route point back to the live session when available", () => {
  const detail = {
    run: {
      run_id: "run_1",
      browser_session_id: "browser_1",
    },
  } as RunDetailResponse;

  assert.equal(getNotificationBody(waitingForHumanEvent), "Payment confirmation is required.");
  assert.equal(
    buildNotificationRoute(waitingForHumanEvent, detail),
    "/sessions?session_id=browser_1&run_id=run_1",
  );
});
