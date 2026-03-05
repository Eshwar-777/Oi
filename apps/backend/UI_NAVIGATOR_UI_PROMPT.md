---

# UX prompt: UI for the UI navigator (browser tab control)

**Role:** You are a UX designer. Define and implement the **user-facing UI** for the UI navigator so that attaching a tab, understanding state, and recovering from errors feel clear, low-friction, and trustworthy. The backend (relay, control server, extension, agent tool) is already built; focus only on what users see and interact with.

---

## 1. Design principles

- **One action to attach:** Attaching the current tab is a single, obvious action (e.g. one click on the extension icon). No multi-step wizard for the happy path.
- **State is visible:** The user can always see whether this tab is attached (e.g. badge, tooltip, popup). If the relay is down or the extension can’t connect, that’s visible too—no silent failure.
- **Reversible and safe:** Detach is as easy as attach. The UI should make it clear that “attached” means “the agent can control this tab” so users can make an informed choice.
- **Errors are actionable:** Every error state suggests what to do next (e.g. “Start the relay,” “Click the icon to attach,” “Check your connection”).
- **Progressive disclosure:** Advanced settings (e.g. relay URL/port) are available but not in the way of first-time use.

---

## 2. Surfaces to design and implement

### 2.1 Extension icon and badge

- **Icon:** Distinct, recognizable, and readable at 16–32px. It should read as “browser control” or “agent/tab” rather than generic.
- **Badge (on the icon):**
  - **Attached:** e.g. “ON” or a checkmark; color that reads as “active” (e.g. green or brand accent). Tooltip: e.g. “This tab is attached. Click to detach.”
  - **Not attached:** No badge or neutral “OFF.” Tooltip: e.g. “Click to attach this tab for the agent.”
  - **Connecting:** Short loading state (e.g. “…” or spinner). Tooltip: e.g. “Connecting to relay…”
  - **Error:** e.g. “!” or “✕” in an error color. Tooltip: e.g. “Relay not reachable. Open options to fix.”
- **Click behavior:** One click toggles attach/detach for the **current** tab. No confirmation for attach/detach unless you explicitly want a “Are you sure?” for detach when the agent is mid-task (optional).

**Deliverables:** Badge states (copy + color + tooltip), icon asset or spec, and short interaction spec (click = toggle; which tab is affected).

---

### 2.2 Extension popup (optional but recommended)

When the user clicks the icon, a small popup can show state and a bit of control:

- **When attached:** “This tab is attached.” Optional: tab title/URL (truncated). Primary action: “Detach.”
- **When not attached:** “This tab is not attached.” Primary action: “Attach.”
- **When relay unreachable:** “Can’t connect to relay.” Brief reason if available (e.g. “Connection refused”). Action: “Open setup” or “Open options.”
- **First time / no relay yet:** Short one-line explanation, e.g. “Attach this tab so the agent can control it.” Link or button to “Setup” or “Options.”

Keep copy to one or two lines; use the options page for details.

**Deliverables:** Copy for each state, suggested layout (stack: status line + one primary button), and when to show popup vs. only badge.

---

### 2.3 Extension options page

- **Purpose:** Configure relay (host/port or full URL) and explain what the extension does.
- **Sections:**
  - **Status:** “Relay: Connected” or “Relay: Not connected” with a short reason. Optional: “Last checked: …” and a “Check again” button.
  - **Configuration:** Fields for relay URL or host + port. Defaults (e.g. `127.0.0.1`, port `18792`) pre-filled. Save/cancel. On save, re-check status.
  - **What this does:** 2–3 sentences: “When you attach a tab, the agent can navigate, click, and type in it. Only attached tabs are controllable. Detach anytime by clicking the icon.”
  - **Security note:** One line, e.g. “The relay runs on your machine. Only attach tabs you’re okay with the agent controlling.”
- **Validation:** If the user saves an invalid URL or unreachable host, show an inline error and keep “Relay: Not connected” until fixed.

**Deliverables:** Wireframe or simple mock (sections + fields + status), copy for each block, and validation rules.

---

### 2.4 First-run / onboarding (in-extension)

- **Trigger:** First install or first open of options (or first time relay has never been connected).
- **Content:** One short screen or modal: what the extension does (“Attach a tab so the agent can control it”), that they need the relay/control server running, and one primary action: “Open setup” or “Go to options.” No long tutorial unless you add a separate “Learn more” flow.
- **Dismissal:** “Don’t show again” or “Got it” so power users aren’t blocked.

**Deliverables:** One screen copy + one CTA; when to show and when to dismiss.

---

### 2.5 Control surface / dashboard (if your app has one)

If there is a web app or desktop UI that shows “browser” or “navigator” status:

- **Status card or row:** e.g. “Browser: 1 tab attached” or “No tab attached.” If attached: optional tab title/URL and “Detach” (if the backend supports it from the app). If not: “Attach a tab using the extension (click the icon on the tab you want to control).”
- **When the agent is using the browser:** Optional subtle indicator: “Agent is using the browser” or “Browser in use” so the user knows why the tab might be moving. No need for live video of the tab unless you want it.
- **Errors:** If the control server can’t reach the relay or no tab is attached when the agent tries to act, show the same kind of message the agent returns: e.g. “No tab attached. Click the extension icon on the tab you want to use.”

**Deliverables:** Component structure (status line, optional detach, error line), copy, and where this appears in the app.

---

### 2.6 Empty and error states (everywhere)

- **No tab attached (agent or UI):** Message: “No tab is attached. Open the tab you want to control and click the [Extension Name] icon to attach it.” No technical jargon unless in a “Details” expander.
- **Relay not reachable:** “Can’t connect to the relay. Make sure [app name] is running and the relay port is [port]. Check extension options if you changed the port.”
- **Tab closed or detached during use:** “The attached tab was closed or detached. Attach another tab to continue.”
- **Permission or debugger blocked:** “The browser blocked control. Try detaching and re-attaching the tab, or use a different tab.”

**Deliverables:** Exact copy for each case and where it appears (extension popup, options, control UI, agent-facing message).

---

## 3. Accessibility and inclusion

- **Extension:** Icon and badge have accessible names/labels; popup and options are focusable and usable with keyboard; focus order and contrast meet WCAG 2.1 AA where possible.
- **Copy:** Use plain language; avoid “CDP,” “relay,” “WebSocket” in user-facing text unless in an advanced or “Technical details” section.
- **Color:** Don’t rely only on color for state (e.g. “ON”/“OFF” or icon state in addition to color).

**Deliverables:** Short a11y checklist (labels, keyboard, contrast) and any specific component notes.

---

## 4. Microcopy and tone

- **Tone:** Calm, direct, helpful. Use “you” and “your tab.”
- **Actions:** Use verbs: “Attach,” “Detach,” “Open setup,” “Check again,” “Save.”
- **Errors:** State what’s wrong in one line, then what to do next.

**Deliverables:** A short list of preferred terms (e.g. “attach” vs “connect,” “relay” vs “bridge” in UI) and 2–3 example strings for success and error.

---

## 5. Implementation order and artifacts

1. **States and copy:** List all states (attached, not attached, connecting, error, first-run). Write final copy and tooltips for each.
2. **Extension UI:** Implement badge, tooltip, popup (if any), and options page from the above. Use your stack (e.g. HTML/CSS/JS, React, Vue).
3. **Onboarding:** Implement first-run/onboarding in the extension.
4. **Control surface:** If applicable, add the status/error components to your app’s dashboard or settings.
5. **Error handling:** Ensure every backend error maps to one of the agreed messages and appears in the right place (extension, control UI, or agent reply).
6. **Accessibility pass:** Keyboard, labels, contrast, and focus order.

**Deliverables:**  
- A short “UI navigator UX” doc (or section in your design system) that includes: states, copy, and which surface each state appears on.  
- Implemented UI (extension + optional control surface) that follows this spec.  
- Optional: simple wireframes or screenshots for extension popup and options page.

---

## 6. Out of scope

- Backend or API design (assumed done).
- Full design system or brand (use existing where possible).
- In-app chat or agent UI beyond showing “browser status” and errors.

---

## 7. Success criteria

- User can attach and detach a tab in one click and always see whether the tab is attached.
- When the relay is down or unreachable, the user sees a clear, actionable message and knows where to fix it (options/setup).
- First-time users understand what “attach” means and how to do it without reading external docs.
- All error states have consistent, actionable copy and appear in the right surface (extension vs control UI).
- Extension and control UI are keyboard-accessible and use clear, non-jargon labels.

---