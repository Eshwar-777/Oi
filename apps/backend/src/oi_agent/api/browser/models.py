from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class BrowserActionRequest(BaseModel):
    action: str = Field(..., min_length=1)
    target: Any = ""
    value: str = ""
    device_id: str | None = None
    tab_id: int | None = None
    run_id: str | None = None
    timeout_seconds: float | None = None


class BrowserNavigateRequest(BaseModel):
    url: str = Field(..., min_length=1)
    device_id: str | None = None
    tab_id: int | None = None
    run_id: str | None = None


class BrowserSnapshotRequest(BaseModel):
    device_id: str | None = None
    tab_id: int | None = None
    run_id: str | None = None


class BrowserAgentPromptRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    device_id: str | None = None
    tab_id: int | None = None
    run_id: str | None = None


class BrowserAgentResumeRequest(BaseModel):
    resume_token: str = Field(..., min_length=1)
