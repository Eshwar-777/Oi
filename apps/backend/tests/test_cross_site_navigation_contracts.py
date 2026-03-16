from __future__ import annotations

import pytest

from oi_agent.services.tools import step_planner as step_planner_module


@pytest.mark.asyncio
async def test_docs_search_listing_uses_deterministic_result_selection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**_: object) -> dict[str, object]:
        return {
            "status": "BLOCKED",
            "summary": "Planner could not ground a result selection.",
            "steps": [],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Open the first API reference result",
            "current_execution_step": {
                "step_id": "phase_docs_select",
                "kind": "select_result",
                "target_constraints": {"result_index": 0, "match_terms": ["api", "reference"]},
            },
            "ui_surface": {
                "kind": "listing",
                "result_items": [
                    {"ref": "e2", "name": "API Reference - Auth"},
                    {"ref": "e3", "name": "Guides - Quickstart"},
                ],
            },
        },
        current_url="https://docs.example.com/search?q=auth",
        current_page_title="Search results",
        page_snapshot={
            "refs": {
                "e2": {"role": "link", "name": "API Reference - Auth"},
                "e3": {"role": "link", "name": "Guides - Quickstart"},
            },
            "snapshot": '[ref=e2] link "API Reference - Auth"\n[ref=e3] link "Guides - Quickstart"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "click"
    assert getattr(result.step.target, "ref", None) == "e2"


@pytest.mark.asyncio
async def test_travel_filters_use_deterministic_filter_selection() -> None:
    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Filter flights to nonstop",
            "current_execution_step": {
                "step_id": "phase_travel_filter",
                "kind": "filter",
                "target_constraints": {"filters": {"stops": "Nonstop"}},
            },
            "ui_surface": {
                "kind": "listing",
                "selected_filters": {},
            },
        },
        current_url="https://travel.example.com/flights",
        current_page_title="Flights",
        page_snapshot={
            "refs": {
                "e5": {"role": "checkbox", "name": "Nonstop"},
                "e6": {"role": "checkbox", "name": "1 stop"},
            },
            "snapshot": '[ref=e5] checkbox "Nonstop"\n[ref=e6] checkbox "1 stop"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "click"
    assert getattr(result.step.target, "ref", None) == "e5"


@pytest.mark.asyncio
async def test_crm_form_entry_uses_deterministic_fill_field() -> None:
    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Enter the contact email",
            "current_execution_step": {
                "step_id": "phase_crm_fill",
                "kind": "fill_field",
                "target_constraints": {
                    "value": "alex@example.com",
                    "field_hint": "contact email",
                },
            },
            "ui_surface": {
                "kind": "form",
            },
        },
        current_url="https://crm.example.com/contacts/new",
        current_page_title="New contact",
        page_snapshot={
            "refs": {
                "e8": {"role": "textbox", "name": "Contact email"},
                "e9": {"role": "textbox", "name": "Company"},
            },
            "snapshot": '[ref=e8] textbox "Contact email"\n[ref=e9] textbox "Company"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "type"
    assert getattr(result.step.target, "ref", None) == "e8"
    assert result.step.value == "alex@example.com"


@pytest.mark.asyncio
async def test_admin_dialog_uses_deterministic_advance() -> None:
    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Confirm the role change",
            "current_execution_step": {
                "step_id": "phase_admin_confirm",
                "kind": "advance",
                "verification_rules": [{"kind": "surface_kind", "expected_surface": "confirmation"}],
            },
            "ui_surface": {
                "kind": "dialog",
                "primary_action_refs": ["e12"],
            },
        },
        current_url="https://admin.example.com/users/42",
        current_page_title="Confirm role change",
        page_snapshot={
            "refs": {
                "e12": {"role": "button", "name": "Confirm"},
                "e13": {"role": "button", "name": "Cancel"},
            },
            "snapshot": '[ref=e12] button "Confirm"\n[ref=e13] button "Cancel"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "click"
    assert getattr(result.step.target, "ref", None) == "e12"
