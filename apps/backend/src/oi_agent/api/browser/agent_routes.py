from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

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
    resolve_device_and_tab_for_prompt,
)
from oi_agent.api.browser.models import BrowserAgentPromptRequest, BrowserAgentResumeRequest
from oi_agent.api.browser.state import (
    PASSIVE_BROWSER_ACTIONS,
    STREAM_MAX_COMMAND_SECONDS,
    STREAM_MAX_PLANNER_SECONDS,
    STREAM_MAX_SECONDS,
    paused_navigator_runs,
)
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.services.tools.tab_selector import select_best_attached_tab

logger = logging.getLogger(__name__)

agent_router = APIRouter()


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

    plan = await plan_browser_steps(
        user_prompt=rewritten_prompt,
        current_url=target_url,
        current_page_title=page_title,
        page_snapshot=snapshot,
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

    plan = await plan_browser_steps(
        user_prompt=rewritten_prompt,
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
    rewritten_prompt = await rewrite_user_prompt(
        user_prompt=payload.prompt,
        current_url=target_url,
        current_page_title=page_title,
    )

    async def event_stream():
        def sse(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        stream_started = time.time()

        async def _plan_with_timeout(
            *,
            prompt_text: str,
            url: str,
            title: str,
            snapshot_data: dict[str, Any] | None,
        ) -> dict[str, Any]:
            return await asyncio.wait_for(
                plan_browser_steps(
                    user_prompt=prompt_text,
                    current_url=url,
                    current_page_title=title,
                    page_snapshot=snapshot_data,
                ),
                timeout=STREAM_MAX_PLANNER_SECONDS,
            )

        try:
            snapshot = await fetch_page_snapshot(device_id, tab_id, run_id)

            try:
                plan = await _plan_with_timeout(
                    prompt_text=rewritten_prompt,
                    url=target_url,
                    title=page_title,
                    snapshot_data=snapshot,
                )
            except asyncio.TimeoutError:
                yield sse(
                    {
                        "type": "done",
                        "ok": False,
                        "message": "Planning timed out. Please retry with a more specific prompt.",
                    }
                )
                return

            steps = plan.get("steps", [])
            browser_steps = [s for s in steps if s.get("type") == "browser"]
            consult_steps = [s for s in steps if s.get("type") == "consult"]
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
                yield sse(
                    {
                        "type": "done",
                        "ok": False,
                        "message": "I could not determine the browser actions needed. Try being more specific.",
                    }
                )
                return
            if not browser_steps and consult_steps:
                consult_msg = str(consult_steps[0].get("description") or consult_steps[0].get("reason") or "").strip()
                yield sse(
                    {
                        "type": "done",
                        "ok": False,
                        "message": consult_msg or "The requested action cannot be completed automatically in the current tab context.",
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

            results: list[dict[str, Any]] = []
            global_step_idx = 0
            max_replan_rounds = 5
            replan_round = 0
            snapshot_only_replans = 0

            try:
                while browser_steps and replan_round <= max_replan_rounds:
                    replan_needed = False

                    for local_idx, step in enumerate(browser_steps):
                        if time.time() - stream_started > STREAM_MAX_SECONDS:
                            yield sse(
                                {
                                    "type": "done",
                                    "ok": False,
                                    "message": "Navigator run timed out. Please retry.",
                                    "steps_executed": results,
                                }
                            )
                            return

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

                            cmd_payload: dict[str, Any] = {
                                "cmd_id": cmd_id,
                                "run_id": run_id,
                                "action": action,
                                "step_index": global_step_idx,
                                "step_label": step.get("description", ""),
                                "total_steps": len(browser_steps),
                            }

                            if action == "act":
                                cmd_payload["ref"] = step.get("ref", "")
                                cmd_payload["kind"] = step.get("kind", "")
                                cmd_payload["value"] = step.get("value", "")
                            else:
                                cmd_payload["target"] = step.get("target", "")
                                cmd_payload["value"] = step.get("value", "")

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

                            result = await connection_manager.send_command_and_wait(
                                device_id, command, timeout=timeout
                            )

                            status = result.get("status", "error")
                            if status != "error" or not is_retriable_error(result.get("data", "")):
                                break
                            if attempt < max_retries:
                                await asyncio.sleep(2)

                        status = result.get("status", "error")

                        if status == "error" and step.get("action") in ("click", "type", "hover", "select", "act"):
                            from oi_agent.services.tools.base import ToolContext
                            from oi_agent.services.tools.navigator.fallbacks import attempt_adaptive_recovery

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
                                total_steps=len(browser_steps),
                            )
                            if recovered is not None and recovered.get("status") != "error":
                                result = recovered
                                status = result.get("status", "done")

                        step_status = "success" if status != "error" else "error"
                        results.append(
                            {
                                "step_index": global_step_idx,
                                "action": step.get("action"),
                                "description": step.get("description", ""),
                                "status": step_status,
                                "data": result.get("data", ""),
                            }
                        )

                        yield sse(
                            {
                                "type": "step_end",
                                "index": global_step_idx,
                                "status": step_status,
                                "data": result.get("data", ""),
                            }
                        )

                        global_step_idx += 1

                        if status == "error":
                            error_data = result.get("data", "")
                            error_data = friendly_browser_error(
                                connection_manager, device_id, tab_id, str(error_data)
                            )
                            if requires_user_intervention(step, error_data):
                                remaining_steps = browser_steps[local_idx + 1 :]
                                resume_token = store_paused_run(
                                    user_id=user["uid"],
                                    prompt=rewritten_prompt,
                                    device_id=device_id,
                                    tab_id=tab_id,
                                    remaining_steps=remaining_steps,
                                )
                                yield sse(
                                    {
                                        "type": "done",
                                        "ok": False,
                                        "requires_user_action": True,
                                        "resume_token": resume_token,
                                        "message": (
                                            f"Step {global_step_idx} needs manual help: {error_data}. "
                                            "Please perform this action in the tab, then click Confirm & Resume."
                                        ),
                                        "steps_executed": results,
                                    }
                                )
                                return
                            yield sse(
                                {
                                    "type": "done",
                                    "ok": False,
                                    "message": f"Step {global_step_idx} failed: {error_data}",
                                    "steps_executed": results,
                                }
                            )
                            return

                        if step.get("action") == "snapshot" and status != "error":
                            snapshot_data = result.get("data", "")
                            try:
                                fresh_snapshot = json.loads(snapshot_data) if isinstance(snapshot_data, str) else None
                            except (json.JSONDecodeError, TypeError):
                                fresh_snapshot = None

                            if fresh_snapshot:
                                replan_round += 1
                                logger.info(
                                    "Re-planning round %d after snapshot for '%s'",
                                    replan_round,
                                    rewritten_prompt,
                                )
                                try:
                                    new_plan = await _plan_with_timeout(
                                        prompt_text=rewritten_prompt,
                                        url=str(fresh_snapshot.get("url", target_url)),
                                        title=str(fresh_snapshot.get("title", page_title)),
                                        snapshot_data=fresh_snapshot,
                                    )
                                except asyncio.TimeoutError:
                                    yield sse(
                                        {
                                            "type": "done",
                                            "ok": False,
                                            "message": "Re-planning timed out. Please retry.",
                                            "steps_executed": results,
                                        }
                                    )
                                    return
                                new_steps = new_plan.get("steps", [])
                                new_browser_steps = [s for s in new_steps if s.get("type") == "browser"]

                                if new_browser_steps:
                                    if all(str(s.get("action", "")).lower() == "snapshot" for s in new_browser_steps):
                                        snapshot_only_replans += 1
                                    else:
                                        snapshot_only_replans = 0
                                    if snapshot_only_replans >= 2:
                                        yield sse(
                                            {
                                                "type": "done",
                                                "ok": False,
                                                "message": (
                                                    "Could not derive actionable steps from page snapshots. "
                                                    "Please refresh the tab state or perform the next action manually, then retry."
                                                ),
                                                "steps_executed": results,
                                            }
                                        )
                                        return
                                    browser_steps = new_browser_steps
                                    yield sse(
                                        {
                                            "type": "replanned",
                                            "steps": new_steps,
                                            "round": replan_round,
                                        }
                                    )
                                    replan_needed = True
                                    break
                            break

                    if not replan_needed:
                        break

                if replan_round > max_replan_rounds:
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "message": "Automation exceeded maximum re-planning rounds. Please retry with a more specific prompt.",
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
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "message": (
                                "Automation ran but did not execute actionable UI interactions. "
                                "This is likely due to unstable or unresolved page elements."
                            ),
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
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "requires_user_action": True,
                            "resume_token": resume_token,
                            "message": (
                                f"Automation completed steps but playback is not active ({reason}). "
                                "Please press Play manually, then click Confirm & Resume."
                            ),
                            "steps_executed": results,
                        }
                    )
                    return

            yield sse(
                {
                    "type": "done",
                    "ok": True,
                    "message": f"Completed {len(results)} browser steps.",
                    "steps_executed": results,
                }
            )

        except Exception as exc:
            logger.exception("Streaming agent error: %s", exc)
            yield sse({"type": "done", "ok": False, "message": str(exc)})

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

    run_id = f"resume-{str(uuid.uuid4())[:8]}"
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
        raise HTTPException(status_code=409, detail=result.error or "Resume failed")

    paused_navigator_runs.pop(payload.resume_token, None)
    return {
        "ok": True,
        "run_id": run_id,
        "message": result.text or "Resumed actions completed.",
        "steps_executed": result.data,
        "selected_target": {"device_id": device_id, "tab_id": tab_id},
    }
