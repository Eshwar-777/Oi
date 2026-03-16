import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import { join } from "path";
import { promisify } from "util";
import type {
  BrowserPageTarget,
  BrowserSessionAdapter,
  BrowserSessionFrame,
  BrowserSessionInputPayload,
  BrowserSessionTargetSelector,
} from "./adapter";
import { CdpBrowserSessionAdapter } from "./cdpAdapter";

const execFileAsync = promisify(execFile);

const RUNNER_ORIGIN = process.env.OI_RUNNER_ORIGIN === "server_runner" ? "server_runner" : "local_runner";
const MAC_APP_NAME = process.env.OI_RUNNER_WINDOW_APP_NAME?.trim() || "Google Chrome";
const DISPLAY_NAME = process.env.DISPLAY || process.env.OI_RUNNER_X_DISPLAY || ":99";
const DISPLAY_WIDTH = Number(process.env.OI_RUNNER_DISPLAY_WIDTH || "1440");
const DISPLAY_HEIGHT = Number(process.env.OI_RUNNER_DISPLAY_HEIGHT || "960");
const STREAM_MAX_WIDTH = Number(process.env.OI_RUNNER_STREAM_MAX_WIDTH || "1280");
const STREAM_JPEG_QUALITY = Number(process.env.OI_RUNNER_STREAM_JPEG_QUALITY || "58");

const MAC_HELPER_SOURCE = String.raw`
import Foundation
import CoreGraphics
import AppKit

struct WindowInfo: Codable {
  let windowId: UInt32
  let x: Int
  let y: Int
  let width: Int
  let height: Int
  let ownerName: String
  let title: String
}

func describeWindow(appName: String) -> WindowInfo? {
  guard let infoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  for item in infoList {
    guard let ownerName = item[kCGWindowOwnerName as String] as? String, ownerName == appName else { continue }
    let layer = item[kCGWindowLayer as String] as? Int ?? 0
    if layer != 0 { continue }
    guard let boundsDict = item[kCGWindowBounds as String] as? [String: Any] else { continue }
    let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) ?? .zero
    if bounds.width < 60 || bounds.height < 60 { continue }
    let windowId = item[kCGWindowNumber as String] as? UInt32 ?? 0
    let title = item[kCGWindowName as String] as? String ?? ""
    return WindowInfo(
      windowId: windowId,
      x: Int(bounds.origin.x.rounded()),
      y: Int(bounds.origin.y.rounded()),
      width: Int(bounds.width.rounded()),
      height: Int(bounds.height.rounded()),
      ownerName: ownerName,
      title: title
    )
  }
  return nil
}

func captureWindow(windowId: UInt32, outputPath: String) throws {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", "-l", String(windowId), "-t", "jpg", outputPath]
  let stderr = Pipe()
  process.standardError = stderr
  try process.run()
  process.waitUntilExit()
  if process.terminationStatus != 0 {
    let data = stderr.fileHandleForReading.readDataToEndOfFile()
    let message = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    throw NSError(domain: "capture", code: Int(process.terminationStatus), userInfo: [
      NSLocalizedDescriptionKey: message?.isEmpty == false ? message! : "capture_failed"
    ])
  }
}

func activateApp(named appName: String) {
  let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome")
  if let app = apps.first {
    app.activate()
    usleep(90000)
    return
  }
  if let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == appName }) {
    app.activate()
    usleep(90000)
  }
}

func postMouse(type: CGEventType, x: Double, y: Double, button: CGMouseButton) {
  let point = CGPoint(x: x, y: y)
  let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  event?.post(tap: .cghidEventTap)
}

func click(buttonName: String, x: Double, y: Double) {
  let button: CGMouseButton
  switch buttonName {
  case "right":
    button = .right
  case "middle":
    button = .center
  default:
    button = .left
  }
  let downType: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
  let upType: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
  postMouse(type: downType, x: x, y: y, button: button)
  usleep(16000)
  postMouse(type: upType, x: x, y: y, button: button)
}

func mouseDown(buttonName: String, x: Double, y: Double) {
  let button: CGMouseButton = buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
  let eventType: CGEventType = button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
  postMouse(type: eventType, x: x, y: y, button: button)
}

func mouseUp(buttonName: String, x: Double, y: Double) {
  let button: CGMouseButton = buttonName == "right" ? .right : buttonName == "middle" ? .center : .left
  let eventType: CGEventType = button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
  postMouse(type: eventType, x: x, y: y, button: button)
}

func mouseMove(x: Double, y: Double) {
  postMouse(type: .mouseMoved, x: x, y: y, button: .left)
}

func scroll(deltaX: Int32, deltaY: Int32) {
  let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0)
  event?.post(tap: .cghidEventTap)
}

func keyCode(for key: String) -> CGKeyCode? {
  switch key.lowercased() {
  case "enter", "return":
    return 36
  case "tab":
    return 48
  case "space":
    return 49
  case "escape", "esc":
    return 53
  case "backspace", "delete":
    return 51
  case "left":
    return 123
  case "right":
    return 124
  case "down":
    return 125
  case "up":
    return 126
  default:
    return nil
  }
}

func typeText(_ text: String) {
  for scalar in text.unicodeScalars {
    let chars = String(scalar)
    let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: chars.utf16.count, unicodeString: Array(chars.utf16))
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: chars.utf16.count, unicodeString: Array(chars.utf16))
    up?.post(tap: .cghidEventTap)
    usleep(5000)
  }
}

func pressKey(_ key: String) {
  if let code = keyCode(for: key) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    up?.post(tap: .cghidEventTap)
    return
  }
  typeText(key)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  fputs("usage: mac-helper <command> <appName> [...args]\n", stderr)
  exit(2)
}

let command = args[1]
let appName = args[2]

switch command {
case "describe":
  guard let info = describeWindow(appName: appName) else {
    fputs("window_not_found\n", stderr)
    exit(1)
  }
  let data = try JSONEncoder().encode(info)
  FileHandle.standardOutput.write(data)
case "capture":
  guard args.count >= 4 else {
    fputs("missing_output_path\n", stderr)
    exit(2)
  }
  guard let info = describeWindow(appName: appName) else {
    fputs("window_not_found\n", stderr)
    exit(1)
  }
  do {
    try captureWindow(windowId: info.windowId, outputPath: args[3])
  } catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
  }
case "click":
  activateApp(named: appName)
  click(buttonName: args[5], x: Double(args[3]) ?? 0, y: Double(args[4]) ?? 0)
case "move":
  activateApp(named: appName)
  mouseMove(x: Double(args[3]) ?? 0, y: Double(args[4]) ?? 0)
case "mouse_down":
  activateApp(named: appName)
  mouseDown(buttonName: args[5], x: Double(args[3]) ?? 0, y: Double(args[4]) ?? 0)
case "mouse_up":
  activateApp(named: appName)
  mouseUp(buttonName: args[5], x: Double(args[3]) ?? 0, y: Double(args[4]) ?? 0)
case "scroll":
  activateApp(named: appName)
  mouseMove(x: Double(args[3]) ?? 0, y: Double(args[4]) ?? 0)
  scroll(deltaX: Int32(args[5]) ?? 0, deltaY: Int32(args[6]) ?? 0)
case "type":
  activateApp(named: appName)
  typeText(args[3])
case "keypress":
  activateApp(named: appName)
  pressKey(args[3])
default:
  fputs("unknown_command\n", stderr)
  exit(2)
}
`;

interface MacWindowInfo {
  windowId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  ownerName: string;
  title: string;
}

let cachedMacHelperSourcePath: string | null = null;
let cachedMacHelperBinaryPath: string | null = null;

async function ensureMacHelper(): Promise<string> {
  if (cachedMacHelperBinaryPath) return cachedMacHelperBinaryPath;
  const helperDir = join(os.homedir(), "Library", "Application Support", "Oye", "WindowHelper");
  const bundleDir = join(helperDir, "OyeWindowHelper.app");
  const contentsDir = join(bundleDir, "Contents");
  const macOsDir = join(contentsDir, "MacOS");
  const resourcesDir = join(contentsDir, "Resources");
  await mkdir(macOsDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });
  const sourcePath = join(resourcesDir, "mac-window-helper.swift");
  const binaryPath = join(macOsDir, "OyeWindowHelper");
  const plistPath = join(contentsDir, "Info.plist");
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Oye Window Helper</string>
  <key>CFBundleExecutable</key>
  <string>OyeWindowHelper</string>
  <key>CFBundleIdentifier</key>
  <string>com.oye.windowhelper</string>
  <key>CFBundleName</key>
  <string>OyeWindowHelper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
  await writeFile(plistPath, infoPlist, "utf8");
  await writeFile(sourcePath, MAC_HELPER_SOURCE, "utf8");
  await execFileAsync("/usr/bin/xcrun", ["swiftc", sourcePath, "-o", binaryPath], {
    maxBuffer: 32 * 1024 * 1024,
  });
  cachedMacHelperSourcePath = sourcePath;
  cachedMacHelperBinaryPath = binaryPath;
  return binaryPath;
}

async function runMacHelper(args: string[]): Promise<string> {
  const helperBinary = await ensureMacHelper();
  const { stdout, stderr } = await execFileAsync(helperBinary, args, {
    maxBuffer: 8 * 1024 * 1024,
  });
  if (stderr?.trim()) {
    console.info("[window-adapter] mac-helper stderr", stderr.trim());
  }
  return stdout.trim();
}

async function getMacWindowInfo(appName: string): Promise<MacWindowInfo> {
  const output = await runMacHelper(["describe", appName]);
  return JSON.parse(output) as MacWindowInfo;
}

async function captureMacWindow(appName: string): Promise<{ screenshot: string; viewport: { width: number; height: number; dpr: number } }> {
  const info = await getMacWindowInfo(appName);
  const tempDir = await mkdtemp(join(os.tmpdir(), "oye-window-shot-"));
  const imagePath = join(tempDir, "window.jpg");
  try {
    await runMacHelper(["capture", appName, imagePath]);
    const buffer = await readFile(imagePath);
    return {
      screenshot: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      viewport: {
        width: info.width,
        height: info.height,
        dpr: 1,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runLinuxCommand(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(args[0]!, args.slice(1), {
    env: {
      ...process.env,
      DISPLAY: DISPLAY_NAME,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function captureLinuxDisplay(): Promise<{ screenshot: string; viewport: { width: number; height: number; dpr: number } }> {
  const tempDir = await mkdtemp(join(os.tmpdir(), "oye-display-shot-"));
  const imagePath = join(tempDir, "display.jpg");
  try {
    const resizeArg =
      STREAM_MAX_WIDTH > 0 && DISPLAY_WIDTH > STREAM_MAX_WIDTH
        ? `${STREAM_MAX_WIDTH}x`
        : null;
    const args = ["-display", DISPLAY_NAME, "-window", "root"];
    if (resizeArg) {
      args.push("-resize", resizeArg);
    }
    args.push("-quality", String(STREAM_JPEG_QUALITY), "jpg:" + imagePath);
    await execFileAsync("import", args, {
      env: {
        ...process.env,
        DISPLAY: DISPLAY_NAME,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    const buffer = await readFile(imagePath);
    return {
      screenshot: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      viewport: {
        width: DISPLAY_WIDTH,
        height: DISPLAY_HEIGHT,
        dpr: 1,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buttonToLinuxCode(button: BrowserSessionInputPayload["button"]): string {
  if (button === "right") return "3";
  if (button === "middle") return "2";
  return "1";
}

export class WindowBrowserSessionAdapter implements BrowserSessionAdapter {
  readonly kind = "window";
  readonly runtime = RUNNER_ORIGIN === "server_runner" ? "browser_window_x11" : "browser_window_native";
  readonly version = process.platform;
  private readonly cdp = new CdpBrowserSessionAdapter();
  private nativeCaptureDisabled = false;

  getCaptureMode() {
    return this.nativeCaptureDisabled ? ("page_surface" as const) : ("browser_window" as const);
  }

  async listPages(cdpUrl: string): Promise<BrowserPageTarget[]> {
    return await this.cdp.listPages(cdpUrl);
  }

  async captureFrame(cdpUrl: string, selector?: BrowserSessionTargetSelector): Promise<BrowserSessionFrame | null> {
    if (selector && (selector.pageId || selector.tabIndex !== undefined || selector.url || selector.title)) {
      await this.cdp.activatePage(cdpUrl, selector).catch(() => {});
    }
    const pages = await this.cdp.listPages(cdpUrl).catch(() => []);
    const activePage = pages.find((page) => page.active) ?? pages[0];
    if (this.nativeCaptureDisabled) {
      return await this.cdp.captureFrame(cdpUrl, selector);
    }
    try {
      if (process.platform === "darwin" && RUNNER_ORIGIN === "local_runner") {
        const captured = await captureMacWindow(MAC_APP_NAME);
        return {
          screenshot: captured.screenshot,
          current_url: activePage?.url || "",
          page_title: activePage?.title || MAC_APP_NAME,
          page_id: activePage?.id || "window",
          viewport: captured.viewport,
        };
      }
      if (RUNNER_ORIGIN === "server_runner" && process.platform === "linux") {
        const captured = await captureLinuxDisplay();
        return {
          screenshot: captured.screenshot,
          current_url: activePage?.url || "",
          page_title: activePage?.title || "Remote Chrome",
          page_id: activePage?.id || "window",
          viewport: captured.viewport,
        };
      }
    } catch (error) {
      console.error("[window-adapter] native capture failed", error);
      this.nativeCaptureDisabled = true;
    }
    return await this.cdp.captureFrame(cdpUrl, selector);
  }

  async activatePage(cdpUrl: string, target: BrowserSessionTargetSelector): Promise<void> {
    await this.cdp.activatePage(cdpUrl, target);
  }

  async navigate(cdpUrl: string, url: string): Promise<void> {
    await this.cdp.navigate(cdpUrl, url);
  }

  async openTab(cdpUrl: string, url?: string): Promise<void> {
    await this.cdp.openTab(cdpUrl, url);
  }

  async dispatchInput(cdpUrl: string, payload: BrowserSessionInputPayload, selector?: BrowserSessionTargetSelector): Promise<void> {
    if (process.platform === "darwin" && RUNNER_ORIGIN === "local_runner") {
      const info = await getMacWindowInfo(MAC_APP_NAME);
      const absoluteX = Math.max(0, Math.round(info.x + (payload.x ?? 0)));
      const absoluteY = Math.max(0, Math.round(info.y + (payload.y ?? 0)));
      if (payload.input_type === "click") {
        await runMacHelper(["click", MAC_APP_NAME, String(absoluteX), String(absoluteY), payload.button ?? "left"]);
        return;
      }
      if (payload.input_type === "move") {
        await runMacHelper(["move", MAC_APP_NAME, String(absoluteX), String(absoluteY)]);
        return;
      }
      if (payload.input_type === "mouse_down") {
        await runMacHelper(["mouse_down", MAC_APP_NAME, String(absoluteX), String(absoluteY), payload.button ?? "left"]);
        return;
      }
      if (payload.input_type === "mouse_up") {
        await runMacHelper(["mouse_up", MAC_APP_NAME, String(absoluteX), String(absoluteY), payload.button ?? "left"]);
        return;
      }
      if (payload.input_type === "scroll") {
        await runMacHelper([
          "scroll",
          MAC_APP_NAME,
          String(absoluteX),
          String(absoluteY),
          String(Math.round(payload.delta_x ?? 0)),
          String(Math.round(payload.delta_y ?? 0)),
        ]);
        return;
      }
      if (payload.input_type === "type" && payload.text) {
        await runMacHelper(["type", MAC_APP_NAME, payload.text]);
        return;
      }
      if (payload.input_type === "keypress" && payload.key) {
        await runMacHelper(["keypress", MAC_APP_NAME, payload.key]);
        return;
      }
    }

    if (RUNNER_ORIGIN === "server_runner" && process.platform === "linux") {
      const x = String(Math.max(0, Math.round(payload.x ?? 0)));
      const y = String(Math.max(0, Math.round(payload.y ?? 0)));
      if (payload.input_type === "click") {
        await runLinuxCommand(["xdotool", "mousemove", "--sync", x, y, "click", buttonToLinuxCode(payload.button)]);
        return;
      }
      if (payload.input_type === "move") {
        await runLinuxCommand(["xdotool", "mousemove", "--sync", x, y]);
        return;
      }
      if (payload.input_type === "mouse_down") {
        await runLinuxCommand(["xdotool", "mousemove", "--sync", x, y, "mousedown", buttonToLinuxCode(payload.button)]);
        return;
      }
      if (payload.input_type === "mouse_up") {
        await runLinuxCommand(["xdotool", "mousemove", "--sync", x, y, "mouseup", buttonToLinuxCode(payload.button)]);
        return;
      }
      if (payload.input_type === "scroll") {
        const deltaY = payload.delta_y ?? 0;
        const button = deltaY > 0 ? "5" : "4";
        const clicks = Math.max(1, Math.ceil(Math.abs(deltaY) / 120));
        await runLinuxCommand(["xdotool", "mousemove", "--sync", x, y, "click", "--repeat", String(clicks), "--delay", "10", button]);
        return;
      }
      if (payload.input_type === "type" && payload.text) {
        await runLinuxCommand(["xdotool", "type", "--delay", "1", payload.text]);
        return;
      }
      if (payload.input_type === "keypress" && payload.key) {
        await runLinuxCommand(["xdotool", "key", payload.key]);
        return;
      }
    }

    await this.cdp.dispatchInput(cdpUrl, payload, selector);
  }
}
