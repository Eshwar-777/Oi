from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from oi_agent.api.browser.agent_utils import (
    check_media_playing,
    cleanup_paused_runs,
    friendly_browser_error,
    is_interactive_intent,
    is_media_intent,
    is_retriable_error,
    requires_user_intervention,
    store_paused_run,
)
from oi_agent.api.browser.common import (
    fetch_page_snapshot,
    fetch_structured_page_context,
    resolve_device_and_tab_for_prompt,
)
from oi_agent.api.browser.history_store import (
    create_navigator_run,
    delete_all_navigator_runs,
    delete_navigator_run,
    finalize_navigator_run,
    list_navigator_runs,
)
from oi_agent.api.browser.models import BrowserAgentPromptRequest, BrowserAgentResumeRequest
from oi_agent.api.browser.state import (
    ENABLE_ADAPTIVE_RECOVERY,
    PASSIVE_BROWSER_ACTIONS,
    PLAN_CACHE_TTL_SECONDS,
    STREAM_MAX_COMMAND_SECONDS,
    STREAM_MAX_PLANNER_SECONDS,
    STREAM_MAX_SECONDS,
    navigator_plan_cache,
    paused_navigator_runs,
)
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.models import (
    AutomationScheduleCreateRequest,
    ResolveExecutionSchedule,
)
from oi_agent.automation.schedule_service import (
    create_automation_schedule,
    delete_automation_schedule,
    list_automation_schedules,
)
from oi_agent.services.tools.tab_selector import select_best_attached_tab

logger = logging.getLogger(__name__)

agent_router = APIRouter()


class NavigatorScheduleCreateRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    device_id: str | None = None
    tab_id: int | None = None
    schedule_type: Literal["once", "interval"] = "once"
    run_at: str | None = None
    interval_seconds: int | None = Field(default=None, ge=30, le=7 * 24 * 3600)
    enabled: bool = True


def _snapshot_is_sparse(snapshot: dict[str, Any] | None) -> bool:
    if not snapshot:
        return True
    try:
        ref_count = int(snapshot.get("refCount", 0) or 0)
    except Exception:
        ref_count = 0
    lines = str(snapshot.get("snapshot", "") or "").strip().splitlines()
    return ref_count <= 2 or len(lines) <= 1


def _step_fingerprint(step: dict[str, Any]) -> str:
    action = str(step.get("action", "")).strip().lower()
    kind = str(step.get("kind", "")).strip().lower()
    ref = str(step.get("ref", "")).strip().lower()
    target = json.dumps(step.get("target", ""), sort_keys=True, default=str)
    value = str(step.get("value", "")).strip()
    value_hash = hashlib.sha1(value.encode("utf-8")).hexdigest()[:10] if value else ""
    return "|".join((action, kind, ref, target, value_hash))


def _state_fingerprint(
    *,
    url: str,
    title: str,
    snapshot: dict[str, Any] | None,
    structured: dict[str, Any] | None,
) -> str:
    snap_ref_count = int((snapshot or {}).get("refCount", 0) or 0)
    snap_epoch = _snapshot_epoch(snapshot)
    structured_count = 0
    if isinstance(structured, dict):
        elements = structured.get("elements", [])
        if isinstance(elements, list):
            structured_count = len(elements)
    seed = "|".join(
        [
            (url or "").strip().lower()[:240],
            (title or "").strip().lower()[:180],
            snap_epoch,
            str(snap_ref_count),
            str(structured_count),
        ]
    )
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


def _snapshot_epoch(snapshot: dict[str, Any] | None) -> str:
    if not isinstance(snapshot, dict):
        return ""
    explicit = str(snapshot.get("snapshot_id", "") or snapshot.get("snapshotId", "")).strip()
    if explicit:
        return explicit
    seed = "|".join(
        [
            str(snapshot.get("url", "") or ""),
            str(snapshot.get("title", "") or ""),
            str(snapshot.get("snapshot", "") or "")[:5000],
        ]
    )
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


def _annotate_act_steps_snapshot_id(
    steps: list[dict[str, Any]],
    snapshot_epoch: str,
) -> list[dict[str, Any]]:
    if not snapshot_epoch:
        return steps
    out: list[dict[str, Any]] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        row = dict(step)
        if str(row.get("action", "")).strip().lower() == "act" and not str(row.get("snapshot_id", "")).strip():
            row["snapshot_id"] = snapshot_epoch
        out.append(row)
    return out


def _cached_plan_get(cache_key: str) -> dict[str, Any] | None:
    now = time.time()
    row = navigator_plan_cache.get(cache_key)
    if not isinstance(row, dict):
        return None
    created = float(row.get("created_at", now))
    if now - created > PLAN_CACHE_TTL_SECONDS:
        navigator_plan_cache.pop(cache_key, None)
        return None
    plan = row.get("plan")
    return plan if isinstance(plan, dict) else None


def _cached_plan_set(cache_key: str, plan: dict[str, Any]) -> None:
    navigator_plan_cache[cache_key] = {
        "created_at": time.time(),
        "plan": plan,
    }


@agent_router.get("/browser/agent/history")
async def browser_agent_history(
    limit: int = Query(default=30, ge=1, le=100),
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    runs = await list_navigator_runs(user_id=user["uid"], limit=limit)
    return {"items": runs}


@agent_router.delete("/browser/agent/history/{run_id}")
async def browser_agent_delete_history_item(
    run_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    deleted = await delete_navigator_run(user_id=user["uid"], run_id=run_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Navigator run not found.")
    return {"ok": True, "run_id": run_id}


@agent_router.delete("/browser/agent/history")
async def browser_agent_delete_history_all(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    deleted_count = await delete_all_navigator_runs(user_id=user["uid"])
    return {"ok": True, "deleted_count": deleted_count}


@agent_router.get("/browser/agent/schedules")
async def browser_agent_list_schedules(
    limit: int = Query(default=50, ge=1, le=200),
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    items = [
        {
            **row.model_dump(mode="json"),
            "source": "automation",
        }
        for row in await list_automation_schedules(user_id=user["uid"], limit=limit)
    ]
    return {"items": items}


@agent_router.post("/browser/agent/schedules")
async def browser_agent_create_schedule(
    payload: NavigatorScheduleCreateRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    schedule_type = payload.schedule_type
    if schedule_type == "once" and not payload.run_at:
        raise HTTPException(status_code=400, detail="run_at is required for once schedules.")
    if schedule_type == "interval" and not payload.interval_seconds:
        raise HTTPException(status_code=400, detail="interval_seconds is required for interval schedules.")
    schedule = await create_automation_schedule(
        user_id=user["uid"],
        payload=AutomationScheduleCreateRequest(
            session_id=f"browser-schedule:{str(uuid.uuid4())[:8]}",
            prompt=payload.prompt.strip(),
            execution_mode=schedule_type,
            schedule=ResolveExecutionSchedule(
                run_at=[payload.run_at] if payload.run_at else [],
                interval_seconds=payload.interval_seconds,
                timezone="UTC",
            ),
            device_id=payload.device_id,
            tab_id=payload.tab_id,
        ),
    )
    return {
        "ok": True,
        "schedule": {
            **schedule.model_dump(mode="json"),
            "source": "automation",
        },
    }


@agent_router.delete("/browser/agent/schedules/{schedule_id}")
async def browser_agent_delete_schedule(
    schedule_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    deleted = await delete_automation_schedule(user_id=user["uid"], schedule_id=schedule_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Schedule not found.")
    return {"ok": True, "schedule_id": schedule_id, "source": "automation"}


@agent_router.post("/browser/agent/plan")
async def browser_agent_plan(
    payload: BrowserAgentPromptRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user["uid"]
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.navigator.prompt_rewriter import rewrite_user_prompt
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

    rewritten_prompt = await rewrite_user_prompt(
        user_prompt=payload.prompt,
        current_url=target_url,
        current_page_title=page_title,
    )

    snapshot = await fetch_page_snapshot(device_id, tab_id, f"plan-{str(uuid.uuid4())[:8]}")
    structured_context = None
    if _snapshot_is_sparse(snapshot):
        structured_context = await fetch_structured_page_context(
            device_id,
            tab_id,
            f"plan-struct-{str(uuid.uuid4())[:8]}",
        )

    plan = await plan_browser_steps(
        user_prompt=rewritten_prompt,
        current_url=target_url,
        current_page_title=page_title,
        page_snapshot=snapshot,
        structured_context=structured_context,
    )
    return {
        "ok": True,
        "plan": plan,
        "selected_target": {"device_id": device_id, "tab_id": tab_id},
        "rewritten_prompt": rewritten_prompt,
    }


@agent_router.post("/browser/agent")
async def browser_agent_prompt(
    payload: BrowserAgentPromptRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.base import ToolContext
    from oi_agent.services.tools.browser_automation import BrowserAutomationTool
    from oi_agent.services.tools.navigator.prompt_rewriter import rewrite_user_prompt
    from oi_agent.services.tools.step_planner import plan_browser_steps

    device_id, tab_id = resolve_device_and_tab_for_prompt(
        prompt=payload.prompt,
        device_id=payload.device_id,
        tab_id=payload.tab_id,
    )

    run_id = payload.run_id or f"agent-{str(uuid.uuid4())[:8]}"
    attached_target = connection_manager.get_attached_target(device_id, tab_id) or {}
    target_url = attached_target.get("url", "")
    page_title = attached_target.get("title", "")
    rewritten_prompt = await rewrite_user_prompt(
        user_prompt=payload.prompt,
        current_url=target_url if isinstance(target_url, str) else "",
        current_page_title=page_title if isinstance(page_title, str) else "",
    )

    snapshot = await fetch_page_snapshot(device_id, tab_id, f"plan-{str(uuid.uuid4())[:8]}")
    structured_context = None
    if _snapshot_is_sparse(snapshot):
        structured_context = await fetch_structured_page_context(
            device_id,
            tab_id,
            f"plan-struct-{str(uuid.uuid4())[:8]}",
        )

    plan = await plan_browser_steps(
        user_prompt=rewritten_prompt,
        current_url=target_url if isinstance(target_url, str) else "",
        current_page_title=page_title if isinstance(page_title, str) else "",
        page_snapshot=snapshot,
        structured_context=structured_context,
    )
    steps = plan.get("steps", [])
    browser_steps = [s for s in steps if s.get("type") == "browser"]
    browser_steps = _annotate_act_steps_snapshot_id(browser_steps, _snapshot_epoch(snapshot))
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
        automation_description=rewritten_prompt,
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
        "rewritten_prompt": rewritten_prompt,
        "steps_executed": result.data,
        "selected_target": {"device_id": device_id, "tab_id": tab_id},
    }


@agent_router.post("/browser/agent/stream")
async def browser_agent_stream(
    payload: BrowserAgentPromptRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.navigator.prompt_rewriter import rewrite_user_prompt
    from oi_agent.services.tools.step_planner import plan_browser_steps

    device_id, tab_id = resolve_device_and_tab_for_prompt(
        prompt=payload.prompt,
        device_id=payload.device_id,
        tab_id=payload.tab_id,
    )

    run_id = payload.run_id or f"agent-{str(uuid.uuid4())[:8]}"
    attached_target = connection_manager.get_attached_target(device_id, tab_id) or {}
    target_url = str(attached_target.get("url", ""))
    page_title = str(attached_target.get("title", ""))
    rewritten_prompt = payload.prompt

    async def event_stream():
        nonlocal rewritten_prompt

        def sse(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        stream_started = time.time()
        results: list[dict[str, Any]] = []
        finalized = False

        async def _finalize_run(
            *,
            status: str,
            message: str,
            requires_user_action: bool = False,
        ) -> None:
            nonlocal finalized
            if finalized:
                return
            finalized = True
            await finalize_navigator_run(
                user_id=user["uid"],
                run_id=run_id,
                status=status,
                message=message,
                requires_user_action=requires_user_action,
                steps_executed=results,
            )

        async def _plan_with_timeout(
            *,
            prompt_text: str,
            url: str,
            title: str,
            snapshot_data: dict[str, Any] | None,
            structured_data: dict[str, Any] | None = None,
            completed_steps: list[str] | None = None,
            failed_step: dict[str, Any] | None = None,
            error_message: str | None = None,
        ) -> dict[str, Any]:
            return await asyncio.wait_for(
                plan_browser_steps(
                    user_prompt=prompt_text,
                    current_url=url,
                    current_page_title=title,
                    page_snapshot=snapshot_data,
                    structured_context=structured_data,
                    completed_steps=completed_steps,
                    failed_step=failed_step,
                    error_message=error_message,
                ),
                timeout=STREAM_MAX_PLANNER_SECONDS,
            )

        try:
            await create_navigator_run(
                user_id=user["uid"],
                run_id=run_id,
                prompt=payload.prompt,
                rewritten_prompt=rewritten_prompt,
                device_id=device_id,
                tab_id=tab_id,
                target_url=target_url,
                page_title=page_title,
            )
            yield sse({"type": "status", "phase": "rewriting_prompt", "run_id": run_id})
            try:
                rewritten_prompt = await asyncio.wait_for(
                    rewrite_user_prompt(
                        user_prompt=payload.prompt,
                        current_url=target_url,
                        current_page_title=page_title,
                    ),
                    timeout=STREAM_MAX_PLANNER_SECONDS,
                )
            except TimeoutError:
                message = "Prompt rewrite timed out. Please retry."
                await _finalize_run(status="failed", message=message)
                yield sse(
                    {
                        "type": "done",
                        "ok": False,
                        "message": message,
                    }
                )
                return

            yield sse({"type": "status", "phase": "capturing_snapshot", "run_id": run_id})
            snapshot = await fetch_page_snapshot(device_id, tab_id, run_id)
            current_snapshot_epoch = _snapshot_epoch(snapshot)
            structured_context = None
            if _snapshot_is_sparse(snapshot):
                yield sse({"type": "status", "phase": "extracting_context", "run_id": run_id})
                structured_context = await fetch_structured_page_context(
                    device_id,
                    tab_id,
                    f"{run_id}-struct",
                )

            yield sse({"type": "status", "phase": "planning", "run_id": run_id})
            fingerprint = _state_fingerprint(
                url=target_url,
                title=page_title,
                snapshot=snapshot,
                structured=structured_context,
            )
            prompt_key = hashlib.sha1(rewritten_prompt.strip().lower().encode("utf-8")).hexdigest()[:16]
            cache_key = f"{prompt_key}:{fingerprint}"
            plan = _cached_plan_get(cache_key)
            if plan:
                yield sse({"type": "status", "phase": "planning_cache_hit", "run_id": run_id})
            else:
                try:
                    plan = await _plan_with_timeout(
                        prompt_text=rewritten_prompt,
                        url=target_url,
                        title=page_title,
                        snapshot_data=snapshot,
                        structured_data=structured_context,
                        completed_steps=[],
                    )
                    _cached_plan_set(cache_key, plan)
                except TimeoutError:
                    message = "Planning timed out. Please retry with a more specific prompt."
                    await _finalize_run(status="failed", message=message)
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "message": message,
                        }
                    )
                    return

            steps = plan.get("steps", [])
            browser_steps = [s for s in steps if s.get("type") == "browser"]
            consult_steps = [s for s in steps if s.get("type") == "consult"]
            browser_steps = _annotate_act_steps_snapshot_id(browser_steps, current_snapshot_epoch)
            steps = [
                _annotate_act_steps_snapshot_id([s], current_snapshot_epoch)[0]
                if isinstance(s, dict) and s.get("type") == "browser"
                else s
                for s in steps
            ]
            yield sse(
                {
                    "type": "planned",
                    "steps": steps,
                    "run_id": run_id,
                    "rewritten_prompt": rewritten_prompt,
                    "selected_target": {"device_id": device_id, "tab_id": tab_id},
                }
            )

            if not steps:
                message = "I could not determine the browser actions needed. Try being more specific."
                await _finalize_run(status="failed", message=message)
                yield sse(
                    {
                        "type": "done",
                        "ok": False,
                        "message": message,
                    }
                )
                return
            if not browser_steps and consult_steps:
                consult_msg = str(consult_steps[0].get("description") or consult_steps[0].get("reason") or "").strip()
                message = consult_msg or "The requested action cannot be completed automatically in the current tab context."
                await _finalize_run(status="failed", message=message)
                yield sse(
                    {
                        "type": "done",
                        "ok": False,
                        "message": message,
                    }
                )
                return

            await connection_manager.send_to_device(
                device_id,
                {
                    "type": "start_screenshot_stream",
                    "payload": {"run_id": run_id, "interval_ms": 1500},
                },
            )

            completed_step_descriptions: list[str] = []
            completed_fingerprints: set[str] = set()
            global_step_idx = 0
            remaining_steps: list[dict[str, Any]] = list(browser_steps)

            try:
                while remaining_steps:
                    if time.time() - stream_started > STREAM_MAX_SECONDS:
                        message = "Navigator run timed out. Please retry."
                        await _finalize_run(status="failed", message=message)
                        yield sse(
                            {
                                "type": "done",
                                "ok": False,
                                "message": message,
                                "steps_executed": results,
                            }
                        )
                        return

                    step = remaining_steps.pop(0)
                    if step.get("type") != "browser":
                        continue

                    yield sse({"type": "step_start", "index": global_step_idx})

                    max_retries = (
                        2
                        if step.get("action") not in ("navigate", "screenshot", "wait", "snapshot")
                        else 0
                    )
                    result: dict[str, Any] = {}

                    for attempt in range(max_retries + 1):
                        cmd_id = str(uuid.uuid4())[:8]
                        action = step.get("action", "")
                        if action == "act" and not str(step.get("snapshot_id", "")).strip() and current_snapshot_epoch:
                            step["snapshot_id"] = current_snapshot_epoch
                        if action == "act":
                            step_snapshot_id = str(step.get("snapshot_id", "")).strip()
                            if (
                                step_snapshot_id
                                and current_snapshot_epoch
                                and step_snapshot_id != current_snapshot_epoch
                            ):
                                result = {
                                    "status": "error",
                                    "data": (
                                        f"Stale ref snapshot_id '{step_snapshot_id}' "
                                        f"does not match current snapshot '{current_snapshot_epoch}'"
                                    ),
                                }
                                break

                        cmd_payload: dict[str, Any] = {
                            "cmd_id": cmd_id,
                            "run_id": run_id,
                            "action": action,
                            "step_index": global_step_idx,
                            "step_label": step.get("description", ""),
                            "total_steps": max(1, len(remaining_steps) + 1),
                        }

                        if action == "act":
                            cmd_payload["ref"] = step.get("ref", "")
                            cmd_payload["kind"] = step.get("kind", "")
                            cmd_payload["value"] = step.get("value", "")
                        else:
                            cmd_payload["target"] = step.get("target", "")
                            cmd_payload["value"] = step.get("value", "")
                            if isinstance(step.get("disambiguation"), dict):
                                cmd_payload["disambiguation"] = step.get("disambiguation")

                        command: dict[str, Any] = {
                            "type": "extension_command",
                            "payload": cmd_payload,
                            "timestamp": datetime.utcnow().isoformat(),
                        }
                        if tab_id is not None:
                            command["payload"]["tab_id"] = tab_id

                        timeout = 30.0
                        if step.get("action") == "wait":
                            timeout = float(step.get("timeout", 15)) + 5
                        elif step.get("action") == "navigate":
                            timeout = 100.0
                        elif step.get("action") == "snapshot":
                            timeout = 20.0
                        timeout = max(5.0, min(timeout, STREAM_MAX_COMMAND_SECONDS))
                        logger.info(
                            "Navigator command run_id=%s step=%s action=%s attempt=%s timeout=%.1fs",
                            run_id,
                            global_step_idx,
                            action,
                            attempt + 1,
                            timeout,
                        )

                        result = await connection_manager.send_command_and_wait(
                            device_id, command, timeout=timeout
                        )
                        logger.info(
                            "Navigator command result run_id=%s step=%s action=%s status=%s",
                            run_id,
                            global_step_idx,
                            action,
                            result.get("status", ""),
                        )

                        status = result.get("status", "error")
                        if status != "error" or not is_retriable_error(result.get("data", "")):
                            break
                        if attempt < max_retries:
                            latest_snapshot = await fetch_page_snapshot(
                                device_id,
                                tab_id,
                                f"{run_id}-retry-{global_step_idx}-{attempt + 1}",
                            )
                            current_snapshot_epoch = _snapshot_epoch(latest_snapshot) or current_snapshot_epoch
                            await asyncio.sleep(2)

                    status = result.get("status", "error")

                    if (
                        ENABLE_ADAPTIVE_RECOVERY
                        and status == "error"
                        and step.get("action") in ("click", "type", "hover", "select", "act")
                    ):
                        from oi_agent.services.tools.base import ToolContext
                        from oi_agent.services.tools.navigator.fallbacks import (
                            attempt_adaptive_recovery,
                        )

                        failed_step_for_recovery = dict(step)
                        if step.get("action") == "act":
                            kind = str(step.get("kind", "")).strip().lower()
                            if kind in {"click", "type", "hover", "select"}:
                                failed_step_for_recovery["action"] = kind
                                failed_step_for_recovery["target"] = step.get("ref", "")

                        recovery_context = ToolContext(
                            automation_id=f"navigator-{run_id}",
                            user_id=user["uid"],
                            action_config={
                                "type": "browser_automation",
                                "device_id": device_id,
                                "tab_id": tab_id,
                                "run_id": run_id,
                            },
                            data_sources=[],
                            trigger_config={"type": "manual"},
                            automation_name="Navigator recovery",
                            automation_description=rewritten_prompt,
                            execution_mode="autopilot",
                        )
                        recovered = await attempt_adaptive_recovery(
                            connection_manager=connection_manager,
                            device_id=device_id,
                            context=recovery_context,
                            run_id=run_id,
                            failed_step=failed_step_for_recovery,
                            step_index=global_step_idx,
                            total_steps=max(1, len(remaining_steps) + 1),
                        )
                        if recovered is not None and recovered.get("status") != "error":
                            result = recovered
                            status = result.get("status", "done")

                    step_status = "success" if status != "error" else "error"
                    screenshot_data = str(result.get("screenshot", "") or "")
                    results.append(
                        {
                            "step_index": global_step_idx,
                            "action": step.get("action"),
                            "description": step.get("description", ""),
                            "status": step_status,
                            "data": result.get("data", ""),
                            "screenshot": screenshot_data,
                        }
                    )

                    yield sse(
                        {
                            "type": "step_end",
                            "index": global_step_idx,
                            "status": step_status,
                            "data": result.get("data", ""),
                            "screenshot": screenshot_data,
                        }
                    )

                    global_step_idx += 1

                    if status != "error":
                        if step.get("action") == "snapshot":
                            current_snapshot_epoch = _snapshot_epoch(result if isinstance(result, dict) else None) or current_snapshot_epoch
                        completed_step_descriptions.append(
                            str(step.get("description", "")).strip() or str(step.get("action", ""))
                        )
                        completed_fingerprints.add(_step_fingerprint(step))
                        continue

                    error_data = result.get("data", "")
                    error_data = friendly_browser_error(
                        connection_manager, device_id, tab_id, str(error_data)
                    )
                    if requires_user_intervention(step, error_data):
                        resume_token = store_paused_run(
                            user_id=user["uid"],
                            prompt=rewritten_prompt,
                            device_id=device_id,
                            tab_id=tab_id,
                            remaining_steps=remaining_steps,
                        )
                        message = (
                            f"Step {global_step_idx} needs manual help: {error_data}. "
                            "Please perform this action in the tab, then click Confirm & Resume."
                        )
                        await _finalize_run(
                            status="blocked",
                            message=message,
                            requires_user_action=True,
                        )
                        yield sse(
                            {
                                "type": "done",
                                "ok": False,
                                "requires_user_action": True,
                                "resume_token": resume_token,
                                "message": message,
                                "steps_executed": results,
                            }
                        )
                        return

                    # Stop immediately on first non-blocked failure; do not continue/replan.
                    message = f"Step {global_step_idx} failed: {error_data}"
                    await _finalize_run(status="failed", message=message)
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "message": message,
                            "steps_executed": results,
                        }
                    )
                    return

            finally:
                await connection_manager.send_to_device(
                    device_id,
                    {
                        "type": "stop_screenshot_stream",
                        "payload": {"run_id": run_id},
                    },
                )

            if is_interactive_intent(rewritten_prompt):
                interactive_done = any(
                    str(r.get("action", "")).lower() not in PASSIVE_BROWSER_ACTIONS
                    and str(r.get("status", "")).lower() == "success"
                    for r in results
                )
                if not interactive_done:
                    message = (
                        "Automation ran but did not execute actionable UI interactions. "
                        "This is likely due to unstable or unresolved page elements."
                    )
                    await _finalize_run(status="failed", message=message)
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "message": message,
                            "steps_executed": results,
                        }
                    )
                    return

            if is_media_intent(rewritten_prompt):
                playing_ok, reason = await check_media_playing(
                    connection_manager=connection_manager,
                    device_id=device_id,
                    tab_id=tab_id,
                    run_id=run_id,
                )
                if not playing_ok:
                    resume_token = store_paused_run(
                        user_id=user["uid"],
                        prompt=rewritten_prompt,
                        device_id=device_id,
                        tab_id=tab_id,
                        remaining_steps=[],
                    )
                    message = (
                        f"Automation completed steps but playback is not active ({reason}). "
                        "Please press Play manually, then click Confirm & Resume."
                    )
                    await _finalize_run(
                        status="blocked",
                        message=message,
                        requires_user_action=True,
                    )
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "requires_user_action": True,
                            "resume_token": resume_token,
                            "message": message,
                            "steps_executed": results,
                        }
                    )
                    return

            latest_screenshot = ""
            for row in reversed(results):
                shot = str(row.get("screenshot", "") or "")
                if shot:
                    latest_screenshot = shot
                    break
            message = f"Completed {len(results)} browser steps."
            await _finalize_run(status="completed", message=message)
            yield sse(
                {
                    "type": "done",
                    "ok": True,
                    "message": message,
                    "steps_executed": results,
                    "screenshot": latest_screenshot,
                }
            )

        except asyncio.CancelledError:
            await _finalize_run(
                status="stopped",
                message="Stopped by client disconnect.",
            )
            raise
        except Exception as exc:
            logger.exception("Streaming agent error: %s", exc)
            message = str(exc)
            await _finalize_run(status="failed", message=message)
            yield sse({"type": "done", "ok": False, "message": message})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@agent_router.post("/browser/agent/resume")
async def browser_agent_resume(
    payload: BrowserAgentResumeRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.base import ToolContext
    from oi_agent.services.tools.browser_automation import BrowserAutomationTool

    cleanup_paused_runs()
    paused = paused_navigator_runs.get(payload.resume_token)
    if not paused:
        raise HTTPException(status_code=404, detail="Resume token expired or not found.")
    if paused.get("user_id") != user["uid"]:
        raise HTTPException(status_code=403, detail="Resume token does not belong to this user.")

    device_id = str(paused.get("device_id", "") or "")
    tab_id = paused.get("tab_id")
    remaining_steps = paused.get("remaining_steps", [])
    prompt = str(paused.get("prompt", "") or "")

    if not device_id or not connection_manager.is_connected(device_id):
        raise HTTPException(status_code=409, detail="Target device is no longer connected.")
    if tab_id is not None:
        attached = {
            int(t.get("tab_id", 0))
            for t in connection_manager.get_attached_tabs(device_id)
            if isinstance(t, dict)
        }
        if int(tab_id) not in attached:
            raise HTTPException(status_code=409, detail="Target tab is no longer attached. Re-run from start.")

    if not isinstance(remaining_steps, list) or len(remaining_steps) == 0:
        paused_navigator_runs.pop(payload.resume_token, None)
        return {
            "ok": True,
            "run_id": f"resume-{str(uuid.uuid4())[:8]}",
            "message": "Manual action confirmed. No remaining automated steps.",
            "steps_executed": [],
            "selected_target": {"device_id": device_id, "tab_id": tab_id},
        }

    resume_snapshot = await fetch_page_snapshot(device_id, tab_id, run_id=f"resume-snapshot-{str(uuid.uuid4())[:8]}")
    resume_epoch = _snapshot_epoch(resume_snapshot)
    if any(str(s.get("action", "")).strip().lower() == "act" for s in remaining_steps) and not resume_epoch:
        raise HTTPException(status_code=409, detail="Could not refresh page snapshot for resume. Please run again from current tab.")
    remaining_steps = _annotate_act_steps_snapshot_id(remaining_steps, resume_epoch)

    run_id = f"resume-{str(uuid.uuid4())[:8]}"
    await create_navigator_run(
        user_id=user["uid"],
        run_id=run_id,
        prompt=prompt or "Resume navigator run",
        rewritten_prompt=prompt or "Resume navigator run",
        device_id=device_id,
        tab_id=tab_id,
        target_url="",
        page_title="",
    )
    context = ToolContext(
        automation_id=f"navigator-{run_id}",
        user_id=user["uid"],
        action_config={
            "type": "browser_automation",
            "device_id": device_id,
            "tab_id": tab_id,
            "run_id": run_id,
        },
        data_sources=[],
        trigger_config={"type": "manual"},
        automation_name="Navigator Resume",
        automation_description=prompt,
        execution_mode="autopilot",
    )

    browser_tool = BrowserAutomationTool()
    result = await browser_tool.execute(context, [{"steps": remaining_steps}])
    if not result.success:
        await finalize_navigator_run(
            user_id=user["uid"],
            run_id=run_id,
            status="failed",
            message=result.error or "Resume failed",
            requires_user_action=False,
            steps_executed=result.data if isinstance(result.data, list) else [],
        )
        raise HTTPException(status_code=409, detail=result.error or "Resume failed")

    await finalize_navigator_run(
        user_id=user["uid"],
        run_id=run_id,
        status="completed",
        message=result.text or "Resumed actions completed.",
        requires_user_action=False,
        steps_executed=result.data if isinstance(result.data, list) else [],
    )
    paused_navigator_runs.pop(payload.resume_token, None)
    return {
        "ok": True,
        "run_id": run_id,
        "message": result.text or "Resumed actions completed.",
        "steps_executed": result.data,
        "selected_target": {"device_id": device_id, "tab_id": tab_id},
    }
