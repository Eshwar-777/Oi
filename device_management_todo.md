Here’s a FastAPI-specific prompt that will reliably produce a full design + working reference implementation.

---

## Prompt (FastAPI + Postgres + Ed25519)

You are a senior backend/security engineer. Build a **device registration + device identity** system in **Python FastAPI** with **Postgres** that lets **one user register many devices** (mobiles, PCs, servers). Use **Ed25519** device keys (private key stays on device). No IMEI/MAC as primary identity.

### Deliverables

Produce a complete, runnable repository-style output with:

* `README.md` with setup + run steps
* `docker-compose.yml` (FastAPI + Postgres)
* Alembic migrations
* FastAPI app with routers, models, schemas, services
* Unit + integration tests (pytest)
* Example curl commands

### Tech constraints

* Python 3.11+
* FastAPI + Uvicorn
* SQLAlchemy 2.0 style + Alembic
* Postgres
* PyNaCl or cryptography library for Ed25519 verify
* JWT for user auth (can use a simplified “login” endpoint for demo)
* Device proof-of-possession (PoP) required on selected routes

---

## Domain model (must implement)

### Tables

1. `users`

* `id` UUID PK
* `email` unique
* `password_hash`
* timestamps

2. `devices`

* `id` UUID PK (server-generated device_id)
* `platform` enum (ios/android/windows/macos/linux/server)
* `device_class` enum (mobile/pc/server)
* `display_name`
* `manufacturer`, `model`, `os_version`, `app_version` nullable
* `status` enum (pending/active/blocked/retired)
* `trust_level` enum (untrusted/verified/managed)
* `created_at`, `last_seen_at`

3. `device_credentials`

* `id` UUID PK
* `device_id` FK -> devices
* `pubkey_ed25519` (bytes/base64) NOT NULL
* `key_version` int (start at 1)
* `created_at`, `revoked_at` nullable
* unique constraint: (device_id, key_version)

4. `device_user_links`

* `device_id` FK
* `user_id` FK
* `role` enum (owner/admin/user/service)
* `status` enum (active/revoked)
* `linked_at`, `revoked_at`
* PK can be composite (device_id, user_id)

5. `enrollments`

* `id` UUID PK
* `user_id` FK
* `device_id` FK nullable until created
* `flow` enum (login, pairing_code, admin_approved)
* `challenge` (random bytes/base64)
* `expires_at`
* `used_at` nullable
* `approved_at` nullable (needed for admin_approved)
* `metadata_json` (requested platform/device_class/etc.)
* indexes on `expires_at`, `user_id`

---

## Enrollment protocol (must implement)

### Step A: Start enrollment

`POST /enrollments`

* Auth: user JWT (for login & pairing_code)
* Body: platform, device_class, display_name, manufacturer/model/os/app versions
* Server returns:

  * `enrollment_id`
  * `challenge` (base64)
  * `expires_at`
* Server creates `enrollments` row with one-time challenge and expiry (e.g., 10 minutes).

### Step B: Complete enrollment (device proves possession)

`POST /enrollments/{enrollment_id}/complete`

* Body includes:

  * `pubkey_ed25519` (base64)
  * `signature` (base64) of: `challenge || enrollment_id || user_id`
* Server verifies signature with pubkey.
* On success:

  * Create `devices` row (status active)
  * Create `device_credentials` row (key_version=1)
  * Create `device_user_links` row (role owner, status active)
  * Mark enrollment used (`used_at`)
* Return `device_id` and a `device_token` (optional), but ALSO implement PoP-based auth.

### Replay prevention requirements

* Challenge is one-time use.
* Enrollment expires.
* Enrollment marked used.
* Signature payload includes enrollment_id + user_id binding.

---

## Device PoP auth (must implement)

Create middleware/dependency for protected routes:

* Request headers:

  * `Authorization: Bearer <user_jwt>`
  * `X-Device-Id: <uuid>`
  * `X-Device-Nonce: <random>`
  * `X-Device-Signature: <base64>` where signature is Ed25519 over:
    `nonce || method || path || body_sha256 || device_id`
* Server verifies:

  * device exists and active
  * device linked to this user and link active
  * signature verifies against latest non-revoked device_credentials pubkey
  * nonce not reused within TTL (store nonce hash in Redis OR Postgres table `device_nonces` with expiry)
* Update `devices.last_seen_at`

Implement at least one protected sample route:
`GET /secure/profile` requires both user JWT and device PoP.

---

## Device management APIs (must implement)

1. List user devices
   `GET /me/devices`

* returns array of devices + status + last_seen_at + trust_level

2. Revoke device
   `POST /devices/{device_id}/revoke`

* sets device status blocked or retired
* revokes active device_user_links and device_credentials

3. Rotate device key
   `POST /devices/{device_id}/rotate-key`

* requires PoP with current key
* accepts new pubkey + signature from old key authorizing the new key (define exact payload)
* creates new device_credentials with key_version+1, revokes old

4. Update device metadata
   `PATCH /devices/{device_id}`

* update display_name and version fields

---

## Tests (must implement)

* Enrollment expiry fails
* Enrollment reuse fails
* Signature verify fails with wrong key
* PoP signature fails if body changes
* Nonce reuse blocked
* Revoked device denied
* Key rotation works and old key no longer valid

---

## Output formatting

* Provide the full file tree
* Provide key file contents (not every single boilerplate line, but enough to run)
* Provide `curl` examples for: login, start enrollment, complete enrollment, call secure route, list devices, revoke

Begin by stating assumptions (e.g., using Redis or Postgres for nonce store). Then implement.

---

If you want it tighter: tell the LLM to use **Redis** for nonce storage (recommended). If you don’t have Redis, say “use Postgres device_nonces table with TTL cleanup job.”


UPDATE / OVERRIDES (do not change anything else unless required by these overrides)

We are NOT using Postgres, SQLAlchemy, or Alembic. We have always used Firebase + Firestore.

Auth:
- Use Firebase Authentication. All user identity is from Firebase ID token.
- Every endpoint that previously used "user JWT" must instead accept:
  Authorization: Bearer <Firebase ID token>
- Verify token using Firebase Admin SDK and use `uid` as `user_id`.

Database:
- Use Google Firestore (Firebase Admin SDK) for all storage.
- Replace SQL schema + migrations with Firestore collections + document structure.
- Do NOT output Alembic files or SQL migrations.

Collections (canonical):
- enrollments/{enrollmentId}
  fields: uid, flow, challenge(base64), expiresAt, usedAt, approvedAt(optional), requestedDevice{platform,deviceClass,displayName,manufacturer,model,osVersion,appVersion}
- devices/{deviceId}
  fields: platform, deviceClass, displayName, manufacturer, model, osVersion, appVersion, status, trustLevel, createdAt, lastSeenAt
- devices/{deviceId}/credentials/{keyVersion}
  fields: keyVersion(int), pubkeyEd25519(base64), createdAt, revokedAt(optional)
- devices/{deviceId}/links/{uid}
  fields: uid, role, status, linkedAt, revokedAt(optional)
- users/{uid}/devices/{deviceId}   (denormalized view for listing)
  fields: deviceId, displayName, platform, deviceClass, status, trustLevel, createdAt, lastSeenAt

Nonce replay protection:
- Implement nonce store in Firestore using collection device_nonces/{sha256(nonce)} with fields: deviceId, uid, expiresAt.
- Enforce timestamp skew (+/- 5 min) and nonce TTL (e.g., 10 min). Use Firestore TTL if available; otherwise include cleanup note.

Device PoP:
- Keep Ed25519 PoP requirement. Update signature payload to include uid binding:
  sig = Sign( nonce || timestamp || method || path || body_sha256 || device_id || uid )
- Verify using latest non-revoked credential under devices/{deviceId}/credentials.

Transactions:
- Use Firestore transactions for:
  - enrollment completion (check not expired/used, then create device, credential, link, denormalized doc, mark used)
  - key rotation
  - revoke

Security rules:
- Provide Firestore Security Rules.
- Users may read users/{uid} and users/{uid}/devices/* where uid == request.auth.uid.
- Clients must NOT be able to write devices/*, credentials/*, links/*, enrollments/* directly (server-only writes).

Tests:
- Use Firestore emulator in pytest. Provide instructions and sample test cases.
- Remove any Postgres/Alembic test setup.

Output:
- Keep the same API surface and behavior unless these overrides force changes.
- Output file tree + key code files + curl examples (assume Firebase ID token is provided externally).