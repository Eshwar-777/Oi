import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from oi_agent.api.auth_routes import auth_router
from oi_agent.api.automation_routes import automation_router
from oi_agent.api.browser import browser_router
from oi_agent.api.browser.schedule_runner import start_scheduler, stop_scheduler
from oi_agent.api.browser.server_runner_manager import server_runner_manager
from oi_agent.api.middleware import CorrelationIdMiddleware, RequestLoggingMiddleware
from oi_agent.api.routes import router
from oi_agent.api.websocket import ws_router
from oi_agent.automation.event_routes import event_router
from oi_agent.config import settings
from oi_agent.devices import device_router
from oi_agent.observability.metrics import render_metrics
from oi_agent.observability.telemetry import configure_logging

configure_logging(settings.log_level, settings.log_format, settings.log_scope)
logger = logging.getLogger(__name__)


def _validate_runtime_configuration() -> None:
    missing = settings.validate_startup()
    if missing:
        raise RuntimeError("Missing required startup configuration: " + ", ".join(missing))


@asynccontextmanager
async def lifespan(app: FastAPI):
    _validate_runtime_configuration()
    logger.info(
        "OI backend started",
        extra={
            "runtime_marker": "backend-intent-debug-v2",
            "config_summary": settings.redacted_summary(),
        },
    )
    scheduler_embedded = settings.automation_scheduler_mode.strip().lower() == "embedded"
    if scheduler_embedded:
        start_scheduler()
    yield
    if scheduler_embedded:
        await stop_scheduler()
    await server_runner_manager.shutdown()
    logger.info("OI backend shutting down")


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.allowed_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(RequestLoggingMiddleware)

app.include_router(router)
app.include_router(auth_router)
app.include_router(automation_router)
app.include_router(event_router)
app.include_router(browser_router)
app.include_router(ws_router)
app.include_router(device_router)


@app.get("/metrics", include_in_schema=False)
async def metrics() -> Response:
    payload, content_type = render_metrics()
    return Response(content=payload, media_type=content_type)
