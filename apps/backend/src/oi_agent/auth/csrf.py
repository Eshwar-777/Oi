from __future__ import annotations

import hashlib
import hmac
import secrets

from fastapi import HTTPException, Request, Response

from oi_agent.config import settings


def _csrf_header_value(request: Request) -> str:
    return request.headers.get(settings.auth_csrf_header_name, "").strip()


def _csrf_cookie_value(request: Request) -> str:
    return request.cookies.get(settings.auth_csrf_cookie_name, "").strip()


def generate_csrf_token() -> str:
    nonce = secrets.token_hex(16)
    signature = hmac.new(
        settings.auth_csrf_secret.encode("utf-8"),
        nonce.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{nonce}.{signature}"


def issue_csrf_cookie(response: Response) -> str:
    token = generate_csrf_token()
    response.set_cookie(
        key=settings.auth_csrf_cookie_name,
        value=token,
        httponly=False,
        secure=settings.is_production,
        samesite="lax",
        max_age=settings.auth_session_cookie_ttl_seconds,
        path="/",
    )
    return token


def clear_csrf_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.auth_csrf_cookie_name,
        path="/",
        samesite="lax",
    )


def validate_csrf_token(token: str) -> bool:
    if "." not in token:
        return False
    nonce, signature = token.split(".", 1)
    if not nonce or not signature:
        return False
    expected = hmac.new(
        settings.auth_csrf_secret.encode("utf-8"),
        nonce.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def enforce_csrf(request: Request) -> None:
    if request.method.upper() in {"GET", "HEAD", "OPTIONS"}:
        return

    header_token = _csrf_header_value(request)
    cookie_token = _csrf_cookie_value(request)
    if not header_token or not cookie_token:
        raise HTTPException(status_code=403, detail="Missing CSRF token")
    if header_token != cookie_token:
        raise HTTPException(status_code=403, detail="Invalid CSRF token")
    if not validate_csrf_token(header_token):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")
