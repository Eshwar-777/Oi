from __future__ import annotations

import hashlib
import secrets
from pathlib import Path

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_CONFIG_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _CONFIG_DIR.parents[1]


def _environment_name() -> str:
    import os

    return str(os.environ.get("ENV") or os.environ.get("APP_ENV") or "dev").strip().lower()


def _should_load_dotenv() -> bool:
    return _environment_name() not in {"prod", "production"}


def _load_env_files() -> None:
    if not _should_load_dotenv():
        return
    for file_path in (
        _REPO_ROOT / ".env",
        _REPO_ROOT / ".env.local",
        _CONFIG_DIR / ".env",
        _CONFIG_DIR / ".env.local",
    ):
        if file_path.exists():
            load_dotenv(file_path, override=False)


_load_env_files()


def _fingerprint(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        return "missing"
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    env: str = Field(default="dev", alias="ENV")
    app_name: str = Field(default="oi-agent", alias="APP_NAME")
    app_host: str = Field(default="0.0.0.0", alias="APP_HOST")
    app_port: int = Field(default=8080, alias="APP_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    log_format: str = Field(default="json", alias="LOG_FORMAT")
    log_scope: str = Field(default="normal", alias="LOG_SCOPE")

    gcp_project: str = Field(default="", alias="GOOGLE_CLOUD_PROJECT")
    gcp_location: str = Field(default="us-central1", alias="GOOGLE_CLOUD_LOCATION")
    google_genai_use_vertexai: bool = Field(default=True, alias="GOOGLE_GENAI_USE_VERTEXAI")
    google_api_key: str = Field(default="", alias="GOOGLE_API_KEY")
    google_application_credentials: str = Field(default="", alias="GOOGLE_APPLICATION_CREDENTIALS")

    gemini_model: str = Field(default="gemini-2.5-flash", alias="GEMINI_MODEL")
    gemini_live_model: str = Field(default="gemini-live-2.5-flash-native-audio", alias="GEMINI_LIVE_MODEL")
    gemini_live_model_fallbacks: str = Field(
        default="gemini-live-2.5-flash-native-audio,gemini-live-2.5-flash-preview-native-audio-09-2025,gemini-2.0-flash-live-001",
        alias="GEMINI_LIVE_MODEL_FALLBACKS",
    )
    gemini_live_voice_name: str = Field(default="Aoede", alias="GEMINI_LIVE_VOICE_NAME")
    gemini_computer_use_model: str = Field(default="gemini-2.5-pro", alias="GEMINI_COMPUTER_USE_MODEL")
    gemini_computer_use_model_fallbacks: str = Field(
        default="gemini-2.5-pro,gemini-2.5-flash",
        alias="GEMINI_COMPUTER_USE_MODEL_FALLBACKS",
    )
    adk_app_name: str = Field(default="oi-adk-chatbot", alias="ADK_APP_NAME")

    firebase_project_id: str = Field(default="", alias="FIREBASE_PROJECT_ID")
    firestore_database: str = Field(default="(default)", alias="FIRESTORE_DATABASE")

    pubsub_topic_tasks: str = Field(default="oi-tasks", alias="PUBSUB_TOPIC_TASKS")
    pubsub_subscription_tasks: str = Field(default="oi-tasks-sub", alias="PUBSUB_SUBSCRIPTION_TASKS")
    gcs_bucket_uploads: str = Field(default="oi-uploads", alias="GCS_BUCKET_UPLOADS")

    tts_language_code: str = Field(default="en-US", alias="TTS_LANGUAGE_CODE")
    tts_voice_name: str = Field(default="en-US-Neural2-D", alias="TTS_VOICE_NAME")

    smtp_host: str = Field(default="smtp.gmail.com", alias="SMTP_HOST")
    smtp_port: int = Field(default=587, alias="SMTP_PORT")
    smtp_user: str = Field(default="", alias="SMTP_USER")
    smtp_password: str = Field(default="", alias="SMTP_PASSWORD")
    default_from_email: str = Field(default="", alias="DEFAULT_FROM_EMAIL")

    enable_live_streaming: bool = Field(default=True, alias="ENABLE_LIVE_STREAMING")
    enable_computer_use: bool = Field(default=True, alias="ENABLE_COMPUTER_USE")
    enable_vision_tools: bool = Field(default=True, alias="ENABLE_VISION_TOOLS")
    computer_use_max_steps: int = Field(default=18, alias="COMPUTER_USE_MAX_STEPS")
    computer_use_action_delay_ms: int = Field(default=900, alias="COMPUTER_USE_ACTION_DELAY_MS")
    enrollment_ttl_seconds: int = Field(default=600, alias="ENROLLMENT_TTL_SECONDS")
    nonce_ttl_seconds: int = Field(default=300, alias="NONCE_TTL_SECONDS")

    allowed_origins: str = Field(default="http://localhost:3000,http://localhost:8081", alias="ALLOWED_ORIGINS")
    request_timeout_seconds: int = Field(default=30, alias="REQUEST_TIMEOUT_SECONDS")
    max_tool_calls_per_request: int = Field(default=10, alias="MAX_TOOL_CALLS_PER_REQUEST")
    runner_shared_secret: str = Field(default="", alias="RUNNER_SHARED_SECRET")
    device_presence_stale_seconds: int = Field(default=180, alias="DEVICE_PRESENCE_STALE_SECONDS")
    automation_store_use_firestore_in_dev: bool = Field(default=False, alias="AUTOMATION_STORE_USE_FIRESTORE_IN_DEV")
    automation_scheduler_mode: str = Field(default="embedded", alias="AUTOMATION_SCHEDULER_MODE")
    automation_scheduler_claim_ttl_seconds: int = Field(default=900, alias="AUTOMATION_SCHEDULER_CLAIM_TTL_SECONDS")
    automation_browser_single_step_planning: bool = Field(default=True, alias="AUTOMATION_BROWSER_SINGLE_STEP_PLANNING")
    automation_runtime_enabled: bool = Field(default=True, alias="AUTOMATION_RUNTIME_ENABLED")
    automation_runtime_base_url: str = Field(default="http://127.0.0.1:8787", alias="AUTOMATION_RUNTIME_BASE_URL")
    automation_runtime_shared_secret: str = Field(default="", alias="AUTOMATION_RUNTIME_SHARED_SECRET")
    auth_session_cookie_name: str = Field(default="oi_session", alias="AUTH_SESSION_COOKIE_NAME")
    auth_session_cookie_ttl_seconds: int = Field(default=432000, alias="AUTH_SESSION_COOKIE_TTL_SECONDS")
    auth_csrf_cookie_name: str = Field(default="oi_csrf", alias="AUTH_CSRF_COOKIE_NAME")
    auth_csrf_header_name: str = Field(default="X-CSRF-Token", alias="AUTH_CSRF_HEADER_NAME")
    auth_csrf_secret: str = Field(default="", alias="AUTH_CSRF_SECRET")
    server_browser_enabled: bool = Field(default=True, alias="SERVER_BROWSER_ENABLED")
    server_browser_headless: bool = Field(default=True, alias="SERVER_BROWSER_HEADLESS")
    server_browser_bootstrap_url: str = Field(default="https://example.com", alias="SERVER_BROWSER_BOOTSTRAP_URL")
    server_browser_host: str = Field(default="127.0.0.1", alias="SERVER_BROWSER_HOST")
    server_browser_profile_root: str = Field(default="/tmp/oi-server-browser", alias="SERVER_BROWSER_PROFILE_ROOT")
    server_browser_executable_path: str = Field(default="", alias="SERVER_BROWSER_EXECUTABLE_PATH")

    @property
    def is_production(self) -> bool:
        return self.env.strip().lower() in {"prod", "production"}

    @property
    def planner_auth_mode(self) -> str:
        if self.google_genai_use_vertexai:
            return "vertex"
        if self.google_api_key.strip():
            return "api_key"
        if self.google_application_credentials.strip():
            return "adc"
        return "unconfigured"

    @property
    def runtime_secret_fingerprint(self) -> str:
        return _fingerprint(self.automation_runtime_shared_secret)

    @property
    def runner_secret_fingerprint(self) -> str:
        return _fingerprint(self.runner_shared_secret)

    @property
    def csrf_secret(self) -> str:
        return self.auth_csrf_secret.strip() or secrets.token_hex(32)

    def redacted_summary(self) -> dict[str, object]:
        return {
            "env": self.env,
            "app": {"host": self.app_host, "port": self.app_port},
            "runtime": {
                "enabled": self.automation_runtime_enabled,
                "base_url": self.automation_runtime_base_url,
                "shared_secret": self.runtime_secret_fingerprint,
            },
            "runner": {"shared_secret": self.runner_secret_fingerprint},
            "planner": {
                "auth_mode": self.planner_auth_mode,
                "model": self.gemini_model,
                "vertex": self.google_genai_use_vertexai,
            },
            "firebase": {
                "project": self.firebase_project_id or self.gcp_project,
                "configured": bool(self.firebase_project_id or self.gcp_project),
            },
        }

    def validate_startup(self) -> list[str]:
        missing: list[str] = []
        if self.is_production and not self.allowed_origins.strip():
            missing.append("ALLOWED_ORIGINS")
        if self.automation_runtime_enabled and not self.automation_runtime_base_url.strip():
            missing.append("AUTOMATION_RUNTIME_BASE_URL")
        if self.automation_runtime_enabled and not self.automation_runtime_shared_secret.strip():
            missing.append("AUTOMATION_RUNTIME_SHARED_SECRET")
        if not self.runner_shared_secret.strip():
            missing.append("RUNNER_SHARED_SECRET")
        if not (self.gcp_project.strip() or self.firebase_project_id.strip()):
            missing.append("GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID")
        if self.google_genai_use_vertexai and not (self.gcp_project.strip() and self.gcp_location.strip()):
            missing.append("Vertex AI project/location")
        if not self.google_genai_use_vertexai and not self.google_api_key.strip():
            missing.append("GOOGLE_API_KEY")
        return missing


settings = Settings()
if not settings.auth_csrf_secret.strip():
    settings.auth_csrf_secret = hashlib.sha256(f"{settings.app_name}:{settings.env}".encode()).hexdigest()
