from __future__ import annotations

from fastapi import APIRouter

from oi_agent.api.browser.actions_routes import actions_router
from oi_agent.api.browser.agent_routes import agent_router
from oi_agent.api.browser.tabs_routes import tabs_router

browser_router = APIRouter()
browser_router.include_router(tabs_router)
browser_router.include_router(actions_router)
browser_router.include_router(agent_router)
