## Browser-Core Extraction Plan

### Goal
Reduce `apps/automation-runtime` from a broad embedded Runtime agent wrapper to a narrower browser-core runtime that keeps only:

- browser tool schema and actions
- snapshot/ref/action engine
- browser session and direct CDP profile handling
- model-facing browser task loop
- runtime event and incident mapping

### Current State
The live path still depends on a broad embedded Runtime agent bridge:

- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/vendor/runtime-agent-bridge.ts`
- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/runtime/agent-browser.ts`

That bridge still brings in:

- embedded agent/session transcript behavior
- broad runtime/config/session helpers
- more of the vendor tree than browser automation alone should require

### Actual Runtime UI Automation Files
These are the Runtime files currently executing browser UI automation in our stack:

- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/agents/tools/browser-tool.ts`
- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/agents/tools/browser-tool.actions.ts`
- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/agents/tools/browser-tool.schema.ts`
- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/browser/pw-tools-core.snapshot.ts`
- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/browser/pw-tools-core.interactions.ts`
- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/browser/pw-tools-core.shared.ts`
- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/browser/pw-session.ts`
- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/browser/client-actions.ts`
- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/browser/client.ts`

To make that surface explicit inside the vendored tree, this pass adds:

- `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/vendor/runtime/src/browser/browser-core-surface.ts`

That file is the intended compatibility seam for future browser-core extraction work.

### Extraction Principles
1. Preserve the current runtime contract to backend/UI.
2. Keep the browser execution semantics stable while shrinking the implementation.
3. Remove broad Runtime ownership in stages, not in one rewrite.
4. Do not prune runtime-loaded browser/tool/config code blindly.

### Phase 1: Runner Boundary
Completed in this pass:

- move Runtime bridge/bootstrap/process management behind a dedicated runtime module:
  - `/Users/yandrapue/.codex/worktrees/d237/Oi/apps/automation-runtime/src/runtime/embedded-runtime-runner.ts`
- keep `agent-browser.ts` focused on browser orchestration and recovery policy
- stop letting `agent-browser.ts` know about:
  - session store file locations
  - Runtime config file seeding
  - bridge process spawn details
  - daemon restart details

This gives us one seam to replace later without rewriting runtime orchestration again.

### Phase 2: Browser-Core Bridge
Replace the current broad bridge path with a browser-core-only bridge that keeps:

- browser tool schema
- browser tool actions
- browser session/profile handling
- browser-first model loop
- runtime event emission

and removes dependency on the broad embedded agent/session runtime wherever possible.

### Phase 3: Vendor Reduction
After the browser-core bridge exists:

- rebuild the actual runtime closure
- drop broad agent/session/channel ecosystems no longer reachable
- keep config/auth/model loading intact only if still required by the browser-core path

### Expected Outcome
After Phase 2 and 3:

- `agent-browser.ts` orchestrates browser automation against a narrow browser-core runner
- the vendored Runtime closure becomes materially smaller than the current active closure
- future pruning becomes a safe delete-only task again instead of an architectural risk
