from __future__ import annotations

import pytest

from oi_agent.api.websocket_runtime import is_closed_websocket_runtime_error


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ('WebSocket is not connected. Need to call "accept" first.', True),
        ("Cannot call 'send' once a close message has been sent.", True),
        ("something unrelated", False),
    ],
)
def test_is_closed_websocket_runtime_error(message: str, expected: bool) -> None:
    assert is_closed_websocket_runtime_error(RuntimeError(message)) is expected
