# UI Navigator: 100 Reduced Test Cases

This is the practical version of [UI_NAVIGATOR_1000_TEST_CASES.md](/Users/yandrapue/.codex/worktrees/d237/Oi/docs/UI_NAVIGATOR_1000_TEST_CASES.md): 100 cases tied to the current Oi codebase, with explicit automated/manual coverage paths.

## Review Summary

The 1000-case document is useful as a brainstorming inventory, but not as an executable release suite.

- It mixes product-agnostic browser behavior with app-specific flows that Oi does not implement today.
- It over-indexes on website categories instead of failure modes already modeled in the code: refs, disambiguation, security gates, interruption, scheduling, and resume.
- It does not distinguish automatable coverage from manual/browser-dependent coverage.

This reduced suite fixes that by focusing on current Oi surfaces:

- Backend navigator planning and guardrails
- Backend conversation and schedule decisions
- Extension-backed/browser-session execution assumptions
- Web chat and schedules UI
- Human takeover, blocker, and evidence flows

## Execution Status For This Review

Automated coverage executed in this pass:

- `apps/backend/tests/test_navigator_context_builder.py`
- `apps/backend/tests/test_planner_guardrails.py`
- `apps/backend/tests/test_step_planner_contract_conversion.py`
- `apps/backend/tests/test_executor_evidence.py`
- `apps/backend/tests/test_response_composer.py`
- `apps/backend/tests/test_conversation_resolver.py`
- `apps/backend/tests/test_healthcheck.py`
- `apps/frontend/web/src/features/chat/runPresentation.test.ts`
- `apps/frontend/web/src/features/assistant/uiCopy.test.ts`
- direct schedule-service smoke execution through `create_automation_schedule`, `list_automation_schedules`, `list_due_automation_schedules`, and `delete_automation_schedule` in dev memory-fallback mode

Manual-only cases remain dependent on a running backend, authenticated web app, and an attached extension/browser session.

## Reduced 100

Format: `ID | Area | Type | Scenario | Coverage`

### 1. Search And Target Resolution

- R-001 | Search | Automated | Exact target selected by stable identity, not index | `test_step_planner_contract_conversion.py`
- R-002 | Search | Automated | Ref-based click survives contract conversion | `test_step_planner_contract_conversion.py`
- R-003 | Search | Automated | Role/name click gets strict disambiguation | `test_planner_guardrails.py`
- R-004 | Search | Automated | Text-only click target is preserved for follow-up review | `test_planner_guardrails.py`
- R-005 | Search | Automated | Unsafe CSS selector is rejected | `test_planner_guardrails.py`
- R-006 | Search | Automated | XPath target is rejected | `test_planner_guardrails.py`
- R-007 | Search | Automated | Coordinate-based click is rejected | `test_planner_guardrails.py`
- R-008 | Search | Automated | Snapshot observation is emitted when interaction is premature | `test_step_planner_contract_conversion.py`
- R-009 | Search | Automated | Semantic locator remains usable when no ref exists yet | `test_planner_guardrails.py`
- R-010 | Search | Manual | Search across a real site resolves the correct record after scrolling/reordering | browser manual

### 2. Context And Identity Verification

- R-011 | Context | Automated | Full prompt includes available instruction sources | `test_navigator_context_builder.py`
- R-012 | Context | Automated | Minimal prompt omits source catalog | `test_navigator_context_builder.py`
- R-013 | Context | Automated | Retrieved instruction context stays bounded | `test_navigator_context_builder.py`
- R-014 | Context | Automated | Runtime metadata stays separate from retrieved debug metadata | `test_navigator_context_builder.py`
- R-015 | Context | Automated | Message-like prompts do not inject synthetic click steps | `test_planner_guardrails.py`
- R-016 | Context | Automated | Named entity must be activated before acting | `test_step_planner_contract_conversion.py`
- R-017 | Context | Automated | Next-action contract rejects missing ref for `act` | `test_step_planner_contract_conversion.py`
- R-018 | Context | Automated | Deterministic ref targets are preserved verbatim | `test_planner_guardrails.py`
- R-019 | Context | Manual | Current page title/header is rechecked after site navigation | browser manual
- R-020 | Context | Manual | Wrong tenant/workspace switch is detected before edit/send | browser manual

### 3. Navigation State, Tabs, And Recovery

- R-021 | Navigation | Automated | New-tab/snapshot target page refs are propagated correctly | `test_step_planner_contract_conversion.py`
- R-022 | Navigation | Automated | Diagnostics step can be emitted when page and observation disagree | `test_step_planner_contract_conversion.py`
- R-023 | Navigation | Automated | Browser plan length is capped to avoid runaway action chains | `test_step_planner_contract_conversion.py`
- R-024 | Navigation | Automated | Plan refinement detects need for snapshot refs | `test_step_planner_contract_conversion.py`
- R-025 | Navigation | Automated | Fallback planner produces native browser steps for GitHub search | `test_step_planner_contract_conversion.py`
- R-026 | Navigation | Automated | Invalid keyboard command is not mutated into a different action | `test_planner_guardrails.py`
- R-027 | Navigation | Automated | Press interaction is allowed as a controlled follow-up step | `test_planner_guardrails.py`
- R-028 | Navigation | Manual | Redirect/login wall pauses flow instead of looping | browser manual
- R-029 | Navigation | Manual | Browser back/refresh rebuilds state instead of using stale DOM | browser manual
- R-030 | Navigation | Manual | Switching to a new tab keeps the active target aligned | extension + browser manual

### 4. Input Routing And Compose Safety

- R-031 | Input | Automated | Type against text target is rewritten to label targeting | `test_planner_guardrails.py`
- R-032 | Input | Automated | Type args are promoted into the actual typed value | `test_step_planner_contract_conversion.py`
- R-033 | Input | Automated | Upload args are promoted into file payload | `test_step_planner_contract_conversion.py`
- R-034 | Input | Automated | Ref candidate never becomes typed text accidentally | `test_step_planner_contract_conversion.py`
- R-035 | Input | Automated | Extract output keys chain cleanly into later steps | `test_step_planner_contract_conversion.py`
- R-036 | Input | Automated | Message summary prioritizes backend-provided manual-action reason | `runPresentation.test.ts`
- R-037 | Input | Manual | Search box and composer coexist without cross-typing | browser manual
- R-038 | Input | Manual | Rich editor focus loss is detected before send | browser manual
- R-039 | Input | Manual | Attachment upload shows visible completion before send | browser manual
- R-040 | Input | Manual | Keyboard submit does not fire in the wrong control | browser manual

### 5. Submit Safety And Sensitive Actions

- R-041 | Safety | Automated | Unsafe selector strategies escalate instead of clicking | `test_planner_guardrails.py`
- R-042 | Safety | Automated | Planner can decline unsafe automation when confidence is weak | `test_step_planner_contract_conversion.py`
- R-043 | Safety | Automated | Visual mode is preferred when DOM evidence is weak | `test_executor_evidence.py`
- R-044 | Safety | Automated | Ref mode is preferred when snapshot evidence is strong | `test_executor_evidence.py`
- R-045 | Safety | Automated | Waiting-for-user-action uses explicit confirm/resume wording | `runPresentation.test.ts`
- R-046 | Safety | Manual | Sensitive publish/send/delete waits for human approval | browser manual
- R-047 | Safety | Manual | External-recipient warning is surfaced before send | browser manual
- R-048 | Safety | Manual | CAPTCHA/MFA gate results in pause, not bypass | browser manual
- R-049 | Safety | Manual | Security modal blocks action until user resolves it | browser manual
- R-050 | Safety | Manual | Wrong-account send/edit is caught before final action | browser manual

### 6. Async Stability And DOM Freshness

- R-051 | Async | Automated | Observation mode is available before interaction steps | `test_step_planner_contract_conversion.py`
- R-052 | Async | Automated | Snapshot format variants map correctly to native snapshot steps | `test_step_planner_contract_conversion.py`
- R-053 | Async | Automated | Follow-up diagnostic step is representable without UI mutation | `test_step_planner_contract_conversion.py`
- R-054 | Async | Automated | Planner guardrails add clickability/security preconditions | `test_planner_guardrails.py`
- R-055 | Async | Automated | Contract schema rejects malformed next actions early | `test_step_planner_contract_conversion.py`
- R-056 | Async | Manual | Spinner/skeleton states are not treated as clickable results | browser manual
- R-057 | Async | Manual | Disabled controls are ignored until enabled | browser manual
- R-058 | Async | Manual | Reordered results after async refresh do not change chosen target | browser manual
- R-059 | Async | Manual | Stale list after browser cache/back is revalidated | browser manual
- R-060 | Async | Manual | Autosave/in-progress draft state is not mistaken for completion | browser manual

### 7. Scheduling And Delayed Execution

- R-061 | Schedule | Automated | Scheduled conversation decision maps to schedule-builder CTA | `test_response_composer.py`
- R-062 | Schedule | Automated | Multi-time decision maps to multi-time schedule-builder CTA | `test_response_composer.py`
- R-063 | Schedule | Automated | Scheduled resolution message points users to the schedules tab | `test_response_composer.py`
- R-064 | Schedule | Automated | UI copy labels `READY_TO_SCHEDULE` correctly | `uiCopy.test.ts`
- R-065 | Schedule | Automated | UI copy labels repeated schedules correctly | `uiCopy.test.ts`
- R-066 | Schedule | Automated | Missing timing field is rendered as human-readable copy | `uiCopy.test.ts`
- R-067 | Schedule | Automated | Scheduled run state renders as `Scheduled` | `uiCopy.test.ts`
- R-068 | Schedule | Automated | Schedule misfire error copy is explicit and actionable | `uiCopy.test.ts`
- R-069 | Schedule | Manual | Once/interval/multi-time schedule appears in the Schedules tab after chat | web manual
- R-070 | Schedule | Manual | Scheduled run does not expose immediate-run controls as the primary path | web manual

### 8. Human Takeover, Pause, Resume

- R-071 | Takeover | Automated | Waiting state gets resume-oriented action label | `runPresentation.test.ts`
- R-072 | Takeover | Automated | Real-world boundary prompts trigger manual-action simulation heuristics | `runPresentation.test.ts`
- R-073 | Takeover | Automated | Pending interruption text is surfaced from backend run detail | `runPresentation.test.ts`
- R-074 | Takeover | Automated | Blocker-related run states normalize to clear UI labels | `uiCopy.test.ts`
- R-075 | Takeover | Manual | User can take control on the blocked step and continue | docs/MANUAL_TESTING_SCENARIOS.md Scenario 5
- R-076 | Takeover | Manual | User can stop instead of resume from blocked state | docs/MANUAL_TESTING_SCENARIOS.md Scenario 5
- R-077 | Takeover | Manual | Human takeover on same device pauses automation safely | browser manual
- R-078 | Takeover | Manual | Resume after manual step does not replay completed actions | browser manual
- R-079 | Takeover | Manual | Resume rejects impossible state transitions cleanly | browser manual
- R-080 | Takeover | Manual | Device disconnect produces actionable blocked state | extension + browser manual

### 9. Cross-Site Auth, Permissions, Blockers

- R-081 | Auth | Automated | Guardrails inject no-security-gate preconditions for interactions | `test_planner_guardrails.py`
- R-082 | Auth | Automated | Unsafe interaction plans can collapse to no-op/escalation | `test_planner_guardrails.py`
- R-083 | Auth | Automated | Browser execution mode can downgrade based on weak evidence | `test_executor_evidence.py`
- R-084 | Auth | Automated | Prompt retrieval can include blocker-aware instruction context | `test_navigator_context_builder.py`
- R-085 | Auth | Manual | Login/SSO prompt pauses flow for user completion | browser manual
- R-086 | Auth | Manual | Permission prompt for notifications/files/camera is treated as user-owned | browser manual
- R-087 | Auth | Manual | Consent/legal modal is surfaced, not auto-accepted | browser manual
- R-088 | Auth | Manual | Re-authentication during save/send does not lose target context | browser manual
- R-089 | Auth | Manual | Cross-domain redirect verifies destination before continuing | browser manual
- R-090 | Auth | Manual | Extension/browser disconnect is surfaced rather than silently retried forever | extension + browser manual

### 10. Evidence, Outcomes, And Release Checks

- R-091 | Evidence | Automated | Completion evidence bundle can be built from executor data | `test_executor_evidence.py`
- R-092 | Evidence | Automated | Run-state summary uses state-specific user-facing text | `runPresentation.test.ts`
- R-093 | Evidence | Automated | Error codes map to explicit user-facing explanations | `uiCopy.test.ts`
- R-094 | Evidence | Automated | Backend health endpoint for scheduled task checks responds cleanly | `test_healthcheck.py`
- R-095 | Evidence | Automated | Planner/executor contracts stay schema-compatible | `test_planner_executor_contracts.py`
- R-096 | Evidence | Manual | Live run shows progress/evidence during browser automation | docs/MANUAL_TESTING_SCENARIOS.md Scenario 4
- R-097 | Evidence | Manual | Completed scheduled task appears with upcoming or prior run timestamps | web manual
- R-098 | Evidence | Manual | Failed run shows retry/next-step guidance instead of false success | web manual
- R-099 | Evidence | Manual | Schedules page shows timezone and next occurrences correctly | web manual
- R-100 | Evidence | Manual | Release smoke covers chat -> schedule creation -> schedules page -> blocked/resume path | combined manual smoke

## Recommended Release Gate

Minimum automated gate:

- Backend: navigator context, planner guardrails, step-contract conversion, executor evidence, response composer
- Frontend: run presentation, schedule UI copy

Minimum manual gate:

- Chat creates a once schedule
- Chat creates a recurring schedule
- Schedules page renders the upcoming event
- A real blocker pauses the run and allows resume/stop
- A browser session can be attached and used without unsafe auto-confirmation
