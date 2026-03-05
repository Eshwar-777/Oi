from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from dotenv import load_dotenv

load_dotenv(".env", override=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # App
    env: str = Field(default="dev", alias="ENV")
    app_name: str = Field(default="oi-agent", alias="APP_NAME")
    app_host: str = Field(default="0.0.0.0", alias="APP_HOST")
    app_port: int = Field(default=8080, alias="APP_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    log_format: str = Field(default="json", alias="LOG_FORMAT")
    log_scope: str = Field(default="normal", alias="LOG_SCOPE")

    # Google Cloud
    gcp_project: str = Field(default="", alias="GOOGLE_CLOUD_PROJECT")
    gcp_location: str = Field(default="us-central1", alias="GOOGLE_CLOUD_LOCATION")
    google_genai_use_vertexai: bool = Field(default=True, alias="GOOGLE_GENAI_USE_VERTEXAI")
    google_application_credentials: str = Field(
        default="", alias="GOOGLE_APPLICATION_CREDENTIALS"
    )

    # Gemini / ADK
    gemini_model: str = Field(default="gemini-2.5-flash", alias="GEMINI_MODEL")
    gemini_live_model: str = Field(
        default="gemini-2.0-flash-live-001", alias="GEMINI_LIVE_MODEL"
    )
    adk_app_name: str = Field(default="oi-adk-chatbot", alias="ADK_APP_NAME")

    # Firebase
    firebase_project_id: str = Field(default="", alias="FIREBASE_PROJECT_ID")
    firestore_database: str = Field(default="(default)", alias="FIRESTORE_DATABASE")

    # Pub/Sub
    pubsub_topic_tasks: str = Field(default="oi-tasks", alias="PUBSUB_TOPIC_TASKS")
    pubsub_subscription_tasks: str = Field(
        default="oi-tasks-sub", alias="PUBSUB_SUBSCRIPTION_TASKS"
    )

    # Cloud Storage
    gcs_bucket_uploads: str = Field(default="oi-uploads", alias="GCS_BUCKET_UPLOADS")

    # Voice
    tts_language_code: str = Field(default="en-US", alias="TTS_LANGUAGE_CODE")
    tts_voice_name: str = Field(default="en-US-Neural2-D", alias="TTS_VOICE_NAME")

    # Email (Gmail SMTP for notifications)
    smtp_host: str = Field(default="smtp.gmail.com", alias="SMTP_HOST")
    smtp_port: int = Field(default=587, alias="SMTP_PORT")
    smtp_user: str = Field(default="", alias="SMTP_USER")
    smtp_password: str = Field(default="", alias="SMTP_PASSWORD")
    default_from_email: str = Field(default="", alias="DEFAULT_FROM_EMAIL")

    # Feature Flags
    enable_live_streaming: bool = Field(default=True, alias="ENABLE_LIVE_STREAMING")
    enable_computer_use: bool = Field(default=False, alias="ENABLE_COMPUTER_USE")
    enable_vision_tools: bool = Field(default=True, alias="ENABLE_VISION_TOOLS")
    enable_browser_automation: bool = Field(default=False, alias="ENABLE_BROWSER_AUTOMATION")

    # Device enrollment
    enrollment_ttl_seconds: int = Field(default=600, alias="ENROLLMENT_TTL_SECONDS")
    nonce_ttl_seconds: int = Field(default=300, alias="NONCE_TTL_SECONDS")

    # Security
    allowed_origins: str = Field(
        default="http://localhost:3000,http://localhost:8081", alias="ALLOWED_ORIGINS"
    )
    request_timeout_seconds: int = Field(default=30, alias="REQUEST_TIMEOUT_SECONDS")
    max_tool_calls_per_request: int = Field(default=10, alias="MAX_TOOL_CALLS_PER_REQUEST")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
