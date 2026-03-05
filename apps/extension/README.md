# OI Browser Extension

Chrome extension for OI browser automation (Companion). Build from the **monorepo root** so dependencies are available:

```bash
# From repo root (Oi/)
pnpm install
pnpm --filter @oi/extension build
```

Or from this folder after a root install:

```bash
cd apps/extension
pnpm build
```

Load the built extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `apps/extension/dist` folder

The extension connects to the OI backend WebSocket (default `ws://localhost:8080/ws`). Ensure the backend is running and the extension is signed in (popup) so it can receive automation commands.
