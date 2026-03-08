from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


SessionOrigin = Literal["local_runner", "server_runner"]
SessionStatus = Literal["idle", "starting", "ready", "busy", "stopped", "error"]
ControllerActorType = Literal["web", "mobile", "desktop", "system"]


class BrowserViewport(BaseModel):
    width: int
    height: int
    dpr: float = 1.0


class BrowserPageRecord(BaseModel):
    page_id: str
    url: str = ""
    title: str = ""
    is_active: bool = False


class ControllerLockRecord(BaseModel):
    actor_id: str
    actor_type: ControllerActorType
    acquired_at: str
    expires_at: str
    priority: int = 0


class BrowserSessionRecord(BaseModel):
    session_id: str
    user_id: str
    origin: SessionOrigin
    provider: str = "agent_browser"
    status: SessionStatus = "starting"
    browser_session_id: str | None = None
    browser_version: str | None = None
    runner_id: str | None = None
    runner_label: str | None = None
    page_id: str | None = None
    pages: list[BrowserPageRecord] = Field(default_factory=list)
    viewport: BrowserViewport | None = None
    controller_lock: ControllerLockRecord | None = None
    metadata: dict[str, str] = Field(default_factory=dict)
    created_at: str
    updated_at: str


class CreateBrowserSessionRequest(BaseModel):
    origin: SessionOrigin
    browser_session_id: str | None = None
    runner_id: str | None = None
    runner_label: str | None = None
    page_id: str | None = None
    browser_version: str | None = None
    viewport: BrowserViewport | None = None
    metadata: dict[str, str] = Field(default_factory=dict)


class UpdateBrowserSessionRequest(BaseModel):
    status: SessionStatus | None = None
    browser_session_id: str | None = None
    browser_version: str | None = None
    page_id: str | None = None
    pages: list[BrowserPageRecord] | None = None
    viewport: BrowserViewport | None = None
    controller_lock: ControllerLockRecord | None = None
    metadata: dict[str, str] | None = None


class BrowserSessionResponse(BaseModel):
    session: BrowserSessionRecord


class BrowserSessionListResponse(BaseModel):
    items: list[BrowserSessionRecord] = Field(default_factory=list)


class RunnerRegisterRequest(BaseModel):
    user_id: str
    origin: SessionOrigin = "local_runner"
    runner_id: str
    runner_label: str | None = None
    browser_session_id: str | None = None
    browser_version: str | None = None
    page_id: str | None = None
    viewport: BrowserViewport | None = None
    metadata: dict[str, str] = Field(default_factory=dict)


class RunnerHeartbeatRequest(BaseModel):
    runner_id: str
    session_id: str
    status: SessionStatus = "ready"
    browser_session_id: str | None = None
    browser_version: str | None = None
    page_id: str | None = None
    pages: list[BrowserPageRecord] | None = None
    viewport: BrowserViewport | None = None
    metadata: dict[str, str] | None = None


class AcquireSessionControlRequest(BaseModel):
    actor_id: str
    actor_type: ControllerActorType = "web"
    priority: int = 100
    ttl_seconds: int = Field(default=300, ge=30, le=3600)


class ReleaseSessionControlRequest(BaseModel):
    actor_id: str


class SessionInputRequest(BaseModel):
    actor_id: str
    input_type: Literal["click", "type", "scroll", "keypress", "move", "mouse_down", "mouse_up"]
    x: int | None = None
    y: int | None = None
    text: str | None = None
    delta_x: int | None = None
    delta_y: int | None = None
    key: str | None = None
    button: Literal["left", "middle", "right"] | None = None


class SessionControlAuditRecord(BaseModel):
    audit_id: str
    session_id: str
    actor_id: str
    actor_type: ControllerActorType
    action: Literal["acquire", "release", "navigate", "refresh_stream", "input"]
    input_type: str | None = None
    target_url: str | None = None
    outcome: Literal["accepted", "rejected"] = "accepted"
    detail: str | None = None
    created_at: str


class SessionControlAuditListResponse(BaseModel):
    items: list[SessionControlAuditRecord] = Field(default_factory=list)
