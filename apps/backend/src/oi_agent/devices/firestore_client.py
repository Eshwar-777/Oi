"""Shared async Firestore client for the device management module."""

from __future__ import annotations

from typing import Any

from oi_agent.config import settings


def get_firestore() -> Any:
    from google.cloud import firestore

    return firestore.AsyncClient(
        project=settings.gcp_project or settings.firebase_project_id,
        database=settings.firestore_database,
    )
