from oi_agent.automation.ui_surface import interpret_ui_surface


def test_interpret_ui_surface_recognizes_listing_filters_and_results() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "targetId": "page-1",
            "snapshot": "Results page",
            "refs": {
                "e1": {"role": "link", "name": "Maroon Shirt Rs. 999"},
                "e2": {"role": "link", "name": "Blue Shirt Rs. 899"},
                "e3": {"role": "link", "name": "Black Shirt Rs. 799"},
                "e4": {"role": "link", "name": "White Shirt Rs. 699"},
                "e5": {"role": "link", "name": "Grey Shirt Rs. 599"},
                "e6": {"role": "link", "name": "Green Shirt Rs. 499"},
            },
        },
        current_url="https://example.com/shirt?color=maroon&size=M&price=0-1000",
        current_title="Shirt results",
    )

    assert surface.kind == "listing"
    assert surface.selected_filters["color"] == "maroon"
    assert surface.selected_filters["size"] == "M"
    assert len(surface.result_items) >= 6


def test_interpret_ui_surface_recognizes_checkout_surface_from_primary_cta_and_url() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "targetId": "page-2",
            "snapshot": "Checkout shipping payment",
            "refs": {
                "e1": {"role": "button", "name": "Continue to payment"},
                "e2": {"role": "textbox", "name": "Address line 1"},
                "e3": {"role": "textbox", "name": "City"},
            },
        },
        current_url="https://example.com/checkout/shipping",
        current_title="Checkout",
    )

    assert surface.kind == "checkout"
    assert "e1" in surface.primary_action_refs
    assert "Address line 1" in surface.active_form_fields
    assert surface.confidence > 0.5


def test_interpret_ui_surface_recognizes_dialog_and_blockers_structurally() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "targetId": "page-3",
            "snapshot": "Modal dialog asking for permission to continue",
            "refs": {
                "e1": {"role": "button", "name": "Allow"},
                "e2": {"role": "button", "name": "Deny"},
            },
        },
        current_url="https://example.com/app",
        current_title="Permission required",
    )

    assert surface.kind == "dialog"
    assert "permission" in surface.blockers


def test_interpret_ui_surface_recognizes_dialog_from_compact_clickable_surface_without_dialog_marker() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "refs": {
                "e1": {"role": "button", "name": "Allow"},
                "e2": {"role": "button", "name": "Deny"},
                "e3": {"role": "link", "name": "Learn more"},
            },
            "snapshot": "Allow Deny Learn more",
        },
        current_url="https://example.com/app",
        current_title="Permission required",
    )

    assert surface.kind == "dialog"
    assert "permission" in surface.blockers


def test_interpret_ui_surface_recognizes_checkout_from_form_structure_without_checkout_keyword() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "refs": {
                "e1": {"role": "textbox", "name": "Address line 1"},
                "e2": {"role": "textbox", "name": "City"},
                "e3": {"role": "textbox", "name": "Postal code"},
                "e4": {"role": "button", "name": "Continue"},
            },
            "snapshot": "Address line 1 City Postal code Continue",
        },
        current_url="https://example.com/order",
        current_title="Shipping details",
    )

    assert surface.kind == "checkout"


def test_interpret_ui_surface_extracts_refs_from_snapshot_text_when_structured_refs_missing() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "snapshot": '[e1] input "Search for products"\n[e2] link "Maroon Shirt Rs. 999"\n[e3] link "Blue Shirt Rs. 899"\n[e4] link "Grey Shirt Rs. 799"',
        },
        current_url="https://example.com/search?q=shirt",
        current_title="Results",
    )

    assert surface.source_ref_count == 4
    assert surface.actionable_refs[0].intent == "input"
    assert surface.kind == "listing"


def test_interpret_ui_surface_extracts_refs_from_runtime_snapshot_line_format() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "snapshot": '- textbox "Search for products" [ref=e8]\n- link "Maroon Shirt Rs. 999" [ref=e9]\n- link "Blue Shirt Rs. 899" [ref=e10]\n- link "Grey Shirt Rs. 799" [ref=e11]',
        },
        current_url="https://example.com/search?q=shirt",
        current_title="Results",
    )

    assert surface.source_ref_count == 4
    assert surface.actionable_refs[0].ref == "e8"
    assert surface.kind == "listing"


def test_interpret_ui_surface_recognizes_blocked_interstitial_surface() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "targetId": "page-9",
            "snapshot": "developer.mozilla.org is blocked developer.mozilla.org refused to connect. ERR_BLOCKED_BY_RESPONSE",
        },
        current_url="https://1click-google-settings.freebusinessapps.net/welcome#google_vignette",
        current_title="MDN Web Docs",
    )

    assert surface.kind == "blocker"
    assert "blocked" in surface.blockers


def test_interpret_ui_surface_does_not_mark_docs_results_as_auth_from_single_login_link() -> None:
    surface = interpret_ui_surface(
        snapshot={
                "refs": {
                    "e1": {"role": "link", "name": "Log in"},
                    "e2": {"role": "textbox", "name": ""},
                    "e3": {"role": "link", "name": "Fetch API reference"},
                    "e4": {"role": "link", "name": "Using the Fetch API"},
                    "e5": {"role": "button", "name": "Search"},
                },
                "snapshot": 'Log in Fetch API reference Using the Fetch API [ref=e2] textbox ""',
            },
        current_url="https://developer.mozilla.org/en-US/search?q=fetch+api",
        current_title="Search | MDN",
    )

    assert surface.kind == "listing"
    assert surface.search_query == "fetch api"


def test_interpret_ui_surface_does_not_mark_results_as_auth_from_incidental_password_text() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "refs": {
                "e1": {"role": "link", "name": "Log in"},
                "e2": {"role": "textbox", "name": ""},
                "e22": {"role": "link", "name": "Fetch API reference"},
                "e23": {"role": "link", "name": "Using the Fetch API"},
            },
            "snapshot": (
                'Auth0 by Okta Passwordless sign up now [ref=e99] '
                'textbox "" [ref=e2] link "Fetch API reference" [ref=e22] '
                'link "Using the Fetch API" [ref=e23]'
            ),
        },
        current_url="https://developer.mozilla.org/en-US/search?q=fetch+api",
        current_title="Search | MDN",
    )

    assert surface.kind == "listing"
    assert len(surface.result_items) >= 2


def test_interpret_ui_surface_prefers_listing_over_form_when_search_results_are_present() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "refs": {
                "e1": {"role": "textbox", "name": "Search"},
                "e2": {"role": "textbox", "name": "Filter within results"},
                "e3": {"role": "link", "name": "asyncio create_task reference"},
                "e4": {"role": "link", "name": "Coroutines and Tasks guide"},
            },
            "snapshot": 'asyncio create_task reference Coroutines and Tasks guide',
        },
        current_url="https://docs.python.org/3/search.html?q=asyncio+create_task",
        current_title="Search",
    )

    assert surface.kind == "listing"
    assert surface.search_query == "asyncio create_task"


def test_interpret_ui_surface_prefers_form_for_rich_editable_foreground_surface() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "refs": {
                "e1": {"role": "dialog", "name": "Compose"},
                "e2": {"role": "textbox", "name": "To recipients"},
                "e3": {"role": "textbox", "name": "Subject"},
                "e4": {"role": "textbox", "name": "Message body"},
                "e5": {"role": "link", "name": "Formatting options"},
                "e6": {"role": "button", "name": "Send"},
            },
            "snapshot": 'Compose To recipients Subject Message body Formatting options Send',
        },
        current_url="https://example.com/compose",
        current_title="Compose",
    )

    assert surface.kind == "form"
    assert len(surface.active_form_fields) == 3


def test_interpret_ui_surface_recognizes_article_like_detail_surface_without_primary_cta() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "refs": {
                "e1": {"role": "link", "name": "History"},
                "e2": {"role": "link", "name": "Early life"},
                "e3": {"role": "link", "name": "See also"},
            },
            "snapshot": (
                "Alan Turing was an English mathematician and computer scientist. "
                "He was highly influential in the development of theoretical computer science."
            ),
        },
        current_url="https://example.com/wiki/Alan_Turing",
        current_title="Alan Turing",
    )

    assert surface.kind == "detail"


def test_interpret_ui_surface_recognizes_simple_search_homepage_as_form() -> None:
    surface = interpret_ui_surface(
        snapshot={
            "refs": {
                "e1": {"role": "input", "name": "Search Wikipedia"},
                "e2": {"role": "button", "name": "Search"},
            },
            "snapshot": "Search Wikipedia Search",
        },
        current_url="https://www.wikipedia.org/",
        current_title="Wikipedia",
    )

    assert surface.kind == "form"
