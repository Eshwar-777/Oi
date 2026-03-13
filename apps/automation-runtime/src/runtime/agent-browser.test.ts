import test from "node:test";
import assert from "node:assert/strict";
import {
  __testOnly,
  createLoopStateForRun,
  executePromptBrowserRun,
} from "./agent-browser.ts";

test("prompt-only email run plans browser actions to completion", async () => {
  let stage = 0;
  const commands: string[][] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      if (stage === 0) {
        return {
          origin: "https://mail.google.com/",
          title: "Inbox",
          snapshot: '- button "Compose" [ref=e11]',
          refs: { e11: { role: "button", name: "Compose" } },
        };
      }
      if (stage < 4) {
        return {
          origin: "https://mail.google.com/",
          title: "Inbox",
          snapshot:
            '- textbox "To" [ref=e21]\n- textbox "Subject" [ref=e22]\n- textbox "Message Body" [ref=e23]\n- button "Send" [ref=e24]\nNew Message',
          refs: {
            e21: { role: "textbox", name: "To" },
            e22: { role: "textbox", name: "Subject" },
            e23: { role: "textbox", name: "Message Body" },
            e24: { role: "button", name: "Send" },
          },
        };
      }
      return {
        origin: "https://mail.google.com/",
        title: "Inbox",
        snapshot: "Message sent",
        refs: {},
      };
    }
    if (args.includes("click") && args.includes("@e11")) {
      stage = 1;
      return { clicked: true };
    }
    if (args.includes("fill") && args.includes("@e21")) {
      stage = 2;
      return { filled: true };
    }
    if (args.includes("fill") && args.includes("@e22")) {
      stage = 3;
      return { filled: true };
    }
    if (args.includes("fill") && args.includes("@e23")) {
      stage = 4;
      return { filled: true };
    }
    if (args.includes("click") && args.includes("@e24")) {
      stage = 5;
      return { clicked: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-1",
        sessionId: "session-1",
        text: "send email to yandrapueshwar2000@gmail.com subject hi body how are you",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: (type, payload) => {
        events.push({ type, payload });
      },
    },
    { runJsonCommand },
  );

  assert.equal(result.success, true);
  assert.equal(result.metadata.terminalCode, "COMPLETED");
  assert.ok(commands.some((command) => command.includes("connect")));
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e11")));
  assert.ok(commands.some((command) => command.includes("fill") && command.includes("@e21")));
  assert.ok(commands.some((command) => command.includes("fill") && command.includes("@e22")));
  assert.ok(commands.some((command) => command.includes("fill") && command.includes("@e23")));
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e24")));
  assert.ok(events.some((event) => event.type === "run.browser.snapshot"));
  assert.ok(events.some((event) => event.type === "run.browser.action"));
});

test("prompt-only email run stops after observation exhaustion", async () => {
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      return {
        origin: "https://mail.google.com/",
        title: "Inbox",
        snapshot: '- button "Compose" [ref=e11]',
        refs: { e11: { role: "button", name: "Compose" } },
      };
    }
    if (args.includes("click") && args.includes("@e11")) {
      return { clicked: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-2",
        sessionId: "session-2",
        text: "send email to yandrapueshwar2000@gmail.com",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    { runJsonCommand },
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata.terminalCode, "OBSERVATION_EXHAUSTED");
  assert.match(String(result.error || ""), /OBSERVATION_EXHAUSTED/);
});

test("generic planner can click a named control on an arbitrary site", async () => {
  const commands: string[][] = [];
  let clicked = false;
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      return clicked
        ? {
            origin: "https://example.com/",
            title: "Example",
            snapshot: "Welcome back",
            refs: {},
          }
        : {
            origin: "https://example.com/",
            title: "Example",
            snapshot: '- button "Sign in" [ref=e11]',
            refs: { e11: { role: "button", name: "Sign in" } },
          };
    }
    if (args.includes("click") && args.includes("@e11")) {
      clicked = true;
      return { clicked: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-3",
        sessionId: "session-3",
        text: "click the Sign in button",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    { runJsonCommand },
  );

  assert.equal(result.success, true);
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e11")));
});

test("model-backed planner can drive an arbitrary-site task without heuristic objectives", async () => {
  const commands: string[][] = [];
  let clicked = false;
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      return clicked
        ? {
            origin: "https://example.com/",
            title: "Example",
            snapshot: "Pricing",
            refs: {},
          }
        : {
            origin: "https://example.com/",
            title: "Example",
            snapshot: '- link "Pricing" [ref=e31]',
            refs: { e31: { role: "link", name: "Pricing" } },
          };
    }
    if (args.includes("click") && args.includes("@e31")) {
      clicked = true;
      return { clicked: true };
    }
    return { ok: true };
  };

  let callCount = 0;
  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-4",
        sessionId: "session-4",
        text: "go to pricing",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      runJsonCommand,
      planNextAction: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            action: "click",
            reason: "Click the Pricing link visible in the current snapshot.",
            requiresHuman: false,
            ref: "@e31",
          };
        }
        return {
          action: "done",
          reason: "The requested destination is now open.",
          requiresHuman: false,
        };
      },
    },
  );

  assert.equal(result.success, true);
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e31")));
});

test("gmail inbox is not misclassified as auth-required when google helper iframe is present", async () => {
  let stage = 0;
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      if (stage === 0) {
        return {
          origin: "https://mail.google.com/mail/u/0/?ogbl#inbox",
          title: "Inbox (968) - yandrapueshwar2000@gmail.com - Gmail",
          snapshot: '- button "Compose" [ref=e11]\n- iframe "https://accounts.google.com/RotateCookiesPage?og_pid=23&rot=3"',
          refs: { e11: { role: "button", name: "Compose" } },
        };
      }
      return {
        origin: "https://mail.google.com/mail/u/0/?ogbl#inbox",
        title: "Inbox (968) - yandrapueshwar2000@gmail.com - Gmail",
        snapshot: "Message sent",
        refs: {},
      };
    }
    if (args.includes("click") && args.includes("@e11")) {
      stage = 1;
      return { clicked: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-5",
        sessionId: "session-5",
        text: "click compose",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    { runJsonCommand },
  );

  assert.equal(result.success, true);
});

test("model done decision is ignored while concrete email objectives remain", async () => {
  let stage = 0;
  const commands: string[][] = [];
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      if (stage === 0) {
        return {
          origin: "https://mail.google.com/",
          title: "Inbox",
          snapshot: '- button "Compose" [ref=e11]',
          refs: { e11: { role: "button", name: "Compose" } },
        };
      }
      if (stage < 4) {
        return {
          origin: "https://mail.google.com/",
          title: "Inbox",
          snapshot:
            '- textbox "To" [ref=e21]\n- textbox "Subject" [ref=e22]\n- textbox "Message Body" [ref=e23]\n- button "Send" [ref=e24]\nNew Message',
          refs: {
            e21: { role: "textbox", name: "To" },
            e22: { role: "textbox", name: "Subject" },
            e23: { role: "textbox", name: "Message Body" },
            e24: { role: "button", name: "Send" },
          },
        };
      }
      return {
        origin: "https://mail.google.com/",
        title: "Inbox",
        snapshot: "Message sent",
        refs: {},
      };
    }
    if (args.includes("click") && args.includes("@e11")) {
      stage = 1;
      return { clicked: true };
    }
    if (args.includes("fill") && args.includes("@e21")) {
      stage = 2;
      return { filled: true };
    }
    if (args.includes("fill") && args.includes("@e22")) {
      stage = 3;
      return { filled: true };
    }
    if (args.includes("fill") && args.includes("@e23")) {
      stage = 4;
      return { filled: true };
    }
    if (args.includes("click") && args.includes("@e24")) {
      stage = 5;
      return { clicked: true };
    }
    return { ok: true };
  };

  let decisionCalls = 0;
  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-6",
        sessionId: "session-6",
        text: "send email to yandrapueshwar2000@gmail.com subject hi body how are you",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      runJsonCommand,
      planNextAction: async () => {
        decisionCalls += 1;
        if (decisionCalls === 1) {
          return {
            action: "done",
            reason: "The task appears finished.",
            requiresHuman: false,
          };
        }
        return null;
      },
    },
  );

  assert.equal(result.success, true);
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e11")));
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e24")));
});

test("compose click switches to role observation before filling recipient", async () => {
  const commands: string[][] = [];
  let stage = 0;
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      const scopeIndex = args.indexOf("-s");
      const scope = scopeIndex >= 0 ? args[scopeIndex + 1] : "";
      if (stage === 0) {
        return {
          origin: "https://mail.google.com/",
          title: "Inbox",
          snapshot: '- button "Compose" [ref=e11]',
          refs: { e11: { role: "button", name: "Compose" } },
        };
      }
      if (stage >= 5) {
        return {
          origin: "https://mail.google.com/mail/u/0/#inbox",
          title: "Inbox",
          snapshot: "Message sent",
          refs: {},
        };
      }
      if (scope === "[role='dialog']:has([aria-label='To recipients'])") {
        return {
          origin: "https://mail.google.com/mail/u/0/#inbox?compose=new",
          title: "Inbox",
          snapshot:
            '- textbox "To" [ref=e21]\n- textbox "Subject" [ref=e22]\n- textbox "Message Body" [ref=e23]\n- button "Send" [ref=e24]\nNew Message',
          refs: {
            e21: { role: "textbox", name: "To" },
            e22: { role: "textbox", name: "Subject" },
            e23: { role: "textbox", name: "Message Body" },
            e24: { role: "button", name: "Send" },
          },
        };
      }
      return {
        origin: "https://mail.google.com/mail/u/0/#inbox?compose=new",
        title: "Inbox",
        snapshot: "",
        refs: {},
      };
    }
    if (args.includes("click") && args.includes("@e11")) {
      stage = 1;
      return { clicked: true };
    }
    if (args.includes("fill") && args.includes("@e21")) {
      stage = 2;
      return { filled: true };
    }
    if (args.includes("fill") && args.includes("@e22")) {
      stage = 3;
      return { filled: true };
    }
    if (args.includes("fill") && args.includes("@e23")) {
      stage = 4;
      return { filled: true };
    }
    if (args.includes("click") && args.includes("@e24")) {
      stage = 5;
      return { clicked: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-7",
        sessionId: "session-7",
        text: "send email to yandrapueshwar2000@gmail.com subject hi body how are you",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    { runJsonCommand },
  );

  assert.equal(result.success, true);
  assert.ok(
    commands.some(
      (command) =>
        command.includes("snapshot") &&
        command.includes("-i") &&
        command.includes("-d") &&
        command.includes("8") &&
        command.includes("-s") &&
        command.includes("[role='dialog']:has([aria-label='To recipients'])"),
    ),
  );
});

test("draft content on compose page does not count as sent", async () => {
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      return {
        origin: "https://mail.google.com/mail/u/0/#inbox?compose=new",
        title: "Inbox",
        snapshot:
          '- textbox "To" [ref=e21]\n- textbox "Subject" [ref=e22]\n- textbox "Message Body" [ref=e23]\nyandrapueshwar2000@gmail.com\nhi\nhow are you',
        refs: {
          e21: { role: "textbox", name: "To" },
          e22: { role: "textbox", name: "Subject" },
          e23: { role: "textbox", name: "Message Body" },
        },
      };
    }
    if (args.includes("fill") || args.includes("click")) {
      return { ok: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-8",
        sessionId: "session-8",
        text: "send email to yandrapueshwar2000@gmail.com subject hi body how are you",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    { runJsonCommand },
  );

  assert.notEqual(result.metadata.terminalCode, "COMPLETED");
});

test("scoped observation falls back to unscoped snapshot when the scoped dialog disappears", async () => {
  let stage = 0;
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      const scopeIndex = args.indexOf("-s");
      const scope = scopeIndex >= 0 ? args[scopeIndex + 1] : "";
      if (stage === 0) {
        return {
          origin: "https://mail.google.com/",
          title: "Inbox",
          snapshot: '- button "Compose" [ref=e11]',
          refs: { e11: { role: "button", name: "Compose" } },
        };
      }
      if (stage < 5 && scope === "[role='dialog']:has([aria-label='To recipients'])") {
        return {
          origin: "https://mail.google.com/mail/u/0/#inbox?compose=new",
          title: "Inbox",
          snapshot:
            '- textbox "To" [ref=e21]\n- textbox "Subject" [ref=e22]\n- textbox "Message Body" [ref=e23]\n- button "Send" [ref=e24]\nNew Message',
          refs: {
            e21: { role: "textbox", name: "To" },
            e22: { role: "textbox", name: "Subject" },
            e23: { role: "textbox", name: "Message Body" },
            e24: { role: "button", name: "Send" },
          },
        };
      }
      if (stage >= 5 && scope) {
        throw new Error("locator.ariaSnapshot: Timeout 10000ms exceeded.");
      }
      return {
        origin: "https://mail.google.com/mail/u/0/#inbox",
        title: "Inbox",
        snapshot: "Message sent",
        refs: {},
      };
    }
    if (args.includes("click") && args.includes("@e11")) {
      stage = 1;
      return { clicked: true };
    }
    if (args.includes("fill") && args.includes("@e21")) {
      stage = 2;
      return { filled: true };
    }
    if (args.includes("fill") && args.includes("@e22")) {
      stage = 3;
      return { filled: true };
    }
    if (args.includes("fill") && args.includes("@e23")) {
      stage = 4;
      return { filled: true };
    }
    if (args.includes("click") && args.includes("@e24")) {
      stage = 5;
      return { clicked: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-9",
        sessionId: "session-9",
        text: "send email to yandrapueshwar2000@gmail.com subject hi body how are you",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: (type, payload) => events.push({ type, payload }),
    },
    { runJsonCommand },
  );

  assert.equal(result.success, true);
  assert.ok(events.some((event) => event.type === "run.runtime_incident" && event.payload.code === "SCOPED_OBSERVATION_FALLBACK"));
});

test("runtime observation memory does not blend different page targets", () => {
  const loopState = createLoopStateForRun();

  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.tool.finished", {
    toolName: "browser",
    args: { action: "snapshot" },
    result: {
      kind: "snapshot",
      details: {
        targetId: "results-tab",
        url: "https://www.myntra.com/maroon-men-shirt",
        title: "Maroon Shirt Men - Buy online",
      },
      content: [{ type: "text", text: "Results for maroon men's shirt" }],
    },
  });

  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.tool.finished", {
    toolName: "browser",
    args: { action: "snapshot" },
    result: {
      kind: "snapshot",
      details: {
        targetId: "product-tab",
        title: "Buy Roadster Shirt | Myntra",
      },
      content: [{ type: "text", text: "Add to bag" }],
    },
  });

  assert.equal(loopState.lastBrowserObservation?.targetId, "product-tab");
  assert.equal(loopState.lastBrowserObservation?.title, "Buy Roadster Shirt | Myntra");
  assert.equal(loopState.lastBrowserObservation?.url, undefined);
  assert.equal(
    loopState.browserObservationsByTarget?.["results-tab"]?.url,
    "https://www.myntra.com/maroon-men-shirt",
  );
});
