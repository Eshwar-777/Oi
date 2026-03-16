from __future__ import annotations


def is_closed_websocket_runtime_error(exc: RuntimeError) -> bool:
    message = str(exc).strip().lower()
    return (
        "websocket is not connected" in message
        or "need to call \"accept\" first" in message
        or "close message has been sent" in message
    )
