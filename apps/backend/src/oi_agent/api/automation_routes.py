from __future__ import annotations

from fastapi import APIRouter, Depends

from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.intent_extractor import resolve_model_selection
from oi_agent.automation.intent_service import understand_turn
from oi_agent.automation.intent_service import prepare_turn as prepare_chat_turn
from oi_agent.automation.models import (
    AutomationScheduleCreateRequest,
    AutomationScheduleListResponse,
    AutomationScheduleResponse,
    ChatPrimeRequest,
    ChatPrimeResponse,
    ChatTurnRequest,
    ChatTurnResponse,
    ConfirmIntentRequest,
    ConfirmIntentResponse,
    GeminiModelListResponse,
    GeminiModelSummary,
    ResolveExecutionRequest,
    ResolveExecutionResponse,
    RunActionResponse,
    RunInterruptionRequest,
    RunResponse,
)
from oi_agent.automation.run_service import (
    confirm_intent,
    get_run_response,
    mutate_run_state,
    report_run_interruption,
    resolve_execution,
)
from oi_agent.automation.schedule_service import (
    create_automation_schedule as create_automation_schedule_entry,
    delete_automation_schedule as delete_automation_schedule_entry,
    list_automation_schedules as list_automation_schedule_entries,
)
from oi_agent.config import settings

automation_router = APIRouter(prefix="/api", tags=["automation"])


def _fallback_gemini_models() -> list[GeminiModelSummary]:
    seen: set[str] = set()
    items: list[GeminiModelSummary] = []
    for model_id in [settings.gemini_model, settings.gemini_live_model]:
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        items.append(
            GeminiModelSummary(
                id=model_id,
                label=model_id.replace("-", " ").replace("preview", "Preview").title(),
            )
        )
    return items


async def _fetch_gemini_models() -> list[GeminiModelSummary]:
    from google import genai
    from google.genai import types

    if settings.google_genai_use_vertexai:
        client = genai.Client(
            vertexai=True,
            project=settings.gcp_project,
            location="global",
        )
    elif settings.google_api_key:
        client = genai.Client(api_key=settings.google_api_key)
    else:
        return _fallback_gemini_models()

    items: list[GeminiModelSummary] = []
    pager = client.models.list(config=types.ListModelsConfig(page_size=100))
    for raw in pager:
        name = str(getattr(raw, "name", "") or "").removeprefix("models/")
        if not name.startswith("gemini"):
            continue
        supported = [str(item) for item in list(getattr(raw, "supported_actions", []) or [])]
        if supported and not any("generate" in item.lower() or "content" in item.lower() for item in supported):
            continue
        label = str(getattr(raw, "display_name", "") or name.replace("-", " ").replace("preview", "Preview").title())
        items.append(
            GeminiModelSummary(
                id=name,
                label=label,
                supports_generation=True,
            )
        )

    return items or _fallback_gemini_models()


@automation_router.post("/chat/prime", response_model=ChatPrimeResponse)
async def chat_prime(
    payload: ChatPrimeRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatPrimeResponse:
    _ = user["uid"]
    return await prepare_chat_turn(payload)


@automation_router.post("/chat/turn", response_model=ChatTurnResponse)
async def chat_turn(
    payload: ChatTurnRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatTurnResponse:
    return await understand_turn(payload, user["uid"])


@automation_router.post("/chat/resolve-execution", response_model=ResolveExecutionResponse)
async def chat_resolve_execution(
    payload: ResolveExecutionRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ResolveExecutionResponse:
    return await resolve_execution(payload, user["uid"])


@automation_router.post("/chat/confirm", response_model=ConfirmIntentResponse)
async def chat_confirm(
    payload: ConfirmIntentRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ConfirmIntentResponse:
    return await confirm_intent(user["uid"], payload.session_id, payload.intent_id, payload.confirmed)


@automation_router.get("/models/gemini", response_model=GeminiModelListResponse)
async def list_gemini_models(
    user: dict[str, str] = Depends(get_current_user),
) -> GeminiModelListResponse:
    _ = user["uid"]
    try:
        items = await _fetch_gemini_models()
    except Exception:
        items = _fallback_gemini_models()
    default_model_id, _ = resolve_model_selection(None)
    if items and default_model_id not in {item.id for item in items}:
        default_model_id = items[0].id
    return GeminiModelListResponse(items=items, default_model_id=default_model_id)


@automation_router.get("/runs/{run_id}", response_model=RunResponse)
async def get_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunResponse:
    return await get_run_response(user["uid"], run_id)


@automation_router.post("/runs/{run_id}/pause", response_model=RunActionResponse)
async def pause_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    return await mutate_run_state(user["uid"], run_id, "pause")


@automation_router.post("/runs/{run_id}/resume", response_model=RunActionResponse)
async def resume_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    return await mutate_run_state(user["uid"], run_id, "resume")


@automation_router.post("/runs/{run_id}/stop", response_model=RunActionResponse)
async def stop_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    return await mutate_run_state(user["uid"], run_id, "stop")


@automation_router.post("/runs/{run_id}/retry", response_model=RunActionResponse)
async def retry_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    return await mutate_run_state(user["uid"], run_id, "retry")


@automation_router.post("/runs/{run_id}/interrupt", response_model=RunActionResponse)
async def interrupt_run(
    run_id: str,
    payload: RunInterruptionRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    return await report_run_interruption(user["uid"], run_id, payload)


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
