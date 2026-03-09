from oi_agent.services.tools.navigator.context_builder import (
    build_navigator_prompt_bundle,
    build_navigator_system_prompt,
    retrieve_instruction_context,
)


def test_system_prompt_lists_instruction_sources_in_full_mode() -> None:
    prompt = build_navigator_system_prompt(task="agent_browser_step_planner", prompt_mode="full")
    assert "You are a browser automation component for Oye." in prompt
    assert "<available_instruction_sources>" in prompt


def test_system_prompt_omits_source_catalog_in_minimal_mode() -> None:
    prompt = build_navigator_system_prompt(task="browser_prompt_rewriter", prompt_mode="minimal")
    assert "<available_instruction_sources>" not in prompt


def test_retrieved_instruction_context_is_bounded() -> None:
    text, items = retrieve_instruction_context(
        user_prompt="send a message on whatsapp and recover login or consent blockers if needed",
        current_url="https://web.whatsapp.com",
        max_chars=1200,
        per_source_char_limit=500,
        max_items=2,
    )
    assert items
    assert len(items) <= 2
    assert len(text) <= 1400


def test_prompt_bundle_separates_runtime_and_retrieved_debug_metadata() -> None:
    bundle = build_navigator_prompt_bundle(
        task="agent_browser_step_planner",
        user_prompt="search for the Oi repository on GitHub",
        current_url="https://github.com",
        current_page_title="GitHub",
        runtime_metadata={"task": "step_planning", "has_snapshot": True},
        sections=[("Snapshot Context", "Snapshot refs: @e1 @e2")],
    )
    assert "## Runtime Metadata" in bundle.task_prompt
    assert "## Snapshot Context" in bundle.task_prompt
    assert bundle.debug["runtime_metadata"]["has_snapshot"] is True
    assert "retrieved_sources" in bundle.debug
