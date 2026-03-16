import test from "node:test";
import assert from "node:assert/strict";
import {
  __testOnly,
  createLoopStateForRun,
  executePromptBrowserRun,
} from "./agent-browser.ts";

test("hook-based run follows planner-provided ref actions through a multi-field form", async () => {
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
          origin: "https://example.com/form",
          title: "Contact",
          snapshot: '- button "Start" [ref=e11]',
          refs: { e11: { role: "button", name: "Start" } },
        };
      }
      if (stage < 5) {
        return {
          origin: "https://example.com/form",
          title: "Contact",
          snapshot:
            '- textbox "Name" [ref=e21]\n- textbox "Topic" [ref=e22]\n- textbox "Details" [ref=e23]\n- button "Submit" [ref=e24]\nContact Form',
          refs: {
            e21: { role: "textbox", name: "Name" },
            e22: { role: "textbox", name: "Topic" },
            e23: { role: "textbox", name: "Details" },
            e24: { role: "button", name: "Submit" },
          },
        };
      }
      return {
        origin: "https://example.com/form/success",
        title: "Contact",
        snapshot: "Submission sent",
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
        text: "start the contact form, fill the fields, and submit it",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: (type, payload) => {
        events.push({ type, payload });
      },
    },
    {
      runJsonCommand,
      planNextAction: async () => {
        if (stage === 0) {
          return { action: "click", ref: "@e11" };
        }
        if (stage === 1) {
          return { action: "fill", ref: "@e21", value: "Ada" };
        }
        if (stage === 2) {
          return { action: "fill", ref: "@e22", value: "Question" };
        }
        if (stage === 3) {
          return { action: "fill", ref: "@e23", value: "How does this work?" };
        }
        if (stage === 4) {
          return { action: "click", ref: "@e24" };
        }
        return { action: "done" };
      },
    },
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

test("hook-based run stops after observation exhaustion when planner cannot ground the next action", async () => {
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      return {
        origin: "https://example.com/form",
        title: "Contact",
        snapshot: '- textbox "Name" [ref=e11]',
        refs: { e11: { role: "textbox", name: "Name" } },
      };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-2",
        sessionId: "session-2",
        text: "complete the contact form",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      runJsonCommand,
      planNextAction: async () => null,
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata.terminalCode, "OBSERVATION_EXHAUSTED");
  assert.match(String(result.error || ""), /OBSERVATION_EXHAUSTED/);
});

test("typed current step rejects browser actions outside allowed actions", async () => {
  const mismatch = __testOnly.currentStepActionMismatchResult(
    {
      runId: "run-step-mismatch",
      sessionId: "session-step-mismatch",
      text: "search for a shirt",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      goalHints: {
        executionContract: {
          current_execution_step: {
            kind: "navigate",
            allowed_actions: ["navigate", "snapshot"],
          },
        },
      },
    },
    {
      success: false,
      rows: [],
      metadata: {
        runtimeSummary: {
          browserOperations: ["navigate", "snapshot", "type"],
        },
      },
      error: "ambiguous",
    },
  );

  assert.ok(mismatch);
  assert.equal(mismatch?.success, false);
  assert.equal(mismatch?.metadata.terminalCode, "STEP_ACTION_MISMATCH");
  assert.match(String(mismatch?.error || ""), /type/);
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

test("hook-based run escalates weak post-search snapshots into results-surface snapshots", async () => {
  const commands: string[][] = [];
  let snapshotCount = 0;
  let typed = false;
  let searched = false;
  let opened = false;
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args[0] === "snapshot") {
      snapshotCount += 1;
      const selectorIndex = args.indexOf("-s");
      const selector = selectorIndex >= 0 ? args[selectorIndex + 1] : "";
      if (snapshotCount === 1) {
        return {
          origin: "https://shop.example.com/",
          title: "Shop",
          snapshot: '- textbox "Search" [ref=e11]\n- button "Search" [ref=e12]',
          refs: {
            e11: { role: "textbox", name: "Search" },
            e12: { role: "button", name: "Search" },
          },
        };
      }
      if (!selector) {
        if (opened) {
          return {
            origin: "https://shop.example.com/product/black-running-shoe-a",
            title: "Black Running Shoe A",
            snapshot: "Black Running Shoe A",
            refs: {},
          };
        }
        return {
          origin: "https://shop.example.com/search?q=black+running+shoes",
          title: "Shop results",
          snapshot: '- textbox "Search" [ref=e21]',
          refs: {
            e21: { role: "input", name: "Search" },
          },
        };
      }
      if (selector.includes("[role='list']")) {
        return {
          origin: "https://shop.example.com/search?q=black+running+shoes",
          title: "Shop results",
          snapshot:
            '- link "Black Running Shoe A" [ref=e31]\n- link "Black Running Shoe B" [ref=e32]\n- checkbox "Size 9" [ref=e33]',
          refs: {
            e31: { role: "link", name: "Black Running Shoe A" },
            e32: { role: "link", name: "Black Running Shoe B" },
            e33: { role: "checkbox", name: "Size 9" },
          },
        };
      }
    }
    if (args.includes("type") && args.includes("@e11")) {
      typed = true;
      return { typed: true };
    }
    if (args.includes("click") && args.includes("@e12")) {
      searched = true;
      return { clicked: true };
    }
    if (args.includes("click") && args.includes("@e31")) {
      opened = true;
      return { clicked: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-results-1",
        sessionId: "session-results-1",
        text: "search for black running shoes and open the first result",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      runJsonCommand,
      planNextAction: async ({ snapshot }) => {
        const refs = snapshot.refs as Record<string, { role?: string; name?: string }> | undefined;
        if (refs?.e11 && refs?.e12 && !typed) {
          return { action: "type", ref: "@e11", value: "black running shoes" };
        }
        if (refs?.e12 && typed && !searched) {
          return { action: "click", ref: "@e12" };
        }
        if (refs?.e31) {
          return { action: "click", ref: "@e31" };
        }
        return { action: "done" };
      },
    },
  );

  assert.equal(result.success, true);
  assert.ok(
    commands.some(
      (command) =>
        command[0] === "snapshot" &&
        command.includes("-s") &&
        String(command[command.indexOf("-s") + 1] || "").includes("[role='list']"),
    ),
  );
});

test("rich results observation is not replaced by a weak single-input snapshot on the same search URL", () => {
  const shouldReplace = __testOnly.shouldReplaceObservationMemory(
    {
      capturedAt: new Date().toISOString(),
      url: "https://shop.example.com/search?q=black+running+shoes",
      title: "Results",
      refCount: 20,
      refs: [
        { ref: "e31", role: "link", name: "Black Running Shoe A" },
        { ref: "e32", role: "link", name: "Black Running Shoe B" },
        { ref: "e33", role: "checkbox", name: "Size 9" },
      ],
    },
    {
      capturedAt: new Date().toISOString(),
      url: "https://shop.example.com/search?q=black+running+shoes",
      title: "Results",
      refCount: 1,
      refs: [{ ref: "e1", role: "input", name: "Search" }],
    },
    {
      capturedAt: new Date().toISOString(),
      operation: "click",
      mutating: true,
    },
  );

  assert.equal(shouldReplace, false);
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

test("model done decision is ignored while explicit verification evidence is still unmet", async () => {
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
        origin: "https://example.com/form",
        title: "Contact",
        snapshot: '- button "Start" [ref=e11]',
        refs: { e11: { role: "button", name: "Start" } },
      };
    }
      if (stage < 5) {
      return {
        origin: "https://example.com/form",
        title: "Contact",
        snapshot:
          '- textbox "Name" [ref=e21]\n- textbox "Topic" [ref=e22]\n- textbox "Details" [ref=e23]\n- button "Submit" [ref=e24]\nContact Form',
        refs: {
          e21: { role: "textbox", name: "Name" },
          e22: { role: "textbox", name: "Topic" },
          e23: { role: "textbox", name: "Details" },
          e24: { role: "button", name: "Submit" },
        },
      };
    }
    return {
      origin: "https://example.com/form/success",
      title: "Contact",
      snapshot: "Submission sent",
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
        text: "start the contact form, fill the fields, and submit it",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
        goalHints: {
          executionContract: {
            verification_evidence: {
              checks: ["Submission sent"],
            },
          },
        },
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
        if (decisionCalls === 2) {
          return { action: "click", ref: "@e11" };
        }
        if (decisionCalls === 3 && stage === 1) {
          return { action: "fill", ref: "@e21", value: "Ada" };
        }
        if (decisionCalls === 4 && stage === 2) {
          return { action: "fill", ref: "@e22", value: "Question" };
        }
        if (decisionCalls === 5 && stage === 3) {
          return { action: "fill", ref: "@e23", value: "How does this work?" };
        }
        if (decisionCalls === 6 && stage === 4) {
          return { action: "click", ref: "@e24" };
        }
        return { action: "done" };
      },
    },
  );

  assert.equal(result.success, true);
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e11")));
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e24")));
});

test("model done decision is ignored while generic target is still actionable", async () => {
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
            origin: "https://example.com/pricing",
            title: "Pricing",
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

  let decisionCalls = 0;
  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-10",
        sessionId: "session-10",
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
        decisionCalls += 1;
        if (decisionCalls === 1) {
          return {
            action: "done",
            reason: "The task appears finished.",
            requiresHuman: false,
          };
        }
        if (decisionCalls === 2) {
          return {
            action: "click",
            reason: "Pricing is still actionable in the current snapshot.",
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

test("recovery prompt carries last action target and value for generic form continuation", () => {
  const loopState = createLoopStateForRun();
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
    result: {
      kind: "snapshot",
      details: {
        targetId: "dialog-1",
        url: "https://example.com/form",
        title: "Contact",
        snapshot: '- textbox "Name" [ref=e21]',
        refs: { e21: { role: "textbox", name: "Name" } },
      },
    },
  });
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.action", {
    action: "fill",
    target: "@e21",
    value: "Ada",
    result: { kind: "fill" },
  });

  const prompt = __testOnly.buildObservationRecoveryPrompt(
    {
      runId: "run-7",
      sessionId: "session-7",
      text: "complete the contact form",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
    },
    loopState,
    {
      snapshotRequest: { action: "snapshot", request: { interactive: true } },
      reason: "Need a fresh observation.",
    },
  );

  assert.match(prompt, /Last browser action: fill/);
  assert.match(prompt, /Last browser action target: @e21/);
  assert.match(prompt, /Last browser action value: Ada/);
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

test("default browser observations use interactive snapshots", async () => {
  const commands: string[][] = [];
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      return {
        origin: "https://www.myntra.com/",
        title: "Myntra",
        snapshot: '- textbox "Search for products" [ref=e8]\n- link "Maroon Shirt Rs. 999" [ref=e9]',
        refs: {
          e8: { role: "textbox", name: "Search for products" },
          e9: { role: "link", name: "Maroon Shirt Rs. 999" },
        },
      };
    }
    if (args.includes("fill")) {
      return { ok: true };
    }
    return { ok: true };
  };

  await executePromptBrowserRun(
    {
      request: {
        runId: "run-interactive-default",
        sessionId: "session-interactive-default",
        text: "open myntra and search for shirt",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    { runJsonCommand },
  );

  assert.ok(
    commands.some((command) => command.includes("snapshot") && command.includes("-i") && command.includes("-d") && command.includes("8")),
  );
});

test("ref-poor broad snapshot retries a focused editable snapshot before acting", async () => {
  const commands: string[][] = [];
  let call = 0;
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      call += 1;
      if (call === 1) {
        return {
          origin: "https://www.myntra.com/",
          title: "Myntra",
          snapshot: "Homepage content only",
          refs: {},
        };
      }
      return {
        origin: "https://www.myntra.com/",
        title: "Myntra",
        snapshot: '- textbox "Search for products" [ref=e8]',
        refs: {
          e8: { role: "textbox", name: "Search for products" },
        },
      };
    }
    if (args.includes("fill")) {
      return { ok: true };
    }
    return { ok: true };
  };

  await executePromptBrowserRun(
    {
      request: {
        runId: "run-focused-retry",
        sessionId: "session-focused-retry",
        text: "open myntra and search for shirt",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    { runJsonCommand },
  );

  assert.ok(
    commands.some(
      (command) =>
        command.includes("snapshot") &&
        command.includes("-s") &&
        command.includes("input, textarea, [role='searchbox'], [role='textbox'], [role='combobox'], form"),
    ),
  );
});

test("recoverable act failures in hook mode do not count as browser action progress", async () => {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      return {
        origin: "https://mail.google.com/mail/u/0/#inbox?compose=new",
        title: "Inbox",
        snapshot: '- textbox "To" [ref=e21]\n- textbox "Subject" [ref=e22]\n- textbox "Message Body" [ref=e23]',
        refs: {
          e21: { role: "textbox", name: "To" },
          e22: { role: "textbox", name: "Subject" },
          e23: { role: "textbox", name: "Message Body" },
        },
      };
    }
    return {
      ok: false,
      recoverable: true,
      requiresObservation: true,
      reason: "Do not use generic fill on this ref-rich editor surface.",
    };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-recoverable-act-failure",
        sessionId: "session-recoverable-act-failure",
        text: "send an email",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: (type, payload) => {
        events.push({ type, payload });
      },
    },
    {
      runJsonCommand,
      planNextAction: async () => ({
        action: "fill",
        ref: "@e21",
        value: "alice@example.com",
      }),
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata.terminalCode, "OBSERVATION_UNGROUNDED");
  assert.ok(events.some((event) => event.type === "run.runtime_incident"));
  assert.ok(!events.some((event) => event.type === "run.browser.action"));
});

test("recoverable act failures in hook mode can continue from a recovered scoped observation", async () => {
  let stage = 0;
  const commands: string[][] = [];

  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      if (stage >= 2) {
        return {
          origin: "https://example.com/results?size=9",
          title: "Results",
          snapshot: "Filter applied",
          refs: {},
        };
      }
      return {
        origin: "https://example.com/results",
        title: "Results",
        snapshot: '- link "Product A" [ref=e11]\n- link "Product B" [ref=e12]',
        refs: {
          e11: { role: "link", name: "Product A" },
          e12: { role: "link", name: "Product B" },
        },
      };
    }
    if (args.includes("scroll") || args.includes("scrollIntoView")) {
      stage = 1;
      return {
        ok: false,
        recoverable: true,
        requiresObservation: true,
        reason: "Use the recovered scoped catalog observation instead of generic page scroll.",
        snapshotRequest: {
          action: "snapshot",
          request: {
            interactive: true,
            compact: true,
            selector: "[role='complementary'], [role='main']",
          },
        },
        retryContract: {
          refOnly: true,
          allowedActions: ["scrollIntoView", "click", "select"],
        },
        recoveredObservation: {
          origin: "https://example.com/results",
          title: "Results",
          snapshot: '- button "Size 9" [ref=e21]\n- button "4 stars & above" [ref=e22]',
          refs: {
            e21: { role: "button", name: "Size 9" },
            e22: { role: "button", name: "4 stars & above" },
          },
        },
      };
    }
    if (args.includes("click") && args.includes("@e21")) {
      stage = 2;
      return { clicked: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-recovered-catalog-observation",
        sessionId: "session-recovered-catalog-observation",
        text: "apply the next visible catalog filter",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      runJsonCommand,
      planNextAction: async ({ snapshot }) => {
        if (stage === 0) {
          return { action: "scroll", ref: "@e11" };
        }
        if (stage === 1 && snapshot.refs && typeof snapshot.refs === "object" && "e21" in snapshot.refs) {
          return { action: "click", ref: "@e21" };
        }
        return { action: "done" };
      },
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.metadata.terminalCode, "COMPLETED");
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e21")));
  assert.ok(
    !commands.some(
      (command) =>
        command[0] === "snapshot" &&
        command.includes("-s") &&
        command.some((part) => String(part).includes("[role='complementary'], [role='main']")),
    ),
  );
});

test("observation recovery prompt tells the runtime to advance one unresolved control at a time", () => {
  const prompt = __testOnly.buildObservationRecoveryPrompt(
    {
      runId: "run-9",
      sessionId: "session-9",
      text: "complete the contact form",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
    },
    createLoopStateForRun(),
    {
      snapshotRequest: { action: "snapshot", request: { interactive: true, compact: true } },
      reason: "Need a fresh observation.",
    },
  );

  assert.match(prompt, /one unresolved control/i);
});

test("tool error recovery is triggered for grounded generic form failures", () => {
  const loopState = createLoopStateForRun();
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
    result: {
      kind: "snapshot",
      details: {
        targetId: "compose-1",
        url: "https://example.com/compose",
        title: "Compose",
        snapshot: '- textbox "To" [ref=e21]\n- textbox "Subject" [ref=e22]',
        refs: {
          e21: { role: "textbox", name: "To" },
          e22: { role: "textbox", name: "Subject" },
        },
      },
    },
  });

  const recovery = __testOnly.shouldRecoverFromToolError(
    {
      success: false,
      rows: [],
      metadata: {
        meta: {
          lastToolError: {
            toolName: "browser",
            error: "fill action is not allowed on ref-rich multi-editable surfaces",
            mutatingAction: true,
          },
        },
      },
      error: "tool failed",
    },
    loopState,
  );

  assert.ok(recovery);
  assert.equal(recovery?.toolName, "browser");
});

test("tool error recovery prompt carries live action context and forbids generic form fill", () => {
  const loopState = createLoopStateForRun();
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
    result: {
      kind: "snapshot",
      details: {
        targetId: "compose-1",
        url: "https://example.com/compose",
        title: "Compose",
        snapshot: '- textbox "To" [ref=e21]\n- textbox "Subject" [ref=e22]',
        refs: {
          e21: { role: "textbox", name: "To" },
          e22: { role: "textbox", name: "Subject" },
        },
      },
    },
  });
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.action", {
    action: "type",
    target: "@e21",
    value: "ada@example.com",
    result: { kind: "type" },
  });

  const prompt = __testOnly.buildToolErrorRecoveryPrompt(
    {
      runId: "run-tool-recovery",
      sessionId: "session-tool-recovery",
      text: "send the message",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      goalHints: {
        entities: {
          recipient: "ada@example.com",
          subject: "Hello",
        },
      },
    },
    loopState,
    {
      toolName: "browser",
      error: "fill action is not allowed on ref-rich multi-editable surfaces",
      mutatingAction: true,
    },
  );

  assert.match(prompt, /Do not use generic form-fill/i);
  assert.match(prompt, /Last browser action target: @e21/);
  assert.match(prompt, /Last browser action value: ada@example.com/);
  assert.match(prompt, /recipient: ref e21/i);
  assert.match(prompt, /subject: ref e22/i);
  assert.match(prompt, /Apply them in that order, one control at a time/i);
  assert.match(prompt, /Next required action: use type on ref e21/i);
});

test("catalog recovery prompt forces a concrete ref-backed catalog action after generic scroll failure", () => {
  const loopState = createLoopStateForRun();
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
    result: {
      kind: "snapshot",
      details: {
        targetId: "results-1",
        url: "https://example.com/catalog?q=shoes",
        title: "Catalog",
        snapshot:
          '- checkbox "Size 9" [ref=e41]\n- option "Under Rs. 3000" [ref=e42]\n- checkbox "4 Stars & Above" [ref=e43]\n- link "Black Running Shoes" [ref=e44]',
        refs: {
          e41: { role: "checkbox", name: "Size 9" },
          e42: { role: "option", name: "Under Rs. 3000" },
          e43: { role: "checkbox", name: "4 Stars & Above" },
          e44: { role: "link", name: "Black Running Shoes" },
        },
      },
    },
  });
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.action", {
    action: "scroll",
    result: { kind: "scroll" },
  });

  const prompt = __testOnly.buildToolErrorRecoveryPrompt(
    {
      runId: "run-catalog-recovery",
      sessionId: "session-catalog-recovery",
      text: "apply filters and open the first valid result",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      goalHints: {
        entities: {
          size: "9",
          price: "under 3000 INR",
          rating: "4 stars and above",
        },
      },
    },
    loopState,
    {
      toolName: "browser",
      error:
        "A generic page-level action was replaced with a scoped catalog snapshot so the next step can use concrete filter or result refs.",
      mutatingAction: true,
    },
  );

  assert.match(prompt, /The last generic catalog action already failed/i);
  assert.match(prompt, /size: click ref e41/i);
  assert.match(prompt, /price: select ref e42/i);
  assert.match(prompt, /rating: click ref e43/i);
  assert.match(prompt, /Do not use another generic scroll/i);
});

test("targeted recovery contract injects a catalog step sequence when filter refs are visible", () => {
  const loopState = createLoopStateForRun();
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
    result: {
      kind: "snapshot",
      details: {
        targetId: "results-2",
        url: "https://example.com/catalog",
        title: "Catalog",
        snapshot: '- checkbox "Size 9" [ref=e51]\n- option "Under Rs. 3000" [ref=e52]',
        refs: {
          e51: { role: "checkbox", name: "Size 9" },
          e52: { role: "option", name: "Under Rs. 3000" },
        },
      },
    },
  });

  const recoveredRequest = __testOnly.withTargetedRecoveryContract(
    {
      runId: "run-catalog-contract",
      sessionId: "session-catalog-contract",
      text: "apply the filters",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      goalHints: {
        entities: {
          size: "9",
          price: "under 3000 INR",
        },
      },
    },
    loopState,
  );

  const currentStep = recoveredRequest.goalHints?.executionContract?.current_execution_step as
    | { kind?: string; allowed_actions?: string[]; target_sequence?: Array<Record<string, unknown>> }
    | undefined;
  assert.equal(currentStep?.kind, "filter");
  assert.deepEqual(currentStep?.allowed_actions, ["snapshot", "scrollintoview", "click", "select"]);
  assert.equal(currentStep?.target_sequence?.[0]?.ref, "e51");
  assert.equal(currentStep?.target_sequence?.[1]?.ref, "e52");
});

test("targeted catalog recovery can derive filter targets from predicted plan phases", () => {
  const loopState = createLoopStateForRun();
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
    result: {
      kind: "snapshot",
      details: {
        targetId: "results-3",
        url: "https://example.com/catalog",
        title: "Catalog",
        snapshot:
          '- checkbox "Size 9" [ref=e61]\n- option "Under Rs. 3000" [ref=e62]\n- checkbox "4 Stars & Above" [ref=e63]',
        refs: {
          e61: { role: "checkbox", name: "Size 9" },
          e62: { role: "option", name: "Under Rs. 3000" },
          e63: { role: "checkbox", name: "4 Stars & Above" },
        },
      },
    },
  });

  const recoveredRequest = __testOnly.withTargetedRecoveryContract(
    {
      runId: "run-catalog-contract-2",
      sessionId: "session-catalog-contract-2",
      text: "apply the filters",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      goalHints: {
        executionContract: {
          predicted_plan: {
            phases: [
              { label: "Apply filter: size 9" },
              { label: "Apply filter: price under 3000 INR" },
              { label: "Apply filter: customer rating 4 stars and above" },
            ],
          },
        },
      },
    },
    loopState,
  );

  const currentStep = recoveredRequest.goalHints?.executionContract?.current_execution_step as
    | { target_sequence?: Array<Record<string, unknown>> }
    | undefined;
  assert.equal(currentStep?.target_sequence?.[0]?.ref, "e61");
  assert.equal(currentStep?.target_sequence?.[1]?.ref, "e62");
  assert.equal(currentStep?.target_sequence?.[2]?.ref, "e63");
});

test("targeted catalog recovery can derive filter targets directly from the prompt text", () => {
  const loopState = createLoopStateForRun();
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
    result: {
      kind: "snapshot",
      details: {
        targetId: "results-3b",
        url: "https://example.com/catalog",
        title: "Catalog",
        snapshot:
          '- checkbox "Size 9" [ref=e61]\n- option "Under Rs. 3000" [ref=e62]\n- checkbox "4 Stars & Above" [ref=e63]',
        refs: {
          e61: { role: "checkbox", name: "Size 9" },
          e62: { role: "option", name: "Under Rs. 3000" },
          e63: { role: "checkbox", name: "4 Stars & Above" },
        },
      },
    },
  });

  const recoveredRequest = __testOnly.withTargetedRecoveryContract(
    {
      runId: "run-catalog-contract-from-prompt",
      sessionId: "session-catalog-contract-from-prompt",
      text: "search for shoes, apply size 9, price under 3000 INR, and rating 4 stars and above",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      goalHints: {},
    },
    loopState,
  );

  const currentStep = recoveredRequest.goalHints?.executionContract?.current_execution_step as
    | { kind?: string; target_sequence?: Array<Record<string, unknown>> }
    | undefined;
  assert.equal(currentStep?.kind, "filter");
  assert.equal(currentStep?.target_sequence?.[0]?.ref, "e61");
  assert.equal(currentStep?.target_sequence?.[1]?.ref, "e62");
  assert.equal(currentStep?.target_sequence?.[2]?.ref, "e63");
});

test("targeted catalog recovery can choose generic visible filter controls by count", () => {
  const loopState = createLoopStateForRun();
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
    result: {
      kind: "snapshot",
      details: {
        targetId: "results-3c",
        url: "https://example.com/catalog",
        title: "Catalog",
        snapshot:
          '- heading "Size" [ref=e11]\n- checkbox "9" [ref=e12]\n- checkbox "10" [ref=e13]\n- heading "Customer Rating" [ref=e14]\n- checkbox "4 Stars & Above" [ref=e15]\n- option "Under Rs. 3000" [ref=e16]',
        refs: {
          e11: { role: "heading", name: "Size" },
          e12: { role: "checkbox", name: "9" },
          e13: { role: "checkbox", name: "10" },
          e14: { role: "heading", name: "Customer Rating" },
          e15: { role: "checkbox", name: "4 Stars & Above" },
          e16: { role: "option", name: "Under Rs. 3000" },
        },
      },
    },
  });

  const recoveredRequest = __testOnly.withTargetedRecoveryContract(
    {
      runId: "run-catalog-contract-generic-count",
      sessionId: "session-catalog-contract-generic-count",
      text: "apply 3 filters on the results page",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      goalHints: {},
    },
    loopState,
  );

  const currentStep = recoveredRequest.goalHints?.executionContract?.current_execution_step as
    | { kind?: string; target_sequence?: Array<Record<string, unknown>> }
    | undefined;
  assert.equal(currentStep?.kind, "filter");
  assert.equal(currentStep?.target_sequence?.[0]?.ref, "e12");
  assert.equal(currentStep?.target_sequence?.[1]?.ref, "e13");
  assert.equal(currentStep?.target_sequence?.[2]?.ref, "e15");
});

test("catalog target suggestions ignore product-card links that only happen to contain size and price text", () => {
  const loopState = createLoopStateForRun();
  __testOnly.rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
    result: {
      kind: "snapshot",
      details: {
        targetId: "results-4",
        url: "https://example.com/catalog",
        title: "Catalog",
        snapshot:
          '- link "Running Shoe Sizes: UK9 Rs. 2499" [ref=e71]\n- checkbox "Size 9" [ref=e72]\n- option "Under Rs. 3000" [ref=e73]',
        refs: {
          e71: { role: "link", name: "Running Shoe Sizes: UK9 Rs. 2499" },
          e72: { role: "checkbox", name: "Size 9" },
          e73: { role: "option", name: "Under Rs. 3000" },
        },
      },
    },
  });

  const recoveredRequest = __testOnly.withTargetedRecoveryContract(
    {
      runId: "run-catalog-contract-3",
      sessionId: "session-catalog-contract-3",
      text: "apply the filters",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      goalHints: {
        entities: {
          size: "9",
          price: "under 3000 INR",
        },
      },
    },
    loopState,
  );

  const currentStep = recoveredRequest.goalHints?.executionContract?.current_execution_step as
    | { target_sequence?: Array<Record<string, unknown>> }
    | undefined;
  assert.equal(currentStep?.target_sequence?.[0]?.ref, "e72");
  assert.equal(currentStep?.target_sequence?.[1]?.ref, "e73");
});

test("targeted catalog recovery injects aria scoped snapshot sequence when filter refs are not yet visible", () => {
  const loopState = createLoopStateForRun();

  const recoveredRequest = __testOnly.withTargetedRecoveryContract(
    {
      runId: "run-catalog-scoped-snapshot",
      sessionId: "session-catalog-scoped-snapshot",
      text: "apply the filters",
      browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
      context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      goalHints: {
        entities: {
          size: "9",
          price: "under 3000 INR",
        },
      },
    },
    loopState,
  );

  const currentStep = recoveredRequest.goalHints?.executionContract?.current_execution_step as
    | {
        allowed_actions?: string[];
        snapshot_sequence?: Array<Record<string, unknown>>;
      }
    | undefined;
  assert.deepEqual(currentStep?.allowed_actions, ["snapshot"]);
  assert.equal(
    currentStep?.snapshot_sequence?.[0]?.selector,
    "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], details, summary, [role='group']",
  );
  assert.equal(currentStep?.snapshot_sequence?.[0]?.snapshotFormat, "aria");
  assert.equal(currentStep?.snapshot_sequence?.[0]?.refs, "aria");
});

test("hook-based run applies scoped catalog snapshot sequence before planning actions", async () => {
  const commands: string[][] = [];
  let filterClicked = false;
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (
      args[0] === "snapshot" &&
      args.includes("-s") &&
      args.includes("fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], details, summary, [role='group']")
    ) {
      return filterClicked
        ? {
            origin: "https://example.com/catalog?q=shoes",
            title: "Catalog",
            snapshot: "Filtered results\n- link \"Black Running Shoes\" [ref=e71]",
            refs: { e71: { role: "link", name: "Black Running Shoes" } },
          }
        : {
            origin: "https://example.com/catalog?q=shoes",
            title: "Catalog",
            snapshot:
              '- checkbox "Size 9" [ref=e41]\n- option "Under Rs. 3000" [ref=e42]\n- checkbox "4 Stars & Above" [ref=e43]',
            refs: {
              e41: { role: "checkbox", name: "Size 9" },
              e42: { role: "option", name: "Under Rs. 3000" },
              e43: { role: "checkbox", name: "4 Stars & Above" },
            },
          };
    }
    if (args[0] === "snapshot") {
      return filterClicked
        ? {
            origin: "https://example.com/catalog?q=shoes",
            title: "Catalog",
            snapshot: "Filtered results",
            refs: {},
          }
        : {
            origin: "https://example.com/catalog?q=shoes",
            title: "Catalog",
            snapshot:
              '- link "Product One" [ref=e11]\n- link "Product Two" [ref=e12]\nCatalog Results',
            refs: {
              e11: { role: "link", name: "Product One" },
              e12: { role: "link", name: "Product Two" },
            },
          };
    }
    if (args.includes("click") && args.includes("@e41")) {
      filterClicked = true;
      return { clicked: true };
    }
    return { ok: true };
  };

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-catalog-main-loop",
        sessionId: "session-catalog-main-loop",
        text: "apply the catalog filters",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
        goalHints: {
          entities: {
            size: "9",
            price: "under 3000 INR",
            rating: "4 stars and above",
          },
          executionContract: {
            current_execution_step: {
              kind: "filter",
              allowed_actions: ["snapshot"],
              snapshot_sequence: [
                {
                  selector:
                    "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], details, summary, [role='group']",
                  interactive: true,
                  compact: true,
                  snapshotFormat: "aria",
                  refs: "aria",
                },
                {
                  selector:
                    "[role='search'], form, [role='list'], [role='grid'], [role='table'], [role='listbox']",
                  interactive: true,
                  compact: true,
                  snapshotFormat: "aria",
                  refs: "aria",
                },
              ],
            },
            verification_evidence: {
              checks: ["Filtered results"],
            },
          },
        },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      runJsonCommand,
      planNextAction: async ({ snapshot }) => {
        const text = String(snapshot.snapshot || "");
        if (text.includes("Size 9")) {
          return { action: "click", ref: "@e41" };
        }
        if (text.includes("Filtered results")) {
          return { action: "done" };
        }
        return { action: "scroll", amount: 400 } as unknown as Record<string, unknown>;
      },
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.metadata.terminalCode, "COMPLETED");
  assert.ok(
    commands.some(
      (command) =>
        command[0] === "snapshot" &&
        command.includes("-s") &&
        command.includes(
          "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], details, summary, [role='group']",
        ),
    ),
  );
  assert.ok(commands.some((command) => command.includes("click") && command.includes("@e41")));
  assert.equal(
    commands.some(
      (command) =>
        command[0] === "click" &&
        command.includes("@e41"),
    ),
    true,
  );
  assert.equal(
    commands.some(
      (command) =>
        command[0] === "scroll" || command[0] === "scrollIntoView",
    ),
    false,
  );
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

test("embedded runtime consumes scoped observation recovery contract once", async () => {
  const loopState = createLoopStateForRun();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  let attempt = 0;

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-recovery-1",
        sessionId: "session-recovery-1",
        text: "find the first suitable product and continue",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState,
      emit: (type, payload) => events.push({ type, payload }),
    },
    {
      prepareRun: async ({ request }) => ({ request } as never),
      prepareRetryRun: async ({ prepared }) => prepared,
      executePreparedRun: async ({ request, prepared, emit }) => {
        const effectiveRequest =
          request ??
          ((prepared as { request?: { text?: string } }).request as { text?: string } | undefined) ??
          { text: "" };
        prompts.push(effectiveRequest.text || "");
        attempt += 1;
        if (attempt === 1) {
          emit("run.tool.finished", {
            toolName: "browser",
            result: {
              details: {
                ok: false,
                recoverable: true,
                requiresObservation: true,
                reason: "No actionable refs were visible in the broad snapshot.",
                snapshotRequest: {
                  interactive: true,
                  compact: true,
                  refs: "aria",
                  selector: "[role='main'], [role='grid']",
                },
                retryGuidance: "Retry with a narrower structural observation.",
                retryContract: {
                  requiresScopedObservation: true,
                  refOnly: true,
                },
              },
            },
          });
          return {
            success: false,
            rows: [],
            metadata: { terminalCode: "EXECUTION_FAILED" },
            error: "missing refs",
          };
        }
        emit("run.tool.finished", {
          toolName: "browser",
          args: { action: "snapshot" },
          result: {
            kind: "snapshot",
            details: {
              targetId: "results",
              url: "https://example.com/results",
              title: "Results",
              refs: 1,
            },
            snapshot: "Recovered view",
            refs: { e11: { role: "button", name: "Continue" } },
            content: [{ type: "text", text: "Recovered view" }],
          },
        });
        return {
          success: true,
          rows: [{ text: "Recovered view" }],
          metadata: { terminalCode: "COMPLETED" },
        };
      },
    },
  );

  assert.equal(result.success, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Scoped observation recovery/);
  assert.match(prompts[1], /requiresScopedObservation/);
  assert.ok(
    events.some(
      (event) =>
        event.type === "run.log" &&
        String(event.payload.message || "").includes("did not produce actionable refs"),
    ),
  );
});

test("embedded runtime injects an initial scoped catalog snapshot contract before first pass", async () => {
  const prompts: string[] = [];
  const preparedRequests: Array<Record<string, unknown>> = [];

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-initial-catalog-contract",
        sessionId: "session-initial-catalog-contract",
        text: "On Myntra, search for black running shoes for men and apply size 9, price under 3000, and rating 4 stars and above.",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
        goalHints: {
          app: "Myntra",
          entities: {
            size: "9",
            price: "under 3000 INR",
            rating: "4 stars and above",
          },
          executionContract: {
            predicted_plan: {
              phases: [
                { label: "Apply filter: size 9" },
                { label: "Apply filter: price under 3000 INR" },
                { label: "Apply filter: rating 4 stars and above" },
              ],
            },
          },
        },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      prepareRun: async ({ request }) => {
        preparedRequests.push(request as Record<string, unknown>);
        return { request } as never;
      },
      prepareRetryRun: async ({ prepared }) => prepared,
      executePreparedRun: async ({ request, prepared }) => {
        const effectiveRequest =
          request ??
          ((prepared as { request?: { text?: string } }).request as { text?: string } | undefined) ??
          { text: "" };
        prompts.push(effectiveRequest.text || "");
        return {
          success: true,
          rows: [{ text: "Observed filter rail" }],
          metadata: { terminalCode: "COMPLETED" },
        };
      },
    },
  );

  assert.equal(result.success, true);
  const executionContract = preparedRequests[0]?.goalHints &&
    typeof preparedRequests[0].goalHints === "object" &&
    "executionContract" in (preparedRequests[0].goalHints as Record<string, unknown>)
      ? ((preparedRequests[0].goalHints as Record<string, unknown>).executionContract as Record<string, unknown>)
      : null;
  const currentStep = executionContract?.current_execution_step as Record<string, unknown> | undefined;
  assert.equal(currentStep?.kind, "filter");
  assert.equal((currentStep?.allowed_actions as string[] | undefined)?.[0], "snapshot");
  assert.equal(
    ((currentStep?.snapshot_sequence as Array<Record<string, unknown>> | undefined)?.[0]?.selector as string | undefined),
    "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], details, summary, [role='group']",
  );
  assert.match(prompts[0] || "", /Structured task hints/);
  assert.match(prompts[0] || "", /black running shoes for men/);
});

test("embedded runtime injects an initial scoped catalog snapshot contract for generic filter counts", async () => {
  const preparedRequests: Array<Record<string, unknown>> = [];

  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-initial-catalog-count-contract",
        sessionId: "session-initial-catalog-count-contract",
        text: "Search an ecommerce site, apply 3 filters, open first valid product, add to cart, stop at payment confirmation.",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
        goalHints: {
          app: "Myntra",
        },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      prepareRun: async ({ request }) => {
        preparedRequests.push(request as Record<string, unknown>);
        return { request } as never;
      },
      prepareRetryRun: async ({ prepared }) => prepared,
      executePreparedRun: async () => ({
        success: true,
        rows: [{ text: "Observed filter rail" }],
        metadata: { terminalCode: "COMPLETED" },
      }),
    },
  );

  assert.equal(result.success, true);
  const executionContract = preparedRequests[0]?.goalHints &&
    typeof preparedRequests[0].goalHints === "object" &&
    "executionContract" in (preparedRequests[0].goalHints as Record<string, unknown>)
      ? ((preparedRequests[0].goalHints as Record<string, unknown>).executionContract as Record<string, unknown>)
      : null;
  const currentStep = executionContract?.current_execution_step as Record<string, unknown> | undefined;
  assert.equal(currentStep?.kind, "filter");
  assert.equal((currentStep?.allowed_actions as string[] | undefined)?.[0], "snapshot");
  assert.equal((currentStep?.target_constraints as Record<string, unknown> | undefined)?.filter_count, 3);
});

test("scoped observation recovery escalates when refs are still missing after retry", async () => {
  const loopState = createLoopStateForRun();
  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-recovery-2",
        sessionId: "session-recovery-2",
        text: "continue the live browser workflow",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState,
      emit: () => {},
    },
    {
      prepareRun: async ({ request }) => ({ request } as never),
      prepareRetryRun: async ({ prepared }) => prepared,
      executePreparedRun: async ({ emit }) => {
        emit("run.tool.finished", {
          toolName: "browser",
          result: {
            details: {
              ok: false,
              recoverable: true,
              requiresObservation: true,
              reason: "No actionable refs were visible in the broad snapshot.",
              snapshotRequest: {
                interactive: true,
                compact: true,
                refs: "aria",
                selector: "[role='main'], [role='grid']",
              },
            },
          },
        });
        return {
          success: false,
          rows: [],
          metadata: { terminalCode: "EXECUTION_FAILED" },
          error: "missing refs",
        };
      },
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata.terminalCode, "OBSERVATION_UNGROUNDED");
  assert.equal(loopState.terminalIncident?.code, "OBSERVATION_UNGROUNDED");
});

test("fresh observation is required after the last mutating browser action", () => {
  const loopState = createLoopStateForRun();
  loopState.lastBrowserObservation = {
    capturedAt: "2026-03-14T10:00:00.000Z",
    snapshotText: "Before click",
  };
  loopState.lastBrowserAction = {
    capturedAt: "2026-03-14T10:00:01.000Z",
    operation: "click",
    mutating: true,
  };

  assert.equal(__testOnly.hasFreshObservationAfterLastMutation(loopState), false);
});

test("completion confidence allows terminal success after a post-action observation", () => {
  const loopState = createLoopStateForRun();
  loopState.lastBrowserAction = {
    capturedAt: "2026-03-14T10:00:01.000Z",
    operation: "click",
    mutating: true,
  };
  loopState.lastBrowserObservation = {
    capturedAt: "2026-03-14T10:00:02.000Z",
    snapshotText: "Pricing page",
  };

  assert.equal(__testOnly.hasFreshObservationAfterLastMutation(loopState), true);
});

test("repeated no-op mutating action is suppressed and marked stalled", async () => {
  const commands: string[][] = [];
  const incidents: Array<Record<string, unknown>> = [];
  const runJsonCommand = async (args: string[]): Promise<Record<string, unknown>> => {
    commands.push(args);
    if (args.includes("connect")) {
      return { launched: true };
    }
    if (args.includes("snapshot")) {
      return {
        origin: "https://example.com/",
        title: "Example",
        snapshot: '- button "Continue" [ref=e11]',
        refs: { e11: { role: "button", name: "Continue" } },
      };
    }
    if (args.includes("click") && args.includes("@e11")) {
      return { clicked: true };
    }
    return { ok: true };
  };

  let decisionCalls = 0;
  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-11",
        sessionId: "session-11",
        text: "click continue",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: (type, payload) => {
        if (type === "run.runtime_incident") {
          incidents.push(payload);
        }
      },
    },
    {
      runJsonCommand,
      planNextAction: async () => {
        decisionCalls += 1;
        if (decisionCalls <= 2) {
          return {
            action: "click",
            reason: "Continue is still visible.",
            requiresHuman: false,
            ref: "@e11",
          };
        }
        return null;
      },
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata.terminalCode, "ACTION_STALLED");
  assert.equal(
    commands.filter((command) => command.includes("click") && command.includes("@e11")).length,
    1,
  );
  assert.ok(incidents.some((payload) => payload.code === "ACTION_STALLED"));
});

test("explicit verifier evidence can complete a run even when refs remain", async () => {
  let clicked = false;
  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-12",
        sessionId: "session-12",
        text: "submit the order",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
        goalHints: {
          executionContract: {
            verification_evidence: {
              checks: ["Order submitted"],
            },
          },
        },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      runJsonCommand: async (args) => {
        if (args.includes("connect")) {
          return { launched: true };
        }
        if (args.includes("snapshot")) {
          return clicked
            ? {
                origin: "https://example.com/orders",
                title: "Orders",
                snapshot: 'Order submitted\n- link "View receipt" [ref=e21]',
                refs: { e21: { role: "link", name: "View receipt" } },
              }
            : {
                origin: "https://example.com/checkout",
                title: "Checkout",
                snapshot: '- button "Submit order" [ref=e11]',
                refs: { e11: { role: "button", name: "Submit order" } },
              };
        }
        if (args.includes("click") && args.includes("@e11")) {
          clicked = true;
          return { clicked: true };
        }
        return { ok: true };
      },
      planNextAction: async ({ snapshot }) => {
        if (String(snapshot.snapshot || "").includes("Submit order")) {
          return {
            action: "click",
            reason: "Submit the order.",
            requiresHuman: false,
            ref: "@e11",
          };
        }
        return {
          action: "done",
          reason: "Submission confirmation is visible.",
          requiresHuman: false,
        };
      },
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.metadata.terminalCode, "COMPLETED");
});

test("done is not trusted when explicit verifier evidence is missing", async () => {
  let clicked = false;
  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-13",
        sessionId: "session-13",
        text: "submit the order",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
        goalHints: {
          executionContract: {
            verification_evidence: {
              checks: ["Order submitted"],
            },
          },
        },
      },
      loopState: createLoopStateForRun(),
      emit: () => {},
    },
    {
      runJsonCommand: async (args) => {
        if (args.includes("connect")) {
          return { launched: true };
        }
        if (args.includes("snapshot")) {
          return clicked
            ? {
                origin: "https://example.com/orders",
                title: "Orders",
                snapshot: "Thanks for your request",
                refs: {},
              }
            : {
                origin: "https://example.com/checkout",
                title: "Checkout",
                snapshot: '- button "Submit order" [ref=e11]',
                refs: { e11: { role: "button", name: "Submit order" } },
              };
        }
        if (args.includes("click") && args.includes("@e11")) {
          clicked = true;
          return { clicked: true };
        }
        return { ok: true };
      },
      planNextAction: async ({ snapshot }) => {
        if (String(snapshot.snapshot || "").includes("Submit order")) {
          return {
            action: "click",
            reason: "Submit the order.",
            requiresHuman: false,
            ref: "@e11",
          };
        }
        return {
          action: "done",
          reason: "The task appears complete.",
          requiresHuman: false,
        };
      },
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata.terminalCode, "OBSERVATION_EXHAUSTED");
});

test("mid-task auth surface is escalated as auth required", async () => {
  let clicked = false;
  const incidents: Array<Record<string, unknown>> = [];
  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-14",
        sessionId: "session-14",
        text: "go to pricing",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: (type, payload) => {
        if (type === "run.runtime_incident") {
          incidents.push(payload);
        }
      },
    },
    {
      runJsonCommand: async (args) => {
        if (args.includes("connect")) {
          return { launched: true };
        }
        if (args.includes("snapshot")) {
          return clicked
            ? {
                origin: "https://accounts.google.com/signin",
                title: "Sign in - Google Accounts",
                snapshot: 'Choose an account\nSign in\n- button "Continue" [ref=e21]',
                refs: { e21: { role: "button", name: "Continue" } },
              }
            : {
                origin: "https://example.com/",
                title: "Example",
                snapshot: '- link "Pricing" [ref=e11]',
                refs: { e11: { role: "link", name: "Pricing" } },
              };
        }
        if (args.includes("click") && args.includes("@e11")) {
          clicked = true;
          return { clicked: true };
        }
        return { ok: true };
      },
      planNextAction: async ({ snapshot }) => {
        if (String(snapshot.snapshot || "").includes("Pricing")) {
          return {
            action: "click",
            reason: "Open pricing.",
            requiresHuman: false,
            ref: "@e11",
          };
        }
        return null;
      },
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata.terminalCode, "AUTH_REQUIRED");
  assert.ok(incidents.some((payload) => payload.code === "AUTH_REQUIRED"));
});

test("mid-task consent surface is escalated as human required", async () => {
  let clicked = false;
  const incidents: Array<Record<string, unknown>> = [];
  const result = await executePromptBrowserRun(
    {
      request: {
        runId: "run-15",
        sessionId: "session-15",
        text: "go to pricing",
        browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
      },
      loopState: createLoopStateForRun(),
      emit: (type, payload) => {
        if (type === "run.runtime_incident") {
          incidents.push(payload);
        }
      },
    },
    {
      runJsonCommand: async (args) => {
        if (args.includes("connect")) {
          return { launched: true };
        }
        if (args.includes("snapshot")) {
          return clicked
            ? {
                origin: "https://example.com/oauth",
                title: "Permissions",
                snapshot: 'Permissions requested\nAllow access\n- button "Allow access" [ref=e22]',
                refs: { e22: { role: "button", name: "Allow access" } },
              }
            : {
                origin: "https://example.com/",
                title: "Example",
                snapshot: '- link "Pricing" [ref=e11]',
                refs: { e11: { role: "link", name: "Pricing" } },
              };
        }
        if (args.includes("click") && args.includes("@e11")) {
          clicked = true;
          return { clicked: true };
        }
        return { ok: true };
      },
      planNextAction: async ({ snapshot }) => {
        if (String(snapshot.snapshot || "").includes("Pricing")) {
          return {
            action: "click",
            reason: "Open pricing.",
            requiresHuman: false,
            ref: "@e11",
          };
        }
        return null;
      },
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata.terminalCode, "HUMAN_REQUIRED");
  assert.ok(incidents.some((payload) => payload.code === "HUMAN_REQUIRED"));
});
