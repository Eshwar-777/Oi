import pytest

from oi_agent.automation.sensitive_actions.detector import detect_sensitive_page


class _FakePage:
    def __init__(self, payload):
        self._payload = payload

    async def evaluate(self, script: str):
        _ = script
        return self._payload


@pytest.mark.asyncio
async def test_detect_sensitive_page_ignores_generic_remove_word_without_context() -> None:
    gate = await detect_sensitive_page(
        _FakePage(
            {
                "url": "https://web.whatsapp.com/",
                "login": False,
                "mfa": False,
                "captcha": False,
                "payment": False,
                "destructive": False,
                "destructiveSignals": ["remove chat from favourites"],
                "permission": False,
            }
        )
    )

    assert gate is None


@pytest.mark.asyncio
async def test_detect_sensitive_page_flags_destructive_flow_with_visible_control_and_context() -> None:
    gate = await detect_sensitive_page(
        _FakePage(
            {
                "url": "https://example.com/settings",
                "login": False,
                "mfa": False,
                "captcha": False,
                "payment": False,
                "destructive": True,
                "destructiveSignals": ["delete account"],
                "permission": False,
            }
        )
    )

    assert gate is not None
    assert gate["reason_code"] == "DESTRUCTIVE_ACTION"
