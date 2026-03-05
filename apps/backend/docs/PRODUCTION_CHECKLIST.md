# Production Readiness Checklist for AI Agents

Use this as a gate. If any critical item is unchecked, do not deploy.

## 1) Product and Behavior Contracts

- [ ] Define allowed capabilities and explicit non-goals.
- [ ] Define trust boundaries (what the agent can read/write/call).
- [ ] Define interaction contracts per mode (chat, voice, live stream, tool use).
- [ ] Define unsafe or disallowed user intents and refusal behavior.
- [ ] Define deterministic behavior for high-risk flows (payments, deletes, account changes).

## 2) Security (Critical)

- [ ] Secrets only from environment or secret manager; never hardcoded.
- [ ] Input validation and output sanitization on every external boundary.
- [ ] Prompt injection defenses: isolate system prompts, validate tool intents, require allowlists.
- [ ] Tool permission model (least privilege, per-tool scopes, per-request budget).
- [ ] Network egress controls and domain allowlists for web-enabled tools.
- [ ] Authentication and authorization for every API route.
- [ ] Multi-tenant isolation: no cross-tenant memory leakage.
- [ ] Audit trail for tool actions and sensitive operations.
- [ ] Data retention and deletion policy enforced.
- [ ] Security testing: SAST, dependency scan, secret scan, and adversarial prompt tests.

## 3) Reliability and Fallbacks (Critical)

- [ ] Timeouts and retries with bounded exponential backoff.
- [ ] Circuit breakers around external services (LLM, DB, webhooks).
- [ ] Graceful degradation path (fallback model / reduced feature mode).
- [ ] Idempotency keys for side-effecting operations.
- [ ] Queue/backpressure strategy for spikes and stream overload.
- [ ] Clear user-visible failure messaging with retry guidance.
- [ ] Dead-letter handling for failed async tasks.

## 4) Observability and Operations

- [ ] Structured logs with request/session/user correlation IDs.
- [ ] Metrics for latency, cost, token usage, tool errors, refusal rate.
- [ ] Distributed tracing for request-to-tool-to-model path.
- [ ] Alerting for SLO breaches and abnormal spend.
- [ ] Runbooks for common incidents.
- [ ] On-call ownership defined.

## 5) Model and Prompt Engineering

- [ ] Version prompts as files and track changes in git.
- [ ] Prompt regression tests (golden set / behavior snapshots).
- [ ] Explicit system prompt hierarchy and conflict resolution rules.
- [ ] Output schema validation for structured responses.
- [ ] Hallucination controls: retrieval checks, source attribution where needed.
- [ ] Safety policy tests (jailbreak, role confusion, data exfiltration attempts).

## 6) Data and Memory

- [ ] Define short-term vs long-term memory boundaries.
- [ ] PII detection and redaction before persistence.
- [ ] Encryption at rest and in transit.
- [ ] Data lineage for generated artifacts.
- [ ] Right-to-delete support and data export where required.

## 7) Code Quality and Modularity

- [ ] Clear module boundaries (`api`, `agents`, `tools`, `memory`, `observability`).
- [ ] Avoid business logic in prompt text; keep logic in code.
- [ ] Strict typing and linting in CI.
- [ ] Unit + integration + end-to-end tests.
- [ ] Backward-compatible API evolution policy.

## 8) Cost and Performance

- [ ] Token budget controls per request/session.
- [ ] Model routing policy (cheap/fast vs expensive/high-quality).
- [ ] Caching strategy for repeated prompts/responses where safe.
- [ ] Streaming strategy with cancellation support.
- [ ] Benchmark latency under realistic concurrency.

## 9) Governance and Compliance

- [ ] Terms/privacy disclosures for AI-generated behavior.
- [ ] Regional data residency controls (if required).
- [ ] Human override and escalation path for critical decisions.
- [ ] Content moderation policy and enforcement.

## 10) Release and Change Management

- [ ] Staging environment mirrors production dependencies.
- [ ] Canary rollout and rollback plan.
- [ ] Migration strategy for memory schema and prompt versions.
- [ ] Post-deploy verification checklist.
