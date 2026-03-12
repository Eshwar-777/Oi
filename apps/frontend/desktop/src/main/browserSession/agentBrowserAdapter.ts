import { execFile } from "child_process";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import type { BrowserPageTarget, BrowserSessionAdapter, BrowserSessionFrame, BrowserSessionInputPayload } from "./adapter";

const execFileAsync = promisify(execFile);
const AGENT_BROWSER_PACKAGE_JSON_PATH = require.resolve("agent-browser/package.json");
const AGENT_BROWSER_PACKAGE = JSON.parse(
  readFileSync(AGENT_BROWSER_PACKAGE_JSON_PATH, "utf8"),
) as { version?: string };
function resolveAgentBrowserBinaryPath(): string {
  const platform = process.platform;
  const arch = process.arch;
  let osKey: string;
  if (platform === "darwin") {
    osKey = "darwin";
  } else if (platform === "linux") {
    osKey = "linux";
  } else if (platform === "win32") {
    osKey = "win32";
  } else {
    throw new Error(`Unsupported platform for agent-browser: ${platform}`);
  }

  let archKey: string;
  if (arch === "x64") {
    archKey = "x64";
  } else if (arch === "arm64") {
    archKey = "arm64";
  } else {
    throw new Error(`Unsupported architecture for agent-browser: ${arch}`);
  }

  const ext = osKey === "win32" ? ".exe" : "";
  return join(dirname(AGENT_BROWSER_PACKAGE_JSON_PATH), "bin", `agent-browser-${osKey}-${archKey}${ext}`);
}

const AGENT_BROWSER_BINARY_PATH = resolveAgentBrowserBinaryPath();

interface AgentBrowserResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface AgentBrowserTabListData {
  tabs?: Array<{
    index: number;
    url: string;
    title: string;
    active: boolean;
  }>;
  active?: number;
}

interface AgentBrowserScreenshotData {
  path?: string;
}

interface AgentBrowserUrlData {
  url?: string;
}

interface AgentBrowserTitleData {
  title?: string;
}

function buildSessionName(cdpUrl: string): string {
  const digest = createHash("sha256").update(cdpUrl).digest("hex").slice(0, 16);
  return `oi-runner-${digest}`;
}

function parseAgentBrowserJson<T>(output: string): AgentBrowserResponse<T> {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("agent-browser returned empty output");
  }

  try {
    return JSON.parse(trimmed) as AgentBrowserResponse<T>;
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]!) as AgentBrowserResponse<T>;
      } catch {
        continue;
      }
    }
    throw new Error(`Could not parse agent-browser JSON output: ${trimmed}`);
  }
}

async function runAgentBrowserCommand<T>(sessionName: string, args: string[]): Promise<T> {
  const command = [AGENT_BROWSER_BINARY_PATH, "--session", sessionName, "--json", ...args];
  const startedAt = Date.now();
  console.info("[agent-browser][runner] exec", JSON.stringify({ sessionName, args }));
  try {
    const { stdout, stderr } = await execFileAsync(
      command[0]!,
      command.slice(1),
      {
        env: {
          ...process.env,
          AGENT_BROWSER_JSON: "1",
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    console.info(
      "[agent-browser][runner] done",
      JSON.stringify({
        sessionName,
        args,
        duration_ms: Date.now() - startedAt,
        stdout: (stdout || "").trim().slice(0, 2000),
        stderr: (stderr || "").trim().slice(0, 2000),
      }),
    );

    const response = parseAgentBrowserJson<T>(stdout || stderr);
    if (!response.success) {
      throw new Error(response.error || `agent-browser ${args[0]} failed`);
    }
    return (response.data ?? {}) as T;
  } catch (error) {
    const failed = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout =
      typeof failed.stdout === "string"
        ? failed.stdout
        : Buffer.isBuffer(failed.stdout)
          ? failed.stdout.toString("utf8")
          : "";
    const stderr =
      typeof failed.stderr === "string"
        ? failed.stderr
        : Buffer.isBuffer(failed.stderr)
          ? failed.stderr.toString("utf8")
          : "";
    console.error(
      "[agent-browser][runner] failed",
      JSON.stringify({
        sessionName,
        args,
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        stdout: stdout.trim().slice(0, 4000),
        stderr: stderr.trim().slice(0, 4000),
      }),
    );
    throw error;
  }
}

export class AgentBrowserSessionAdapter implements BrowserSessionAdapter {
  readonly kind = "agent_browser";
  readonly runtime = "agent-browser";
  readonly version = AGENT_BROWSER_PACKAGE.version ?? "unknown";

  private readonly connectedTargets = new Map<string, string>();
  private readonly sessionQueues = new Map<string, Promise<unknown>>();

  private async withSessionLock<T>(sessionName: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionName) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.sessionQueues.set(sessionName, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionQueues.get(sessionName) === queued) {
        this.sessionQueues.delete(sessionName);
      }
    }
  }

  private async ensureConnected(cdpUrl: string): Promise<string> {
    const sessionName = buildSessionName(cdpUrl);
    await this.withSessionLock(sessionName, async () => {
      if (this.connectedTargets.get(sessionName) === cdpUrl) {
        return;
      }
      await runAgentBrowserCommand(sessionName, ["connect", cdpUrl]);
      this.connectedTargets.set(sessionName, cdpUrl);
    });
    this.connectedTargets.set(sessionName, cdpUrl);
    return sessionName;
  }

  async listPages(cdpUrl: string): Promise<BrowserPageTarget[]> {
    const sessionName = await this.ensureConnected(cdpUrl);
    return await this.withSessionLock(sessionName, async () => {
      const result = await runAgentBrowserCommand<AgentBrowserTabListData>(sessionName, ["tab"]);
      return (result.tabs ?? []).map((tab) => ({
        id: String(tab.index),
        title: tab.title,
        url: tab.url,
        type: "page",
        active: tab.active,
      }));
    });
  }

  async captureFrame(cdpUrl: string): Promise<BrowserSessionFrame | null> {
    const sessionName = await this.ensureConnected(cdpUrl);
    return await this.withSessionLock(sessionName, async () => {
      const tabs = await runAgentBrowserCommand<AgentBrowserTabListData>(sessionName, ["tab"]);
      const mappedTabs = (tabs.tabs ?? []).map((tab) => ({
          id: String(tab.index),
          title: tab.title,
          url: tab.url,
          active: tab.active,
      }));
      const activePage = mappedTabs.find((page) => page.active) ?? mappedTabs[0];
      const screenshot = await runAgentBrowserCommand<AgentBrowserScreenshotData>(sessionName, ["screenshot"]);
      if (!screenshot.path) {
        return null;
      }
      const [urlResult, titleResult, image] = await Promise.all([
        runAgentBrowserCommand<AgentBrowserUrlData>(sessionName, ["get", "url"]),
        runAgentBrowserCommand<AgentBrowserTitleData>(sessionName, ["get", "title"]),
        readFile(screenshot.path),
      ]);
      const viewport = await runAgentBrowserCommand<{ result?: { viewport?: { width?: number; height?: number; dpr?: number } } }>(
        sessionName,
        ["javascript", "() => ({ viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 } })"],
      )
        .then((result) => result?.result?.viewport)
        .catch(() => undefined);
      return {
        screenshot: `data:image/png;base64,${image.toString("base64")}`,
        current_url: urlResult.url ?? activePage?.url ?? "",
        page_title: titleResult.title ?? activePage?.title ?? "",
        page_id: activePage?.id ?? "0",
        viewport:
          viewport?.width && viewport?.height
            ? {
                width: Math.round(viewport.width),
                height: Math.round(viewport.height),
                dpr: typeof viewport.dpr === "number" && Number.isFinite(viewport.dpr) ? viewport.dpr : 1,
              }
            : undefined,
      };
    });
  }

  async navigate(cdpUrl: string, url: string): Promise<void> {
    const sessionName = await this.ensureConnected(cdpUrl);
    await this.withSessionLock(sessionName, async () => {
      await runAgentBrowserCommand(sessionName, ["open", url]);
    });
  }

  async activatePage(
    cdpUrl: string,
    target: { pageId?: string; url?: string; title?: string; tabIndex?: number },
  ): Promise<void> {
    const sessionName = await this.ensureConnected(cdpUrl);
    await this.withSessionLock(sessionName, async () => {
      const tabs = await runAgentBrowserCommand<AgentBrowserTabListData>(sessionName, ["tab"]);
      const candidates = tabs.tabs ?? [];
      let matched =
        typeof target.tabIndex === "number" && Number.isFinite(target.tabIndex)
          ? candidates.find((tab) => tab.index === target.tabIndex)
          : undefined;
      if (!matched && typeof target.url === "string" && target.url.trim().length > 0) {
        matched = candidates.find((tab) => tab.url === target.url!.trim());
      }
      if (!matched && typeof target.title === "string" && target.title.trim().length > 0) {
        matched = candidates.find((tab) => tab.title === target.title!.trim());
      }
      if (!matched) {
        throw new Error("Could not find agent-browser tab to activate");
      }
      await runAgentBrowserCommand(sessionName, ["tab", String(matched.index)]);
    });
  }

  async openTab(cdpUrl: string, url?: string): Promise<void> {
    const sessionName = await this.ensureConnected(cdpUrl);
    await this.withSessionLock(sessionName, async () => {
      const args = ["tab", "new"];
      if (typeof url === "string" && url.trim().length > 0) {
        args.push(url.trim());
      }
      await runAgentBrowserCommand(sessionName, args);
    });
  }

  async dispatchInput(cdpUrl: string, payload: BrowserSessionInputPayload): Promise<void> {
    const sessionName = await this.ensureConnected(cdpUrl);
    const x = typeof payload.x === "number" ? String(Math.round(payload.x)) : "0";
    const y = typeof payload.y === "number" ? String(Math.round(payload.y)) : "0";
    const button = payload.button ?? "left";

    await this.withSessionLock(sessionName, async () => {
      if (payload.input_type === "click") {
        await runAgentBrowserCommand(sessionName, ["mouse", "move", x, y]);
        await runAgentBrowserCommand(sessionName, ["mouse", "down", button]);
        await runAgentBrowserCommand(sessionName, ["mouse", "up", button]);
        return;
      }

      if (payload.input_type === "move") {
        await runAgentBrowserCommand(sessionName, ["mouse", "move", x, y]);
        return;
      }

      if (payload.input_type === "mouse_down") {
        await runAgentBrowserCommand(sessionName, ["mouse", "move", x, y]);
        await runAgentBrowserCommand(sessionName, ["mouse", "down", button]);
        return;
      }

      if (payload.input_type === "mouse_up") {
        await runAgentBrowserCommand(sessionName, ["mouse", "move", x, y]);
        await runAgentBrowserCommand(sessionName, ["mouse", "up", button]);
        return;
      }

      if (payload.input_type === "scroll") {
        await runAgentBrowserCommand(sessionName, ["mouse", "move", x, y]);
        await runAgentBrowserCommand(sessionName, [
          "mouse",
          "wheel",
          String(Math.round(payload.delta_y ?? 480)),
          String(Math.round(payload.delta_x ?? 0)),
        ]);
        return;
      }

      if (payload.input_type === "type" && typeof payload.text === "string" && payload.text.length > 0) {
        await runAgentBrowserCommand(sessionName, ["keyboard", "inserttext", payload.text]);
        return;
      }

      if (payload.input_type === "keypress" && typeof payload.key === "string" && payload.key.length > 0) {
        await runAgentBrowserCommand(sessionName, ["press", payload.key]);
      }
    });
  }
}
