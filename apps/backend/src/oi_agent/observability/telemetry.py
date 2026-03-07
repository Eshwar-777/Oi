import json
import logging
from datetime import UTC, datetime

import structlog

_BASE_LOG_RECORD_FIELDS = {
    "name",
    "msg",
    "args",
    "levelname",
    "levelno",
    "pathname",
    "filename",
    "module",
    "exc_info",
    "exc_text",
    "stack_info",
    "lineno",
    "funcName",
    "created",
    "msecs",
    "relativeCreated",
    "thread",
    "threadName",
    "processName",
    "process",
    "message",
}


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        for key, value in record.__dict__.items():
            if key in _BASE_LOG_RECORD_FIELDS or key.startswith("_"):
                continue
            payload[key] = value

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, ensure_ascii=False, default=str)


class PrettyLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, tz=UTC).strftime("%Y-%m-%d %H:%M:%S")
        base = f"{ts} {record.levelname:<5} {record.name}: {record.getMessage()}"
        extras: list[str] = []
        for key, value in record.__dict__.items():
            if key in _BASE_LOG_RECORD_FIELDS or key.startswith("_"):
                continue
            if isinstance(value, (dict, list, tuple)):
                rendered = json.dumps(value, ensure_ascii=False, default=str)
            else:
                rendered = str(value)
            extras.append(f"{key}={rendered}")
        if record.exc_info:
            extras.append(f"exception={self.formatException(record.exc_info)}")
        return f"{base} {' '.join(extras)}".rstrip()


def configure_logging(level: str, fmt: str = "json", scope: str = "normal") -> None:
    handler = logging.StreamHandler()
    if str(fmt).strip().lower() == "pretty":
        handler.setFormatter(PrettyLogFormatter())
    else:
        handler.setFormatter(JsonLogFormatter())

    normalized_scope = str(scope).strip().lower()
    base_level = level
    if normalized_scope == "data":
        base_level = "WARNING"

    logging.basicConfig(level=base_level, handlers=[handler], force=True)

    # Suppress noisy third-party logs by default.
    for noisy in (
        "httpx",
        "httpcore",
        "google_genai",
        "google",
        "uvicorn.access",
    ):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # Data-only mode: keep only data-bearing app logs visible.
    if normalized_scope == "data":
        logging.getLogger("oi_agent.api.websocket_frames").setLevel(logging.INFO)
        logging.getLogger("oi_agent.api.browser.agent_routes").setLevel(logging.INFO)
        logging.getLogger("oi_agent.api.middleware").setLevel(logging.WARNING)
        logging.getLogger("uvicorn.error").setLevel(logging.WARNING)

    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(base_level)),
    )
