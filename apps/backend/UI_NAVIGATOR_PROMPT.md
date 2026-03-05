---

## Prompt: Implement a UI Navigator (Browser Tab Control via Extension)

**Goal:** Implement a **UI navigator** that lets an AI agent control a user’s existing browser tab (navigate, click, type, snapshot). The user attaches a tab by installing a browser extension and clicking a toolbar button; the agent then drives that tab via a control API. The implementation must be **designed and built by you**—create your own architecture, source layout, tools, and skills; do not copy from any reference codebase.

---

### 1. High-level architecture (implement these concepts)

- **Browser control server:** An HTTP API (REST or RPC) that the agent calls to perform browser actions (e.g. navigate, snapshot, click, type). It runs on the user’s machine and listens on a configurable port.
- **Extension relay:** A local process that:
  - Accepts a WebSocket connection from your **browser extension** (one connection per “relay session”).
  - Accepts one or more WebSocket connections from **CDP clients** (your control server or a library that speaks Chrome DevTools Protocol).
  - Forwards CDP messages between the extension and the CDP clients so that commands sent by the control server are executed on the tab the extension has attached.
- **Browser extension (e.g. Chrome MV3):**
  - Provides a toolbar button; clicking it **attaches** or **detaches** the current tab.
  - When attached: uses the browser’s debug/automation API (e.g. Chrome’s `chrome.debugger`) to attach to that tab and speak CDP.
  - Connects to the relay over WebSocket (e.g. `ws://127.0.0.1:<relay_port>/extension`).
  - For each CDP command received from the relay, executes it on the attached tab and sends back responses/events.
  - Sends a “target attached” event to the relay when the user attaches a tab, and “target detached” when they detach or close the tab.

The “UI” being navigated is the **browser tab**. The “navigator” is the chain: agent → control API → relay → extension → CDP on the tab.

---

### 2. Requirements and constraints

- **CDP:** Use Chrome DevTools Protocol (or the browser’s equivalent) as the wire protocol between relay and the tab. The control server can speak CDP directly or use a library that wraps CDP (e.g. Puppeteer or a minimal CDP client).
- **Relay and control server on loopback:** The relay and the control server must bind to loopback only (e.g. `127.0.0.1`). No listening on `0.0.0.0` by default so the UI navigator is not exposed on the network unless the user explicitly configures otherwise.
- **Explicit attach:** Only tabs the user explicitly attaches (e.g. by clicking the extension icon) are controllable. Do not auto-attach to the active tab or other tabs.
- **Clear attach state:** The extension must show clear attach state (e.g. badge “ON” when attached, empty or “OFF” when not). Optional: tooltip or options page explaining “Click to attach this tab for the agent.”
- **One relay per “profile”:** Design so that one relay process can serve one logical “browser profile” (e.g. “Chrome” or “default”). If you support multiple profiles later, each can have its own relay port.
- **No hardcoded secrets:** Do not hardcode API keys or tokens in the extension or relay. If you add remote access later, use configuration or environment variables for tokens.

---

### 3. What you must create (your own design and code)

- **Source layout:** Define your own `src/` (or equivalent) layout. Include at least:
  - A **relay** module: WebSocket server that maintains the extension connection and CDP client connection(s), forwards CDP messages, and tracks attached targets (tab id, session id, target info).
  - A **control server** module: HTTP server that exposes endpoints the agent will call (e.g. `/tabs`, `/navigate`, `/snapshot`, `/act` or similar). It obtains a CDP connection to the relay and uses CDP (or a wrapper) to perform actions.
  - Optional: a **CDP client** helper that connects to the relay’s CDP WebSocket and sends/receives CDP commands and events.
- **Extension:** Implement a minimal Chrome (or Chromium) MV3 extension that:
  - Connects to the relay at a configurable host/port (e.g. from options or a default like `127.0.0.1:18792`).
  - On toolbar click: attach/detach current tab using the debugger API; on attach, send “target attached” (with targetId/sessionId) to the relay; on detach, send “target detached.”
  - Forwards CDP commands from the relay to the attached tab and returns responses/events to the relay.
- **Agent-facing tool:** Implement a **tool** (or skill) that the agent can call to drive the browser. It should:
  - Accept at least: action (e.g. navigate, snapshot, click, type), and action-specific params (url, selector or ref, text, etc.).
  - Call your control server API and return results (e.g. snapshot HTML or screenshot, or success/failure).
  - Handle “no tab attached” by returning a clear message telling the user to attach a tab via the extension.
- **Skill (optional but recommended):** Add a **skill** or documentation that describes when and how to use the UI navigator: when to use the browser tool, that the user must attach a tab first, and how to interpret snapshot/refs for follow-up actions (e.g. click by ref). Do not copy text from other projects; write it for your app.
- **Configuration:** Allow configuring at least: control server port, relay port, and (if needed) relay host for the extension. Use config files or environment variables; document the expected format.

---

### 4. Implementation order

1. **Relay:** Implement the relay server (extension WebSocket + CDP client WebSocket, message forwarding, target registry). Test with a simple CDP client (e.g. send `Target.getTargets`) and a minimal extension that connects and sends “target attached.”
2. **Extension:** Implement the extension (connect to relay, attach/detach on toolbar click, forward CDP to/from the tab). Verify with the relay that attach/detach and a few CDP commands (e.g. `Page.navigate`) work.
3. **Control server:** Implement the HTTP API that uses the relay (via CDP or a wrapper) to perform navigate, snapshot, click, type. Add error handling for “no tab attached” and invalid target.
4. **Agent tool:** Implement the agent tool that calls the control server and maps agent actions to your API. Add the skill/docs so the agent knows when and how to use the UI navigator.
5. **Config and docs:** Add configuration (ports, optional host) and a short README or internal doc: how to install the extension, start the relay and control server, and attach a tab.

---

### 5. Out of scope for this prompt

- Remote access (e.g. relay or control server on another machine): design so it could be added later (e.g. configurable bind address and auth) but do not implement it now.
- Multiple simultaneous tabs or multi-profile support: optional; a single attached tab per relay is enough for the first version.
- Non-Chromium browsers: focus on Chrome/Chromium and CDP; other browsers can be a later extension.

---

### 6. Success criteria

- User can install the extension, start the relay and control server, and attach one tab via the toolbar.
- Agent can call the browser tool to navigate that tab, get a snapshot (and optionally a screenshot), and perform click/type using refs or selectors from the snapshot.
- If no tab is attached, the tool returns a clear, user-facing message.
- Relay and control server listen only on loopback unless configured otherwise.
- Code is structured in your own modules (relay, control server, extension, tool, skill); no copy-paste of a full reference implementation.

---
