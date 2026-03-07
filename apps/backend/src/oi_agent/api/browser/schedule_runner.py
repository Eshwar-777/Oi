from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from oi_agent.automation.executor import execute_run
from oi_agent.automation.run_service import create_and_execute_scheduled_run
from oi_agent.automation.schedule_service import (
    claim_automation_schedule,
    list_due_automation_schedules,
    mark_automation_schedule_after_run,
)

logger = logging.getLogger(__name__)

_scheduler_task: asyncio.Task[None] | None = None
_scheduler_stop = asyncio.Event()
_worker_id = f"automation-scheduler-{str(uuid.uuid4())[:8]}"


async def _run_one_automation_schedule(schedule: dict[str, Any]) -> None:
    schedule_id = str(schedule.get("schedule_id", "") or "")
    prompt = str(schedule.get("prompt", "") or "")
    if not schedule_id or not prompt:
        return

    claimed = await claim_automation_schedule(schedule_id=schedule_id, worker_id=_worker_id)
    if claimed is None:
        return

    try:
        run, _plan = await create_and_execute_scheduled_run(claimed.model_dump(mode="json"))
        await execute_run(run.run_id)
        await mark_automation_schedule_after_run(schedule_id=schedule_id, success=True)
    except Exception as exc:
        logger.exception("Automation scheduled run failed schedule_id=%s: %s", schedule_id, exc)
        await mark_automation_schedule_after_run(schedule_id=schedule_id, success=False, error_message=str(exc))


async def _scheduler_loop() -> None:
    logger.info("Automation scheduler loop started")
    while not _scheduler_stop.is_set():
        try:
            automation_due = await list_due_automation_schedules(limit=10)
            for row in automation_due:
                await _run_one_automation_schedule(row.model_dump(mode="json"))
        except Exception as exc:
            logger.exception("Automation scheduler loop error: %s", exc)
        try:
            await asyncio.wait_for(_scheduler_stop.wait(), timeout=5.0)
        except TimeoutError:
            pass
    logger.info("Automation scheduler loop stopped")


def start_scheduler() -> None:
    global _scheduler_task
    if _scheduler_task and not _scheduler_task.done():
        return
    _scheduler_stop.clear()
    _scheduler_task = asyncio.create_task(_scheduler_loop())


async def stop_scheduler() -> None:
    global _scheduler_task
    _scheduler_stop.set()
    if _scheduler_task:
        _scheduler_task.cancel()
        try:
            await _scheduler_task
        except BaseException:
            pass
        _scheduler_task = None
