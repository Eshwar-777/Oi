import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from oi_agent.api.browser import browser_router
from oi_agent.api.middleware import CorrelationIdMiddleware, RequestLoggingMiddleware
from oi_agent.api.routes import router
from oi_agent.api.websocket import ws_router
from oi_agent.config import settings
from oi_agent.devices import device_router
from oi_agent.observability.telemetry import configure_logging

configure_logging(settings.log_level, settings.log_format, settings.log_scope)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("OI backend started")
    yield
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
app.include_router(browser_router)
app.include_router(ws_router)
app.include_router(device_router)
