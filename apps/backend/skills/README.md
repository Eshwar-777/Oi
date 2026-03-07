# Skills

Store reusable capabilities as file-based skill definitions.

Suggested structure:

- `skills/<skill_name>/SKILL.md`
- `skills/<skill_name>/prompts/*.md`
- `skills/<skill_name>/tools/*.py`

Each skill should define:
- purpose and constraints
- required tools
- input/output contract
- failure and fallback behavior

Current project skills:

- `curate-intent-router`: classify request as `task` / `automation` / `cron`
- `curate-execution-selector`: choose API vs MCP vs browser execution path
- `curate-browser-task-guard`: enforce UI prerequisites before run
- `curate-response-grounding`: avoid irrelevant substitutions in responses
- `ui-navigator`: run extension-backed browser tab control via `/api/browser/*`
- `browser-form-debugging`: diagnose failed browser field targeting and recover with stable targets
- `login-and-consent-recovery`: recover blocked UI flows after auth, consent, or onboarding gates
- `site-playbook-authoring`: add local playbooks that feed browser planning
- `safe-checkout-guardrails`: add conservative rules for high-risk commerce flows
