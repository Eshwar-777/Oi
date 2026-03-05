# Testing Curate, Companion, Consult & Mesh

Use these steps to verify the task graph (Curate → Schedule → Companion → Consult) and the device mesh. Run the backend first: `pnpm dev:backend` (or `make dev` in `apps/backend`).

**Base URL:** `http://localhost:8080`  
**Auth:** In dev, endpoints that use `get_current_user` accept requests without a token and use `dev-user` / `uid: "dev-user"`.

---

## 1. Curate (planning)

Curate turns a free-text description into a structured plan (steps + optional schedule).

**Request:**

```bash
curl -X POST http://localhost:8080/tasks/create \
  -H "Content-Type: application/json" \
  -d '{"description": "Every Monday at 9am, search Google for top 5 AI news and email me the summary"}'
```

**What to check:**

- Response has `plan_description` (short summary of the plan).
- Response has `steps` (array of steps with `description`, `action_type`, `status: "pending"`).
- `status` is `"awaiting_approval"` or the graph continues to Schedule/Companion and you may see `"running"` or `"completed"`.
- If Gemini is unavailable, you still get a fallback plan (single step with your description).

**Curate is working if:** You get a non-empty `plan_description` and at least one step.

---

## 2. Schedule (when to run)

Schedule decides whether to run now or later. If `scheduled_at` is in the future, the graph exits with status `scheduled`.

**Request:**

```bash
curl -X POST http://localhost:8080/tasks/create \
  -H "Content-Type: application/json" \
  -d '{"description": "Send me a reminder", "scheduled_at": "2030-01-01T09:00:00Z"}'
```

**What to check:**

- Response has `status: "scheduled"` and optionally `scheduled_at`.
- The graph does not run Companion (no steps executed).

**Schedule is working if:** With a future `scheduled_at` you get `status: "scheduled"`.

---

## 3. Companion (execution)

Companion runs each step (browser_action / api_call). Our stub implementations just log and return a success string, so steps should flip to `done` and the graph can reach `completed`.

**Request:**

```bash
curl -X POST http://localhost:8080/tasks/create \
  -H "Content-Type: application/json" \
  -d '{"description": "Open example.com and get the page title"}'
```

**What to check:**

- Response has `steps` with at least one step having `status: "done"` and a non-null `result`.
- `status` is `"completed"`.
- Backend logs show “Executing step 1/N for task …”.

**Companion is working if:** Steps show `done` and `result`, and final `status` is `"completed"`.

---

## 4. Consult (human-in-the-loop)

Consult runs when a step has `action_type: "human_decision"` and Companion raises “human action required”. The graph then goes to Consult; with no `human_action_response` yet, it returns `blocked`.

Ask for a plan that includes a human decision (e.g. “ask before paying” or “confirm with me before submitting”):

```bash
curl -X POST http://localhost:8080/tasks/create \
  -H "Content-Type: application/json" \
  -d '{"description": "Book the cheapest flight NYC to London next Friday, but ask me before entering payment details"}'
```

**What to check:**

- If the plan has a step with `action_type: "human_decision"`, Companion will raise and the graph will hit Consult.
- Response has `status: "blocked"` and `blocked_reason` set (e.g. “Human decision needed: …”).
- Backend logs show “Task … waiting for human action …”.

**Consult is working if:** For a description that leads to a human_decision step, you get `status: "blocked"` and a non-empty `blocked_reason`.

**Note:** `/tasks/create` runs the graph in memory and does not persist the task to Firestore. So you cannot yet test “resume after human action” (submit action and re-run graph) through this endpoint alone. To test the full flow you’d need a flow that persists the task and uses the checkpointer, then calls `POST /tasks/{task_id}/action` to resume.

---

## 5. Mesh – Devices

**Register a device:**

```bash
curl -X POST http://localhost:8080/devices/register \
  -H "Content-Type: application/json" \
  -d '{"device_type": "web", "device_name": "Chrome on Mac"}'
```

**What to check:** Response has `device_id` (UUID).

**List devices:**

```bash
curl http://localhost:8080/devices
```

**What to check:** JSON array of devices; should include the one you just registered (e.g. `device_type`, `device_name`, `device_id`). In dev with no Firestore or with empty collection you may get `[]` until the registry is used (e.g. with Firestore).

**Devices are working if:** Register returns a `device_id` and list returns a consistent list (or empty if Firestore isn’t set up yet).

---

## 6. Mesh – Groups & invite

**Create a group:** There is no dedicated “create group” endpoint in the current routes; groups are created when needed (e.g. when a task is created with a mesh_group_id). You can still test **list** and **invite** if a group exists.

**List mesh groups:**

```bash
curl http://localhost:8080/mesh/groups
```

**What to check:** JSON array (may be empty).

**Invite a member** (requires an existing group and the current user as owner):

```bash
curl -X POST http://localhost:8080/mesh/invite \
  -H "Content-Type: application/json" \
  -d '{"group_id": "<group-id>", "email": "teammate@example.com"}'
```

**Mesh groups are working if:** List returns 200; invite returns 200 or 403/404 with a clear error if group is missing or user is not owner.

---

## 7. Mesh – Action lock (submit human action)

`POST /tasks/{task_id}/action` submits a human response for a **blocked** task and uses a Firestore transaction so only one device “wins”.

To test it you need a task document in Firestore with `status: "blocked"`:

1. **Option A – Manual Firestore document**  
   In Firebase Console → Firestore, create a document in the `tasks` collection with:
   - `task_id` (or use document ID): e.g. `test-blocked-task-1`
   - `status`: `"blocked"`
   - `created_by_user_id`: `dev-user` (or the uid your dev auth uses)
   - Any other fields your code expects (e.g. `plan_description`, `steps`, `created_at`, `updated_at`).

2. **Submit action:**

```bash
curl -X POST http://localhost:8080/tasks/test-blocked-task-1/action \
  -H "Content-Type: application/json" \
  -d '{"action": "Proceed with payment", "device_id": "my-phone"}'
```

**What to check:**

- First request: 200 and body like `{"status": "action_submitted"}`.
- In Firestore, the task document’s `status` becomes `"running"` and `human_action_response` / `human_action_device_id` are set.
- Second request (same task, same or different device): 409 with message that the task is no longer blocked (AlreadyHandledError).

**Action lock is working if:** First call succeeds and updates Firestore; second call returns 409.

---

## 8. Quick checklist

| Component   | Test summary |
|------------|----------------|
| **Curate** | POST /tasks/create with a description → `plan_description` + `steps` in response. |
| **Schedule** | POST /tasks/create with future `scheduled_at` → `status: "scheduled"`. |
| **Companion** | POST /tasks/create with a simple automation → steps `done`, `status: "completed"`. |
| **Consult** | POST /tasks/create with “ask me before…” → `status: "blocked"`, `blocked_reason` set. |
| **Mesh devices** | POST /devices/register → `device_id`; GET /devices → list. |
| **Mesh groups** | GET /mesh/groups → 200; POST /mesh/invite (with valid group) → 200 or clear error. |
| **Mesh action lock** | Create blocked task in Firestore, then POST /tasks/{id}/action → 200 then 409 on duplicate. |

Run these with the backend and (for mesh + action lock) Firestore configured; adjust host/port if you run the API elsewhere.
