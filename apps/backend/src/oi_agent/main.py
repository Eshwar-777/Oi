import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from oi_agent.api.automation_routes import automation_router
from oi_agent.api.auth_routes import auth_router
from oi_agent.api.browser import browser_router
from oi_agent.api.browser.schedule_runner import start_scheduler, stop_scheduler
from oi_agent.api.middleware import CorrelationIdMiddleware, RequestLoggingMiddleware
from oi_agent.api.routes import router
from oi_agent.api.websocket import ws_router
from oi_agent.automation.event_routes import event_router
from oi_agent.config import settings
from oi_agent.devices import device_router
from oi_agent.observability.telemetry import configure_logging

configure_logging(settings.log_level, settings.log_format, settings.log_scope)
logger = logging.getLogger(__name__)


def _validate_runtime_configuration() -> None:
    if settings.env == "dev":
        return

    missing: list[str] = []
    if not settings.allowed_origins.strip():
        missing.append("ALLOWED_ORIGINS")
    if not (settings.gcp_project or settings.firebase_project_id):
        missing.append("GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID")

    if missing:
        raise RuntimeError(
            "Missing required non-dev configuration: " + ", ".join(missing)
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    _validate_runtime_configuration()
    logger.info(
        "OI backend started",
        extra={
            "runtime_marker": "backend-intent-debug-v2",
            "gemini_model": settings.gemini_model,
            "gemini_live_model": settings.gemini_live_model,
            "gcp_location": settings.gcp_location,
            "use_vertexai": settings.google_genai_use_vertexai,
        },
    )
    scheduler_embedded = settings.automation_scheduler_mode.strip().lower() == "embedded"
    if scheduler_embedded:
        start_scheduler()
    yield
    if scheduler_embedded:
        await stop_scheduler()
    logger.info("OI backend shutting down")


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins.split(","),
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
