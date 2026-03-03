from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from oi_agent.agents.orchestrator import AgentOrchestrator
from oi_agent.auth.firebase_auth import get_current_user

router = APIRouter()
orchestrator = AgentOrchestrator()


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    session_id: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1)
    device_id: str | None = None


class TaskCreateRequest(BaseModel):
    description: str = Field(..., min_length=1)
    device_id: str = Field(default="api-client")
    scheduled_at: str | None = None


class TaskActionRequest(BaseModel):
    action: str = Field(..., min_length=1)
    device_id: str = Field(..., min_length=1)


class DeviceRegisterRequest(BaseModel):
    device_type: str = Field(..., min_length=1)
    device_name: str = Field(..., min_length=1)
    fcm_token: str | None = None


class MeshInviteRequest(BaseModel):
    email: str = Field(..., min_length=1)
    group_id: str = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Chat (Converse)
# ---------------------------------------------------------------------------

@router.post("/chat")
async def chat(
    payload: ChatRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    """Send a message to OI and get a response.

    The orchestrator decides whether this is a regular conversation
    or a task creation request.
    """
    try:
        response = await orchestrator.handle(
            user_id=user["uid"],
            session_id=payload.session_id,
            message=payload.message,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Chat failed: {exc}") from exc

    return {"response": response}


@router.post("/interact")
async def interact(
    payload: ChatRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    """Alias for /chat for backward compatibility."""
    return await chat(payload, user)


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------

@router.post("/tasks/create")
async def create_task(
    payload: TaskCreateRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Create a task and run it through the full LangGraph lifecycle.

    Bypasses the Converse chatbot and feeds the description directly
    into the Curate -> Schedule -> Companion -> Consult graph.
    """
    import uuid
    from langchain_core.messages import HumanMessage

    task_id = str(uuid.uuid4())
    user_id = user["uid"]

    initial_state = {
        "task_id": task_id,
        "user_id": user_id,
        "mesh_group_id": user_id,
        "created_by_device_id": payload.device_id,
        "messages": [HumanMessage(content=payload.description)],
        "plan_description": "",
        "steps": [],
        "scheduled_at": payload.scheduled_at,
        "current_step_index": 0,
        "status": "planning",
        "blocked_reason": None,
        "blocked_screenshot_url": None,
        "human_action_response": None,
        "human_action_device_id": None,
    }

    try:
        from oi_agent.agents.task_graph.graph import build_task_graph

        graph = build_task_graph().compile()

        final_state = await graph.ainvoke(
            initial_state,
            config={
                "configurable": {"thread_id": task_id},
                "recursion_limit": 200,
            },
        )

        return {
            "task_id": task_id,
            "status": final_state.get("status", "unknown"),
            "plan_description": final_state.get("plan_description", ""),
            "steps": final_state.get("steps", []),
            "current_step_index": final_state.get("current_step_index", 0),
            "blocked_reason": final_state.get("blocked_reason"),
            "scheduled_at": final_state.get("scheduled_at"),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Task graph execution failed: {exc}",
        ) from exc


@router.get("/tasks")
async def list_tasks(
    user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """List all tasks for the authenticated user."""
    try:
        from oi_agent.memory.firestore_store import FirestoreTaskStore

        store = FirestoreTaskStore()
        tasks = await store.list_user_tasks(user["uid"])
        return [t.model_dump(mode="json") for t in tasks]
    except Exception:
        return []


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Get details for a specific task."""
    from oi_agent.memory.firestore_store import FirestoreTaskStore

    store = FirestoreTaskStore()
    task = await store.get_task(task_id)

    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.created_by_user_id != user["uid"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    return task.model_dump(mode="json")


@router.post("/tasks/{task_id}/action")
async def submit_task_action(
    task_id: str,
    payload: TaskActionRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    """Submit a human action for a blocked task (Consult flow)."""
    from oi_agent.mesh.action_lock import AlreadyHandledError, submit_human_action

    try:
        await submit_human_action(
            task_id=task_id,
            action=payload.action,
            device_id=payload.device_id,
            user_id=user["uid"],
        )
    except AlreadyHandledError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {"status": "action_submitted"}


@router.put("/tasks/{task_id}/cancel")
async def cancel_task(
    task_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    """Cancel a scheduled or running task."""
    from oi_agent.memory.firestore_store import FirestoreTaskStore

    store = FirestoreTaskStore()
    task = await store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.created_by_user_id != user["uid"]:
        raise HTTPException(status_code=403, detail="Forbidden")

    await store.update_task(task_id, {"status": "cancelled"})
    return {"status": "cancelled"}


# ---------------------------------------------------------------------------
# Devices
# ---------------------------------------------------------------------------

@router.post("/devices/register")
async def register_device(
    payload: DeviceRegisterRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    """Register a device for the authenticated user."""
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    device_id = await registry.register_device(
        user_id=user["uid"],
        device_type=payload.device_type,
        device_name=payload.device_name,
        fcm_token=payload.fcm_token,
    )
    return {"device_id": device_id}


@router.get("/devices")
async def list_devices(
    user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """List all devices for the authenticated user."""
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    return await registry.get_user_devices(user["uid"])


# ---------------------------------------------------------------------------
# Mesh Groups
# ---------------------------------------------------------------------------

@router.post("/mesh/invite")
async def invite_mesh_member(
    payload: MeshInviteRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    """Invite a user to a mesh group."""
    from oi_agent.mesh.group_manager import MeshGroupManager

    manager = MeshGroupManager()
    try:
        await manager.invite_member(
            group_id=payload.group_id,
            inviter_user_id=user["uid"],
            invitee_user_id=payload.email,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    return {"status": "invited"}


@router.get("/mesh/groups")
async def list_mesh_groups(
    user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """List all mesh groups the user belongs to."""
    from oi_agent.mesh.group_manager import MeshGroupManager

    manager = MeshGroupManager()
    return await manager.get_user_groups(user["uid"])
