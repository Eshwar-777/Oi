---
name: OI Refined Architecture Plan
overview: "Refined architecture plan for OI incorporating: (1) Curate/Companion/Consult as a single LangGraph state machine with shared context, (2) device mesh with real-time sync across all user devices, (3) multi-user delegation, and (4) non-technical user UX with Chat + Tasks views instead of four separate tabs."
todos:
  - id: restructure-monorepo
    content: Restructure repo into apps/backend, apps/web, apps/mobile, apps/desktop, apps/extension + packages/ with pnpm workspaces. Move existing src/ into apps/backend/src/
    status: completed
  - id: shared-packages
    content: Create @oi/shared-types (TaskState, MeshGroup, Device, Message types), @oi/api-client (REST + Firestore listener helpers), @oi/theme (maroon palette tokens)
    status: completed
  - id: backend-auth-firestore
    content: Add Firebase Auth middleware, Firestore session/memory store replacing InMemorySessionStore, and WebSocket endpoint for voice streaming + extension
    status: completed
  - id: backend-converse
    content: "Build Converse system: expand existing ADK chatbot with multimodal support (voice via TTS/STT, vision via Gemini Vision, live streaming via Gemini Live)"
    status: completed
  - id: backend-task-graph
    content: "Build the single LangGraph state machine: TaskState TypedDict, Curate node (plan decomposition), Schedule node (Cloud Scheduler trigger), Companion node (step execution with Playwright), Consult node (human-in-the-loop interrupt). Write FirestoreCheckpointer for graph persistence."
    status: completed
  - id: backend-mesh
    content: "Build device mesh layer: DeviceRegistry (register/unregister + FCM tokens), MeshGroupManager (create/invite/revoke), EventBroadcaster (Firestore write + FCM push), ActionLock (Firestore transactions for first-responder-wins)"
    status: completed
  - id: web-app
    content: "Build Next.js app: landing/download page, Chat view (Converse), Tasks view (list + detail with live Firestore updates + action-needed), Settings view (devices + mesh groups). Maroon theme via @oi/theme + Tailwind."
    status: completed
  - id: mobile-app
    content: "Build Expo app: Chat tab (text + voice + camera), Tasks tab (Firestore real-time task list + detail + action on blocks), Settings tab (devices + mesh). FCM push notifications with deep link to blocked task."
    status: completed
  - id: desktop-electron
    content: Build Electron shell loading the Next.js web frontend, with system tray integration, native notifications, and screen capture for Converse
    status: completed
  - id: browser-extension
    content: "Build Chrome MV3 extension: background service worker (WS to backend), content scripts (DOM click/fill/read), tab grouping under OI label, popup showing current task status"
    status: completed
  - id: infra-terraform
    content: Terraform configs for Cloud Run, Firestore, Pub/Sub, Cloud Scheduler, Cloud Storage, Firebase (Auth + FCM + Hosting), Artifact Registry, Secret Manager
    status: completed
  - id: ci-cd-pipelines
    content: "GitHub Actions: backend.yml (lint+test+deploy Cloud Run), web.yml (lint+test+deploy Firebase Hosting), mobile.yml (EAS Build+Submit), desktop.yml (electron-builder), extension.yml (Chrome Web Store)"
    status: completed
isProject: false
---

# OI -- Refined Architecture and Execution Plan (v2)

This plan supersedes v1. Key changes from the previous plan:

- Curate, Companion, and Consult are **nodes in a single LangGraph state machine**, not separate modules
- UX is **Chat + Tasks** (not four equal tabs) -- users are non-technical
- Device mesh is a first-class architectural concern with real-time sync
- Firestore real-time listeners replace most custom WebSocket broadcasting

---

## 1. The Core Mental Model

OI has exactly **two agent systems** that work independently:

**System A: Converse** -- A standalone multimodal chatbot. Text, voice, images, camera, documents. No task state. Stateless conversations (with session memory). This is the Google ADK chatbot, already scaffolded in [src/oi_agent/agents/adk_chatbot.py](src/oi_agent/agents/adk_chatbot.py).

**System B: Task Lifecycle Graph** -- A single LangGraph state machine where Curate, Companion, and Consult are nodes. They share one `TaskState`. The graph has checkpoints persisted to Firestore so it can pause (wait for schedule, wait for human) and resume across hours or days.

The **Orchestrator** ([src/oi_agent/agents/orchestrator.py](src/oi_agent/agents/orchestrator.py)) decides which system to route to. If the user says "what's the weather?" it goes to Converse. If the user says "book Ed Sheeran tickets at 4pm" it enters the Task Lifecycle Graph.

```mermaid
graph TB
    UserInput["User Message"]
    Orchestrator["Orchestrator"]
    Converse["System A: Converse<br/>(ADK Chatbot)"]
    TaskGraph["System B: Task Lifecycle Graph<br/>(LangGraph)"]
    
    UserInput --> Orchestrator
    Orchestrator -->|"chat / question / voice"| Converse
    Orchestrator -->|"automate / plan / do something"| TaskGraph

    subgraph taskNodes [Task Lifecycle -- Single Shared State]
        Curate["Curate Node<br/>Plan the task"]
        Schedule["Schedule Node<br/>Wait for trigger time"]
        Companion["Companion Node<br/>Execute each step"]
        Consult["Consult Node<br/>Ask human for help"]
        Done["Done Node<br/>Report result"]
    end

    TaskGraph --> Curate
    Curate -->|plan ready| Schedule
    Schedule -->|trigger time reached| Companion
    Companion -->|step complete| Companion
    Companion -->|blocked| Consult
    Companion -->|all steps done| Done
    Consult -->|human acted| Companion
    Consult -->|user cancelled| Done
    Curate -->|user wants re-plan| Curate
```

---

## 2. The Shared TaskState (Heart of the System)

All three agents (Curate, Companion, Consult) read and write to the same state object. This is a LangGraph `TypedDict` with annotated reducers:

```python
from typing import Annotated, Literal, TypedDict
from langgraph.graph import add_messages

class TaskStep(TypedDict):
    index: int
    description: str
    action_type: Literal["api_call", "browser_action", "human_decision"]
    target_url: str | None
    status: Literal["pending", "running", "done", "failed", "blocked"]
    result: str | None

class TaskState(TypedDict):
    # Identity -- set once at creation
    task_id: str
    user_id: str
    mesh_group_id: str
    created_by_device_id: str

    # Shared conversation context -- all 3 agents append to this
    messages: Annotated[list, add_messages]

    # Curate populates these
    plan_description: str
    steps: list[TaskStep]
    scheduled_at: str | None          # ISO timestamp or None for immediate

    # Companion updates these
    current_step_index: int
    status: Literal[
        "planning", "awaiting_approval", "scheduled",
        "running", "blocked", "completed", "failed", "cancelled"
    ]

    # Consult populates these when human acts
    blocked_reason: str | None
    blocked_screenshot_url: str | None
    human_action_response: str | None
    human_action_device_id: str | None
```

**How this flows:**

1. Curate node receives user request in `messages`, produces `plan_description` + `steps`, sets `status = "awaiting_approval"`
2. User approves (or OI auto-approves simple plans). Schedule node sets `status = "scheduled"` and waits.
3. At trigger time, Companion node picks up, iterates through `steps`, updates `current_step_index` and each step's `status`
4. If a step hits a blocker (CAPTCHA, decision needed), Companion sets `status = "blocked"`, `blocked_reason`, `blocked_screenshot_url`
5. LangGraph checkpoints the state to Firestore and suspends (using `interrupt`)
6. Consult broadcasts "action needed" to all devices in the mesh
7. A human responds from any device. `human_action_response` is written. Graph resumes.
8. Companion reads the human action, continues from where it left off.

---

## 3. Device Mesh Architecture

This is the most architecturally distinct part of OI. Every user has a **device group**. Multiple users can form a **mesh group** for shared task delegation.

### 3a. Mesh Data Model (Firestore)

```
Firestore Collections:

users/{user_id}
  ├── email, display_name, created_at
  └── devices/{device_id}
        ├── device_type: "web" | "mobile" | "desktop" | "extension"
        ├── device_name: "Yandrapue's MacBook Pro"
        ├── fcm_token: string (for push notifications)
        ├── is_online: boolean
        └── last_seen: timestamp

mesh_groups/{group_id}
  ├── owner_user_id: string
  ├── members: [
  │     { user_id, role: "owner" | "delegate", added_at }
  │   ]
  └── name: "Family" | "Work" | etc.

tasks/{task_id}
  ├── mesh_group_id: string
  ├── created_by: { user_id, device_id }
  ├── graph_checkpoint: binary (LangGraph serialized state)
  ├── status: string (denormalized from graph state for queries)
  ├── created_at, updated_at: timestamp
  └── events/{event_id}  (subcollection -- timeline)
        ├── type: "created" | "planned" | "approved" | "scheduled" |
        │         "step_started" | "step_completed" | "blocked" |
        │         "human_acted" | "completed" | "failed" | "cancelled"
        ├── timestamp
        ├── device_id (which device triggered this event)
        ├── user_id (which user triggered this event)
        └── payload: map (event-specific data)

conversations/{session_id}
  ├── user_id
  ├── messages: array
  └── created_at, updated_at
```

### 3b. How Devices Stay in Sync

```mermaid
sequenceDiagram
    participant HomePC as Home PC<br/>(Desktop + Extension)
    participant Backend as OI Backend
    participant Firestore as Firestore
    participant WorkPC as Work PC<br/>(Desktop)
    participant Phone as Mobile Phone

    Note over HomePC,Phone: All 3 devices belong to same user
    
    HomePC->>Backend: Extension runs task step
    Backend->>Firestore: Update task status + add event
    
    Note over Firestore: Real-time listeners fire
    
    Firestore-->>WorkPC: onSnapshot: task updated
    WorkPC-->>WorkPC: UI shows live progress
    
    Firestore-->>Phone: onSnapshot: task updated
    Phone-->>Phone: UI shows live progress

    Backend->>Backend: Step blocked -- CAPTCHA detected
    Backend->>Firestore: status = blocked, screenshot_url
    
    Firestore-->>WorkPC: onSnapshot: blocked!
    Firestore-->>Phone: onSnapshot: blocked!
    
    Backend->>Phone: FCM push: "OI needs your help"
    Backend->>WorkPC: FCM push: "OI needs your help"

    Note over Phone: User opens notification
    Phone->>Backend: POST /tasks/{id}/action (CAPTCHA solved)
    Backend->>Firestore: human_action_response, resume graph
    
    Firestore-->>HomePC: onSnapshot: resumed
    Firestore-->>WorkPC: onSnapshot: resumed
    
    HomePC->>Backend: Extension continues task
```

**Three communication channels, each with a purpose:**

- **Firestore real-time listeners** -- Primary sync mechanism. All clients (web, mobile, desktop) subscribe to task documents. When the backend updates a task, every device sees it instantly. This handles 90% of sync.
- **FCM push notifications** -- Wakes up mobile apps that are backgrounded/closed. The user taps the notification and goes straight to the blocked task.
- **WebSocket** -- Used ONLY for streaming (live voice, live video, Gemini Live bidirectional audio) and for the browser extension (which cannot use Firestore listeners). Not used for task sync.

### 3c. Action Locking (Prevent Double-Action)

When a task is blocked and waiting for human input, multiple devices see the "Action Needed" prompt. To prevent two users/devices from responding simultaneously:

```python
# In the Consult node: Firestore transaction ensures exactly one response
@firestore.transactional
def submit_human_action(transaction, task_ref, action, device_id, user_id):
    task = task_ref.get(transaction=transaction)
    if task.get("status") != "blocked":
        raise AlreadyHandledError("Another device already responded")
    transaction.update(task_ref, {
        "graph_state.human_action_response": action,
        "graph_state.human_action_device_id": device_id,
        "status": "running",
    })
```

All other devices see the status change to "running" via their real-time listener and their UI updates to show "Resumed by [device name]".

---

## 4. UX Architecture (Non-Technical Users)

Users never see "Curate", "Companion", or "Consult" as labels. The app has two primary views:

### App Navigation

```
Bottom Tab Bar (Mobile) / Sidebar (Web + Desktop):
  [Chat]     -- Converse. Talk to OI.
  [Tasks]    -- See all tasks, their plans, progress, and history.
  [Settings] -- Devices, mesh groups, preferences.

Plus:
  [Action Needed Badge] -- Red badge on Tasks tab when any task is blocked.
  [Push Notification]   -- "OI needs your help with: Book Ed Sheeran tickets"
                           Taps directly to the blocked task in Tasks view.
```

### How the User Experiences It

1. User opens Chat, says: "Book 2 Ed Sheeran concert tickets at 4pm today"
2. OI responds IN THE CHAT: "Got it. Here's my plan: 1) Open Ticketmaster at 3:59pm 2) Search for Ed Sheeran 3) Select 2 best available tickets 4) Proceed to checkout. Should I go ahead?"
3. User says "Yes" in the chat.
4. A new task card appears in the Tasks view. Status: "Scheduled for 4:00 PM". The Chat shows: "All set! I'll start at 4pm. You can track progress in Tasks."
5. At 4pm, the task card updates live: "Running -- Step 1: Opening Ticketmaster..."
6. If blocked: Push notification arrives. User taps it. Task card shows the CAPTCHA image with a "Solve and Continue" button.
7. User solves it. Task resumes. "Step 3: Selecting tickets..."
8. Task completes. "Booked! 2 tickets, Section A, Row 12. Confirmation #XYZ."

The **transition from Chat to Task is seamless** -- it happens in the same conversation. The Task view is just a dashboard for monitoring and acting.

---

## 5. Backend Architecture (Refined)

### Directory Structure (within `apps/backend/src/oi_agent/`)

```
oi_agent/
├── __init__.py
├── main.py                          # FastAPI app entry
├── config.py                        # Pydantic settings (exists)
│
├── api/
│   ├── routes.py                    # REST endpoints (exists, to be expanded)
│   ├── websocket.py                 # WS for voice streaming + extension
│   └── middleware.py                # Auth, CORS, rate-limit, correlation IDs
│
├── agents/
│   ├── orchestrator.py              # Routes Chat vs Task (exists, to be expanded)
│   │
│   ├── converse/                    # System A: Standalone chatbot
│   │   ├── chatbot.py              # ADK text chat (from existing adk_chatbot.py)
│   │   └── live_stream.py          # Gemini Live bidirectional voice/video
│   │
│   └── task_graph/                  # System B: Single LangGraph -- Curate+Companion+Consult
│       ├── graph.py                 # Graph definition: nodes, edges, compile
│       ├── state.py                 # TaskState TypedDict (shared by all nodes)
│       ├── checkpointer.py          # Firestore-backed LangGraph checkpoint saver
│       └── nodes/
│           ├── curate.py            # Plan decomposition node
│           ├── schedule.py          # Wait-for-trigger node
│           ├── companion.py         # Step execution node
│           └── consult.py           # Human-in-the-loop interrupt node
│
├── tools/
│   ├── registry.py                  # Tool registry (exists)
│   ├── browser_automation.py        # Playwright headless
│   ├── computer_use.py              # Gemini Computer Use (exists)
│   ├── vision.py                    # Image/camera analysis via Gemini Vision
│   ├── voice.py                     # Google Cloud TTS + STT
│   └── google_cloud.py             # GCP context helper (exists)
│
├── mesh/
│   ├── device_registry.py           # Register/unregister devices, FCM tokens
│   ├── group_manager.py             # Create/manage mesh groups, invite users
│   ├── broadcaster.py               # Broadcast task events to all mesh devices
│   └── action_lock.py              # Firestore transactional locking for Consult
│
├── auth/
│   ├── firebase_auth.py             # Verify Firebase ID tokens
│   └── permissions.py              # Mesh-aware authorization (can user X act on task Y?)
│
├── memory/
│   ├── store.py                     # Abstract interface (exists)
│   ├── firestore_store.py           # Firestore implementation
│   └── models.py                    # Pydantic data models for Firestore documents
│
├── prompts/loader.py                # (exists)
├── skills/loader.py                 # (exists)
└── observability/telemetry.py       # (exists)
```

### The Task Graph in Detail (graph.py)

```python
from langgraph.graph import StateGraph, END
from oi_agent.agents.task_graph.state import TaskState
from oi_agent.agents.task_graph.nodes import curate, schedule, companion, consult

def build_task_graph() -> StateGraph:
    graph = StateGraph(TaskState)

    graph.add_node("curate", curate.run)
    graph.add_node("schedule", schedule.run)
    graph.add_node("companion", companion.run)
    graph.add_node("consult", consult.run)

    graph.set_entry_point("curate")

    graph.add_edge("curate", "schedule")

    graph.add_conditional_edges("schedule", schedule.route, {
        "execute": "companion",
        "wait": END,          # checkpoint + resume via Cloud Scheduler
    })

    graph.add_conditional_edges("companion", companion.route, {
        "next_step": "companion",  # loop: execute next step
        "blocked": "consult",       # needs human
        "done": END,
        "failed": END,
    })

    graph.add_conditional_edges("consult", consult.route, {
        "resume": "companion",     # human acted, continue
        "re_plan": "curate",       # human wants a different plan
        "cancel": END,
    })

    return graph

# Compiled with Firestore checkpointer for persistence
task_graph = build_task_graph().compile(
    checkpointer=FirestoreCheckpointer()
)
```

---

## 6. System Architecture Diagram (Complete)

```mermaid
graph TB
    subgraph devices [User Devices -- Mesh Group]
        WebApp["Web App<br/>(Next.js)"]
        DesktopApp["Desktop App<br/>(Electron)"]
        MobileApp["Mobile App<br/>(Expo)"]
        Extension["Browser Extension<br/>(Chrome MV3)"]
    end

    subgraph gateway [API Layer -- Cloud Run]
        FastAPI["FastAPI"]
        WSEndpoint["WebSocket Endpoint"]
        AuthMiddleware["Firebase Auth<br/>Middleware"]
    end

    subgraph orchestration [Agent Orchestration]
        Orchestrator["Orchestrator"]

        subgraph converse [System A: Converse]
            ADKChat["ADK Chatbot<br/>(text + vision)"]
            GeminiLive["Gemini Live<br/>(voice + video stream)"]
        end

        subgraph taskGraph [System B: Task Lifecycle Graph -- LangGraph]
            CurateNode["Curate Node"]
            ScheduleNode["Schedule Node"]
            CompanionNode["Companion Node"]
            ConsultNode["Consult Node"]
            GraphState["Shared TaskState"]
        end
    end

    subgraph meshLayer [Device Mesh Layer]
        DeviceRegistry["Device Registry"]
        MeshGroups["Mesh Group Manager"]
        Broadcaster["Event Broadcaster"]
        ActionLock["Action Lock<br/>(Transactional)"]
    end

    subgraph toolLayer [Tools]
        Playwright["Playwright<br/>(Browser Automation)"]
        GeminiVision["Gemini Vision"]
        TTS_STT["Google TTS/STT"]
        ComputerUse["Gemini Computer Use"]
    end

    subgraph gcp [Google Cloud]
        VertexAI["Vertex AI<br/>(Gemini Models)"]
        FirestoreDB["Firestore"]
        PubSub["Cloud Pub/Sub"]
        CloudScheduler["Cloud Scheduler"]
        FCM["Firebase Cloud<br/>Messaging"]
        GCS["Cloud Storage"]
    end

    WebApp & DesktopApp & MobileApp -->|"REST + Firestore listeners"| FastAPI
    Extension -->|"WebSocket"| WSEndpoint
    MobileApp -.->|"FCM push"| FCM

    FastAPI --> AuthMiddleware --> Orchestrator

    Orchestrator --> ADKChat
    Orchestrator --> GeminiLive
    Orchestrator --> CurateNode

    CurateNode --> GraphState
    ScheduleNode --> GraphState
    CompanionNode --> GraphState
    ConsultNode --> GraphState

    CurateNode --> ScheduleNode
    ScheduleNode --> CompanionNode
    CompanionNode --> ConsultNode
    ConsultNode --> CompanionNode

    GraphState -->|checkpoint| FirestoreDB

    CompanionNode --> Playwright
    CompanionNode --> ComputerUse
    ADKChat --> GeminiVision
    GeminiLive --> VertexAI

    Playwright --> Extension
    ConsultNode --> Broadcaster
    Broadcaster --> FCM
    Broadcaster --> FirestoreDB

    ScheduleNode --> CloudScheduler
    CloudScheduler --> PubSub
    PubSub --> CompanionNode

    FirestoreDB -.->|"real-time sync"| WebApp
    FirestoreDB -.->|"real-time sync"| DesktopApp
    FirestoreDB -.->|"real-time sync"| MobileApp
```

---

## 7. Real-Time Sync: The Ed Sheeran Ticket Example (Full Flow)

```mermaid
sequenceDiagram
    participant User
    participant Phone as Phone (Mobile)
    participant HomePC as Home PC (Desktop + Extension)
    participant WorkPC as Work PC (Desktop)
    participant Backend as OI Backend
    participant FS as Firestore
    participant Scheduler as Cloud Scheduler
    participant FCMSvc as FCM

    Note over User,FCMSvc: 10:00 AM -- User creates task from phone during commute

    User->>Phone: "Book 2 Ed Sheeran tickets at 4pm"
    Phone->>Backend: POST /chat {message}
    Backend->>Backend: Orchestrator -> Task Graph -> Curate Node
    Backend->>FS: Create task doc + checkpoint (status: planning)
    
    FS-->>HomePC: onSnapshot: new task (planning)
    FS-->>WorkPC: onSnapshot: new task (planning)
    
    Backend->>Backend: Curate produces plan (3 steps)
    Backend->>FS: Update task (status: awaiting_approval)
    Backend-->>Phone: "Here's my plan: 1) Open Ticketmaster 2) Select tickets 3) Checkout. Go ahead?"

    FS-->>HomePC: onSnapshot: plan ready
    FS-->>WorkPC: onSnapshot: plan ready

    User->>Phone: "Yes, do it"
    Phone->>Backend: POST /chat {message: "yes"}
    Backend->>Backend: Schedule Node: set trigger for 3:59 PM
    Backend->>Scheduler: Create job for 15:59
    Backend->>FS: Update task (status: scheduled, run_at: 15:59)
    Backend-->>Phone: "Scheduled! I'll start at 3:59 PM."

    FS-->>HomePC: onSnapshot: scheduled
    FS-->>WorkPC: onSnapshot: scheduled

    Note over User,FCMSvc: 3:59 PM -- Trigger fires

    Scheduler->>Backend: Pub/Sub trigger
    Backend->>Backend: Resume graph -> Companion Node
    Backend->>FS: Update task (status: running, step 1)
    
    FS-->>Phone: onSnapshot: running step 1
    FS-->>HomePC: onSnapshot: running step 1
    FS-->>WorkPC: onSnapshot: running step 1

    Backend->>HomePC: WS to Extension: open ticketmaster.com
    HomePC-->>Backend: Page loaded, searching...

    Backend->>FS: Update task (step 2: selecting tickets)
    FS-->>Phone: onSnapshot: step 2
    FS-->>WorkPC: onSnapshot: step 2

    HomePC-->>Backend: CAPTCHA detected!
    Backend->>Backend: Companion -> Consult Node
    Backend->>FS: Update task (status: blocked, screenshot_url)
    Backend->>FCMSvc: Push to all mesh devices
    
    FCMSvc-->>Phone: "OI needs help: Solve CAPTCHA"
    FCMSvc-->>WorkPC: "OI needs help: Solve CAPTCHA"

    FS-->>Phone: onSnapshot: blocked + screenshot
    FS-->>WorkPC: onSnapshot: blocked + screenshot

    Note over User: User is in meeting, wife gets notification too (mesh delegate)
    
    User->>Phone: Taps notification -> sees CAPTCHA -> solves it
    Phone->>Backend: POST /tasks/{id}/action (CAPTCHA answer)
    Backend->>Backend: ActionLock: Firestore transaction (first responder wins)
    Backend->>FS: Update task (status: running, human_action received)
    Backend->>Backend: Resume graph -> Companion continues

    FS-->>HomePC: onSnapshot: resumed
    FS-->>WorkPC: onSnapshot: resumed (shows "Resumed by Phone")

    Backend->>HomePC: WS to Extension: submit CAPTCHA, proceed to checkout
    HomePC-->>Backend: Checkout complete! Confirmation #XYZ

    Backend->>FS: Update task (status: completed, result)
    Backend->>FCMSvc: Push: "Tickets booked!"

    FS-->>Phone: onSnapshot: completed
    FS-->>WorkPC: onSnapshot: completed
    FCMSvc-->>Phone: "Ed Sheeran tickets booked! Confirmation #XYZ"
```

---

## 8. Monorepo Structure (Updated)

```
Oi/
├── apps/
│   ├── backend/                     # Python -- FastAPI + ADK + LangGraph
│   │   ├── src/oi_agent/            # (structure from Section 5)
│   │   ├── tests/
│   │   ├── prompts/
│   │   ├── skills/
│   │   ├── configs/
│   │   ├── requirements.txt
│   │   ├── pyproject.toml
│   │   ├── Makefile
│   │   └── Dockerfile
│   │
│   ├── web/                         # Next.js -- Landing + Dashboard
│   │   ├── src/app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx             # Landing / download page
│   │   │   └── (app)/
│   │   │       ├── layout.tsx       # App shell: sidebar with Chat, Tasks, Settings
│   │   │       ├── chat/page.tsx    # Converse
│   │   │       ├── tasks/
│   │   │       │   ├── page.tsx     # Task list dashboard
│   │   │       │   └── [id]/page.tsx # Single task detail + action
│   │   │       └── settings/
│   │   │           ├── page.tsx
│   │   │           ├── devices/page.tsx
│   │   │           └── mesh/page.tsx
│   │   ├── src/components/
│   │   ├── src/features/
│   │   ├── src/hooks/
│   │   ├── src/services/
│   │   ├── package.json
│   │   └── tailwind.config.ts
│   │
│   ├── mobile/                      # React Native Expo
│   │   ├── app/
│   │   │   ├── _layout.tsx
│   │   │   ├── (auth)/
│   │   │   │   ├── login.tsx
│   │   │   │   └── register.tsx
│   │   │   └── (tabs)/
│   │   │       ├── _layout.tsx      # Tab bar: Chat, Tasks, Settings
│   │   │       ├── chat.tsx
│   │   │       ├── tasks/
│   │   │       │   ├── index.tsx    # Task list
│   │   │       │   └── [id].tsx     # Task detail + action
│   │   │       └── settings.tsx
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── desktop/                     # Electron shell
│   │   ├── src/main/
│   │   ├── package.json
│   │   └── electron-builder.yml
│   │
│   └── extension/                   # Chrome MV3
│       ├── src/
│       │   ├── background/          # WS connection to backend, task execution
│       │   ├── content/             # DOM interaction scripts
│       │   └── popup/               # Mini task status UI
│       ├── manifest.json
│       └── package.json
│
├── packages/
│   ├── shared-types/                # @oi/shared-types
│   │   └── src/
│   │       ├── api.ts               # REST request/response types
│   │       ├── task.ts              # TaskState, TaskStep, TaskEvent
│   │       ├── mesh.ts              # MeshGroup, Device, Member
│   │       ├── chat.ts              # Message, Conversation
│   │       └── websocket.ts         # WS frame types
│   ├── api-client/                  # @oi/api-client
│   │   └── src/
│   │       ├── http.ts              # REST client (shared across all apps)
│   │       ├── firestore.ts         # Firestore listener helpers
│   │       └── ws.ts               # WebSocket client (voice + extension)
│   └── theme/                       # @oi/theme
│       └── src/
│           ├── colors.ts            # #751636, #33101c, whites, blacks
│           ├── typography.ts
│           └── spacing.ts
│
├── infra/terraform/
├── .github/workflows/
├── docs/
├── scripts/
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

---

## 9. Technology Stack (Same as v1, with additions)

### Backend (Python)

- FastAPI, Uvicorn/Gunicorn, Pydantic v2
- Google ADK 1.0+, LangChain 0.3+, **LangGraph 0.2+** (the centerpiece)
- Gemini 2.5 Flash (text), Gemini 2.0 Flash Live (streaming), Gemini Vision
- **Playwright** (browser automation in Companion node)
- Google Cloud TTS + STT (OI's voice)
- **Firebase Admin SDK** (auth, Firestore, FCM)
- Firestore (persistence, real-time sync, graph checkpoints)
- Cloud Pub/Sub + Cloud Scheduler (timed task triggers)
- Cloud Storage (uploads, screenshots)
- structlog + OpenTelemetry (observability)

### Frontend Web (TypeScript)

- Next.js 14+ (App Router), Tailwind CSS v4 (maroon theme)
- TanStack Query (server state), Zustand (client state)
- **Firebase JS SDK** (Auth + Firestore real-time listeners)
- WebSocket (voice streaming only)

### Mobile (TypeScript)

- Expo SDK 51+, Expo Router
- TanStack Query + Zustand
- **React Native Firebase** (Auth + Firestore + Cloud Messaging)
- expo-camera, expo-av, expo-notifications

### Desktop

- Electron 30+ wrapping the Next.js web frontend
- System tray, native notifications, screen capture

### Browser Extension

- Chrome MV3, WebSocket to backend, DOM content scripts, Tab Groups API

### Infrastructure

- GCP: Cloud Run, Firestore, Pub/Sub, Scheduler, Storage, FCM, Secret Manager
- Terraform for IaC, GitHub Actions for CI/CD

---

## 10. All Configurations Needed

### Backend `.env`

```
ENV=dev
APP_NAME=oi-agent
APP_HOST=0.0.0.0
APP_PORT=8080
LOG_LEVEL=INFO

GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_GENAI_USE_VERTEXAI=true
GOOGLE_APPLICATION_CREDENTIALS=

GEMINI_MODEL=gemini-2.5-flash
GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001
ADK_APP_NAME=oi-adk-chatbot

FIREBASE_PROJECT_ID=your-project-id
FIRESTORE_DATABASE=(default)

PUBSUB_TOPIC_TASKS=oi-tasks
PUBSUB_SUBSCRIPTION_TASKS=oi-tasks-sub
GCS_BUCKET_UPLOADS=oi-uploads

TTS_LANGUAGE_CODE=en-US
TTS_VOICE_NAME=en-US-Neural2-D

ENABLE_LIVE_STREAMING=true
ENABLE_COMPUTER_USE=false
ENABLE_VISION_TOOLS=true
ENABLE_BROWSER_AUTOMATION=false

ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8081
REQUEST_TIMEOUT_SECONDS=30
MAX_TOOL_CALLS_PER_REQUEST=10
```

### Web `.env.local`

```
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
```

### Mobile `.env`

```
API_URL=http://localhost:8080
WS_URL=ws://localhost:8080/ws
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
```

### GCP Resources (Terraform)

- Cloud Run: `oi-backend`
- Firestore: `(default)` with collections: `users`, `mesh_groups`, `tasks`, `conversations`
- Pub/Sub: topic `oi-tasks`, subscription `oi-tasks-sub`
- Cloud Scheduler: jobs created dynamically per task
- Cloud Storage: `oi-uploads`
- Firebase: Auth (email + Google), Cloud Messaging, Hosting
- Artifact Registry: `oi-images`
- Secret Manager: all sensitive env vars

---

## 11. CI/CD (Same as v1)

- **Every PR:** lint + typecheck + unit tests + build check (path-filtered per app)
- **Merge to main:** Docker build -> deploy staging -> integration tests -> manual gate to prod
- **Git tag:** EAS Build (mobile), electron-builder (desktop), Chrome Web Store (extension)
- **Secrets:** GitHub Actions Secrets + GCP Workload Identity Federation

---

## 12. Build Order (Revised Phases)

**Phase 1 -- Foundation + Converse (Weeks 1-3)**

- Restructure monorepo (move existing code into `apps/backend/`)
- Shared packages: `@oi/shared-types`, `@oi/api-client`, `@oi/theme`
- Backend: Firebase Auth middleware, Firestore store, expand existing chatbot
- Web: Next.js app with landing page + Chat view (Converse only)
- CI/CD: backend + web pipelines

**Phase 2 -- Multimodal + Mobile + Desktop (Weeks 4-6)**

- Backend: Voice (TTS/STT), Vision, Gemini Live streaming
- Web: Voice input/output, image upload, camera, screen share
- Mobile: Expo scaffold, Chat tab with voice + camera
- Desktop: Electron shell loading web frontend

**Phase 3 -- Task Lifecycle Graph (Weeks 7-10)**

- Backend: Build the LangGraph state machine (Curate + Companion + Consult nodes)
- Backend: Firestore checkpointer for graph persistence
- Backend: Cloud Scheduler + Pub/Sub integration for timed tasks
- Backend: Playwright browser automation tool
- Extension: Chrome extension with tab grouping + DOM interaction
- Web + Mobile: Tasks view (create plan, monitor progress, act on blocks)

**Phase 4 -- Device Mesh (Weeks 11-13)**

- Backend: Device registry, mesh group manager, event broadcaster
- Backend: Action locking (Firestore transactions)
- Backend: FCM push notification dispatch
- All clients: Firestore real-time listeners for task sync
- Mobile: Push notification handling, deep link to blocked task
- Web + Mobile: Settings view (devices, mesh groups, invitations)

**Phase 5 -- Polish + Production (Weeks 14-16)**

- Production checklist (see `docs/PRODUCTION_CHECKLIST.md`)
- E2E testing across all platforms and mesh scenarios
- Security audit (mesh authorization, action delegation)
- Performance: concurrent tasks, mesh with 5+ devices
- App store submissions, desktop builds, extension submission

---

## 13. Key Risks and Mitigations

- **LangGraph checkpointing to Firestore:** LangGraph has built-in MemorySaver but no Firestore saver. We need to write `FirestoreCheckpointer` implementing the `BaseCheckpointSaver` interface. This is straightforward but must be tested for serialization edge cases.
- **Browser automation blocked by bot detection:** Playwright can be fingerprinted. Mitigation: (1) use stealth plugins, (2) fall back to Gemini Computer Use which operates via screenshots, (3) always have Consult as the safety net.
- **Real-time sync latency:** Firestore listeners are fast (sub-second in same region) but add ~100-300ms. For the Task view this is fine. For voice streaming, we use WebSocket (not Firestore).
- **Mesh security:** A delegate user can act on tasks they're invited to. Every action is logged with `user_id` + `device_id`. Mesh owners can revoke delegates instantly. Firestore security rules enforce read/write scoping.
- **Graph resumption after hours/days:** LangGraph checkpoints are durable. The Cloud Scheduler fires a Pub/Sub message which triggers a Cloud Run instance that loads the checkpoint and resumes. Stateless compute, stateful graph.

---

## 14. Code Philosophy

- Every module has a single responsibility with a name that tells you what it does
- Functions are short (under 30 lines), with descriptive names that read as sentences
- Type hints on everything -- types are the documentation
- No abbreviations in variable names (`notification` not `notif`, `scheduler` not `sched`)
- Constants at the top, private helpers at the bottom, public API in the middle
- Every file follows: imports -> constants -> types -> public functions -> private helpers
- Tests mirror the source tree and read as behavior specifications
- The LangGraph nodes are pure functions: `(TaskState) -> dict` -- easy to test in isolation
