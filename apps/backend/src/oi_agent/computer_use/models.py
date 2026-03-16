from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from oi_agent.automation.models import ClientContext


ComputerUseStatus = Literal["clarification", "scheduled", "running", "ready"]


class ComputerUseExecuteRequest(BaseModel):
    session_id: str
    conversation_id: str | None = None
    prompt: str
    client_context: ClientContext = Field(default_factory=ClientContext)


class ComputerUseExecuteResponse(BaseModel):
    conversation_id: str
    session_id: str
    assistant_text: str
    status: ComputerUseStatus = "ready"
    run_id: str | None = None
    schedule_ids: list[str] = Field(default_factory=list)
    requires_clarification: bool = False
