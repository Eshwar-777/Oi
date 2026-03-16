from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from oi_agent.api.browser.server_runner_manager import server_runner_manager
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.sessions.models import ManagedRunnerStatusResponse

managed_runner_router = APIRouter()


@managed_runner_router.get("/browser/server-runner", response_model=ManagedRunnerStatusResponse)
async def get_server_runner_status(
    user: dict[str, Any] = Depends(get_current_user),
) -> ManagedRunnerStatusResponse:
    return ManagedRunnerStatusResponse(runner=await server_runner_manager.status(user["uid"]))


@managed_runner_router.post("/browser/server-runner/start", response_model=ManagedRunnerStatusResponse)
async def start_server_runner(
    user: dict[str, Any] = Depends(get_current_user),
) -> ManagedRunnerStatusResponse:
    try:
        status = await server_runner_manager.start(user["uid"])
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return ManagedRunnerStatusResponse(runner=status)


@managed_runner_router.post("/browser/server-runner/stop", response_model=ManagedRunnerStatusResponse)
async def stop_server_runner(
    user: dict[str, Any] = Depends(get_current_user),
) -> ManagedRunnerStatusResponse:
    return ManagedRunnerStatusResponse(runner=await server_runner_manager.stop(user["uid"]))
