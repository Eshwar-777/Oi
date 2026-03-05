from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from oi_agent.agents.orchestrator import AgentOrchestrator
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.services.tools.tab_selector import select_best_attached_tab

logger = logging.getLogger(__name__)

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


class DeviceRegisterRequest(BaseModel):
    device_type: str = Field(..., min_length=1)
    device_name: str = Field(..., min_length=1)
    fcm_token: str | None = None


class MeshInviteRequest(BaseModel):
    email: str = Field(..., min_length=1)
    group_id: str = Field(..., min_length=1)


class BrowserActionRequest(BaseModel):
    action: str = Field(..., min_length=1)
    target: Any = ""
    value: str = ""
    device_id: str | None = None
    tab_id: int | None = None
    run_id: str | None = None
    timeout_seconds: float | None = None


class BrowserNavigateRequest(BaseModel):
    url: str = Field(..., min_length=1)
    device_id: str | None = None
    tab_id: int | None = None
    run_id: str | None = None


class BrowserSnapshotRequest(BaseModel):
    device_id: str | None = None
    tab_id: int | None = None
    run_id: str | None = None


class BrowserAgentPromptRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    device_id: str | None = None
    tab_id: int | None = None
    run_id: str | None = None


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Browser Control API (UI Navigator)
# ---------------------------------------------------------------------------

def _resolve_device_and_tab(
    device_id: str | None,
    tab_id: int | None,
) -> tuple[str, int | None]:
    """Resolve device_id and optional tab_id from the connection manager."""
    from oi_agent.api.websocket import connection_manager

    dev = device_id or next(iter(connection_manager.get_extension_device_ids()), "")
    if not dev:
        raise HTTPException(
            status_code=409,
            detail="No extension connected. Install/connect the Oi extension, attach a tab, then try again.",
        )
    if connection_manager.is_attach_state_known(dev) and not connection_manager.has_attached_target(dev):
        raise HTTPException(
            status_code=409,
            detail="No tab attached. Click the Oi extension icon on the tab you want to control, then try again.",
        )
    return dev, tab_id


def _resolve_device_and_tab_for_prompt(
    *,
    prompt: str,
    device_id: str | None,
    tab_id: int | None,
) -> tuple[str, int | None]:
    """Resolve target tab; auto-select best tab when tab_id is not provided."""
    from oi_agent.api.websocket import connection_manager

    explicit_device_id = device_id
    dev, explicit_tab = _resolve_device_and_tab(device_id, tab_id)
    if explicit_tab is not None:
        return dev, explicit_tab

    selected = select_best_attached_tab(
        prompt=prompt,
        attached_rows=connection_manager.list_attached_targets(),
        preferred_device_id=explicit_device_id,
    )
    if selected is None:
        return dev, explicit_tab
    selected_dev, selected_tab = selected
    return selected_dev, selected_tab


@router.get("/browser/tabs")
async def list_browser_tabs(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user["uid"]
    from oi_agent.api.websocket import connection_manager

    return {"items": connection_manager.list_attached_targets()}


@router.post("/browser/act")
async def browser_act(
    payload: BrowserActionRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user["uid"]
    from oi_agent.api.websocket import connection_manager

    device_id, tab_id = _resolve_device_and_tab(payload.device_id, payload.tab_id)

    cmd_id = str(uuid.uuid4())[:8]
    command: dict[str, Any] = {
        "type": "extension_command",
        "payload": {
            "cmd_id": cmd_id,
            "run_id": payload.run_id or "browser-api",
            "action": payload.action,
            "target": payload.target,
            "value": payload.value,
        },
    }
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id

    timeout = payload.timeout_seconds or (20.0 if payload.action == "navigate" else 30.0)
    result = await connection_manager.send_command_and_wait(device_id, command, timeout=timeout)
    return {
        "device_id": device_id,
        "attached_target": connection_manager.get_attached_target(device_id, tab_id),
        "result": result,
    }


@router.post("/browser/navigate")
async def browser_navigate(
    payload: BrowserNavigateRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    return await browser_act(
        BrowserActionRequest(
            action="navigate",
            target=payload.url,
            device_id=payload.device_id,
            tab_id=payload.tab_id,
            run_id=payload.run_id,
            timeout_seconds=20.0,
        ),
        user,
    )


@router.post("/browser/snapshot")
async def browser_snapshot(
    payload: BrowserSnapshotRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    return await browser_act(
        BrowserActionRequest(
            action="read_dom",
            target="",
            device_id=payload.device_id,
            tab_id=payload.tab_id,
            run_id=payload.run_id,
            timeout_seconds=25.0,
        ),
        user,
    )


@router.post("/browser/agent/plan")
async def browser_agent_plan(
    payload: BrowserAgentPromptRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.step_planner import plan_browser_steps

    explicit_device_id = payload.device_id
    device_id = payload.device_id or next(iter(connection_manager.get_extension_device_ids()), "")
    tab_id = payload.tab_id
    if device_id and connection_manager.has_attached_target(device_id) and tab_id is None:
        selected = select_best_attached_tab(
            prompt=payload.prompt,
            attached_rows=connection_manager.list_attached_targets(),
            preferred_device_id=explicit_device_id,
        )
        if selected:
            device_id, tab_id = selected
    target_url = ""
    page_title = ""
    if device_id and connection_manager.has_attached_target(device_id):
        attached = connection_manager.get_attached_target(device_id, tab_id) or {}
        target_url = attached.get("url", "") or ""
        page_title = attached.get("title", "") or ""

    plan = await plan_browser_steps(
        user_prompt=payload.prompt,
        current_url=target_url,
        current_page_title=page_title,
    )
    return {"ok": True, "plan": plan, "selected_target": {"device_id": device_id, "tab_id": tab_id}}


@router.post("/browser/agent")
async def browser_agent_prompt(
    payload: BrowserAgentPromptRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.base import ToolContext
    from oi_agent.services.tools.browser_automation import BrowserAutomationTool
    from oi_agent.services.tools.step_planner import plan_browser_steps

    device_id, tab_id = _resolve_device_and_tab_for_prompt(
        prompt=payload.prompt,
        device_id=payload.device_id,
        tab_id=payload.tab_id,
    )

    run_id = payload.run_id or f"agent-{str(uuid.uuid4())[:8]}"
    attached_target = connection_manager.get_attached_target(device_id, tab_id) or {}
    target_url = attached_target.get("url", "")
    page_title = attached_target.get("title", "")

    plan = await plan_browser_steps(
        user_prompt=payload.prompt,
        current_url=target_url if isinstance(target_url, str) else "",
        current_page_title=page_title if isinstance(page_title, str) else "",
    )
    steps = plan.get("steps", [])
    browser_steps = [s for s in steps if s.get("type") == "browser"]
    consult_steps = [s for s in steps if s.get("type") == "consult"]
    if not steps:
        return {
            "ok": False,
            "run_id": run_id,
            "message": "I could not determine the browser actions needed. Try being more specific — e.g. 'click on Compose' or 'search for flights to Delhi'.",
            "plan": plan,
        }
    if not browser_steps and consult_steps:
        consult_msg = str(consult_steps[0].get("description") or consult_steps[0].get("reason") or "").strip()
        return {
            "ok": False,
            "run_id": run_id,
            "message": consult_msg or "The requested action cannot be completed automatically in the current tab context.",
            "plan": plan,
            "selected_target": {"device_id": device_id, "tab_id": tab_id},
        }

    context = ToolContext(
        automation_id=f"navigator-{run_id}",
        user_id=user["uid"],
        action_config={
            "type": "browser_automation",
            "device_id": device_id,
            "tab_id": tab_id,
            "run_id": run_id,
        },
        data_sources=[{"type": "url", "url": target_url}] if isinstance(target_url, str) and target_url else [],
        trigger_config={"type": "manual"},
        automation_name="Navigator Agent Action",
        automation_description=payload.prompt,
        execution_mode="autopilot",
    )

    browser_tool = BrowserAutomationTool()
    try:
        result = await browser_tool.execute(context, [{"steps": browser_steps}])
    except Exception as exc:
        logger.exception("Browser agent execution failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Agent execution error: {exc}") from exc

    if not result.success:
        raise HTTPException(status_code=409, detail=result.error or "Browser action failed")

    return {
        "ok": True,
        "run_id": run_id,
        "message": result.text or "Action completed.",
        "plan": plan,
        "steps_executed": result.data,
        "selected_target": {"device_id": device_id, "tab_id": tab_id},
    }


# ---------------------------------------------------------------------------
# Streaming agent endpoint (real-time step progress via SSE)
# ---------------------------------------------------------------------------

@router.post("/browser/agent/stream")
async def browser_agent_stream(
    payload: BrowserAgentPromptRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    """Execute browser agent with real-time per-step progress streamed as SSE."""
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.step_planner import plan_browser_steps

    device_id, tab_id = _resolve_device_and_tab_for_prompt(
        prompt=payload.prompt,
        device_id=payload.device_id,
        tab_id=payload.tab_id,
    )

    run_id = payload.run_id or f"agent-{str(uuid.uuid4())[:8]}"
    attached_target = connection_manager.get_attached_target(device_id, tab_id) or {}
    target_url = str(attached_target.get("url", ""))
    page_title = str(attached_target.get("title", ""))

    async def event_stream():
        def sse(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        try:
            plan = await plan_browser_steps(
                user_prompt=payload.prompt,
                current_url=target_url,
                current_page_title=page_title,
            )
            steps = plan.get("steps", [])
            browser_steps = [s for s in steps if s.get("type") == "browser"]
            consult_steps = [s for s in steps if s.get("type") == "consult"]
            yield sse(
                {
                    "type": "planned",
                    "steps": steps,
                    "run_id": run_id,
                    "selected_target": {"device_id": device_id, "tab_id": tab_id},
                }
            )

            if not steps:
                yield sse({
                    "type": "done",
                    "ok": False,
                    "message": "I could not determine the browser actions needed. Try being more specific.",
                })
                return
            if not browser_steps and consult_steps:
                consult_msg = str(consult_steps[0].get("description") or consult_steps[0].get("reason") or "").strip()
                yield sse({
                    "type": "done",
                    "ok": False,
                    "message": consult_msg or "The requested action cannot be completed automatically in the current tab context.",
                })
                return

            await connection_manager.send_to_device(device_id, {
                "type": "start_screenshot_stream",
                "payload": {"run_id": run_id, "interval_ms": 1500},
            })

            results: list[dict[str, Any]] = []

            try:
                for idx, step in enumerate(browser_steps):
                    if step.get("type") != "browser":
                        continue

                    yield sse({"type": "step_start", "index": idx})

                    max_retries = 2 if step.get("action") not in ("navigate", "screenshot", "wait") else 0
                    result: dict[str, Any] = {}

                    for attempt in range(max_retries + 1):
                        cmd_id = str(uuid.uuid4())[:8]
                        command: dict[str, Any] = {
                            "type": "extension_command",
                            "payload": {
                                "cmd_id": cmd_id,
                                "run_id": run_id,
                                "action": step.get("action", ""),
                                "target": step.get("target", ""),
                                "value": step.get("value", ""),
                                "step_index": idx,
                                "step_label": step.get("description", ""),
                                "total_steps": len(steps),
                            },
                            "timestamp": datetime.utcnow().isoformat(),
                        }
                        if tab_id is not None:
                            command["payload"]["tab_id"] = tab_id

                        timeout = 30.0
                        if step.get("action") == "wait":
                            timeout = float(step.get("timeout", 15)) + 5
                        elif step.get("action") == "navigate":
                            timeout = 100.0

                        result = await connection_manager.send_command_and_wait(
                            device_id, command, timeout=timeout,
                        )

                        status = result.get("status", "error")
                        if status != "error" or not _is_retriable_error(result.get("data", "")):
                            break
                        if attempt < max_retries:
                            await asyncio.sleep(2)

                    status = result.get("status", "error")
                    step_status = "success" if status != "error" else "error"

                    results.append({
                        "step_index": idx,
                        "action": step.get("action"),
                        "description": step.get("description", ""),
                        "status": step_status,
                        "data": result.get("data", ""),
                    })

                    yield sse({
                        "type": "step_end",
                        "index": idx,
                        "status": step_status,
                        "data": result.get("data", ""),
                    })

                    if status == "error":
                        error_data = result.get("data", "")
                        yield sse({
                            "type": "done",
                            "ok": False,
                            "message": f"Step {idx + 1} failed: {error_data}",
                            "steps_executed": results,
                        })
                        return

            finally:
                await connection_manager.send_to_device(device_id, {
                    "type": "stop_screenshot_stream",
                    "payload": {"run_id": run_id},
                })

            yield sse({
                "type": "done",
                "ok": True,
                "message": f"Completed {len(results)} browser steps.",
                "steps_executed": results,
            })

        except Exception as exc:
            logger.exception("Streaming agent error: %s", exc)
            yield sse({"type": "done", "ok": False, "message": str(exc)})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _is_retriable_error(error: str) -> bool:
    retriable = ("not found", "not ready", "loading", "element not found")
    return any(r in error.lower() for r in retriable)


# ---------------------------------------------------------------------------
# Chat (Converse)
# ---------------------------------------------------------------------------

@router.post("/chat")
async def chat(
    payload: ChatRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
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
    return await chat(payload, user)


@router.post("/devices/register")
async def register_device(
    payload: DeviceRegisterRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
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
    from oi_agent.mesh.group_manager import MeshGroupManager

    manager = MeshGroupManager()
    return await manager.get_user_groups(user["uid"])


# ---------------------------------------------------------------------------
# Connected Devices
# ---------------------------------------------------------------------------

@router.get("/devices/connected")
async def list_connected_devices(
    user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, str]]:
    from oi_agent.api.websocket import connection_manager

    devices = connection_manager.get_extension_device_ids()
    return [{"device_id": d, "status": "connected"} for d in devices]
