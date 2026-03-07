# Manual Testing Guide — End-to-End Scenarios

This guide gives step-by-step instructions to test the full flow: **Curate → Companion → Consult**, including API-only automations, scheduled runs, test runs, and (optionally) browser automation and Consult handoff.

---

## Prerequisites

Before running any scenario, ensure:

1. **Backend**
   - From repo root: `cd apps/backend && source .venv/bin/activate && PYTHONPATH=src uvicorn oi_agent.main:app --reload --host 0.0.0.0 --port 8080`
   - Or run via your usual method. API must be reachable at `http://localhost:8080` (or the URL your web app uses).

2. **Web app**
   - From repo root: `cd apps/frontend/web && pnpm dev` (or `npm run dev`). App typically at `http://localhost:3000`.

3. **Auth**
   - Web app is configured to authenticate (e.g. Firebase). In dev, backend may accept a dev user; ensure you’re logged in so API calls include a valid token.

4. **Optional for Scenarios 4 & 5**
   - **Chrome extension**: Built and loaded from `apps/extension` (e.g. `pnpm build` then load unpacked in `chrome://extensions`). Extension must be able to reach backend WebSocket (e.g. `ws://localhost:8080/ws`).
   - **SMTP (for email scenarios)**: If you want real email delivery, set `SMTP_*` and `DEFAULT_FROM_EMAIL` in `apps/backend/.env` (see `.env.example`). Otherwise, runs may complete but email send can fail or be skipped.

5. **Triggering a test run**
   - **In the UI:** Open any automation in Curate (click the card) and click **Run now**. The new run appears under **Tasks → Companion**.
   - **Alternatively** (browser console): Tasks → Curate → open an automation → DevTools → Console:
     ```js
     fetch('/api/automations/YOUR_AUTOMATION_ID/test', { method: 'POST', credentials: 'include' })
       .then(r => r.json()).then(console.log).catch(console.error);
     ```
   - **curl** (replace `YOUR_AUTOMATION_ID` and `YOUR_ID_TOKEN`):
     ```bash
     curl -X POST "http://localhost:3000/api/automations/YOUR_AUTOMATION_ID/test" \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer YOUR_ID_TOKEN" \
       --cookie "your-session-cookie-if-applicable"
     ```
   - After a successful test, the new run appears under **Tasks → Companion**.

---

## Scenario 1 — AI news email every 5 hours (API-only, scheduled)

**Goal:** Create an automation that sends an AI news digest by email every 5 hours and confirm it appears in Companion and can run.

### Steps

1. Open **Tasks** in the web app and select the **Curate** tab.
2. Click **+ New Automation** (or equivalent).
3. In the prompt, enter something like:
   - *“Send me an email with AI news digest every 5 hours to my Gmail.”*
4. Confirm the AI returns a **plan** (name, trigger, data sources, action). It should suggest:
   - Trigger: time-based, every 5 hours (e.g. `interval_hours: 5` or cron).
   - Action: send email / email notification.
   - Data: news (e.g. web search / news).
5. Accept the plan and **create** the automation.
6. **Verify in Curate**
   - The new automation appears in the list.
   - Status is **Active** (or **On**) and trigger summary mentions “every 5 hours” (or similar).
7. **Verify in Companion**
   - Switch to the **Companion** tab.
   - You should see this automation’s **scheduled** job (e.g. “Next run at …” or a run once the scheduler has fired). If the backend uses “next run” from scheduler, detail view may show next run time.
8. **Trigger a test run**
   - In the automation detail page, click **Run now** (or call `POST /api/automations/{automation_id}/test` from browser console / curl if the button is not available).
   - After the run starts, you may be redirected to the Companion tab; otherwise go to **Tasks → Companion**.
9. **Verify run in Companion**
   - Go to **Companion**.
   - A new run for “AI news digest” (or the name you gave) appears.
   - Open the run: stages (e.g. Triggered → Planning → Fetching → … → Executing → Done) and a short summary are shown.
   - If SMTP is configured, check inbox for the digest; otherwise at least the run status should be **completed** (or **failed** with an email-related error).

### Pass criteria

- Automation created from natural language.
- Automation appears in Curate and Companion.
- Test run creates a run in Companion with correct stages and status.

---

## Scenario 2 — Weather notification (API-only, one-off test)

**Goal:** Create a “notify me about weather” automation and run it once via the test endpoint.

### Steps

1. **Curate** → **+ New Automation**.
2. Enter:
   - *“Notify me every morning about the weather in San Francisco.”*
3. Confirm the plan includes:
   - Trigger: time-based (e.g. every morning / cron).
   - Action: notify (in-app or email).
   - Data: weather (e.g. weather_check or similar).
4. Create the automation.
5. Turn it **On** if needed.
6. Open the automation (click it) and click **Run now** to trigger a test run.
7. **Companion** tab:
   - New run appears.
   - Open run: pipeline shows weather fetch + notification step; status **completed** (or failed with a clear reason).

### Pass criteria

- Weather-related automation created and run once; run visible in Companion with expected stages.

---

## Scenario 3 — Manual trigger and run history

**Goal:** Ensure runs are listed and that a manual test run shows correct metadata.

### Steps

1. **Curate** → Create any simple automation (e.g. “Send me a daily summary of tech news”).
2. Create and leave it **On**.
3. Trigger **two** test runs: open the automation and click **Run now** twice (or call the test endpoint twice).
4. **Companion** tab:
   - List shows multiple runs (e.g. “Recent” section).
   - Each run has automation name, status (e.g. Done), and optional duration/summary.
5. Open **one** run:
   - Step-by-step log shows stages (Triggered, Planning, Fetching, …).
   - Summary text is present.
   - “Last run” / “Next run” (if shown) on the automation in Curate are updated after test runs.

### Pass criteria

- Multiple runs for the same automation appear in Companion; detail view shows full pipeline and summary.

---

## Scenario 4 — Browser automation and live view (extension required)

**Goal:** Run an automation that uses the browser (e.g. open a page and take a screenshot) and see the run in Companion, ideally with live browser view.

### Steps

1. **Extension**
   - Build and load the OI extension; ensure it connects to backend WebSocket (e.g. `ws://localhost:8080/ws`).
   - Optional: set backend `ENABLE_BROWSER_AUTOMATION=true` if your app uses this flag.
2. **Curate** → **+ New Automation**.
3. Enter a task that implies browser use, e.g.:
   - *“Open example.com and send me a screenshot every day.”*
   - Or a task that the design API maps to browser steps (if your design supports it).
4. Create the automation and turn it **On**.
5. Open the automation and click **Run now** (or trigger via test endpoint).
6. **Companion** tab:
   - A run appears; if the pipeline includes browser steps, it may show “Browser” or “via Browser” and a live view section.
   - If the extension is connected and the run uses browser steps:
     - **Live browser view** (e.g. BrowserView) may show screenshots or “Waiting for connection.”
     - Step log may show browser steps (navigate, screenshot, etc.).
7. If no extension is connected:
   - Run may complete with API-only steps, or fail for browser steps; error or “No extension connected” is acceptable.

### Pass criteria

- With extension connected and a browser-capable automation, a run appears in Companion and (if implemented) live browser area shows screenshots or connection status. Without extension, run behavior is clear (completed or failed with a sensible reason).

---

## Scenario 5 — Consult handoff (blocked run → resolve)

**Goal:** Simulate a run that needs human help (blocked), see it in Consult, and resolve it so Companion can continue (or stop).

### Steps

1. **Create a blocking situation** (choose one):
   - **Option A:** Use an automation that intentionally hits a “payment” or “consult” step (if you have a test flow that creates a Consult session), or
   - **Option B:** Manually create a Consult session via backend/API for testing (e.g. create a `ConsultSession` in Firestore with `state: pending` and link to an automation/run), or
   - **Option C:** Run a browser automation that hits a page the stuck detector classifies as “payment” or “CAPTCHA” so the backend creates a Consult job.
2. **Companion**
   - A run for that automation shows status **Blocked** or **Needs help** (or similar).
   - Optional: Companion tab shows a count or link to “Needs your help.”
3. **Consult** tab:
   - At least one consult item appears (e.g. “Payment needed” or “Verify you’re human”).
   - Open the item: description, what to do, and (if implemented) screenshot or live view are shown.
4. **Take control**
   - Click **Take control** / **Control on this device** (or **Remote control** if testing from another device).
   - If same device: interact in the browser tab as instructed, then click **I’ve fixed it, continue** (or **I’m done**).
   - If remote: use the remote view to complete the action, then **I’m done**.
5. **Resolve**
   - Click **I’ve fixed it, continue** (resume) or **Stop this automation** (abort).
6. **Verify**
   - **Consult**: Item moves to “Resolved” or disappears from pending.
   - **Companion**: Run status changes to **Running** then **Done** (if resumed), or **Cancelled**/Stopped (if aborted).

### Pass criteria

- Blocked run appears in Companion and Consult.
- User can take control and resolve (resume or abort).
- Companion and Consult state update consistently after resolve.

---

## Quick reference

| Scenario | Curate | Companion | Consult | Notes |
|----------|--------|-----------|---------|--------|
| 1. AI news every 5h | Create + enable | See job + test run | — | Use test endpoint to run once |
| 2. Weather notify | Create + enable | See run after test | — | One-off test run |
| 3. Run history | Create | Multiple runs, detail view | — | Call test twice |
| 4. Browser + live view | Create browser task | Run + live browser area | — | Extension required |
| 5. Consult handoff | — | Blocked run | Resolve item | Need blocked run (real or simulated) |

---

## Troubleshooting

- **Companion empty after creating automation**
  - Runs appear only after the scheduler fires or after you call the **test** endpoint. Trigger a test run via `POST /api/automations/{id}/test`.
- **Test endpoint 401/403**
  - Ensure the request includes the same auth the web app uses (cookie or Bearer token).
- **Email not received**
  - Check SMTP settings in `.env`; use Gmail App Password if using Gmail.
- **Extension not connecting**
  - Verify backend WebSocket URL (e.g. `ws://localhost:8080/ws`) and that the extension is loaded and has the correct backend URL.
- **Consult not showing**
  - Ensure a run is actually blocked (e.g. Consult session created or stuck detection triggered). Check Firestore `consult_sessions` and automation `needs_attention` if needed.

Use these five scenarios to validate end-to-end behavior before release or demos.
