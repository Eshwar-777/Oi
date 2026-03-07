# Backend Architecture

The canonical backend design is documented in [BACKEND_AUTOMATION_ARCHITECTURE.md](./BACKEND_AUTOMATION_ARCHITECTURE.md).

This file remains as the entrypoint because other project notes already reference `docs/ARCHITECTURE.md`.

## Current direction

- FastAPI app with Firebase-authenticated HTTP and WebSocket APIs
- Structured automation flow: `intent -> plan -> run -> events -> artifacts`
- Unified runtime for immediate and scheduled automation runs
- Firestore-first persistence with local in-memory fallback
- Unified automation scheduling with optional browser-route compatibility

## Migration note

Use `/api/schedules` for schedule creation and lifecycle management.

`/browser/agent/schedules` is now only a compatibility route that proxies into the automation schedule layer.

For details, read [BACKEND_AUTOMATION_ARCHITECTURE.md](./BACKEND_AUTOMATION_ARCHITECTURE.md).
