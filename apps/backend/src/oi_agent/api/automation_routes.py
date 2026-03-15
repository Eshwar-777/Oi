from __future__ import annotations

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.analytics_service import (
    get_automation_engine_analytics,
    get_runtime_incident_analytics,
)
from oi_agent.automation.conversation_service import (
    create_conversation,
    create_conversation_state,
    delete_conversation,
    get_conversation_session_state,
    get_conversation_state,
    handle_chat_turn,
    list_conversations,
)
from oi_agent.automation.intent_extractor import resolve_model_selection
from oi_agent.automation.models import (
    AutomationEngineAnalyticsResponse,
    AutomationScheduleCreateRequest,
    AutomationScheduleListResponse,
    AutomationScheduleResponse,
    ChatSessionStateResponse,
    ChatTurnRequest,
    ChatTurnResponse,
    ConversationListResponse,
    CreateConversationRequest,
    GeminiModelListResponse,
    GeminiModelSummary,
    NotificationPreferencesResponse,
    NotificationPreferencesUpdateRequest,
    RunActionResponse,
    RunInterruptionRequest,
    RunListResponse,
    RunResponse,
    RunRetryRequest,
    RuntimeIncidentAnalyticsResponse,
    RunTransitionListResponse,
)
from oi_agent.automation.notification_preferences_service import (
    get_user_notification_preferences,
    update_user_notification_preferences,
)
from oi_agent.automation.run_service import (
    approve_sensitive_action,
    delete_stale_run,
    get_run_response,
    get_run_transitions_response,
    list_runs_response,
    mutate_run_state,
    report_run_interruption,
)
from oi_agent.automation.schedule_service import (
    create_automation_schedule as create_automation_schedule_entry,
)
from oi_agent.automation.schedule_service import (
    delete_automation_schedule as delete_automation_schedule_entry,
)
from oi_agent.automation.schedule_service import (
    list_automation_schedules as list_automation_schedule_entries,
)
from oi_agent.config import settings
from oi_agent.observability.metrics import (
    record_chat_turn_failure,
    record_chat_turn_request,
    record_model_discovery_failure,
)
from oi_agent.computer_use.service import handle_computer_use_turn

automation_router = APIRouter(prefix="/api", tags=["automation"])
logger = logging.getLogger(__name__)

_CURATED_GEMINI_MODELS: tuple[tuple[str, str], ...] = (
    ("gemini-2.5-pro", "Gemini 2.5 Pro"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
    ("gemini-2.0-flash", "Gemini 2.0 Flash"),
    ("gemini-2.0-flash-lite", "Gemini 2.0 Flash-Lite"),
)
_MIN_DISCOVERED_GEMINI_MODELS = 4


def _dedupe_gemini_models(items: list[GeminiModelSummary]) -> list[GeminiModelSummary]:
    deduped: dict[str, GeminiModelSummary] = {}
    for item in items:
        if not item.id:
            continue
        deduped[item.id] = item
    return [deduped[key] for key in sorted(deduped.keys())]


def _curated_gemini_models() -> list[GeminiModelSummary]:
    return [
        GeminiModelSummary(
            id=model_id,
            label=label,
            provider="google",
            supports_generation=True,
        )
        for model_id, label in _CURATED_GEMINI_MODELS
    ]


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
                provider="google",
                supports_generation=True,
            )
        )
    return _dedupe_gemini_models(items + _curated_gemini_models())


def _list_gemini_models_for_location(location: str) -> list[GeminiModelSummary]:
    from google import genai
    from google.genai import types

    if settings.google_genai_use_vertexai:
        client = genai.Client(
            vertexai=True,
            project=settings.gcp_project,
            location=location,
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
                provider="google",
                supports_generation=True,
            )
        )

    return items


async def _fetch_gemini_models() -> list[GeminiModelSummary]:
    if settings.google_genai_use_vertexai:
        candidate_locations = [settings.gcp_location]
        if settings.gcp_location.strip().lower() != "global":
            candidate_locations.append("global")
        discovered: list[GeminiModelSummary] = []
        for location in candidate_locations:
            discovered.extend(await asyncio.to_thread(_list_gemini_models_for_location, location))
        items = _dedupe_gemini_models(discovered)
    else:
        items = await asyncio.to_thread(_list_gemini_models_for_location, settings.gcp_location)
        items = _dedupe_gemini_models(items)

    if len(items) < _MIN_DISCOVERED_GEMINI_MODELS:
        return _dedupe_gemini_models(items + _curated_gemini_models())

    return items or _fallback_gemini_models()


@automation_router.post("/chat/turn", response_model=ChatTurnResponse)
async def chat_turn(
    payload: ChatTurnRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatTurnResponse:
    model = str(payload.client_context.model or "auto")
    source = "chat_api"
    record_chat_turn_request(model=model, source=source)
    try:
        return await handle_chat_turn(payload, user["uid"])
    except Exception:
        record_chat_turn_failure(model=model, source=source)
        raise


@automation_router.get("/chat/conversations", response_model=ConversationListResponse)
async def list_chat_conversations(
    user: dict[str, str] = Depends(get_current_user),
) -> ConversationListResponse:
    return await list_conversations(user["uid"])


@automation_router.post("/chat/conversations", response_model=ChatSessionStateResponse)
async def create_chat_conversation(
    payload: CreateConversationRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatSessionStateResponse:
    return await create_conversation_state(user["uid"], payload)


@automation_router.get("/chat/conversations/{conversation_id}", response_model=ChatSessionStateResponse)
async def get_chat_conversation(
    conversation_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatSessionStateResponse:
    return await get_conversation_state(user["uid"], conversation_id)


@automation_router.delete("/chat/conversations/{conversation_id}")
async def delete_chat_conversation(
    conversation_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, object]:
    return await delete_conversation(user["uid"], conversation_id)


@automation_router.post("/chat/conversations/{conversation_id}/turn", response_model=ChatTurnResponse)
async def chat_conversation_turn(
    conversation_id: str,
    payload: ChatTurnRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatTurnResponse:
    patched = payload.model_copy(update={"conversation_id": conversation_id})
    model = str(patched.client_context.model or "auto")
    source = "chat_api"
    record_chat_turn_request(model=model, source=source)
    try:
        return await handle_chat_turn(patched, user["uid"])
    except Exception:
        record_chat_turn_failure(model=model, source=source)
        raise


@automation_router.post("/computer-use/turn", response_model=ChatTurnResponse)
async def computer_use_turn(
    payload: ChatTurnRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatTurnResponse:
    return await handle_computer_use_turn(payload, user["uid"])


@automation_router.post("/computer-use/conversations/{conversation_id}/turn", response_model=ChatTurnResponse)
async def computer_use_conversation_turn(
    conversation_id: str,
    payload: ChatTurnRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatTurnResponse:
    patched = payload.model_copy(update={"conversation_id": conversation_id})
    return await handle_computer_use_turn(patched, user["uid"])


@automation_router.get("/chat/sessions/{session_id}", response_model=ChatSessionStateResponse)
async def get_chat_session(
    session_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> ChatSessionStateResponse:
    return await get_conversation_session_state(user["uid"], session_id)


@automation_router.get("/models/gemini", response_model=GeminiModelListResponse)
async def list_gemini_models(
    user: dict[str, str] = Depends(get_current_user),
) -> GeminiModelListResponse:
    _ = user["uid"]
    try:
        items = await _fetch_gemini_models()
    except Exception:
        record_model_discovery_failure(provider="vertex" if settings.google_genai_use_vertexai else "google_api")
        logger.warning("Gemini model discovery failed; falling back to configured models", exc_info=True)
        items = _fallback_gemini_models()
    default_model_id, _ = resolve_model_selection(None)
    if items and default_model_id not in {item.id for item in items}:
        default_model_id = items[0].id
    return GeminiModelListResponse(items=items, default_model_id=default_model_id)


@automation_router.get("/runs", response_model=RunListResponse)
async def list_runs(
    session_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    user: dict[str, str] = Depends(get_current_user),
) -> RunListResponse:
    return await list_runs_response(user["uid"], session_id=session_id, limit=limit)

@automation_router.get("/runs/{run_id}", response_model=RunResponse)
async def get_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunResponse:
    return await get_run_response(user["uid"], run_id)


@automation_router.get("/runs/{run_id}/transitions", response_model=RunTransitionListResponse)
async def get_run_transitions(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunTransitionListResponse:
    return await get_run_transitions_response(user["uid"], run_id)


@automation_router.delete("/runs/{run_id}")
async def delete_run_route(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, object]:
    return await delete_stale_run(user["uid"], run_id)


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


@automation_router.post("/runs/{run_id}/approve-sensitive-action", response_model=RunActionResponse)
async def approve_sensitive_action_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    return await approve_sensitive_action(user["uid"], run_id)


@automation_router.post("/runs/{run_id}/stop", response_model=RunActionResponse)
async def stop_run(
    run_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    return await mutate_run_state(user["uid"], run_id, "stop")


@automation_router.post("/runs/{run_id}/retry", response_model=RunActionResponse)
async def retry_run(
    run_id: str,
    payload: RunRetryRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> RunActionResponse:
    return await mutate_run_state(
        user["uid"],
        run_id,
        "retry",
        browser_session_id=payload.browser_session_id,
    )


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


@automation_router.get("/analytics/automation-engines", response_model=AutomationEngineAnalyticsResponse)
async def get_automation_engine_analytics_route(
    user: dict[str, str] = Depends(get_current_user),
) -> AutomationEngineAnalyticsResponse:
    _ = user["uid"]
    return await get_automation_engine_analytics()


@automation_router.get("/analytics/runtime-incidents", response_model=RuntimeIncidentAnalyticsResponse)
async def get_runtime_incident_analytics_route(
    user: dict[str, str] = Depends(get_current_user),
) -> RuntimeIncidentAnalyticsResponse:
    _ = user["uid"]
    return await get_runtime_incident_analytics()


@automation_router.get("/notification-preferences", response_model=NotificationPreferencesResponse)
async def get_notification_preferences_route(
    user: dict[str, str] = Depends(get_current_user),
) -> NotificationPreferencesResponse:
    return NotificationPreferencesResponse(
        preferences=await get_user_notification_preferences(user["uid"]),
    )


@automation_router.put("/notification-preferences", response_model=NotificationPreferencesResponse)
async def update_notification_preferences_route(
    payload: NotificationPreferencesUpdateRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> NotificationPreferencesResponse:
    return NotificationPreferencesResponse(
        preferences=await update_user_notification_preferences(user["uid"], payload),
    )


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
