# Architecture (Scaffold)

## Core components

- `api/`: HTTP surface (`/health`, `/interact`)
- `agents/`: orchestration layer for ADK + LangGraph flows
- `tools/`: tool adapters (vision, computer use, storage, external APIs)
- `prompts/`: prompt loading and versioning
- `skills/`: reusable agent capabilities and policies
- `memory/`: short/long-term memory interfaces
- `observability/`: logging, metrics, tracing bootstrapping

## Runtime flow

1. Request enters API route.
2. Request is validated and assigned correlation ID.
3. Orchestrator selects interaction path (chat/live/tool-heavy).
4. LangGraph/ADK executes tool/model plan with guardrails.
5. Response is validated, logged, and returned.

## Notes

- Keep tool execution side effects behind explicit policies.
- Keep prompt assets immutable per release version.
- Record model/tool decisions for post-mortem debugging.
