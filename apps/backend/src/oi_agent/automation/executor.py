from __future__ import annotations

import asyncio
import base64
import uuid
from datetime import UTC, datetime
from typing import Any

from oi_agent.api.browser.common import fetch_page_snapshot, resolve_device_and_tab_for_prompt
from oi_agent.automation.events import publish_event
from oi_agent.automation.models import (
    AutomationPlan,
    AutomationRun,
    AutomationStep,
    RunArtifact,
    RunError,
    RunTransition,
)
from oi_agent.automation.response_composer import (
    compose_cancellation_payload,
    compose_completion_payload,
)
from oi_agent.automation.sensitive_actions.detector import (
    detect_sensitive_page,
    detect_sensitive_step,
)
from oi_agent.automation.state_machine import is_terminal_state
from oi_agent.automation.store import (
    get_browser_session,
    get_plan,
    get_run,
    save_artifacts,
    save_plan,
    save_run_transition,
    update_run,
)
from oi_agent.services.tools.base import ToolContext, ToolResult
from oi_agent.services.tools.browser_automation import BrowserAutomationTool
from oi_agent.services.tools.navigator.prompt_rewriter import rewrite_user_prompt
from oi_agent.services.tools.navigator.site_playbooks import build_playbook_context
from oi_agent.services.tools.step_planner import plan_browser_steps

_tasks: dict[str, asyncio.Task[None]] = {}
_task_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def _record_transition(
    *,
    run_id: str,
    from_state: str | None,
    to_state: str,
    reason_code: str,
    reason_text: str = "",
) -> None:
    transition = RunTransition(
        transition_id=str(uuid.uuid4()),
        run_id=run_id,
        from_state=from_state,  # type: ignore[arg-type]
        to_state=to_state,  # type: ignore[arg-type]
        reason_code=reason_code,
        reason_text=reason_text,
        actor_type="system",
        created_at=_now_iso(),
    )
    await save_run_transition(transition.transition_id, transition.model_dump(mode="json"))


def _coerce_step_kind(action: str) -> str:
    known = {"navigate", "click", "type", "scroll", "wait", "extract", "hover", "select"}
    return action if action in known else "unknown"


def _steps_from_browser_plan(steps: list[dict[str, Any]]) -> list[AutomationStep]:
    rows: list[AutomationStep] = []
    for idx, step in enumerate(steps):
        if not isinstance(step, dict) or step.get("type") != "browser":
            continue
        action = str(step.get("action", "")).strip().lower()
        label = str(step.get("description") or action.title() or f"Step {idx + 1}").strip()
        rows.append(
            AutomationStep(
                step_id=str(step.get("id") or f"s{idx + 1}"),
                kind=_coerce_step_kind(action),  # type: ignore[arg-type]
                label=label,
                description=label,
                status="pending",
            )
        )
    return rows


async def _playwright_import() -> Any:
    try:
        from playwright.async_api import async_playwright
    except Exception as exc:  # pragma: no cover - depends on local env
        raise RuntimeError("Playwright is not installed for browser session execution.") from exc
    return async_playwright


def _data_url_from_png_bytes(payload: bytes) -> str:
    encoded = base64.b64encode(payload).decode("ascii")
    return f"data:image/png;base64,{encoded}"


async def _browser_session_metadata(browser_session_id: str | None) -> dict[str, Any] | None:
    if not browser_session_id:
        return None
    return await get_browser_session(browser_session_id)


async def _connect_browser_session(cdp_url: str) -> tuple[Any, Any, Any]:
    async_playwright = await _playwright_import()
    playwright = await async_playwright().start()
    browser = await playwright.chromium.connect_over_cdp(cdp_url)
    contexts = browser.contexts
    context = contexts[0] if contexts else await browser.new_context()
    pages = context.pages
    page = pages[0] if pages else await context.new_page()
    return playwright, browser, page


async def _extract_structured_context_from_page(page: Any) -> dict[str, Any]:
    return await page.evaluate(
        """
        () => {
          const elements = [];
          const interactable = document.querySelectorAll(
            "a, button, input, select, textarea, [role='button'], [role='link'], [role='textbox'], [role='combobox'], [onclick]"
          );
          interactable.forEach((el, idx) => {
            if (idx > 200) return;
            const rect = el.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0;
            if (!visible && el.tagName !== 'BODY') return;
            elements.push({
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || '',
              type: el.type || '',
              text: (el.textContent || '').trim().substring(0, 100),
              ariaLabel: el.getAttribute('aria-label') || '',
              placeholder: el.getAttribute('placeholder') || '',
              href: el.href || '',
              name: el.getAttribute('name') || '',
              id: el.id || '',
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              visible
            });
          });
          return {
            url: location.href,
            title: document.title,
            elements,
            viewport: { w: innerWidth, h: innerHeight },
            scrollY
          };
        }
        """
    )


def _locator_from_target(page: Any, target: Any) -> Any:
    if isinstance(target, str):
        return page.locator(target)
    if not isinstance(target, dict):
        raise RuntimeError("Unsupported target format for browser session executor.")
    mode = str(target.get("by", "")).strip().lower()
    value = str(target.get("value", "")).strip()
    if mode == "role":
        options: dict[str, Any] = {}
        name = str(target.get("name", "")).strip()
        if name:
            options["name"] = name
        return page.get_by_role(value, **options)
    if mode == "text":
        return page.get_by_text(value, exact=False)
    if mode == "name":
        escaped = value.replace('"', '\\"')
        return page.locator(f'[name="{escaped}"], #{escaped}')
    if mode == "placeholder":
        return page.get_by_placeholder(value)
    if mode == "testid":
        return page.get_by_test_id(value)
    if mode == "label":
        return page.get_by_label(value)
    if mode == "css":
        return page.locator(value)
    raise RuntimeError(f"Unsupported target mode '{mode}' for browser session executor.")


async def _execute_browser_steps_over_cdp(
    cdp_url: str,
    steps: list[dict[str, Any]],
    *,
    run_id: str | None = None,
    session_id: str | None = None,
) -> ToolResult:
    playwright, browser, page = await _connect_browser_session(cdp_url)
    results: list[dict[str, Any]] = []
    last_screenshot = ""
    try:
        initial_gate = await detect_sensitive_page(page)
        if initial_gate is not None:
            last_screenshot = _data_url_from_png_bytes(await page.screenshot(type="png"))
            return ToolResult(
                success=False,
                data=results,
                error=initial_gate["reason_text"],
                metadata={
                    "last_screenshot": last_screenshot,
                    "sensitive_reason_code": initial_gate["reason_code"],
                    "sensitive_reason_text": initial_gate["reason_text"],
                    "sensitive_url": initial_gate.get("url", ""),
                },
            )
        for idx, step in enumerate(steps):
            if run_id and session_id:
                await _wait_if_paused_or_cancelled(run_id, session_id)
            action = str(step.get("action", "")).strip().lower()
            description = str(step.get("description", "") or action or f"Step {idx + 1}")
            screenshot = ""
            try:
                step_gate = detect_sensitive_step(step)
                if step_gate is not None:
                    screenshot = _data_url_from_png_bytes(await page.screenshot(type="png"))
                    last_screenshot = screenshot or last_screenshot
                    return ToolResult(
                        success=False,
                        data=results,
                        error=step_gate["reason_text"],
                        metadata={
                            "last_screenshot": last_screenshot,
                            "sensitive_reason_code": step_gate["reason_code"],
                            "sensitive_reason_text": step_gate["reason_text"],
                        },
                    )
                if action == "navigate":
                    url = str(step.get("target", "") or "")
                    await page.goto(url, wait_until="domcontentloaded")
                elif action == "click":
                    await _locator_from_target(page, step.get("target")).first.click(timeout=15000)
                elif action == "type":
                    await _locator_from_target(page, step.get("target")).first.fill(str(step.get("value", "") or ""), timeout=15000)
                elif action == "select":
                    await _locator_from_target(page, step.get("target")).first.select_option(label=str(step.get("value", "") or ""))
                elif action == "hover":
                    await _locator_from_target(page, step.get("target")).first.hover(timeout=15000)
                elif action == "scroll":
                    target = step.get("target")
                    if target not in ("", None, {}):
                        await _locator_from_target(page, target).first.scroll_into_view_if_needed(timeout=15000)
                    else:
                        await page.mouse.wheel(0, int(step.get("value", 600) or 600))
                elif action == "wait":
                    target = step.get("target")
                    if target not in ("", None, {}):
                        await _locator_from_target(page, target).first.wait_for(state="visible", timeout=15000)
                    else:
                        await page.wait_for_timeout(float(step.get("value", 2000) or 2000))
                elif action == "read_dom":
                    text = await page.locator("body").inner_text(timeout=15000)
                    results.append(
                        {"step_index": idx, "action": action, "description": description, "status": "done", "data": text[:5000], "screenshot": ""}
                    )
                    continue
                elif action == "extract_structured":
                    structured = await _extract_structured_context_from_page(page)
                    results.append(
                        {
                            "step_index": idx,
                            "action": action,
                            "description": description,
                            "status": "done",
                            "data": structured,
                            "screenshot": "",
                        }
                    )
                    continue
                elif action == "screenshot":
                    screenshot = _data_url_from_png_bytes(await page.screenshot(type="png"))
                elif action == "act":
                    raise RuntimeError("Ref-based act steps are not supported yet for browser session execution.")
                else:
                    raise RuntimeError(f"Unsupported browser session action: {action}")

                if action != "screenshot":
                    screenshot = _data_url_from_png_bytes(await page.screenshot(type="png"))
                last_screenshot = screenshot or last_screenshot
                page_gate = await detect_sensitive_page(page)
                if page_gate is not None:
                    last_screenshot = screenshot or last_screenshot
                    results.append(
                        {
                            "step_index": idx,
                            "action": action,
                            "description": description,
                            "status": "done",
                            "data": "ok",
                            "screenshot": screenshot,
                        }
                    )
                    return ToolResult(
                        success=False,
                        data=results,
                        error=page_gate["reason_text"],
                        metadata={
                            "last_screenshot": last_screenshot,
                            "sensitive_reason_code": page_gate["reason_code"],
                            "sensitive_reason_text": page_gate["reason_text"],
                            "sensitive_url": page_gate.get("url", ""),
                        },
                    )
                results.append(
                    {
                        "step_index": idx,
                        "action": action,
                        "description": description,
                        "status": "done",
                        "data": "ok",
                        "screenshot": screenshot,
                    }
                )
            except Exception as exc:
                results.append(
                    {
                        "step_index": idx,
                        "action": action,
                        "description": description,
                        "status": "error",
                        "data": str(exc),
                        "screenshot": screenshot,
                    }
                )
                return ToolResult(
                    success=False,
                    data=results,
                    error=f"Step {idx} failed: {exc}",
                    metadata={"last_screenshot": last_screenshot},
                )
        return ToolResult(
            success=True,
            data=results,
            text=f"Completed {len(results)} browser steps",
            metadata={"last_screenshot": last_screenshot},
        )
    finally:
        await browser.close()
        await playwright.stop()


async def _update_plan_steps(plan_id: str, steps: list[AutomationStep]) -> AutomationPlan:
    raw_plan = await get_plan(plan_id)
    if raw_plan is None:
        raise RuntimeError("Plan not found during execution.")
    raw_plan["steps"] = [step.model_dump(mode="json") for step in steps]
    await save_plan(plan_id, raw_plan)
    return AutomationPlan.model_validate(raw_plan)


async def _set_run_state(run_id: str, state: str, error: RunError | None = None) -> AutomationRun:
    current = await get_run(run_id)
    previous_state = str((current or {}).get("state", "") or "") or None
    updated = await update_run(
        run_id,
        {
            "state": state,
            "updated_at": _now_iso(),
            "last_error": error.model_dump(mode="json") if error else None,
        },
    )
    if updated is None:
        raise RuntimeError("Run not found during execution.")
    if previous_state != state:
        await _record_transition(
            run_id=run_id,
            from_state=previous_state,
            to_state=state,
            reason_code=f"STATE_{state.upper()}",
            reason_text=error.message if error else "",
        )
    return AutomationRun.model_validate(updated)


async def _update_run_progress(run_id: str, index: int | None) -> AutomationRun:
    updated = await update_run(
        run_id,
        {
            "current_step_index": index,
            "updated_at": _now_iso(),
        },
    )
    if updated is None:
        raise RuntimeError("Run not found during execution.")
    return AutomationRun.model_validate(updated)


async def _wait_if_paused_or_cancelled(run_id: str, session_id: str) -> None:
    _ = session_id
    while True:
        raw_run = await get_run(run_id)
        if raw_run is None:
            raise RuntimeError("Run not found.")
        state = str(raw_run.get("state", ""))
        if state in {"paused", "waiting_for_human", "human_controlling"}:
            await asyncio.sleep(0.1)
            continue
        if state in {"cancelled", "canceled"}:
            raise asyncio.CancelledError()
        return


async def _publish_step_event(
    *,
    user_id: str,
    session_id: str,
    run_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    await publish_event(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        event_type=event_type,
        payload=payload,
    )


async def execute_run(run_id: str) -> None:
    raw_run = await get_run(run_id)
    if raw_run is None:
        return
    run = AutomationRun.model_validate(raw_run)
    owner_user_id = str(raw_run.get("user_id", "") or "")
    raw_plan = await get_plan(run.plan_id)
    if raw_plan is None:
        await _set_run_state(
            run_id,
            "failed",
            RunError(code="PLAN_NOT_FOUND", message="Automation plan not found.", retryable=False),
        )
        return
    plan = AutomationPlan.model_validate(raw_plan)
    session_id = run.session_id

    try:
        await publish_event(
            user_id=owner_user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.started",
            payload={"run_id": run_id},
        )
        run = await _set_run_state(run_id, "starting")

        prompt = plan.summary
        current_url = ""
        current_title = ""
        structured_context = None
        page_snapshot = None
        device_id: str | None = None
        tab_id: int | None = None
        cdp_url = ""

        if run.executor_mode in {"local_runner", "server_runner"}:
            session_meta = await _browser_session_metadata(run.browser_session_id)
            metadata = session_meta.get("metadata", {}) if isinstance(session_meta, dict) else {}
            cdp_url = str(metadata.get("cdp_url", "") or "") if isinstance(metadata, dict) else ""
            if not session_meta or not cdp_url:
                raise RuntimeError(
                    "This run requires a browser session. Start or select a local/server runner session before running automation."
                )

            playwright, browser, page = await _connect_browser_session(cdp_url)
            try:
                current_url = str(page.url or "")
                current_title = str(await page.title())
                structured_context = await _extract_structured_context_from_page(page)
            finally:
                await browser.close()
                await playwright.stop()
        else:
            device_id, tab_id = await resolve_device_and_tab_for_prompt(
                user_id=owner_user_id,
                prompt=prompt,
                device_id=plan.targets[0].device_id if plan.targets else None,
                tab_id=plan.targets[0].tab_id if plan.targets else None,
            )
            if plan.targets:
                plan.targets[0].device_id = device_id
                plan.targets[0].tab_id = tab_id
                raw_plan = await get_plan(plan.plan_id)
                assert raw_plan is not None
                raw_plan["targets"] = [target.model_dump(mode="json") for target in plan.targets]
                await save_plan(plan.plan_id, raw_plan)
            page_snapshot = await fetch_page_snapshot(device_id, tab_id, f"run-{run_id}")
            current_url = str((page_snapshot or {}).get("url", "") or "")
            current_title = str((page_snapshot or {}).get("title", "") or "")

        playbook_context = build_playbook_context(
            prompt=prompt,
            current_url=current_url,
        )
        rewritten_prompt = await rewrite_user_prompt(
            user_prompt=prompt,
            current_url=current_url,
            current_page_title=current_title,
            playbook_context=playbook_context,
            model_override=plan.model_id,
        )
        browser_plan = await plan_browser_steps(
            user_prompt=rewritten_prompt,
            current_url=current_url,
            current_page_title=current_title,
            page_snapshot=page_snapshot,
            structured_context=structured_context,
            playbook_context=playbook_context,
            model_override=plan.model_id,
        )
        browser_steps = [
            step for step in browser_plan.get("steps", []) if isinstance(step, dict) and step.get("type") == "browser"
        ]
        plan = await _update_plan_steps(plan.plan_id, _steps_from_browser_plan(browser_steps))
        await update_run(run_id, {"total_steps": len(plan.steps), "updated_at": _now_iso()})
        run = await _set_run_state(run_id, "running")

        async def before_step(step_index: int, step: dict[str, Any]) -> None:
            await _wait_if_paused_or_cancelled(run_id, session_id)
            await _update_run_progress(run_id, step_index)
            step_id = str(step.get("id") or f"s{step_index + 1}")
            label = str(step.get("description") or step.get("action") or f"Step {step_index + 1}")
            if step_index < len(plan.steps):
                rows = [row.model_dump(mode="json") for row in plan.steps]
                rows[step_index]["status"] = "running"
                rows[step_index]["started_at"] = _now_iso()
                raw_plan = await get_plan(plan.plan_id)
                assert raw_plan is not None
                raw_plan["steps"] = rows
                await save_plan(plan.plan_id, raw_plan)
            await _publish_step_event(
                user_id=owner_user_id,
                session_id=session_id,
                run_id=run_id,
                event_type="step.started",
                payload={"run_id": run_id, "step_id": step_id, "index": step_index, "label": label},
            )

        async def after_step(step_index: int, step: dict[str, Any], result: dict[str, Any]) -> None:
            step_id = str(step.get("id") or f"s{step_index + 1}")
            status = str(result.get("status", "") or "")
            label = str(step.get("description") or step.get("action") or f"Step {step_index + 1}")
            rows = [row.model_dump(mode="json") for row in plan.steps]
            if step_index < len(rows):
                rows[step_index]["completed_at"] = _now_iso()
                rows[step_index]["status"] = "completed" if status != "error" else "failed"
                screenshot = str(result.get("screenshot", "") or "")
                if screenshot:
                    rows[step_index]["screenshot_url"] = screenshot
            raw_plan = await get_plan(plan.plan_id)
            assert raw_plan is not None
            raw_plan["steps"] = rows
            await save_plan(plan.plan_id, raw_plan)
            screenshot = str(result.get("screenshot", "") or "")
            if screenshot:
                artifacts = await save_screenshot_artifact(run_id, step_id, screenshot)
                _ = artifacts
            event_type = "step.completed" if status != "error" else "step.failed"
            payload = {
                "run_id": run_id,
                "step_id": step_id,
                "index": step_index,
                "label": label,
                "screenshot_url": screenshot or None,
            }
            if status == "error":
                payload.update(
                    {
                        "code": "ELEMENT_NOT_FOUND",
                        "message": str(result.get("data", "") or "Step failed"),
                        "retryable": True,
                    }
                )
            await _publish_step_event(
                user_id=owner_user_id,
                session_id=session_id,
                run_id=run_id,
                event_type=event_type,
                payload=payload,
            )

        if cdp_url:
            result = await _execute_browser_steps_over_cdp(
                cdp_url,
                browser_steps,
                run_id=run_id,
                session_id=session_id,
            )
        else:
            assert device_id is not None
            context = ToolContext(
                automation_id=f"run-{run_id}",
                user_id=owner_user_id or "automation-user",
                action_config={
                    "type": "browser_automation",
                    "device_id": device_id,
                    "tab_id": tab_id,
                    "app_name": plan.targets[0].app_name if plan.targets else None,
                    "run_id": run_id,
                    "before_step": before_step,
                    "after_step": after_step,
                },
                data_sources=[],
                trigger_config={"type": "manual"},
                automation_name="Automation Run",
                automation_description=rewritten_prompt,
                execution_mode="autopilot",
            )
            result = await BrowserAutomationTool().execute(context, [{"steps": browser_steps}])
        for idx, row in enumerate(result.data):
            step = browser_steps[idx] if idx < len(browser_steps) else {}
            await before_step(idx, step)
            if row.get("status") == "error":
                await after_step(
                    idx,
                    step,
                    {"status": "error", "data": row.get("data", ""), "screenshot": row.get("screenshot", "")},
                )
                break
            await after_step(idx, step, {"status": "done", "data": row.get("data", ""), "screenshot": row.get("screenshot", "")})
        if not result.success:
            message = result.error or "Automation failed."
            lowered = message.lower()
            sensitive_reason_code = str(result.metadata.get("sensitive_reason_code", "") or "")
            sensitive_reason_text = str(result.metadata.get("sensitive_reason_text", "") or message)
            sensitive_url = str(result.metadata.get("sensitive_url", "") or "")
            if sensitive_reason_code:
                last_screenshot = str(result.metadata.get("last_screenshot", "") or "")
                if last_screenshot:
                    await save_screenshot_artifact(run_id, "sensitive-action", last_screenshot)
                gate_error = RunError(
                    code="SENSITIVE_ACTION_BLOCKED",
                    message=sensitive_reason_text,
                    retryable=True,
                )
                await _set_run_state(run_id, "waiting_for_human", gate_error)
                await publish_event(
                    user_id=owner_user_id,
                    session_id=session_id,
                    run_id=run_id,
                    event_type="run.waiting_for_human",
                    payload={
                        "run_id": run_id,
                        "reason": sensitive_reason_text,
                        "reason_code": sensitive_reason_code,
                        "url": sensitive_url or current_url,
                    },
                )
                return
            if any(
                token in lowered
                for token in (
                    "manual intervention required",
                    "security_gate",
                    "captcha",
                    "otp",
                    "2fa",
                    "login required",
                    "payment",
                    "permission",
                )
            ):
                gate_error = RunError(
                    code="SENSITIVE_ACTION_BLOCKED",
                    message=message,
                    retryable=True,
                )
                await _set_run_state(run_id, "waiting_for_human", gate_error)
                await publish_event(
                    user_id=owner_user_id,
                    session_id=session_id,
                    run_id=run_id,
                    event_type="run.waiting_for_human",
                    payload={"run_id": run_id, "reason": message, "reason_code": "GENERIC_SENSITIVE_ACTION", "url": current_url},
                )
                return
            error = RunError(
                code="EXECUTION_FAILED",
                message=message,
                retryable=True,
            )
            await _set_run_state(run_id, "failed", error)
            await publish_event(
                user_id=owner_user_id,
                session_id=session_id,
                run_id=run_id,
                event_type="run.failed",
                payload={"run_id": run_id, "code": error.code, "message": error.message, "retryable": error.retryable},
            )
            return

        last_screenshot = str(result.metadata.get("last_screenshot", "") or "")
        if last_screenshot:
            await save_screenshot_artifact(run_id, "final", last_screenshot)
        await _update_run_progress(run_id, len(plan.steps) - 1 if plan.steps else None)
        await _set_run_state(run_id, "completed")
        await publish_event(
            user_id=owner_user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.completed",
            payload={"run_id": run_id, **compose_completion_payload(result.text)},
        )
    except asyncio.CancelledError:
        raw_run = await get_run(run_id)
        current_state = str((raw_run or {}).get("state", ""))
        if not is_terminal_state(current_state):
            await _set_run_state(run_id, "cancelled")
        await publish_event(
            user_id=owner_user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.interrupted_by_user",
            payload={
                "run_id": run_id,
                **compose_cancellation_payload(),
            },
        )
    except Exception as exc:
        error = RunError(code="EXECUTION_FAILED", message=str(exc), retryable=True)
        await _set_run_state(run_id, "failed", error)
        await publish_event(
            user_id=owner_user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.failed",
            payload={"run_id": run_id, "code": error.code, "message": error.message, "retryable": error.retryable},
        )
    finally:
        async with _task_lock:
            _tasks.pop(run_id, None)


async def save_screenshot_artifact(run_id: str, step_id: str, screenshot_url: str) -> list[dict[str, Any]]:
    artifacts = await get_run_artifacts(run_id)
    artifacts.append(
        RunArtifact(
            artifact_id=f"{run_id}-{step_id}-{len(artifacts) + 1}",
            type="screenshot",
            url=screenshot_url,
            created_at=_now_iso(),
            step_id=step_id,
        ).model_dump(mode="json")
    )
    await save_artifacts(run_id, artifacts)
    return artifacts


async def get_run_artifacts(run_id: str) -> list[dict[str, Any]]:
    from oi_agent.automation.store import get_artifacts

    return await get_artifacts(run_id)


async def start_execution(run_id: str) -> None:
    async with _task_lock:
        if run_id in _tasks and not _tasks[run_id].done():
            return
        _tasks[run_id] = asyncio.create_task(execute_run(run_id))


async def cancel_execution(run_id: str) -> None:
    async with _task_lock:
        task = _tasks.get(run_id)
        if task and not task.done():
            task.cancel()


async def has_live_execution(run_id: str) -> bool:
    async with _task_lock:
        task = _tasks.get(run_id)
        return bool(task and not task.done())


async def reset_execution_tasks() -> None:
    async with _task_lock:
        tasks = list(_tasks.values())
        _tasks.clear()
    for task in tasks:
        if not task.done():
            task.cancel()
    for task in tasks:
        try:
            await task
        except BaseException:
            pass
