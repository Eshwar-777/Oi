## Automation Runtime Prune Plan

### Goal
Reduce `apps/automation-runtime` to the code actually required for browser automation without breaking the current runtime-backed Gmail/WhatsApp flows.

### Method
We traced the real runtime entrypoints and built an `esbuild` module graph from:

- `apps/automation-runtime/vendor/runtime-agent-bridge.ts`
- `apps/automation-runtime/vendor/runtime-auth-seed-bridge.ts`

Those bridges, plus the local runtime shell, represent the live browser automation path used by the backend.

### Keep Rules
We keep:

1. The runtime shell:
   - `src/server/*`
   - `src/runtime/*`
   - `src/contracts/*`
   - `src/adapter/runtime/*`

2. Vendored files inside the actual bundled module graph for:
   - the Runtime agent bridge
   - the auth seed bridge

3. Config and bootstrap files, even if they look thin:
   - they are part of startup and auth seeding

### Safe Delete Rules
A vendored file is safe to delete only if:

1. It is outside the bundled bridge module graph.
2. It is not a local runtime shell/config file.
3. It is not required by nearby browser scenarios:
   - Gmail send
   - WhatsApp send
   - Gmail to WhatsApp cross-app transfer
   - GitHub navigation
   - Calendar creation
   - pause/resume/stop/retry
   - auth/timeout/retry incident handling

### Current Result
The current embedded Runtime path still pulls in most of the vendored tree, but the browser-only seam reduced the safe-delete residue to effectively zero.

That means:

- further large reduction is no longer a delete-only task
- the next major size win requires continuing the browser-core extraction so the active bridge no longer depends on the broad general-agent runtime/tool graph

Measured from the live bridge bundle closure:

- vendored files before browser-core seam tightening: `1791`
- vendored files after the first safe prune pass: `1687`
- vendored files remaining now: `1667`
- additional vendored files safely deleted after the browser-only seam: `20`

### Browser-Only Seams Already Extracted
The browser-only path now has these explicit reductions in place:

1. Browser tool execution goes through a dedicated browser-core surface instead of scattered browser imports.
2. Browser-only runs use a browser-only tool builder and do not eagerly load the full tool-builder path.
3. Browser-only runs route through a dedicated `browser-attempt.ts` seam.
4. Browser-only runs skip broad product prompt additions such as docs-path, TTS hint, and owner-display prompt injection.
5. Browser-only runs skip the full skills runtime/env loading path and instead use a narrow browser-core skills prompt.
6. Browser-only runs skip bootstrap/context file resolution and bootstrap-budget analysis entirely.

This means the next meaningful reduction is no longer bootstrap/skills cleanup. The next leverage point is the remaining general-agent/session/runtime graph still pulled in by the shared embedded attempt body.

### What Was Deleted In This Pass
Only vendored files outside the actual bridge bundle closure.

Representative deleted families:

- runtime-only leaves for non-browser channels
- unused outbound/channel delivery helpers
- stale plugin runtime leaves not reachable from the browser-only bridge path
- non-browser CLI dependency stubs
- WhatsApp-target helper leaves that are no longer referenced by the browser-only tool profile

### What Remains
The remaining vendored code is still in the live module graph for the current browser automation runtime. If we want to go materially smaller than this, the correct next step is not another blind prune. It is to keep narrowing the bridge/runner/tool-builder seams until the browser-only entrypoint stops statically depending on the broader embedded Runtime agent runtime.
