#!/usr/bin/env python3
"""Pure scoring logic for the production-readiness scorer."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple


NA_VALUE = "NA"
CATEGORY_NA_WARNING_RATIO = 0.3
TOTAL_PASS_THRESHOLD = 3.5
CATEGORY_PASS_THRESHOLD = 3.0
CRITICAL_PASS_THRESHOLD = 3.0


@dataclass(frozen=True)
class Category:
    key: str
    name: str
    weight: float


@dataclass(frozen=True)
class Checkpoint:
    id: int
    category_key: str
    title: str
    description: str
    remediation_hint: str
    is_critical: bool = False


CATEGORIES: List[Category] = [
    Category("architecture", "Architecture & System Design", 0.20),
    Category("code_quality", "Code Quality & Engineering Discipline", 0.10),
    Category("correctness", "Correctness & Logic Integrity", 0.15),
    Category("security", "Security", 0.15),
    Category("performance", "Performance & Scalability", 0.10),
    Category("observability", "Observability & Reliability", 0.10),
    Category("testing", "Testing & Validation", 0.15),
    Category("devex", "DevEx & Operational Readiness", 0.05),
]

CATEGORY_BY_KEY: Dict[str, Category] = {category.key: category for category in CATEGORIES}
CRITICAL_CHECKPOINT_IDS = {31, 33, 34, 36, 40, 61, 62, 63, 75}


def _build_checkpoints() -> List[Checkpoint]:
    definitions: List[Tuple[int, str, str, str, str]] = [
        (1, "architecture", "Clear architectural pattern", "Project follows a recognizable architectural style.", "Define and document a primary architecture and align new code to it."),
        (2, "architecture", "Separation of concerns", "UI, domain, and infrastructure responsibilities are not mixed.", "Split mixed modules so each layer owns one concern."),
        (3, "architecture", "Dependency direction", "Core domain logic does not depend directly on infrastructure details.", "Invert dependencies so domain code depends on interfaces, not adapters."),
        (4, "architecture", "Explicit boundaries between modules/packages", "Module responsibilities and package boundaries are clearly enforced.", "Introduce explicit package boundaries and tighten imports."),
        (5, "architecture", "State management clarity", "State ownership and update paths are obvious.", "Centralize or clearly document state ownership and transitions."),
        (6, "architecture", "Side effects isolation", "I/O and other side effects are kept out of core logic.", "Push side effects to adapters or service boundaries."),
        (7, "architecture", "Predictable data flow", "Data moves through the system in a traceable, consistent way.", "Standardize request and event flow so state changes are easy to trace."),
        (8, "architecture", "Explicit error propagation strategy", "Errors are surfaced through a consistent mechanism.", "Adopt a single error-handling pattern and document it."),
        (9, "architecture", "No circular dependencies", "Modules do not form dependency cycles.", "Break cycles by extracting shared abstractions or reorganizing modules."),
        (10, "architecture", "No hidden global state", "Behavior is not driven by implicit mutable globals.", "Replace hidden globals with explicit dependencies or configuration."),
        (11, "code_quality", "Consistent style", "Formatting and style conventions are consistently applied.", "Adopt and enforce one style guide across the repo."),
        (12, "code_quality", "Clear naming", "Variables, functions, and modules use precise names.", "Rename ambiguous identifiers to reflect intent and scope."),
        (13, "code_quality", "Function size discipline", "Functions remain focused and reasonably small.", "Split large functions into smaller units with single purposes."),
        (14, "code_quality", "Minimal duplication", "Logic is not copy-pasted across the codebase.", "Extract repeated logic into shared helpers or modules."),
        (15, "code_quality", "No dead code", "Unused code paths and files are removed.", "Delete unreachable code and unused assets instead of leaving them dormant."),
        (16, "code_quality", "No commented-out logic", "Inactive code is not left commented in source files.", "Remove commented code and rely on version control history."),
        (17, "code_quality", "Minimal magic constants", "Important numeric or string literals are named and centralized.", "Promote repeated literals to named constants with intent."),
        (18, "code_quality", "Proper typing", "Type boundaries are explicit and loosely typed escape hatches are limited.", "Tighten boundary contracts and remove broad dynamic types."),
        (19, "code_quality", "No TODO landmines", "Deferred work is tracked intentionally instead of left inline without ownership.", "Convert risky TODOs into tracked issues or complete them."),
        (20, "code_quality", "Commit hygiene / readable diffs", "Changes are organized into reviewable commits and diffs.", "Split broad changes into focused commits and smaller PRs."),
        (21, "correctness", "Edge case handling", "Known edge cases are identified and handled deliberately.", "Enumerate edge cases and add explicit handling for them."),
        (22, "correctness", "Input validation coverage", "Inputs are validated before core logic relies on them.", "Add validation at trust boundaries and reject malformed input early."),
        (23, "correctness", "Explicit null/undefined handling", "Nullable or missing values are handled intentionally.", "Make absent values explicit and guard every nullable path."),
        (24, "correctness", "Async error handling correctness", "Async operations propagate failures correctly.", "Handle async failures explicitly and avoid swallowed errors."),
        (25, "correctness", "Race condition risk addressed", "Concurrency hazards are identified and controlled.", "Protect shared state and sequence-sensitive operations."),
        (26, "correctness", "Idempotency where needed", "Repeatable operations behave safely under retries.", "Add idempotency keys or dedupe logic for retryable flows."),
        (27, "correctness", "Deterministic behavior under retries", "Retries do not create inconsistent outcomes.", "Define retry semantics and make side effects retry-safe."),
        (28, "correctness", "No hidden mutation side effects", "Mutations are visible and do not surprise callers.", "Reduce shared mutable state and return new values where practical."),
        (29, "correctness", "Clear invariants", "Critical assumptions are defined and enforced.", "Document invariants and assert them at boundaries."),
        (30, "correctness", "No timing hacks as control flow", "Behavior does not depend on fragile sleeps or timing tricks.", "Replace timing-based coordination with explicit signals or retries."),
        (31, "security", "Secrets management", "Secrets are not committed and are handled through secure mechanisms.", "Move secrets to a managed store and rotate any exposed credentials."),
        (32, "security", "Proper environment separation", "Environments are isolated with distinct config and access patterns.", "Separate dev, staging, and prod credentials and config paths."),
        (33, "security", "Auth flow correctness", "Authentication paths are complete and resistant to common failure modes.", "Review auth flows end to end and close token/session gaps."),
        (34, "security", "Authorization enforced server-side", "Access control checks are enforced on trusted server boundaries.", "Move authorization checks to server-side policy enforcement."),
        (35, "security", "Input sanitization", "Untrusted inputs are sanitized or encoded appropriately.", "Apply context-appropriate sanitization and output encoding."),
        (36, "security", "No client-side-only trust", "Security decisions are not delegated solely to the client.", "Revalidate client assertions on trusted backend paths."),
        (37, "security", "Dependency vulnerability awareness", "Dependency risk is monitored and acted on.", "Track dependency advisories and patch vulnerable packages promptly."),
        (38, "security", "Rate limiting / abuse controls where relevant", "Abuse protections exist for exposed, high-risk surfaces.", "Add rate limits, quotas, or anti-abuse controls on exposed endpoints."),
        (39, "security", "Secure default configs", "Default configuration values fail closed where possible.", "Harden defaults so insecure settings require explicit opt-in."),
        (40, "security", "CORS not over-permissive", "Cross-origin access is scoped narrowly to intended origins.", "Restrict CORS policies to the minimum required origins and methods."),
        (41, "performance", "Avoid obvious N+1", "The system avoids repeated avoidable per-item work on hot paths.", "Batch or prefetch data to remove obvious N+1 behavior."),
        (42, "performance", "Avoid unbounded memory growth", "Memory usage is bounded during normal and peak operation.", "Add caps, streaming, or eviction policies for large workloads."),
        (43, "performance", "Avoid unnecessary re-renders", "Frontend render work is controlled where applicable.", "Reduce avoidable renders by stabilizing state flow and component boundaries."),
        (44, "performance", "Avoid blocking I/O on hot paths", "Latency-sensitive paths do not block on slow synchronous I/O.", "Move blocking work off hot paths or make it asynchronous."),
        (45, "performance", "Bundle size sanity", "Delivered bundles remain proportionate to user needs.", "Audit large dependencies and trim client payloads."),
        (46, "performance", "Caching strategy where needed", "Caching is used intentionally for repeated expensive work.", "Introduce scoped caching with invalidation rules where it pays off."),
        (47, "performance", "Backpressure handling where needed", "The system degrades safely under load instead of queueing forever.", "Add bounded queues, backpressure, or load-shedding policies."),
        (48, "performance", "Efficient data structures", "Core paths use data structures that fit their access patterns.", "Replace poorly matched structures on hot paths with better-fitting ones."),
        (49, "performance", "Cold start sensitivity addressed", "Startup latency is considered for serverless or short-lived runtimes.", "Reduce startup work or prewarm critical paths where needed."),
        (50, "performance", "Concurrency behavior understood", "Concurrency limits and behavior are known and intentionally configured.", "Document and tune concurrency settings for expected workloads."),
        (51, "observability", "Structured logging", "Logs are machine-parseable and consistent.", "Emit structured logs with stable fields for key events."),
        (52, "observability", "Meaningful error messages", "Errors are actionable for operators and developers.", "Improve error messages with context, cause, and next action."),
        (53, "observability", "Metrics for critical paths", "Critical user or system flows have measurable metrics.", "Instrument latency, throughput, and error metrics on key paths."),
        (54, "observability", "Health checks", "Health or readiness probes exist where the system needs them.", "Add targeted health checks for dependencies and service readiness."),
        (55, "observability", "No silent failures", "Failures are surfaced to operators instead of disappearing.", "Convert silent catch blocks into explicit logging or error handling."),
        (56, "observability", "Correlation IDs / request tracing", "Cross-service requests can be traced end to end where applicable.", "Propagate correlation IDs through request and job boundaries."),
        (57, "observability", "Alertability", "There is a clear signal for incidents that should page an operator.", "Define alert conditions tied to actionable user or system impact."),
        (58, "observability", "SLO thinking", "Latency and reliability targets are defined or at least considered.", "Establish practical service objectives for critical paths."),
        (59, "observability", "Crash-safe behavior / graceful shutdown", "The system handles crashes or shutdowns without corrupting state.", "Add graceful shutdown hooks and protect in-flight work."),
        (60, "observability", "Feature flags or safe rollout mechanisms", "Risky changes can be rolled out progressively where applicable.", "Introduce feature flags or staged rollout controls for risky changes."),
        (61, "testing", "Unit tests for business logic", "Core business rules are covered by unit tests.", "Add fast unit tests around business-critical logic."),
        (62, "testing", "Integration tests for boundaries", "Key boundary interactions are covered by integration tests.", "Add integration tests around databases, queues, and external APIs."),
        (63, "testing", "E2E tests for critical flows", "Critical user journeys are validated end to end.", "Automate end-to-end checks for the highest-value workflows."),
        (64, "testing", "Deterministic test setup", "Tests run from a controlled and reproducible setup.", "Remove hidden environmental dependencies from test setup."),
        (65, "testing", "No flaky tests", "Tests pass reliably without intermittent failures.", "Eliminate timing and shared-state causes of flaky tests."),
        (66, "testing", "Test coverage of error paths", "Failure paths are explicitly tested, not just happy paths.", "Add tests for validation errors, retries, and downstream failures."),
        (67, "testing", "Mocks not leaking abstractions", "Mocks support behavior verification without distorting the real design.", "Use thinner mocks or more integration tests at abstraction boundaries."),
        (68, "testing", "Regression tests for known bugs", "Past defects are captured in repeatable tests.", "Add a regression test whenever a production bug is fixed."),
        (69, "testing", "Performance tests", "Performance-sensitive systems have relevant load or benchmark coverage.", "Add targeted performance checks for critical throughput or latency paths."),
        (70, "testing", "Security tests / basic checks", "Basic security behaviors are validated with tests or automated checks.", "Add security-focused validation for auth, access, and input handling."),
        (71, "devex", "Clear README", "The repo explains what it is, how to run it, and how to contribute.", "Expand the README with setup, usage, and operational notes."),
        (72, "devex", "Setup reproducibility", "New contributors can reproduce setup with minimal tribal knowledge.", "Automate setup steps and remove manual drift-prone instructions."),
        (73, "devex", "Env var documentation", "Required configuration is documented with clear defaults or examples.", "Document every required environment variable and its purpose."),
        (74, "devex", "Linting + formatting enforced", "Formatting and lint checks are automated and expected.", "Add lint and format checks to local workflows and CI."),
        (75, "devex", "CI pipeline exists", "A continuous integration pipeline validates core quality signals.", "Add CI that runs the minimum reliable test and lint suite."),
        (76, "devex", "Build reproducibility", "Build outputs can be reproduced from source consistently.", "Pin build inputs and document reproducible build steps."),
        (77, "devex", "Deployment strategy clear", "Deployment flow and ownership are documented clearly.", "Document how releases are promoted and who owns each step."),
        (78, "devex", "Versioning discipline", "Releases follow a consistent versioning approach.", "Adopt and enforce a documented versioning policy."),
        (79, "devex", "DB migrations strategy", "Database schema changes follow a safe, repeatable process where relevant.", "Adopt versioned migrations and document rollback expectations."),
        (80, "devex", "Rollback capability", "There is a practical path to revert a bad release.", "Define and test a rollback path before shipping risky changes."),
        (81, "code_quality", "No overuse of libs for trivial logic", "Trivial problems are not solved with unnecessary dependencies.", "Remove low-value dependencies and keep simple logic in-house."),
        (82, "architecture", "No needless abstraction depth", "Abstractions exist to serve real complexity, not imagined future needs.", "Collapse indirection layers that do not buy flexibility."),
        (83, "architecture", "Domain model clarity", "The domain model is visible and maps cleanly to the problem space.", "Make domain concepts explicit in types, modules, and language."),
        (84, "architecture", "Consistent architecture across files", "Architectural patterns are applied consistently throughout the repo.", "Standardize file patterns and refactor outliers toward them."),
        (85, "architecture", "Folder structure is coherent", "Repository structure reflects system boundaries and is navigable.", "Reorganize folders so related code lives together predictably."),
        (86, "code_quality", "Utility modules not dumping ground", "Shared helpers remain focused instead of becoming miscellaneous buckets.", "Split catch-all utility files into domain-specific modules."),
        (87, "devex", "Decision records for complex choices", "Important technical decisions are documented and traceable.", "Capture major design decisions in lightweight ADRs or equivalent notes."),
        (88, "code_quality", "PRs not entire app in one commit", "Changes are reviewed in focused increments instead of giant dumps.", "Break work into smaller reviewable slices with clear intent."),
        (89, "code_quality", "Typed boundaries at API layer", "API contracts are explicit and validated at boundaries.", "Define and enforce request and response schemas at API edges."),
        (90, "devex", "No works on my machine config", "Local configuration is portable and does not rely on one developer environment.", "Remove machine-specific assumptions from setup and runtime config."),
        (91, "devex", "Prompt/versioning if AI used", "AI prompts or orchestration logic are versioned where relevant.", "Version prompts and record the variants deployed to production."),
        (92, "devex", "Model version pinning if AI used", "AI model identifiers are pinned instead of floating silently.", "Pin model versions and document upgrade review steps."),
        (93, "correctness", "Output validation if AI used", "AI-generated outputs are validated before being trusted.", "Validate model outputs against schemas or business rules."),
        (94, "devex", "Temperature/config explicit if AI used", "AI runtime settings are explicit and reviewable.", "Make model parameters explicit in code or config."),
        (95, "observability", "Guardrails/fallbacks if AI used", "AI features fail safely and degrade gracefully when needed.", "Add fallback behavior and guardrails for unsafe or failed model responses."),
        (96, "performance", "Token/cost awareness if AI used", "AI usage cost and token consumption are measured and bounded.", "Track token usage and cap expensive calls where practical."),
        (97, "performance", "Latency budgets if AI used", "AI-dependent features have explicit latency expectations.", "Define latency budgets and design around them."),
        (98, "observability", "Audit logging if AI used", "AI actions and high-risk outputs are logged for review.", "Record auditable logs for AI decisions and tool actions."),
        (99, "security", "No blind trust in model outputs if AI used", "Model outputs are treated as untrusted input.", "Add verification, policy checks, or human review for risky model output."),
        (100, "devex", "Clear support boundaries if automating external UIs", "Operational ownership and support limits are defined for fragile automations.", "Document what UI automations are supported and where operators intervene."),
    ]
    return [
        Checkpoint(
            id=checkpoint_id,
            category_key=category_key,
            title=title,
            description=description,
            remediation_hint=remediation_hint,
            is_critical=checkpoint_id in CRITICAL_CHECKPOINT_IDS,
        )
        for checkpoint_id, category_key, title, description, remediation_hint in definitions
    ]


CHECKPOINTS: List[Checkpoint] = _build_checkpoints()
CHECKPOINT_BY_ID: Dict[int, Checkpoint] = {checkpoint.id: checkpoint for checkpoint in CHECKPOINTS}


def validate_catalog() -> None:
    if len(CHECKPOINTS) != 100:
        raise ValueError(f"Expected 100 checkpoints, found {len(CHECKPOINTS)}")
    if abs(sum(category.weight for category in CATEGORIES) - 1.0) > 1e-9:
        raise ValueError("Category weights must sum to 1.0")
    missing = sorted(set(range(1, 101)) - set(CHECKPOINT_BY_ID))
    if missing:
        raise ValueError(f"Missing checkpoint ids: {missing}")


validate_catalog()


def create_template_payload() -> Dict[str, Any]:
    return {
        "metadata": {
            "version": 1,
            "notes": [
                "Use numeric scores from 0.0 to 5.0.",
                "Use null or the string 'NA' for genuinely not-applicable checkpoints.",
            ],
        },
        "scores": {str(checkpoint.id): None for checkpoint in CHECKPOINTS},
    }


def create_overrides_template_payload() -> Dict[str, Any]:
    return {
        "metadata": {
            "version": 1,
            "notes": [
                "Provide only the checkpoint ids you want to override.",
                "Values must be numbers from 0.0 to 5.0, null, or 'NA'.",
            ],
        },
        "scores": {},
    }


def _coerce_score_value(raw_value: Any, checkpoint_id: int) -> Optional[float]:
    if raw_value is None:
        return None
    if isinstance(raw_value, str):
        normalized = raw_value.strip()
        if not normalized:
            return None
        if normalized.upper() == NA_VALUE:
            return None
        try:
            raw_value = float(normalized)
        except ValueError as exc:
            raise ValueError(f"Checkpoint {checkpoint_id}: invalid score '{raw_value}'") from exc
    if isinstance(raw_value, bool):
        raise ValueError(f"Checkpoint {checkpoint_id}: boolean is not a valid score")
    if isinstance(raw_value, (int, float)):
        value = float(raw_value)
        if value < 0.0 or value > 5.0:
            raise ValueError(f"Checkpoint {checkpoint_id}: score must be between 0 and 5")
        return value
    raise ValueError(f"Checkpoint {checkpoint_id}: unsupported score type {type(raw_value).__name__}")


def normalize_scores(payload: Any) -> Dict[int, Optional[float]]:
    if isinstance(payload, dict) and "scores" in payload:
        payload = payload["scores"]

    raw_scores: Dict[int, Any] = {}
    if isinstance(payload, dict):
        for key, value in payload.items():
            try:
                checkpoint_id = int(key)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Invalid checkpoint id key: {key!r}") from exc
            raw_scores[checkpoint_id] = value
    elif isinstance(payload, list):
        if len(payload) != 100:
            raise ValueError("List input must contain exactly 100 entries")
        raw_scores = {index + 1: value for index, value in enumerate(payload)}
    else:
        raise ValueError("Input must be a JSON object with a 'scores' map or a 100-item list")

    missing = sorted(set(CHECKPOINT_BY_ID) - set(raw_scores))
    extra = sorted(set(raw_scores) - set(CHECKPOINT_BY_ID))
    if missing:
        raise ValueError(f"Missing scores for checkpoint ids: {missing}")
    if extra:
        raise ValueError(f"Unknown checkpoint ids in input: {extra}")

    return {checkpoint_id: _coerce_score_value(value, checkpoint_id) for checkpoint_id, value in sorted(raw_scores.items())}


def normalize_partial_scores(payload: Any) -> Dict[int, Optional[float]]:
    if isinstance(payload, dict) and "scores" in payload:
        payload = payload["scores"]
    if not isinstance(payload, dict):
        raise ValueError("Override input must be a JSON object or an object with a 'scores' map")

    normalized: Dict[int, Optional[float]] = {}
    for key, value in payload.items():
        try:
            checkpoint_id = int(key)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Invalid checkpoint id key: {key!r}") from exc
        if checkpoint_id not in CHECKPOINT_BY_ID:
            raise ValueError(f"Unknown checkpoint id in overrides: {checkpoint_id}")
        normalized[checkpoint_id] = _coerce_score_value(value, checkpoint_id)
    return normalized


def _round_score(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return round(value, 4)


def compute_report(
    scores: Dict[int, Optional[float]],
    assessments: Optional[Dict[int, Dict[str, Any]]] = None,
    report_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if set(scores) != set(CHECKPOINT_BY_ID):
        raise ValueError("Scores must include all checkpoint ids 1..100")

    checkpoint_entries: List[Dict[str, Any]] = []
    category_buckets: Dict[str, Dict[str, Any]] = {
        category.key: {
            "category_key": category.key,
            "category_name": category.name,
            "weight": category.weight,
            "scores": [],
            "na_count": 0,
            "total_checkpoints": 0,
        }
        for category in CATEGORIES
    }

    for checkpoint in CHECKPOINTS:
        score = scores[checkpoint.id]
        bucket = category_buckets[checkpoint.category_key]
        bucket["total_checkpoints"] += 1
        if score is None:
            bucket["na_count"] += 1
        else:
            bucket["scores"].append(score)
        checkpoint_entries.append(
            {
                "id": checkpoint.id,
                "category_key": checkpoint.category_key,
                "category_name": CATEGORY_BY_KEY[checkpoint.category_key].name,
                "title": checkpoint.title,
                "description": checkpoint.description,
                "remediation_hint": checkpoint.remediation_hint,
                "is_critical": checkpoint.is_critical,
                "score": _round_score(score),
                "applicable": score is not None,
                "assessment_source": (
                    assessments.get(checkpoint.id, {}).get("source")
                    if assessments
                    else "manual"
                ),
                "assessment_confidence": (
                    assessments.get(checkpoint.id, {}).get("confidence")
                    if assessments
                    else "high"
                ),
                "assessment_rationale": (
                    assessments.get(checkpoint.id, {}).get("rationale")
                    if assessments
                    else "Manual score entry."
                ),
                "assessment_evidence": (
                    assessments.get(checkpoint.id, {}).get("evidence", [])
                    if assessments
                    else []
                ),
            }
        )

    category_rollups: List[Dict[str, Any]] = []
    failed_gates = {
        "category_gates": [],
        "critical_checkpoint_gates": [],
        "total_score_gate": None,
    }
    weighted_total = 0.0

    for category in CATEGORIES:
        bucket = category_buckets[category.key]
        applicable_scores = bucket["scores"]
        average = sum(applicable_scores) / len(applicable_scores) if applicable_scores else None
        contribution = (average * category.weight) if average is not None else 0.0
        weighted_total += contribution
        na_ratio = bucket["na_count"] / bucket["total_checkpoints"] if bucket["total_checkpoints"] else 0.0
        warning = None
        if na_ratio > CATEGORY_NA_WARNING_RATIO:
            warning = (
                f"High NA ratio: {bucket['na_count']} of {bucket['total_checkpoints']} checkpoints "
                f"marked not applicable."
            )
        if average is None or average < CATEGORY_PASS_THRESHOLD:
            failed_gates["category_gates"].append(
                {
                    "category_key": category.key,
                    "category_name": category.name,
                    "score": _round_score(average),
                    "threshold": CATEGORY_PASS_THRESHOLD,
                    "reason": "Category score below threshold" if average is not None else "No scored checkpoints in category",
                }
            )
        category_rollups.append(
            {
                "category_key": category.key,
                "category_name": category.name,
                "weight": category.weight,
                "score": _round_score(average),
                "weighted_contribution": _round_score(contribution),
                "applicable_count": len(applicable_scores),
                "na_count": bucket["na_count"],
                "total_checkpoints": bucket["total_checkpoints"],
                "warning": warning,
            }
        )

    for checkpoint in checkpoint_entries:
        if checkpoint["is_critical"] and checkpoint["score"] is not None and checkpoint["score"] < CRITICAL_PASS_THRESHOLD:
            failed_gates["critical_checkpoint_gates"].append(
                {
                    "id": checkpoint["id"],
                    "title": checkpoint["title"],
                    "score": checkpoint["score"],
                    "threshold": CRITICAL_PASS_THRESHOLD,
                    "category_name": checkpoint["category_name"],
                    "reason": "Critical checkpoint below threshold",
                }
            )

    total_score = _round_score(weighted_total) or 0.0
    if total_score < TOTAL_PASS_THRESHOLD:
        failed_gates["total_score_gate"] = {
            "score": total_score,
            "threshold": TOTAL_PASS_THRESHOLD,
            "reason": "Weighted total score below threshold",
        }

    lowest_scored = sorted(
        (entry for entry in checkpoint_entries if entry["score"] is not None),
        key=lambda item: (item["score"], item["id"]),
    )[:10]
    top_issues = [
        {
            "id": entry["id"],
            "title": entry["title"],
            "score": entry["score"],
            "category_name": entry["category_name"],
            "remediation_hint": entry["remediation_hint"],
        }
        for entry in lowest_scored
    ]

    did_fail = (
        bool(failed_gates["category_gates"])
        or bool(failed_gates["critical_checkpoint_gates"])
        or failed_gates["total_score_gate"] is not None
    )

    source_counts: Dict[str, int] = {}
    confidence_counts: Dict[str, int] = {}
    for entry in checkpoint_entries:
        source = entry["assessment_source"] or "unknown"
        confidence = entry["assessment_confidence"] or "unknown"
        source_counts[source] = source_counts.get(source, 0) + 1
        confidence_counts[confidence] = confidence_counts.get(confidence, 0) + 1

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "checkpoint_scores": checkpoint_entries,
        "category_rollups": category_rollups,
        "total_score": total_score,
        "pass": not did_fail,
        "status": "PASS" if not did_fail else "FAIL",
        "failed_gates": failed_gates,
        "top_issues": top_issues,
        "assessment_summary": {
            "by_source": source_counts,
            "by_confidence": confidence_counts,
        },
        "report_metadata": report_metadata or {},
    }


def category_label_mapping_notes() -> List[str]:
    return [
        "Checkpoints 81-100 are mapped into the 8 weighted categories instead of a ninth weighted bucket.",
        "AI-specific checkpoints are distributed by intent: architecture, code quality, correctness, security, performance, observability, and DevEx.",
    ]


def iter_checkpoints() -> Iterable[Checkpoint]:
    return CHECKPOINTS
