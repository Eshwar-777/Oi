# Auth and Runtime Ownership

- `Firebase/Auth` is the primary user identity system. Backend HTTP routes and user-scoped data depend on verified Firebase identity.
- `Firestore-backed user/device records` determine which user owns a conversation, run, schedule, or browser session.
- `Runner shared secret` is machine-to-backend trust for runner registration and runner websocket control. It does not identify a user.
- `Automation runtime shared secret` is backend-to-runtime trust for run execution and readiness checks.
- `Browser session control` is user-authorized interaction on a runner-owned browser session. A controller lock indicates active human takeover.
- `conversation_id` is the user-facing chat identity. `session_id` remains the runtime/event-stream key owned by that conversation.
