"""Tests for the device identity / registration / PoP system (Firestore-backed).

Covers:
  1. Enrollment expiry fails
  2. Enrollment reuse fails
  3. Signature verify fails with wrong key
  4. PoP signature fails if body changes
  5. Nonce reuse blocked
  6. Revoked device denied
  7. Key rotation works and old key no longer valid

Running with Firestore emulator:
  1. Install: gcloud components install cloud-firestore-emulator
  2. Start:   gcloud emulators firestore start --host-port=localhost:8181
  3. Export:  export FIRESTORE_EMULATOR_HOST=localhost:8181
  4. Run:     pytest tests/test_device_management.py -v

Without emulator these tests use mock patches.
"""

from __future__ import annotations

import base64
import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey


# ---------------------------------------------------------------------------
# In-memory Firestore fake for tests
# ---------------------------------------------------------------------------

class FakeDocSnapshot:
    def __init__(self, id: str, data: dict | None, ref=None):
        self._id = id
        self._data = data
        self.reference = ref

    @property
    def id(self):
        return self._id

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        return dict(self._data) if self._data else {}


class FakeDocRef:
    def __init__(self, store: dict, path: str, doc_id: str):
        self._store = store
        self._path = path
        self._id = doc_id
        self._key = f"{path}/{doc_id}"

    @property
    def id(self):
        return self._id

    async def get(self, transaction=None):
        data = self._store.get(self._key)
        return FakeDocSnapshot(self._id, data, ref=self)

    async def set(self, data, merge=False):
        self._store[self._key] = dict(data)

    async def update(self, data):
        if self._key not in self._store:
            raise Exception(f"Document {self._key} not found")
        self._store[self._key].update(data)

    def collection(self, name):
        return FakeCollectionRef(self._store, f"{self._key}/{name}")


class FakeCollectionRef:
    def __init__(self, store: dict, path: str):
        self._store = store
        self._path = path

    def document(self, doc_id: str):
        return FakeDocRef(self._store, self._path, doc_id)

    async def get(self):
        prefix = self._path + "/"
        results = []
        for k, v in self._store.items():
            if k.startswith(prefix):
                remainder = k[len(prefix):]
                if "/" not in remainder:
                    ref = FakeDocRef(self._store, self._path, remainder)
                    results.append(FakeDocSnapshot(remainder, v, ref=ref))
        return results

    def order_by(self, field, direction=None):
        return FakeQuery(self._store, self._path, field, direction)

    def limit(self, n):
        return FakeQuery(self._store, self._path, None, None, limit=n)


class FakeQuery:
    def __init__(self, store, path, field=None, direction=None, limit=None):
        self._store = store
        self._path = path
        self._field = field
        self._direction = direction
        self._limit = limit

    def order_by(self, field, direction=None):
        return FakeQuery(self._store, self._path, field, direction, self._limit)

    def limit(self, n):
        return FakeQuery(self._store, self._path, self._field, self._direction, n)

    async def get(self):
        prefix = self._path + "/"
        results = []
        for k, v in self._store.items():
            if k.startswith(prefix):
                remainder = k[len(prefix):]
                if "/" not in remainder:
                    ref = FakeDocRef(self._store, self._path, remainder)
                    results.append(FakeDocSnapshot(remainder, v, ref=ref))

        if self._field:
            desc = self._direction and "DESCENDING" in str(self._direction)
            results.sort(key=lambda s: s.to_dict().get(self._field, 0), reverse=bool(desc))

        if self._limit:
            results = results[:self._limit]
        return results


class FakeTransaction:
    def __init__(self, store):
        self._store = store
        self._ops = []

    def set(self, ref, data):
        self._store[ref._key] = dict(data)

    def update(self, ref, data):
        if ref._key in self._store:
            self._store[ref._key].update(data)


class FakeFirestoreClient:
    def __init__(self):
        self._store: dict[str, dict] = {}

    def collection(self, name):
        return FakeCollectionRef(self._store, name)

    def transaction(self):
        return FakeTransaction(self._store)

    @property
    def async_transactional(self):
        store = self._store

        def decorator(func):
            async def wrapper(transaction, *args, **kwargs):
                return await func(transaction, *args, **kwargs)
            return wrapper
        return decorator


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_db():
    return FakeFirestoreClient()


@pytest.fixture(autouse=True)
def _patch_firestore(fake_db):
    with patch("oi_agent.devices.firestore_client.get_firestore", return_value=fake_db), \
         patch("oi_agent.devices.enrollment.get_firestore", return_value=fake_db), \
         patch("oi_agent.devices.service.get_firestore", return_value=fake_db), \
         patch("oi_agent.devices.pop_auth.get_firestore", return_value=fake_db):
        yield


@pytest_asyncio.fixture
async def app():
    from fastapi import FastAPI
    from oi_agent.auth.firebase_auth import get_current_user
    from oi_agent.devices.router import device_router

    test_app = FastAPI()
    test_app.include_router(device_router)

    async def fake_get_current_user():
        return {"uid": UID, "email": "test@example.com"}

    test_app.dependency_overrides[get_current_user] = fake_get_current_user
    return test_app


@pytest_asyncio.fixture
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


UID = "test-uid-123"


async def _do_enrollment(client: AsyncClient):
    """Run full enrollment, return (device_id, signing_key)."""
    resp = await client.post("/enrollments", json={
        "platform": "macos",
        "device_class": "pc",
        "display_name": "Test MacBook",
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()
    enrollment_id = data["enrollment_id"]
    challenge = base64.b64decode(data["challenge"])

    signing_key = SigningKey.generate()
    message = challenge + enrollment_id.encode() + UID.encode()
    signature = signing_key.sign(message).signature

    resp = await client.post(f"/enrollments/{enrollment_id}/complete", json={
        "pubkey_ed25519": base64.b64encode(signing_key.verify_key.encode()).decode(),
        "signature": base64.b64encode(signature).decode(),
    })
    assert resp.status_code == 200, resp.text
    return resp.json()["device_id"], signing_key


def _build_pop_headers(
    device_id: str,
    signing_key: SigningKey,
    method: str,
    path: str,
    body: bytes = b"",
    uid: str = UID,
) -> dict[str, str]:
    nonce = os.urandom(16)
    nonce_b64 = base64.b64encode(nonce).decode()
    timestamp = datetime.now(timezone.utc).isoformat()
    body_sha256 = hashlib.sha256(body).digest()

    message = (
        nonce
        + timestamp.encode()
        + method.encode()
        + path.encode()
        + body_sha256
        + device_id.encode()
        + uid.encode()
    )
    signature = signing_key.sign(message).signature

    return {
        "X-Device-Id": device_id,
        "X-Device-Nonce": nonce_b64,
        "X-Device-Timestamp": timestamp,
        "X-Device-Signature": base64.b64encode(signature).decode(),
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_full_enrollment_happy_path(client):
    device_id, _ = await _do_enrollment(client)
    assert device_id is not None
    assert len(device_id) == 36


@pytest.mark.asyncio
async def test_enrollment_expiry(client, fake_db):
    resp = await client.post("/enrollments", json={
        "platform": "linux", "device_class": "server", "display_name": "Expired",
    })
    data = resp.json()
    enrollment_id = data["enrollment_id"]
    challenge = base64.b64decode(data["challenge"])

    # Force-expire the enrollment
    key = f"enrollments/{enrollment_id}"
    fake_db._store[key]["expiresAt"] = (
        datetime.now(timezone.utc) - timedelta(hours=1)
    ).isoformat()

    signing_key = SigningKey.generate()
    message = challenge + enrollment_id.encode() + UID.encode()
    signature = signing_key.sign(message).signature

    resp = await client.post(f"/enrollments/{enrollment_id}/complete", json={
        "pubkey_ed25519": base64.b64encode(signing_key.verify_key.encode()).decode(),
        "signature": base64.b64encode(signature).decode(),
    })
    assert resp.status_code == 400
    assert "expired" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_enrollment_reuse(client):
    resp = await client.post("/enrollments", json={
        "platform": "android", "device_class": "mobile", "display_name": "Phone",
    })
    data = resp.json()
    enrollment_id = data["enrollment_id"]
    challenge = base64.b64decode(data["challenge"])

    signing_key = SigningKey.generate()
    message = challenge + enrollment_id.encode() + UID.encode()
    signature = signing_key.sign(message).signature
    body = {
        "pubkey_ed25519": base64.b64encode(signing_key.verify_key.encode()).decode(),
        "signature": base64.b64encode(signature).decode(),
    }

    resp1 = await client.post(f"/enrollments/{enrollment_id}/complete", json=body)
    assert resp1.status_code == 200

    resp2 = await client.post(f"/enrollments/{enrollment_id}/complete", json=body)
    assert resp2.status_code == 400
    assert "already used" in resp2.json()["detail"].lower()


@pytest.mark.asyncio
async def test_wrong_key_enrollment(client):
    resp = await client.post("/enrollments", json={
        "platform": "ios", "device_class": "mobile", "display_name": "iPhone",
    })
    data = resp.json()
    enrollment_id = data["enrollment_id"]
    challenge = base64.b64decode(data["challenge"])

    correct_key = SigningKey.generate()
    wrong_key = SigningKey.generate()

    message = challenge + enrollment_id.encode() + UID.encode()
    signature = wrong_key.sign(message).signature

    resp = await client.post(f"/enrollments/{enrollment_id}/complete", json={
        "pubkey_ed25519": base64.b64encode(correct_key.verify_key.encode()).decode(),
        "signature": base64.b64encode(signature).decode(),
    })
    assert resp.status_code == 400
    assert "signature" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_pop_body_tamper(client):
    device_id, signing_key = await _do_enrollment(client)

    pop_headers = _build_pop_headers(
        device_id, signing_key, "GET", "/secure/profile", b'{"tampered": true}',
    )
    resp = await client.get("/secure/profile", headers=pop_headers)
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_nonce_reuse(client):
    device_id, signing_key = await _do_enrollment(client)

    nonce = os.urandom(16)
    nonce_b64 = base64.b64encode(nonce).decode()
    timestamp = datetime.now(timezone.utc).isoformat()
    body_sha256 = hashlib.sha256(b"").digest()

    message = (
        nonce + timestamp.encode() + b"GET" + b"/secure/profile"
        + body_sha256 + device_id.encode() + UID.encode()
    )
    signature = signing_key.sign(message).signature

    headers = {
        "X-Device-Id": device_id,
        "X-Device-Nonce": nonce_b64,
        "X-Device-Timestamp": timestamp,
        "X-Device-Signature": base64.b64encode(signature).decode(),
    }

    resp1 = await client.get("/secure/profile", headers=headers)
    assert resp1.status_code == 200

    resp2 = await client.get("/secure/profile", headers=headers)
    assert resp2.status_code == 401
    assert "nonce" in resp2.json()["detail"].lower()


@pytest.mark.asyncio
async def test_revoked_device_denied(client):
    device_id, signing_key = await _do_enrollment(client)

    resp = await client.post(f"/devices/{device_id}/revoke")
    assert resp.status_code == 200
    assert resp.json()["status"] == "blocked"

    pop_headers = _build_pop_headers(
        device_id, signing_key, "GET", "/secure/profile", b"",
    )
    resp = await client.get("/secure/profile", headers=pop_headers)
    assert resp.status_code == 403
    assert "not active" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_key_rotation(client):
    device_id, old_key = await _do_enrollment(client)

    new_key = SigningKey.generate()
    new_pub_b64 = base64.b64encode(new_key.verify_key.encode()).decode()

    auth_message = new_key.verify_key.encode() + device_id.encode()
    auth_sig = old_key.sign(auth_message).signature
    auth_sig_b64 = base64.b64encode(auth_sig).decode()

    import json
    body_bytes = json.dumps({
        "new_pubkey_ed25519": new_pub_b64,
        "authorization_signature": auth_sig_b64,
    }).encode()

    pop_headers = _build_pop_headers(
        device_id, old_key, "POST", f"/devices/{device_id}/rotate-key", body_bytes,
    )
    pop_headers["Content-Type"] = "application/json"

    resp = await client.post(
        f"/devices/{device_id}/rotate-key",
        content=body_bytes,
        headers=pop_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["key_version"] == 2

    # Old key should now fail PoP
    old_pop = _build_pop_headers(device_id, old_key, "GET", "/secure/profile", b"")
    resp = await client.get("/secure/profile", headers=old_pop)
    assert resp.status_code == 401

    # New key should work
    new_pop = _build_pop_headers(device_id, new_key, "GET", "/secure/profile", b"")
    resp = await client.get("/secure/profile", headers=new_pop)
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_list_devices(client):
    device_id, _ = await _do_enrollment(client)
    resp = await client.get("/me/devices")
    assert resp.status_code == 200
    devices = resp.json()["devices"]
    assert len(devices) >= 1


@pytest.mark.asyncio
async def test_update_device(client):
    device_id, _ = await _do_enrollment(client)
    resp = await client.patch(
        f"/devices/{device_id}",
        json={"display_name": "Renamed MacBook", "app_version": "2.0.0"},
    )
    assert resp.status_code == 200
    assert resp.json()["display_name"] == "Renamed MacBook"
