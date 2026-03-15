from oi_agent.automation.models import ExecutionStep, UISurfaceState, VerificationRule
from oi_agent.automation.ui_verifier import reconcile_execution_steps, verify_execution_step


def _surface(**kwargs) -> UISurfaceState:
    payload = {"captured_at": "2026-03-14T00:00:00Z", "kind": "unknown"}
    payload.update(kwargs)
    return UISurfaceState(**payload)


def test_verify_execution_step_matches_selected_filter_and_result_change() -> None:
    step = ExecutionStep(
        step_id="phase_2",
        kind="filter",
        label='Apply color filter "maroon"',
        verification_rules=[
            VerificationRule(kind="selected_filter", key="color", value="maroon"),
            VerificationRule(kind="result_count_changed"),
        ],
    )
    before = _surface(kind="listing", selected_filters={}, result_items=[{"ref": "e1", "name": "A"}])
    after = _surface(
        kind="listing",
        selected_filters={"color": "maroon"},
        result_items=[{"ref": "e1", "name": "A"}, {"ref": "e2", "name": "B"}],
    )

    verified, change = verify_execution_step(step=step, before=before, after=after)

    assert verified is True
    assert "filter color=maroon is selected" in str(change)


def test_reconcile_execution_steps_marks_first_unverified_step_active() -> None:
    steps = [
        ExecutionStep(
            step_id="phase_1",
            kind="search",
            label='Search for "shirt"',
            verification_rules=[VerificationRule(kind="search_query", value="shirt")],
        ),
        ExecutionStep(
            step_id="phase_2",
            kind="select_result",
            label="Select the first result",
            verification_rules=[VerificationRule(kind="surface_kind", expected_surface="detail")],
        ),
    ]
    after = _surface(kind="listing", search_query="shirt")

    active_index, reconciled = reconcile_execution_steps(steps=steps, ui_surface=after)

    assert active_index == 1
    assert reconciled[0].status == "completed"
    assert reconciled[1].status == "active"


def test_verify_execution_step_matches_search_query_when_ui_uses_raw_query_subset() -> None:
    step = ExecutionStep(
        step_id="phase_1",
        kind="search",
        label='Search for "maroon shirt"',
        verification_rules=[VerificationRule(kind="search_query", value="maroon shirt")],
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="unknown"),
        after=_surface(kind="listing", search_query="shirt"),
    )

    assert verified is True
    assert "search query is maroon shirt" in str(change)


def test_verify_execution_step_accepts_search_when_matching_results_surface_is_already_visible() -> None:
    step = ExecutionStep(
        step_id="phase_1",
        kind="search",
        label='Search for "fetch api"',
        verification_rules=[
            VerificationRule(kind="search_query", value="fetch api"),
            VerificationRule(kind="result_count_changed"),
        ],
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="listing", search_query=""),
        after=_surface(
            kind="listing",
            search_query="fetch api",
            result_items=[{"ref": "e22", "name": "Fetch API reference"}],
        ),
    )

    assert verified is True
    assert "search query is fetch api" in str(change)


def test_verify_execution_step_matches_price_filter_after_range_normalization() -> None:
    step = ExecutionStep(
        step_id="phase_3",
        kind="filter",
        label="Apply price filter under 1000",
        verification_rules=[VerificationRule(kind="selected_filter", key="price", value="under 1000")],
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="listing"),
        after=_surface(kind="listing", selected_filters={"price": "0-1000"}),
    )

    assert verified is True
    assert "filter price=under 1000 is selected" in str(change)


def test_verify_execution_step_requires_navigate_target_host_match() -> None:
    step = ExecutionStep(
        step_id="phase_nav",
        kind="navigate",
        label="Go to MDN",
        target_constraints={"target_host": "developer.mozilla.org"},
        verification_rules=[VerificationRule(kind="url_contains", value="developer.mozilla.org")],
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="unknown"),
        after=_surface(kind="listing", url="https://developer.mozilla.org/en-US/docs/Web"),
    )

    assert verified is True
    assert "navigated to developer.mozilla.org" in str(change)


def test_verify_execution_step_rejects_navigate_when_foreground_host_is_wrong() -> None:
    step = ExecutionStep(
        step_id="phase_nav",
        kind="navigate",
        label="Go to MDN",
        target_constraints={"target_host": "developer.mozilla.org"},
        verification_rules=[VerificationRule(kind="url_contains", value="developer.mozilla.org")],
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="unknown"),
        after=_surface(
            kind="unknown",
            url="https://1click-google-settings.freebusinessapps.net/welcome#google_vignette",
            title="MDN Web Docs",
        ),
    )

    assert verified is False
    assert change is None


def test_verify_execution_step_rejects_navigate_when_foreground_is_blocker_surface() -> None:
    step = ExecutionStep(
        step_id="phase_nav",
        kind="navigate",
        label="Go to MDN",
        target_constraints={"target_host": "developer.mozilla.org"},
        verification_rules=[VerificationRule(kind="url_contains", value="developer.mozilla.org")],
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="unknown"),
        after=_surface(
            kind="blocker",
            url="https://1click-google-settings.freebusinessapps.net/welcome#google_vignette",
            blockers=["blocked"],
        ),
    )

    assert verified is False
    assert change is None


def test_verify_execution_step_accepts_navigate_on_target_host_even_when_surface_is_search_results() -> None:
    step = ExecutionStep(
        step_id="phase_nav",
        kind="navigate",
        label="Go to MDN",
        target_constraints={"target_host": "developer.mozilla.org"},
        verification_rules=[
            VerificationRule(kind="url_contains", value="developer.mozilla.org"),
            VerificationRule(kind="surface_kind", expected_surface="listing"),
        ],
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="unknown"),
        after=_surface(
            kind="listing",
            url="https://developer.mozilla.org/en-US/search?q=fetch+api",
            search_query="fetch api",
            result_items=[{"ref": "e22", "name": "Fetch API"}],
        ),
    )

    assert verified is True
    assert "navigated to developer.mozilla.org" in str(change)


def test_verify_execution_step_requires_navigate_identity_match_for_app_targets() -> None:
    step = ExecutionStep(
        step_id="phase_nav",
        kind="navigate",
        label="Go to Gmail",
        target_constraints={"target_identity_terms": ["gmail"]},
        verification_rules=[VerificationRule(kind="surface_kind", expected_surface="listing")],
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="unknown"),
        after=_surface(kind="listing", url="https://developer.mozilla.org/en-US/", title="MDN Web Docs"),
    )

    assert verified is False
    assert change is None


def test_verify_execution_step_accepts_navigate_identity_match_on_foreground_page() -> None:
    step = ExecutionStep(
        step_id="phase_nav",
        kind="navigate",
        label="Go to Gmail",
        target_constraints={"target_identity_terms": ["gmail"]},
        verification_rules=[VerificationRule(kind="surface_kind", expected_surface="listing")],
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="unknown"),
        after=_surface(kind="listing", url="https://mail.google.com/mail/u/0/#inbox", title="Gmail"),
    )

    assert verified is True
    assert "navigated to gmail" in str(change).lower()


def test_verify_execution_step_accepts_select_result_when_url_changes() -> None:
    step = ExecutionStep(
        step_id="phase_select",
        kind="select_result",
        label="Open the first result",
    )

    verified, change = verify_execution_step(
        step=step,
        before=_surface(kind="listing", url="https://developer.mozilla.org/en-US/search?q=fetch+api"),
        after=_surface(kind="unknown", url="https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API"),
    )

    assert verified is True
    assert "url changed" in str(change)
