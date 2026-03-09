from __future__ import annotations

from fastapi import APIRouter

from oi_agent.api.browser.actions_routes import actions_router
from oi_agent.api.browser.agent_routes import agent_router
from oi_agent.api.browser.runner_routes import runner_router
from oi_agent.api.browser.session_stream_routes import session_stream_router
from oi_agent.api.browser.sessions_routes import sessions_router
from oi_agent.api.browser.tabs_routes import tabs_router

browser_router = APIRouter()
browser_router.include_router(actions_router)
browser_router.include_router(agent_router)
browser_router.include_router(tabs_router)
browser_router.include_router(sessions_router)
browser_router.include_router(runner_router)
browser_router.include_router(session_stream_router)
