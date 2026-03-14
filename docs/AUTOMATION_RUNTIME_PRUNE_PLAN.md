## Automation Runtime Prune Plan

### Goal
Reduce `apps/automation-runtime` to the code actually required for browser automation without breaking the current runtime-backed Gmail/WhatsApp flows.

### Method
We traced the real runtime entrypoint and built a module graph from:

- `apps/automation-runtime/vendor/runtime-agent-bridge.ts`

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
This worktree still had a delete-only residue outside the live bridge closure.

Measured from the current Runtime bridge closure:

- vendored files before this pass: `572`
- vendored files remaining now: `383`
- vendored files safely deleted in this pass: `189`

The remaining `383` files are still in the active browser Runtime graph. Further material reduction now requires more seam extraction rather than another blind prune pass.

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
Only vendored files outside the actual bridge closure rooted at:

- `apps/automation-runtime/vendor/runtime-agent-bridge.ts`

Representative deleted families:

- runtime-only leaves for non-browser channels
- unused outbound/channel delivery helpers
- stale plugin runtime leaves not reachable from the browser-only bridge path
- non-browser CLI dependency stubs
- WhatsApp-target helper leaves that are no longer referenced by the browser-only tool profile

### What Remains
The remaining vendored code is still in the live module graph for the current browser automation runtime. If we want to go materially smaller than this, the correct next step is not another blind prune. It is to keep narrowing the bridge/runner/tool-builder seams until the browser-only entrypoint stops statically depending on the broader embedded Runtime agent runtime.
