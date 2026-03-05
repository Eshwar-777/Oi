# OI — Full Project Context

> Use this document to onboard into the OI codebase in any IDE. It covers architecture, file structure, every API endpoint, data models, technologies, environment variables, and design decisions.

---

## 1. What is OI?

OI is an interactive AI agent that automates tasks through natural conversation. It supports multimodal input (text, voice, images, camera, documents, screen share) and runs across web, mobile, desktop, and browser extension.

**Two core systems:**

| System | Description |
|--------|-------------|
| **Converse** | Standalone multimodal chatbot using Google ADK + Gemini Live. Handles text, voice, vision, documents. |
| **Task Lifecycle** | A single LangGraph `StateGraph` with three collaborative nodes — **Curate** (plan), **Companion** (execute), **Consult** (human-in-the-loop) — sharing a unified `TaskState`. |

**User Mesh:** One user can own multiple devices (2 PCs, 1 mobile). All devices stay synced on task updates via Firestore real-time listeners. When the agent needs human input (Consult), all devices get notified; any device can respond. Users can also delegate to other users (shared context).

---

## 2. Monorepo Structure

```
/
├── apps/
│   ├── backend/          Python FastAPI + Google ADK + LangGraph
│   ├── web/              Next.js 14+ (App Router) — landing + dashboard
│   ├── mobile/           React Native Expo SDK 54+ — iOS/Android
│   ├── desktop/          Electron 30+ — wraps the web frontend
│   └── extension/        Chrome MV3 browser extension
├── packages/
│   ├── shared-types/     @oi/shared-types — TypeScript interfaces
│   ├── api-client/       @oi/api-client — HTTP + Firestore + WebSocket clients
│   └── theme/            @oi/theme — Design tokens (maroon palette)
├── infra/
│   └── terraform/        GCP IaC (Cloud Run, Firestore, Pub/Sub, etc.)
├── .github/workflows/    CI/CD (backend, web, mobile, desktop, extension)
├── package.json          Root pnpm workspace scripts
├── pnpm-workspace.yaml   Workspace definition
└── docs/                 Testing guides
```

**Workspace manager:** pnpm 9+ with workspaces for all `apps/*` and `packages/*`.

**Root scripts (package.json):**
- `dev:backend` — `make -C apps/backend dev`
- `dev:web` — `pnpm --filter @oi/web dev`
- `dev:mobile` — `pnpm --filter @oi/mobile start`
- `dev:desktop` — `pnpm --filter @oi/desktop dev`
- `dev:extension` — `pnpm --filter @oi/extension dev`

---

## 3. Backend Architecture (Python)

**Location:** `apps/backend/src/oi_agent/`

### 3.1 Entry Point

`main.py` creates a FastAPI app with:
- CORS middleware (origins from `ALLOWED_ORIGINS`)
- `CorrelationIdMiddleware` — adds X-Correlation-Id to every request
- `RequestLoggingMiddleware` — structured request/response logging
- Three routers: `router` (core API), `ws_router` (WebSocket), `device_router` (device management)

### 3.2 Configuration

`config.py` — Pydantic `BaseSettings` loading from `.env`:

| Setting | Env Var | Default |
|---------|---------|---------|
| `env` | `ENV` | `dev` |
| `gcp_project` | `GOOGLE_CLOUD_PROJECT` | `""` |
| `gcp_location` | `GOOGLE_CLOUD_LOCATION` | `us-central1` |
| `gemini_model` | `GEMINI_MODEL` | `gemini-2.5-flash` |
| `gemini_live_model` | `GEMINI_LIVE_MODEL` | `gemini-2.0-flash-live-001` |
| `firebase_project_id` | `FIREBASE_PROJECT_ID` | `""` |
| `firestore_database` | `FIRESTORE_DATABASE` | `(default)` |
| `pubsub_topic_tasks` | `PUBSUB_TOPIC_TASKS` | `oi-tasks` |
| `gcs_bucket_uploads` | `GCS_BUCKET_UPLOADS` | `oi-uploads` |
| `tts_language_code` | `TTS_LANGUAGE_CODE` | `en-US` |
| `tts_voice_name` | `TTS_VOICE_NAME` | `en-US-Neural2-D` |
| `enrollment_ttl_seconds` | `ENROLLMENT_TTL_SECONDS` | `600` |
| `nonce_ttl_seconds` | `NONCE_TTL_SECONDS` | `300` |
| `allowed_origins` | `ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:8081` |
| Feature flags | `ENABLE_LIVE_STREAMING`, `ENABLE_COMPUTER_USE`, `ENABLE_VISION_TOOLS`, `ENABLE_BROWSER_AUTOMATION` | `true/false` |

### 3.3 API Endpoints

#### Core Routes (`api/routes.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Health check |
| POST | `/chat` | — | Send message to OI (orchestrator routes to Converse or Task) |
| POST | `/interact` | — | Alias for `/chat` |
| POST | `/tasks/create` | Firebase | Create task → runs LangGraph directly |
| GET | `/tasks` | Firebase | List user's tasks |
| GET | `/tasks/{task_id}` | Firebase | Get task details |
| POST | `/tasks/{task_id}/action` | Firebase | Submit human action for blocked task (Consult) |
| PUT | `/tasks/{task_id}/cancel` | Firebase | Cancel a task |
| POST | `/devices/register` | Firebase | Register device to mesh (Firestore) |
| GET | `/devices` | Firebase | List user's devices (Firestore mesh) |
| POST | `/mesh/invite` | Firebase | Invite user to mesh group |
| GET | `/mesh/groups` | Firebase | List mesh groups |

#### Device Management Routes (`devices/router.py`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/enrollments` | Firebase | Start device enrollment (returns challenge) |
| POST | `/enrollments/{id}/complete` | — | Complete enrollment with Ed25519 PoP |
| GET | `/me/devices` | Firebase | List user's enrolled devices |
| POST | `/devices/{id}/revoke` | Firebase | Revoke/block a device |
| POST | `/devices/{id}/rotate-key` | Firebase + PoP | Rotate Ed25519 key |
| PATCH | `/devices/{id}` | Firebase | Update device metadata |
| GET | `/secure/profile` | Firebase + PoP | Sample PoP-protected route |

#### WebSocket (`api/websocket.py`)

| Path | Query Param | Description |
|------|-------------|-------------|
| `/ws` | `device_id` | Bidirectional — voice streaming, extension commands |

### 3.4 Agent Orchestrator

`agents/orchestrator.py` — `AgentOrchestrator.handle()` routes each user message:
- Determines intent (conversation vs. task creation)
- For conversations → `ConverseChatbot` (Google ADK + Gemini)
- For tasks → Task Lifecycle Graph

### 3.5 Converse System

| File | Purpose |
|------|---------|
| `agents/converse/chatbot.py` | `ConverseChatbot` — text/multimodal chat using Google ADK |
| `agents/converse/live_stream.py` | Gemini Live bidirectional audio/video sessions |

### 3.6 Task Lifecycle Graph (LangGraph)

**State:** `agents/task_graph/state.py` — `TaskState` TypedDict:

```python
class TaskState(TypedDict):
    task_id: str
    user_id: str
    mesh_group_id: str
    created_by_device_id: str
    messages: Annotated[list[Any], add_messages]  # shared conversation
    plan_description: str                          # from Curate
    steps: list[TaskStep]                          # from Curate
    scheduled_at: str | None                       # from Curate
    current_step_index: int                        # Companion tracks
    status: TaskStatus                             # current lifecycle state
    blocked_reason: str | None                     # Consult fills
    blocked_screenshot_url: str | None
    human_action_response: str | None              # user provides
    human_action_device_id: str | None
```

**Graph:** `agents/task_graph/graph.py`

```
curate → schedule → companion → (loop | consult | END)
                                  consult → (companion | curate | END)
```

| Node | File | Purpose |
|------|------|---------|
| `curate` | `nodes/curate.py` | Decomposes user request into plan + steps using Gemini |
| `schedule` | `nodes/schedule.py` | Delays execution until `scheduled_at` or executes immediately |
| `companion` | `nodes/companion.py` | Executes each step (API calls, browser automation, etc.) |
| `consult` | `nodes/consult.py` | Pauses for human input when blocked |

**Checkpointing:** `checkpointer.py` — `FirestoreCheckpointer` persists `TaskState` to Firestore after each node.

### 3.7 Authentication

| File | Purpose |
|------|---------|
| `auth/firebase_auth.py` | `verify_firebase_token()` → validates Firebase ID tokens; `get_current_user` → FastAPI dependency returning `{uid, email}`. In dev mode without token, returns `{uid: "dev-user"}` |
| `auth/permissions.py` | Mesh-aware authorization checks |

### 3.8 Device Identity (Ed25519 PoP)

All backed by Firestore. No Postgres/SQLAlchemy.

| File | Purpose |
|------|---------|
| `devices/firestore_client.py` | Shared async Firestore client factory |
| `devices/enrollment.py` | Challenge-response enrollment protocol. `start_enrollment()` issues challenge, `complete_enrollment()` verifies Ed25519 signature and creates device + credential + link |
| `devices/pop_auth.py` | PoP middleware. Signature: `nonce ‖ timestamp ‖ method ‖ path ‖ body_sha256 ‖ device_id ‖ uid`. Nonce replay prevention via `device_nonces/{hash}` |
| `devices/service.py` | `list_user_devices()`, `revoke_device()`, `rotate_key()`, `update_device_metadata()` |
| `devices/schemas.py` | Pydantic request/response models with string enums (Platform, DeviceClass, DeviceStatus, TrustLevel, etc.) |
| `devices/router.py` | FastAPI routes using `Depends(get_current_user)` for Firebase Auth |

### 3.9 Mesh Layer

| File | Purpose |
|------|---------|
| `mesh/device_registry.py` | `DeviceRegistry` — registers devices in Firestore `users/{uid}/devices/{deviceId}`, manages FCM tokens, online/offline status |
| `mesh/group_manager.py` | `MeshGroupManager` — manages mesh groups and invitations in `mesh_groups/{groupId}` |
| `mesh/broadcaster.py` | `EventBroadcaster` — broadcasts task events to all mesh group devices, sends FCM push notifications |
| `mesh/action_lock.py` | Firestore transactional locking for human actions — prevents duplicate responses from multiple devices |

### 3.10 Memory / Persistence

| File | Purpose |
|------|---------|
| `memory/models.py` | Pydantic models: `Conversation`, `ChatMessage`, `TaskDocument`, `TaskEvent` |
| `memory/firestore_store.py` | `FirestoreSessionStore` (chat sessions), `FirestoreTaskStore` (task CRUD) |

### 3.11 Tools

| File | Purpose |
|------|---------|
| `tools/registry.py` | `ToolRegistry` — registers and retrieves tools for ADK |
| `tools/vision.py` | Gemini Vision — image analysis |
| `tools/voice.py` | Google Cloud TTS / STT |
| `tools/computer_use.py` | Computer Use API integration |
| `tools/google_cloud.py` | GCP service helpers |

### 3.12 Observability

`observability/telemetry.py` — structlog + OpenTelemetry configuration.

---

## 4. Firestore Collections

| Collection | Fields | Purpose |
|------------|--------|---------|
| `users/{uid}/devices/{deviceId}` | device_id, displayName, platform, deviceClass, status, trustLevel, is_online, lastSeenAt | Denormalized device list (mesh reads this) |
| `devices/{deviceId}` | platform, deviceClass, displayName, status, trustLevel, createdAt, lastSeenAt | Canonical device record |
| `devices/{deviceId}/credentials/{keyVersion}` | keyVersion, pubkeyEd25519, createdAt, revokedAt | Ed25519 public keys |
| `devices/{deviceId}/links/{uid}` | uid, role, status, linkedAt, revokedAt | User-device ownership |
| `enrollments/{enrollmentId}` | uid, flow, challenge, expiresAt, usedAt, requestedDevice{...} | Enrollment records |
| `device_nonces/{sha256(nonce)}` | deviceId, uid, expiresAt | PoP nonce replay prevention |
| `mesh_groups/{groupId}` | members[], memberUids[] | Mesh group membership |
| `tasks/{taskId}` | (TaskDocument fields) | Task persistence |

### Firestore Security Rules

- `users/{uid}/**` — read own data only; writes server-only
- `devices/{deviceId}` — read if linked + active; writes server-only
- `devices/{deviceId}/credentials/**` — server-only (never client-readable)
- `enrollments/**`, `device_nonces/**` — server-only
- `mesh_groups/{groupId}` — read if member
- `tasks/{taskId}` — read if owner

Rules file: `apps/backend/firestore.rules`

---

## 5. Frontend — Web (Next.js)

**Location:** `apps/web/`

| Tech | Version |
|------|---------|
| Next.js | 14+ (App Router) |
| Tailwind CSS | maroon theme |
| TanStack Query | data fetching |
| Zustand | state management |
| Firebase JS SDK | Auth + Firestore listeners |

**Pages:**

| Route | File | Description |
|-------|------|-------------|
| `/` | `page.tsx` | Landing page with download links |
| `/chat` | `(app)/chat/page.tsx` | Chat interface (Converse) |
| `/tasks` | `(app)/tasks/page.tsx` | Task list |
| `/tasks/[id]` | `(app)/tasks/[id]/page.tsx` | Task detail view |
| `/settings` | `(app)/settings/page.tsx` | Settings hub |
| `/settings/devices` | `(app)/settings/devices/page.tsx` | Device management |
| `/settings/mesh` | `(app)/settings/mesh/page.tsx` | Mesh group management |

**API proxy:** `next.config.js` rewrites `/api/*` → `http://localhost:8080/*` for local dev.

---

## 6. Frontend — Mobile (React Native Expo)

**Location:** `apps/mobile/`

| Tech | Version |
|------|---------|
| Expo SDK | 54+ |
| Expo Router | file-based routing |
| React Native Firebase | Auth, Firestore, FCM |
| expo-camera, expo-av | camera/audio input |

**Screens:** `app/_layout.tsx` → `(auth)/login.tsx` or `(tabs)/chat.tsx`, `tasks/index.tsx`, `settings.tsx`

**API URL resolution:** `src/lib/api.ts` — `getApiBaseUrl()` dynamically resolves the backend URL from `Constants.expoConfig?.hostUri` (for dev on physical devices) or `EXPO_PUBLIC_API_URL`.

---

## 7. Frontend — Desktop (Electron)

**Location:** `apps/desktop/`

Electron 30+ wrapping the web frontend. `src/main/index.ts` loads `http://localhost:3000` in dev, or a packaged web build in production. Includes system tray, `desktopCapturer` for screen share, and IPC bridge via `preload.ts`.

---

## 8. Browser Extension (Chrome MV3)

**Location:** `apps/extension/`

| File | Purpose |
|------|---------|
| `manifest.json` | Chrome MV3 manifest with tab groups, activeTab permissions |
| `src/background/service-worker.ts` | Maintains WebSocket to backend, handles commands (navigate, click, type, screenshot) |
| `src/content/content-script.ts` | DOM automation — executes click, type, read_dom commands |
| `src/popup/popup.ts` | Opens `/tasks` in the web app |

---

## 9. Shared Packages

### @oi/shared-types (`packages/shared-types/`)
TypeScript interfaces: `IChatMessage`, `ITaskStep`, `ITaskDocument`, `IDevice`, `IUser`, `IWebSocketFrame`, `IMeshGroup`, API request/response types.

### @oi/api-client (`packages/api-client/`)
- `OiHttpClient` — REST client (sendMessage, listTasks, getTask, registerDevice, etc.)
- `createTaskListener` / `createMeshListener` — Firestore real-time listeners
- `OiWebSocketClient` — WebSocket for voice streaming and extension commands

### @oi/theme (`packages/theme/`)
Design tokens:
- **Colors:** Maroon palette (`#751636` primary, `#33101c` deep), neutrals, status colors
- **Typography:** font families, sizes, weights
- **Spacing:** 4px grid scale

---

## 10. Color Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `maroon.500` | `#751636` | Primary brand color |
| `maroon.900` | `#33101C` | Deep backgrounds, dark mode |
| `maroon.50` | `#FAE8ED` | Light backgrounds |
| `neutral.0` | `#FFFFFF` | White |
| `neutral.1000` | `#000000` | Black |
| `status.success` | `#24C07F` | Success states |
| `status.warning` | `#F5A623` | Warnings |
| `status.error` | `#E04040` | Errors |
| `status.info` | `#4A90D9` | Info states |

---

## 11. Infrastructure (Terraform)

**Location:** `infra/terraform/`

| Resource | Purpose |
|----------|---------|
| Cloud Run | Backend deployment |
| Firestore | All persistent storage |
| Pub/Sub | Task event bus |
| Cloud Storage | File uploads |
| Artifact Registry | Docker images |
| Secret Manager | API keys, credentials |

Variables: `project_id`, `region` (default: `us-central1`), `environment` (staging/prod), `backend_image`.

---

## 12. CI/CD (GitHub Actions)

| Workflow | Trigger | Jobs |
|----------|---------|------|
| `backend.yml` | `apps/backend/**` | lint-and-test → deploy-staging (Cloud Run) |
| `web.yml` | `apps/web/**`, `packages/**` | lint-and-build |
| `mobile.yml` | `apps/mobile/**`, `packages/**` | lint-and-typecheck → EAS build |
| `desktop.yml` | `apps/desktop/**`, `packages/**` | lint → build (matrix: macOS, Linux, Windows) |
| `extension.yml` | `apps/extension/**` | lint-and-build |

---

## 13. Dependencies

### Python (`apps/backend/requirements.txt`)

| Category | Packages |
|----------|----------|
| Runtime | fastapi, uvicorn, gunicorn, pydantic, pydantic-settings, python-dotenv, PyYAML, tenacity, structlog |
| Google Cloud | google-adk, google-genai, google-cloud-aiplatform, google-cloud-logging, google-cloud-secret-manager, google-cloud-storage, google-cloud-firestore, google-cloud-pubsub, google-cloud-scheduler, google-cloud-texttospeech, google-cloud-speech |
| Firebase | firebase-admin |
| LangChain | langchain, langgraph, langchain-google-vertexai |
| Crypto | PyNaCl (Ed25519 device PoP) |
| Observability | opentelemetry-api, opentelemetry-sdk, opentelemetry-instrumentation-fastapi |
| Testing | pytest, pytest-asyncio, httpx, ruff, mypy |

### Node.js (key packages)

| App | Dependencies |
|-----|-------------|
| web | next, react, tailwindcss, firebase, @tanstack/react-query, zustand |
| mobile | expo ~54, react-native, @react-native-firebase/*, expo-camera, expo-av, expo-router |
| desktop | electron, electron-serve, electron-builder |
| extension | vite, @types/chrome |

---

## 14. Quick Start

```bash
# 1. Install TypeScript dependencies
pnpm install

# 2. Bootstrap Python backend
cd apps/backend && make bootstrap && cd ../..

# 3. Configure GCP credentials
gcloud auth application-default login

# 4. Set up environment
cp apps/backend/.env.example apps/backend/.env
# Edit .env with your GOOGLE_CLOUD_PROJECT and FIREBASE_PROJECT_ID

# 5. Run services
pnpm dev:backend    # FastAPI → http://localhost:8080
pnpm dev:web        # Next.js → http://localhost:3000
pnpm dev:mobile     # Expo  → http://localhost:8081

# 6. Run backend tests
cd apps/backend && make test
```

---

## 15. Key Design Decisions

1. **Monorepo with pnpm workspaces** — single repo for all apps + shared packages; path-filtered CI
2. **Firebase Auth everywhere** — web, mobile, desktop, extension all use Firebase ID tokens; backend verifies via Admin SDK
3. **Firestore as single DB** — no Postgres; all device identity, tasks, mesh state, and session data in Firestore
4. **Ed25519 device PoP** — devices prove possession of a private key on every protected request; keys stored in Firestore; nonce replay prevention
5. **LangGraph for task lifecycle** — Curate/Companion/Consult share a single `TaskState`; checkpointed to Firestore; supports scheduling, human-in-the-loop, and re-planning
6. **Mesh = denormalized Firestore** — `users/{uid}/devices/{deviceId}` is the canonical device list for the mesh; real-time Firestore listeners on all clients; FCM for push notifications
7. **Next.js API proxy** — local dev proxies `/api/*` to the FastAPI backend; no CORS issues
8. **Expo `getApiBaseUrl()`** — mobile dynamically resolves the backend URL from Expo's dev server host IP

---

## 16. Testing

- **Backend:** `pytest` with `pytest-asyncio`. Device management tests use an in-memory fake Firestore client (no external dependencies). Run: `cd apps/backend && make test`
- **Firestore emulator:** For integration tests: `gcloud emulators firestore start --host-port=localhost:8181`, then `export FIRESTORE_EMULATOR_HOST=localhost:8181`
- **Frontend:** Each app has `lint` and `typecheck` scripts via pnpm

---

## 17. File-by-File Reference

### Backend (`apps/backend/src/oi_agent/`)

```
main.py                         FastAPI app with middleware + 3 routers
config.py                       Pydantic settings from .env
api/
  routes.py                     Core REST endpoints (chat, tasks, devices, mesh)
  websocket.py                  /ws endpoint + ConnectionManager
  middleware.py                 CorrelationId + RequestLogging middleware
agents/
  orchestrator.py               Routes messages to Converse or Task graph
  converse/chatbot.py           ConverseChatbot (Google ADK)
  converse/live_stream.py       Gemini Live audio/video
  task_graph/graph.py           LangGraph StateGraph builder
  task_graph/state.py           TaskState TypedDict + TaskStep + TaskStatus
  task_graph/checkpointer.py    FirestoreCheckpointer
  task_graph/nodes/curate.py    Plan decomposition node
  task_graph/nodes/schedule.py  Scheduling / delay node
  task_graph/nodes/companion.py Step execution node
  task_graph/nodes/consult.py   Human-in-the-loop node
auth/
  firebase_auth.py              Firebase token verification + get_current_user
  permissions.py                Mesh-aware authorization
devices/
  firestore_client.py           get_firestore() helper
  enrollment.py                 Ed25519 challenge-response enrollment
  pop_auth.py                   PoP middleware (sig = nonce||ts||method||path||body_sha256||device_id||uid)
  service.py                    Device CRUD (list, revoke, rotate key, update)
  schemas.py                    Pydantic models with string enums
  router.py                     /enrollments, /me/devices, /devices/*, /secure/profile
mesh/
  device_registry.py            Firestore device registration for mesh
  group_manager.py              Mesh group CRUD + invitations
  broadcaster.py                Task event broadcast + FCM push
  action_lock.py                Transactional locking for human actions
memory/
  models.py                     Conversation, ChatMessage, TaskDocument, TaskEvent
  firestore_store.py            Session + Task persistence in Firestore
tools/
  vision.py                     Gemini Vision (image analysis)
  voice.py                      Google Cloud TTS / STT
  computer_use.py               Computer Use API
  registry.py                   Tool registration for ADK
observability/
  telemetry.py                  structlog + OpenTelemetry
```

### Web (`apps/web/src/app/`)

```
layout.tsx                      Root HTML layout
page.tsx                        Landing page
globals.css                     Tailwind + maroon theme
(app)/layout.tsx                App shell with sidebar nav
(app)/chat/page.tsx             Chat interface
(app)/tasks/page.tsx            Task list
(app)/tasks/[id]/page.tsx       Task detail
(app)/settings/page.tsx         Settings hub
(app)/settings/devices/page.tsx Device management
(app)/settings/mesh/page.tsx    Mesh groups
```

### Mobile (`apps/mobile/app/`)

```
_layout.tsx                     Root Stack layout
(auth)/login.tsx                Firebase Auth login
(tabs)/_layout.tsx              Tab bar (Chat, Tasks, Settings)
(tabs)/chat.tsx                 Chat screen
(tabs)/tasks/index.tsx          Tasks screen
(tabs)/settings.tsx             Settings screen
src/lib/api.ts                  getApiBaseUrl() — dynamic host resolution
```
