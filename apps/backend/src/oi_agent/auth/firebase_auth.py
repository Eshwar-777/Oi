from __future__ import annotations

import logging
from typing import Any, cast

from fastapi import Depends, HTTPException, Request

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
    return None


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


async def verify_firebase_token(request: Request) -> dict[str, Any]:
    """FastAPI dependency that verifies a Firebase ID token."""
    token = _extract_bearer_token(request)
    return await verify_firebase_id_token(token)


async def get_current_user(
    claims: dict[str, Any] = Depends(verify_firebase_token),
) -> dict[str, Any]:
    """Convenience dependency that returns the verified user claims."""
    return claims
