from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: str
    content: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    attachments: list[dict[str, Any]] = Field(default_factory=list)


class Conversation(BaseModel):
    session_id: str
    user_id: str
    messages: list[ChatMessage] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class TaskDocument(BaseModel):
    task_id: str
    mesh_group_id: str
    created_by_user_id: str
    created_by_device_id: str
    status: str = "planning"
    plan_description: str = ""
    steps: list[dict[str, Any]] = Field(default_factory=list)
    scheduled_at: str | None = None
    current_step_index: int = 0
    blocked_reason: str | None = None
    blocked_screenshot_url: str | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class TaskEvent(BaseModel):
    event_type: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    device_id: str | None = None
    user_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
