from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any, cast

from fastapi import Depends, HTTPException, Request

from oi_agent.auth.csrf import enforce_csrf

logger = logging.getLogger(__name__)

_firebase_app: Any = None


def _get_firebase_app() -> Any:
    """Lazy-init the Firebase Admin SDK."""
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app

    try:
        import firebase_admin
        from firebase_admin import credentials

        _firebase_app = firebase_admin.initialize_app(
            credentials.ApplicationDefault()
        )
    except Exception as exc:
        logger.warning("Firebase Admin SDK not available: %s", exc)
        _firebase_app = None

    return _firebase_app


def _extract_bearer_token(request: Request) -> str | None:
    """Pull the Bearer token from the Authorization header."""
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:]
    token = request.query_params.get("access_token", "").strip()
    return token or None


def _extract_session_cookie(request: Request) -> str | None:
    from oi_agent.config import settings

    cookie = request.cookies.get(settings.auth_session_cookie_name, "").strip()
    return cookie or None


async def verify_firebase_id_token(token: str | None) -> dict[str, Any]:
    """Verify a Firebase ID token and return decoded claims."""
    from oi_agent.config import settings

    if settings.env == "dev" and not token:
        return {"uid": "dev-user", "email": "dev@localhost"}

    if not token:
        raise HTTPException(status_code=401, detail="Missing authorization token")

    app = _get_firebase_app()
    if app is None:
        if settings.env == "dev":
            return {"uid": "dev-user", "email": "dev@localhost"}
        raise HTTPException(status_code=500, detail="Firebase not configured")

    try:
        from firebase_admin import auth as firebase_auth

        decoded = firebase_auth.verify_id_token(token)
        return cast(dict[str, Any], decoded)
    except Exception as exc:
        logger.warning("Firebase token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Unauthorized") from exc


async def verify_firebase_session_cookie(session_cookie: str | None) -> dict[str, Any]:
    from oi_agent.config import settings

    if settings.env == "dev" and not session_cookie:
        return {"uid": "dev-user", "email": "dev@localhost"}

    if not session_cookie:
        raise HTTPException(status_code=401, detail="Missing session cookie")

    app = _get_firebase_app()
    if app is None:
        if settings.env == "dev":
            return {"uid": "dev-user", "email": "dev@localhost"}
        raise HTTPException(status_code=500, detail="Firebase not configured")

    try:
        from firebase_admin import auth as firebase_auth

        decoded = firebase_auth.verify_session_cookie(session_cookie, check_revoked=False)
        return cast(dict[str, Any], decoded)
    except Exception as exc:
        logger.warning("Firebase session cookie verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Unauthorized") from exc


async def verify_firebase_token(request: Request) -> dict[str, Any]:
    """FastAPI dependency that verifies a Firebase session cookie or ID token."""
    token = _extract_bearer_token(request)
    if token:
        return await verify_firebase_id_token(token)
    session_cookie = _extract_session_cookie(request)
    if session_cookie:
        enforce_csrf(request)
        try:
            return await verify_firebase_session_cookie(session_cookie)
        except HTTPException:
            pass
    return await verify_firebase_id_token(token)


async def get_current_user(
    claims: dict[str, Any] = Depends(verify_firebase_token),
) -> dict[str, Any]:
    """Convenience dependency that returns the verified user claims."""
    return claims


def create_custom_token(uid: str) -> str:
    """Create a Firebase custom token for QR/mobile handoff flows."""
    app = _get_firebase_app()
    if app is None:
        raise HTTPException(status_code=500, detail="Firebase not configured")

    try:
        from firebase_admin import auth as firebase_auth

        token = firebase_auth.create_custom_token(uid)
        return token.decode("utf-8") if isinstance(token, bytes) else str(token)
    except Exception as exc:
        logger.warning("Firebase custom token creation failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to create custom token") from exc


def create_session_cookie(id_token: str) -> str:
    from oi_agent.config import settings

    app = _get_firebase_app()
    if app is None:
        raise HTTPException(status_code=500, detail="Firebase not configured")

    try:
        from firebase_admin import auth as firebase_auth

        expires_in = timedelta(seconds=settings.auth_session_cookie_ttl_seconds)
        cookie = firebase_auth.create_session_cookie(id_token, expires_in=expires_in)
        return str(cookie)
    except Exception as exc:
        logger.warning("Firebase session cookie creation failed: %s", exc)
        raise HTTPException(status_code=401, detail="Failed to create session cookie") from exc
