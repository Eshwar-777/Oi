from __future__ import annotations

from fastapi import APIRouter, Depends

from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation import (
    confirm_intent,
    create_automation_schedule_entry,
    delete_automation_schedule_entry,
    get_run_response,
    list_automation_schedule_entries,
    mutate_run_state,
    report_run_interruption,
    resolve_execution,
    understand_turn,
)
from oi_agent.automation.models import (
    AutomationScheduleCreateRequest,
    AutomationScheduleListResponse,
    AutomationScheduleResponse,
    ChatTurnRequest,
    ChatTurnResponse,
    ConfirmIntentRequest,
    ConfirmIntentResponse,
    ResolveExecutionRequest,
    ResolveExecutionResponse,
    RunActionResponse,
    RunInterruptionRequest,
    RunResponse,
)

automation_router = APIRouter(prefix="/api", tags=["automation"])


@automation_router.post("/chat/turn", response_model=ChatTurnResponse)
async def chat_turn(
    payload: ChatTurnRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatTurnResponse:
    _ = user["uid"]
    return await understand_turn(payload)


@automation_router.post("/chat/resolve-execution", response_model=ResolveExecutionResponse)
async def chat_resolve_execution(
    payload: ResolveExecutionRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ResolveExecutionResponse:
    _ = user["uid"]
    return await resolve_execution(payload)


@automation_router.post("/chat/confirm", response_model=ConfirmIntentResponse)
async def chat_confirm(
    payload: ConfirmIntentRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ConfirmIntentResponse:
    _ = user["uid"]
    return await confirm_intent(payload.session_id, payload.intent_id, payload.confirmed)


@automation_router.get("/runs/{run_id}", response_model=RunResponse)
async def get_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunResponse:
    _ = user["uid"]
    return await get_run_response(run_id)


@automation_router.post("/runs/{run_id}/pause", response_model=RunActionResponse)
async def pause_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    _ = user["uid"]
    return await mutate_run_state(run_id, "pause")


@automation_router.post("/runs/{run_id}/resume", response_model=RunActionResponse)
async def resume_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    _ = user["uid"]
    return await mutate_run_state(run_id, "resume")


@automation_router.post("/runs/{run_id}/stop", response_model=RunActionResponse)
async def stop_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    _ = user["uid"]
    return await mutate_run_state(run_id, "stop")


@automation_router.post("/runs/{run_id}/retry", response_model=RunActionResponse)
async def retry_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    _ = user["uid"]
    return await mutate_run_state(run_id, "retry")


@automation_router.post("/runs/{run_id}/interrupt", response_model=RunActionResponse)
async def interrupt_run(
    run_id: str,
    payload: RunInterruptionRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    _ = user["uid"]
    return await report_run_interruption(run_id, payload)


@automation_router.get("/schedules", response_model=AutomationScheduleListResponse)
async def list_schedules(
    user: dict[str, str] = Depends(get_current_user),
) -> AutomationScheduleListResponse:
    return AutomationScheduleListResponse(items=await list_automation_schedule_entries(user_id=user["uid"]))


@automation_router.post("/schedules", response_model=AutomationScheduleResponse)
async def create_schedule(
    payload: AutomationScheduleCreateRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> AutomationScheduleResponse:
    schedule = await create_automation_schedule_entry(user_id=user["uid"], payload=payload)
    return AutomationScheduleResponse(schedule=schedule)


@automation_router.delete("/schedules/{schedule_id}")
async def delete_schedule(
    schedule_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, object]:
    deleted = await delete_automation_schedule_entry(user_id=user["uid"], schedule_id=schedule_id)
    return {"ok": deleted, "schedule_id": schedule_id}
