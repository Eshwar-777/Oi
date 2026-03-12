import { EventEmitter } from "node:events";
import type { RuntimeEvent } from "../contracts/events.js";
import type {
  AutomationRuntimeRunRecord,
  AutomationRuntimeRunRequest,
} from "../contracts/run.js";
import { createRuntimeEvent } from "./event-mapper.js";
import {
  createLoopStateForRun,
  executePromptBrowserRun,
} from "./agent-browser.js";

type StoredRun = {
  record: AutomationRuntimeRunRecord;
  events: RuntimeEvent[];
  emitter: EventEmitter;
  controller: AbortController;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class RunManager {
  private runs = new Map<string, StoredRun>();
  private loopStates = new Map<string, ReturnType<typeof createLoopStateForRun>>();

  getRun(runId: string): AutomationRuntimeRunRecord | null {
    return this.runs.get(runId)?.record ?? null;
  }

  async startRun(request: AutomationRuntimeRunRequest): Promise<{ run: AutomationRuntimeRunRecord; cursor: number }> {
    const existing = this.runs.get(request.runId);
    if (existing && existing.record.state === "running") {
      throw new Error(`Run ${request.runId} is already active.`);
    }
    const record: AutomationRuntimeRunRecord = {
      runId: request.runId,
      sessionId: request.sessionId,
      state: "queued",
      createdAt: existing?.record.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      error: null,
      result: null,
    };
    const stored: StoredRun = existing ?? {
      record,
      events: [],
      emitter: new EventEmitter(),
      controller: new AbortController(),
    };
    stored.record = record;
    stored.controller = new AbortController();
    const cursor = stored.events.length;
    this.runs.set(request.runId, stored);
    queueMicrotask(() => {
      void this.executeRun(request).catch(() => {});
    });
    return { run: record, cursor };
  }

  cancelRun(runId: string): AutomationRuntimeRunRecord | null {
    const stored = this.runs.get(runId);
    if (!stored) {
      return null;
    }
    stored.controller.abort();
    stored.record = {
      ...stored.record,
      state: "cancelled",
      updatedAt: nowIso(),
      error: "Run cancelled.",
    };
    this.emit(runId, "run.failed", { error: "Run cancelled.", cancelled: true });
    return stored.record;
  }

  pauseRun(runId: string): AutomationRuntimeRunRecord | null {
    const stored = this.runs.get(runId);
    if (!stored) {
      return null;
    }
    stored.controller.abort();
    stored.record = {
      ...stored.record,
      state: "paused",
      updatedAt: nowIso(),
      error: null,
    };
    this.emit(runId, "run.paused", { reason: "Paused by user." });
    return stored.record;
  }

  listEvents(runId: string, after = -1): RuntimeEvent[] {
    const stored = this.runs.get(runId);
    if (!stored) {
      return [];
    }
    return stored.events.filter((event) => event.seq > after);
  }

  subscribe(runId: string, listener: (event: RuntimeEvent) => void): (() => void) {
    const stored = this.runs.get(runId);
    if (!stored) {
      throw new Error(`Run ${runId} not found.`);
    }
    const handler = (event: RuntimeEvent) => listener(event);
    stored.emitter.on("event", handler);
    return () => stored.emitter.off("event", handler);
  }

  private emit(runId: string, type: RuntimeEvent["type"], payload: Record<string, unknown>): void {
    const stored = this.runs.get(runId);
    if (!stored) {
      return;
    }
    const event = createRuntimeEvent(stored.events.length, runId, type, payload);
    stored.events.push(event);
    stored.emitter.emit("event", event);
  }

  private async executeRun(request: AutomationRuntimeRunRequest): Promise<void> {
    const stored = this.runs.get(request.runId);
    if (!stored) {
      return;
    }
    const loopState =
      this.loopStates.get(request.runId) ?? createLoopStateForRun();
    this.loopStates.set(request.runId, loopState);
    stored.record = { ...stored.record, state: "running", updatedAt: nowIso() };
    this.emit(request.runId, "run.started", {
      sessionId: request.sessionId,
      text: request.text,
    });
    this.emit(request.runId, "run.thinking", {
      summary: request.steps?.length
        ? "Node automation runtime accepted the browser execution batch."
        : "Node automation runtime accepted the browser prompt and is planning from live state.",
    });

    let result;
    try {
      result = await executePromptBrowserRun({
        request,
        loopState,
        emit: (type, payload) => this.emit(request.runId, type, payload),
        signal: stored.controller.signal,
      });
    } catch (error) {
      if (stored.controller.signal.aborted && stored.record.state === "paused") {
        return;
      }
      if (stored.controller.signal.aborted && stored.record.state === "cancelled") {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      stored.record = {
        ...stored.record,
        state: "failed",
        updatedAt: nowIso(),
        error: message,
        result: null,
      };
      this.emit(request.runId, "run.runtime_incident", {
        code: "EXECUTION_FAILED",
        reason: message,
        replannable: false,
      });
      this.emit(request.runId, "run.failed", {
        error: message,
        code: "EXECUTION_FAILED",
        result: null,
      });
      return;
    }
    if (stored.controller.signal.aborted && stored.record.state === "paused") {
      return;
    }
    if (stored.controller.signal.aborted && stored.record.state === "cancelled") {
      return;
    }
    if (result.success) {
      stored.record = {
        ...stored.record,
        state: "completed",
        updatedAt: nowIso(),
        result: { rows: result.rows, metadata: result.metadata },
        error: null,
      };
      this.emit(request.runId, "run.completed", {
        result: stored.record.result,
      });
      return;
    }
    const error = String(result.error || "Node automation runtime execution failed.");
    const terminalCode = String(
      result.metadata.terminalCode ||
        (result.metadata.meta &&
        typeof result.metadata.meta === "object" &&
        "terminalCode" in result.metadata.meta
          ? (result.metadata.meta as Record<string, unknown>).terminalCode
          : "") ||
        "",
    );
    const code =
      terminalCode ||
      (error.startsWith("Step") && error.includes("observation_exhausted")
        ? "OBSERVATION_EXHAUSTED"
        : "EXECUTION_FAILED");
    const isHumanRequired = code === "AUTH_REQUIRED" || code === "HUMAN_REQUIRED";
    stored.record = {
      ...stored.record,
      state: "failed",
      updatedAt: nowIso(),
      error,
      result: { rows: result.rows, metadata: result.metadata },
    };
    if (code === "OBSERVATION_EXHAUSTED") {
      this.emit(request.runId, "run.runtime_incident", {
        code,
        reason: error,
        replannable: false,
      });
    }
    if (isHumanRequired) {
      this.emit(request.runId, "run.waiting_for_human", {
        reason: error,
        reasonCode: code,
        result: stored.record.result,
      });
      return;
    }
    this.emit(request.runId, "run.failed", {
      error,
      code,
      result: stored.record.result,
    });
  }
}
