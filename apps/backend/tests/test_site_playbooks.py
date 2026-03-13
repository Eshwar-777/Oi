from oi_agent.services.tools.navigator.site_playbooks import (
    build_playbook_context,
    select_playbooks,
)


def test_select_playbooks_picks_search_entity_and_messaging_guidance() -> None:
    matches = select_playbooks(
        "Find tortoise and send the following message on whatsapp",
        "https://web.whatsapp.com/",
    )

    ids = {playbook.playbook_id for playbook in matches}
    assert "search-results" in ids
    assert "entity-selection-and-activation" in ids
    assert "editor-draft-and-commit" in ids


def test_build_playbook_context_includes_multiple_relevant_playbooks() -> None:
    context = build_playbook_context(
        "Update the note for lead Alice in hubspot and save it",
        "https://app.hubspot.com/",
    )

    assert "[entity-selection-and-activation] Entity Selection And Activation" in context
    assert "[detail-open-edit-commit] Detail Open Edit Commit" in context
