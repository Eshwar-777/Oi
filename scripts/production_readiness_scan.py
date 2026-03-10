#!/usr/bin/env python3
"""Repository scan heuristics for hybrid production-readiness scoring."""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


MAX_TEXT_FILE_SIZE = 1024 * 1024
SKIP_DIRS = {
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    "coverage",
    ".turbo",
    ".pnpm-store",
    ".idea",
    ".vscode",
}
TEXT_EXTENSIONS = {
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".cfg",
    ".sh",
    ".sql",
    ".env",
    ".rules",
    ".html",
    ".css",
}


@dataclass
class RepoSignals:
    root: Path
    file_paths: List[str]
    text_files: Dict[str, str]
    total_files: int
    source_files: int
    test_files: int
    todo_count: int
    any_count: int
    commented_logic_count: int
    localhost_refs: int
    sleep_refs: int
    empty_catch_count: int
    bare_except_pass_count: int
    has_readme: bool
    has_ci: bool
    has_lockfile: bool
    has_env_example: bool
    has_deploy_script: bool
    has_bootstrap_script: bool
    has_docker: bool
    has_terraform: bool
    has_architecture_docs: bool
    has_decision_records: bool
    has_versioning_signals: bool
    has_migrations: bool
    has_health_checks: bool
    has_metrics: bool
    has_logging: bool
    has_tracing: bool
    has_alerting: bool
    has_slo: bool
    has_shutdown: bool
    has_feature_flags: bool
    has_auth: bool
    has_authorization: bool
    has_validation: bool
    has_rate_limiting: bool
    has_guardrails: bool
    has_fallbacks: bool
    has_caching: bool
    has_backpressure: bool
    has_concurrency_controls: bool
    has_cold_start_signals: bool
    has_latency_budget: bool
    has_token_cost_tracking: bool
    has_audit_logging: bool
    has_prompt_assets: bool
    has_model_pinning: bool
    has_output_validation: bool
    has_explicit_model_config: bool
    has_api_schemas: bool
    has_domain_dirs: bool
    has_service_dirs: bool
    has_module_boundaries: bool
    has_store_state: bool
    has_error_handling: bool
    has_test_fixtures: bool
    has_perf_tests: bool
    has_security_tests: bool
    has_e2e_tests: bool
    has_integration_tests: bool
    has_unit_tests: bool
    has_regression_tests: bool
    has_mocking: bool
    has_retry_logic: bool
    has_idempotency: bool
    has_typescript: bool
    has_python: bool
    has_frontend: bool
    has_backend: bool
    cors_star: bool
    secret_findings: List[str]
    utility_dump_files: List[str]
    long_function_count: int
    repo_root_junk_count: int
    commit_count: int
    commit_messages: List[str]
    import_cycle_count: int


def _iter_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIRS]
        for filename in filenames:
            yield Path(dirpath) / filename


def _is_text_file(path: Path) -> bool:
    if path.suffix.lower() in TEXT_EXTENSIONS:
        return True
    return path.name in {"Dockerfile", "Makefile", ".env.example"}


def _read_text(path: Path) -> Optional[str]:
    try:
        if path.stat().st_size > MAX_TEXT_FILE_SIZE:
            return None
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def _run_git(root: Path, args: List[str]) -> str:
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError:
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def _count_regex(pattern: str, text: str) -> int:
    return len(re.findall(pattern, text, flags=re.MULTILINE))


def _detect_local_import_cycles(text_files: Dict[str, str]) -> int:
    graph: Dict[str, Set[str]] = {}
    normalized_paths = {path.replace("\\", "/"): path.replace("\\", "/") for path in text_files}

    for rel_path, content in text_files.items():
        if not rel_path.endswith((".ts", ".tsx", ".js", ".jsx")):
            continue
        module_path = rel_path.replace("\\", "/")
        graph.setdefault(module_path, set())
        base_dir = str(Path(module_path).parent).replace("\\", "/")
        for match in re.finditer(r'import\s+.*?from\s+[\'"](\.[^\'"]+)[\'"]', content):
            target = match.group(1)
            resolved = (Path(base_dir) / target).resolve().as_posix()
            for suffix in (".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"):
                candidate = resolved + suffix if not suffix.startswith("/") else resolved + suffix
                try:
                    relative = str(Path(candidate).relative_to(Path.cwd())).replace("\\", "/")
                except Exception:
                    relative = candidate
                if relative in normalized_paths:
                    graph[module_path].add(relative)
                    break

    visited: Set[str] = set()
    stack: Set[str] = set()
    cycles = 0

    def dfs(node: str) -> None:
        nonlocal cycles
        visited.add(node)
        stack.add(node)
        for neighbor in graph.get(node, set()):
            if neighbor not in visited:
                dfs(neighbor)
            elif neighbor in stack:
                cycles += 1
        stack.remove(node)

    for node in graph:
        if node not in visited:
            dfs(node)
    return cycles


def scan_repository(root: Path) -> RepoSignals:
    root = root.resolve()
    file_paths: List[str] = []
    text_files: Dict[str, str] = {}
    total_files = 0
    source_files = 0
    test_files = 0
    todo_count = 0
    any_count = 0
    commented_logic_count = 0
    localhost_refs = 0
    sleep_refs = 0
    empty_catch_count = 0
    bare_except_pass_count = 0
    secret_findings: List[str] = []
    utility_dump_files: List[str] = []
    long_function_count = 0

    for path in _iter_files(root):
        rel_path = str(path.relative_to(root))
        rel_lower = rel_path.lower()
        file_paths.append(rel_path)
        total_files += 1

        if rel_lower.endswith((".py", ".js", ".jsx", ".ts", ".tsx")):
            source_files += 1
        if any(token in rel_lower for token in ("test", "spec", "__tests__", "e2e", "integration")):
            test_files += 1

        if "util" in rel_lower or "helper" in rel_lower:
            try:
                if path.stat().st_size > 12_000:
                    utility_dump_files.append(rel_path)
            except OSError:
                pass

        if not _is_text_file(path):
            continue
        content = _read_text(path)
        if content is None:
            continue
        text_files[rel_path] = content
        lowered = content.lower()

        todo_count += lowered.count("todo") + lowered.count("fixme")
        any_count += _count_regex(r"\bany\b", content)
        commented_logic_count += _count_regex(r"^\s*(#|//|/\*)\s*(if|for|while|return|const|let|var|function|class)\b", content)
        localhost_refs += lowered.count("localhost") + lowered.count("127.0.0.1")
        sleep_refs += lowered.count("sleep(") + lowered.count("settimeout(")
        empty_catch_count += _count_regex(r"catch\s*\([^)]*\)\s*\{\s*\}", content)
        bare_except_pass_count += _count_regex(r"except\s*:\s*pass", lowered)

        probable_secret_pattern = re.compile(
            r"(api[_-]?key|secret|token|password)\s*[:=]\s*['\"]([A-Za-z0-9_\-]{20,}|sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_\-]{16,})['\"]",
            flags=re.IGNORECASE,
        )
        if probable_secret_pattern.search(content):
            if ".example" not in rel_lower and "test" not in rel_lower:
                secret_findings.append(rel_path)

        if rel_path.endswith(".py"):
            long_function_count += sum(
                1
                for match in re.finditer(r"(?m)^def\s+\w+\(.*\):", content)
                if len(content[match.start():].splitlines()[:80]) >= 80
            )
        if rel_path.endswith((".ts", ".tsx", ".js", ".jsx")):
            long_function_count += _count_regex(r"function\s+\w+\([^)]*\)\s*\{(?:.|\n){800,}?\}", content)

    lower_paths = [path.lower() for path in file_paths]
    text_blob = "\n".join(text_files.values()).lower()

    ci_paths = [path for path in lower_paths if ".github/workflows/" in path or "gitlab-ci" in path or "azure-pipelines" in path]
    architecture_docs = any("architecture" in path or "production_checklist" in path for path in lower_paths)
    decision_records = any("adr" in path or "decision" in path for path in lower_paths)
    versioning_signals = any("changelog" in path for path in lower_paths) or "version" in text_blob
    migrations = any(token in path for path in lower_paths for token in ("migration", "alembic", "prisma", "flyway"))
    health_checks = "healthcheck" in text_blob or "/health" in text_blob or "readiness" in text_blob
    metrics = any(token in text_blob for token in ("metrics", "prometheus", "telemetry", "histogram", "counter("))
    logging = any(token in text_blob for token in ("logger.", "logging.", "structlog", "loguru", "winston", "pino"))
    tracing = any(token in text_blob for token in ("trace_id", "correlation id", "correlation_id", "request_id", "opentelemetry"))
    alerting = any(token in text_blob for token in ("pagerduty", "alert", "oncall", "page you"))
    slo = any(token in text_blob for token in ("slo", "sla", "error budget", "latency budget"))
    shutdown = any(token in text_blob for token in ("graceful shutdown", "shutdown", "sigterm", "signal.signal"))
    feature_flags = any(token in text_blob for token in ("feature flag", "launchdarkly", "flagsmith", "flag_"))
    auth = any(token in text_blob for token in ("auth", "oauth", "jwt", "session"))
    authorization = any(token in text_blob for token in ("permission", "authorize", "rbac", "role", "policy"))
    validation = any(token in text_blob for token in ("validate", "schema", "pydantic", "zod", "joi", "marshmallow"))
    rate_limiting = any(token in text_blob for token in ("rate limit", "ratelimit", "throttle", "quota"))
    guardrails = any(token in text_blob for token in ("guardrail", "safety", "policy check"))
    fallbacks = any(token in text_blob for token in ("fallback", "degrade gracefully", "circuit breaker"))
    caching = any(token in text_blob for token in ("cache", "redis", "memoize"))
    backpressure = any(token in text_blob for token in ("backpressure", "bounded queue", "semaphore", "queue maxsize"))
    concurrency = any(token in text_blob for token in ("concurrency", "parallelism", "pool", "semaphore", "lock"))
    cold_start = "cold start" in text_blob or "serverless" in text_blob
    latency_budget = any(token in text_blob for token in ("latency budget", "timeout budget"))
    token_cost = any(token in text_blob for token in ("token cost", "cost awareness", "token usage", "usage_cost"))
    audit_logging = "audit log" in text_blob or "audit_logging" in text_blob
    prompt_assets = any("prompt" in path for path in lower_paths)
    model_pinning = any(token in text_blob for token in ("gpt-4", "gpt-5", "claude-", "gemini-", "model_version", "model:"))
    output_validation = any(token in text_blob for token in ("output validation", "json schema", "structured output", "validate_output"))
    explicit_model_config = any(token in text_blob for token in ("temperature", "top_p", "max_tokens", "model_config"))
    api_schemas = any(token in text_blob for token in ("schema", "dto", "interface ", "typeddict", "basemodel"))
    domain_dirs = any("/domain/" in f"/{path}" for path in lower_paths)
    service_dirs = any("/service" in f"/{path}" or "/services/" in f"/{path}" for path in lower_paths)
    module_boundaries = any(path.startswith("apps/") or path.startswith("packages/") for path in lower_paths)
    store_state = any(token in text_blob for token in ("store", "context", "state", "reducer"))
    error_handling = any(token in text_blob for token in ("try:", "except", "catch", "error handler", "middleware"))
    test_fixtures = any(token in lower_paths for token in ("fixtures", "factory", "seed"))
    perf_tests = any("perf" in path or "benchmark" in path or "load" in path for path in lower_paths)
    security_tests = any("security" in path for path in lower_paths)
    e2e_tests = any("e2e" in path or "playwright" in path or "cypress" in path for path in lower_paths)
    integration_tests = any("integration" in path for path in lower_paths)
    unit_tests = test_files > 0
    regression_tests = any("regression" in path or "known bug" in text_files.get(path, "").lower() for path in text_files)
    mocking = "mock" in text_blob or "patch(" in text_blob
    retry_logic = "retry" in text_blob or "backoff" in text_blob
    idempotency = "idempot" in text_blob or "dedupe" in text_blob
    has_typescript = any(path.endswith((".ts", ".tsx")) for path in lower_paths)
    has_python = any(path.endswith(".py") for path in lower_paths)
    has_frontend = any(path.startswith("apps/frontend") or path.startswith("apps/web") for path in lower_paths)
    has_backend = any(path.startswith("apps/backend") or "/api/" in path for path in lower_paths)
    cors_star = bool(re.search(r"allow_origins\s*=\s*\[\s*['\"]\*['\"]\s*\]", text_blob)) or "cors(\"*\")" in text_blob
    repo_root_junk_count = len([path for path in file_paths if "/" not in path and path.lower().endswith((".md", ".txt"))]) - 2

    commit_count_raw = _run_git(root, ["rev-list", "--count", "HEAD"])
    commit_count = int(commit_count_raw) if commit_count_raw.isdigit() else 0
    commit_messages = [line for line in _run_git(root, ["log", "--pretty=%s", "-20"]).splitlines() if line]

    return RepoSignals(
        root=root,
        file_paths=file_paths,
        text_files=text_files,
        total_files=total_files,
        source_files=source_files,
        test_files=test_files,
        todo_count=todo_count,
        any_count=any_count,
        commented_logic_count=commented_logic_count,
        localhost_refs=localhost_refs,
        sleep_refs=sleep_refs,
        empty_catch_count=empty_catch_count,
        bare_except_pass_count=bare_except_pass_count,
        has_readme=any(path.lower() == "readme.md" for path in file_paths),
        has_ci=bool(ci_paths),
        has_lockfile=any(name in lower_paths for name in ("package-lock.json", "pnpm-lock.yaml", "poetry.lock", "pipfile.lock", "cargo.lock")),
        has_env_example=any(".env.example" in path or "sample.env" in path for path in lower_paths),
        has_deploy_script=any("deploy" in path for path in lower_paths),
        has_bootstrap_script=any("bootstrap" in path or "setup" in path for path in lower_paths),
        has_docker=any("dockerfile" in path or "docker-compose" in path for path in lower_paths),
        has_terraform=any(path.startswith("infra/terraform") for path in lower_paths),
        has_architecture_docs=architecture_docs,
        has_decision_records=decision_records,
        has_versioning_signals=versioning_signals,
        has_migrations=migrations,
        has_health_checks=health_checks,
        has_metrics=metrics,
        has_logging=logging,
        has_tracing=tracing,
        has_alerting=alerting,
        has_slo=slo,
        has_shutdown=shutdown,
        has_feature_flags=feature_flags,
        has_auth=auth,
        has_authorization=authorization,
        has_validation=validation,
        has_rate_limiting=rate_limiting,
        has_guardrails=guardrails,
        has_fallbacks=fallbacks,
        has_caching=caching,
        has_backpressure=backpressure,
        has_concurrency_controls=concurrency,
        has_cold_start_signals=cold_start,
        has_latency_budget=latency_budget,
        has_token_cost_tracking=token_cost,
        has_audit_logging=audit_logging,
        has_prompt_assets=prompt_assets,
        has_model_pinning=model_pinning,
        has_output_validation=output_validation,
        has_explicit_model_config=explicit_model_config,
        has_api_schemas=api_schemas,
        has_domain_dirs=domain_dirs,
        has_service_dirs=service_dirs,
        has_module_boundaries=module_boundaries,
        has_store_state=store_state,
        has_error_handling=error_handling,
        has_test_fixtures=test_fixtures,
        has_perf_tests=perf_tests,
        has_security_tests=security_tests,
        has_e2e_tests=e2e_tests,
        has_integration_tests=integration_tests,
        has_unit_tests=unit_tests,
        has_regression_tests=regression_tests,
        has_mocking=mocking,
        has_retry_logic=retry_logic,
        has_idempotency=idempotency,
        has_typescript=has_typescript,
        has_python=has_python,
        has_frontend=has_frontend,
        has_backend=has_backend,
        cors_star=cors_star,
        secret_findings=secret_findings,
        utility_dump_files=utility_dump_files[:20],
        long_function_count=long_function_count,
        repo_root_junk_count=max(repo_root_junk_count, 0),
        commit_count=commit_count,
        commit_messages=commit_messages,
        import_cycle_count=_detect_local_import_cycles(text_files),
    )


def _assessment(score: float, confidence: str, rationale: str, evidence: List[str], source: str = "auto") -> Dict[str, Any]:
    score = max(0.0, min(5.0, round(score, 2)))
    return {
        "score": score,
        "source": source,
        "confidence": confidence,
        "rationale": rationale,
        "evidence": evidence[:6],
    }


def _bool_score(
    present: bool,
    evidence: List[str],
    positive: str,
    negative: str,
    high_score: float = 4.2,
    low_score: float = 2.2,
    confidence: str = "medium",
) -> Dict[str, Any]:
    return _assessment(high_score if present else low_score, confidence, positive if present else negative, evidence)


def _conditional_assessment(
    condition: bool,
    high_score: float,
    low_score: float,
    confidence: str,
    positive: str,
    negative: str,
    evidence: List[str],
) -> Dict[str, Any]:
    return _assessment(high_score if condition else low_score, confidence, positive if condition else negative, evidence)


def _count_score(
    count: int,
    evidence: List[str],
    rationale: str,
    bad_rationale: str,
    thresholds: Tuple[int, int],
    scores: Tuple[float, float, float],
    confidence: str = "medium",
) -> Dict[str, Any]:
    if count >= thresholds[1]:
        score = scores[2]
    elif count >= thresholds[0]:
        score = scores[1]
    else:
        score = scores[0]
    return _assessment(score, confidence, rationale if count >= thresholds[0] else bad_rationale, evidence)


def auto_assess_repository(root: Path) -> Tuple[Dict[int, Dict[str, Any]], Dict[str, Any]]:
    signals = scan_repository(root)

    def files_matching(substr: str, limit: int = 3) -> List[str]:
        matches = [path for path in signals.file_paths if substr.lower() in path.lower()]
        return matches[:limit]

    assessments: Dict[int, Dict[str, Any]] = {}

    def add(checkpoint_id: int, assessment: Dict[str, Any]) -> None:
        assessments[checkpoint_id] = assessment

    add(1, _bool_score(signals.has_architecture_docs or signals.has_module_boundaries, files_matching("architecture") + files_matching("apps/"), "Architecture is documented or strongly encoded in repo structure.", "No strong architecture documentation or structural pattern detected.", 4.0, 2.5))
    add(2, _bool_score(signals.has_domain_dirs and signals.has_service_dirs, files_matching("domain") + files_matching("service"), "Domain and service layers suggest separation of concerns.", "Layer separation is not strongly encoded in directory structure.", 4.0, 2.4))
    add(3, _bool_score(signals.has_domain_dirs and signals.has_service_dirs, files_matching("domain") + files_matching("infra"), "Repo structure suggests directional dependency boundaries.", "Dependency direction is not obvious from repository structure.", 3.8, 2.6, "low"))
    add(4, _bool_score(signals.has_module_boundaries, files_matching("packages/") + files_matching("apps/"), "Apps/packages structure gives explicit module boundaries.", "Repo layout does not clearly enforce module boundaries.", 4.2, 2.4))
    add(5, _bool_score(signals.has_store_state, files_matching("store") + files_matching("context") + files_matching("state"), "State containers or state modules are present.", "State ownership is not obvious from the code layout.", 3.8, 2.5, "low"))
    add(6, _bool_score(signals.has_service_dirs, files_matching("service"), "Service-oriented modules suggest side effects are separated.", "Side effects appear mixed into general code paths.", 3.7, 2.6, "low"))
    add(7, _bool_score(signals.has_store_state or signals.has_backend, files_matching("router") + files_matching("reducer"), "Flow control modules exist for predictable data movement.", "Data flow is not strongly expressed in routing or state modules.", 3.7, 2.5, "low"))
    add(8, _bool_score(signals.has_error_handling, files_matching("middleware") + files_matching("error"), "Error handling constructs are present.", "Little explicit error propagation strategy was detected.", 3.8, 2.3))
    add(9, _assessment(4.4 if signals.import_cycle_count == 0 else 1.5, "medium", "No local import cycles detected." if signals.import_cycle_count == 0 else "Local import cycles were detected in the scanned dependency graph.", [f"local import cycle count={signals.import_cycle_count}"]))
    add(10, _assessment(3.4 if signals.has_module_boundaries and signals.has_env_example else 2.6, "low", "Config and module boundaries reduce the risk of hidden global state." if signals.has_module_boundaries else "Hidden global state risk remains unclear from static scanning.", files_matching("config") + files_matching(".env")))

    add(11, _bool_score(signals.has_ci or signals.has_lockfile, files_matching("eslint") + files_matching("ruff") + files_matching("prettier"), "Lint or workflow signals suggest consistent style enforcement.", "No strong style enforcement signals detected.", 4.0, 2.4))
    add(12, _assessment(3.4, "low", "Naming quality requires human judgment; static scan gives a neutral draft.", []))
    add(13, _assessment(4.0 if signals.long_function_count < 10 else 2.4, "medium", "Few very long functions were detected." if signals.long_function_count < 10 else "Several large functions suggest weak function-size discipline.", [f"long function count={signals.long_function_count}"]))
    add(14, _assessment(3.1, "low", "Duplication is hard to measure reliably without semantic analysis; using a neutral draft score.", []))
    add(15, _assessment(3.0 if signals.todo_count < 20 else 2.2, "low", "TODO volume is moderate; no obvious dead-code signal dominates." if signals.todo_count < 20 else "High TODO/FIXME count increases dead-code and unfinished-path risk.", [f"todo_count={signals.todo_count}"]))
    add(16, _assessment(4.2 if signals.commented_logic_count == 0 else 2.0, "medium", "No obvious commented-out logic patterns detected." if signals.commented_logic_count == 0 else "Commented-out logic patterns were detected.", [f"commented_logic_count={signals.commented_logic_count}"]))
    add(17, _assessment(3.0, "low", "Magic constant usage is difficult to score statically without language-aware parsing.", []))
    add(18, _assessment(4.2 if signals.has_typescript and signals.any_count < 20 else 3.4 if signals.has_python else 2.5, "medium", "Type discipline is supported by TypeScript usage and limited any usage." if signals.has_typescript else "Typing appears mixed or mostly dynamic.", [f"typescript={signals.has_typescript}", f"any_count={signals.any_count}"]))
    add(19, _assessment(4.0 if signals.todo_count < 10 else 2.3, "medium", "TODO/FIXME count is limited." if signals.todo_count < 10 else "TODO/FIXME density suggests deferred-risk landmines.", [f"todo_count={signals.todo_count}"]))
    add(20, _assessment(4.2 if signals.commit_count >= 10 and len(signals.commit_messages) >= 5 else 2.5, "medium", "Commit history shows multiple reviewable units." if signals.commit_count >= 10 else "Commit history is too shallow to demonstrate hygiene confidently.", [f"commit_count={signals.commit_count}"] + signals.commit_messages[:3]))

    add(21, _conditional_assessment(signals.test_files >= 10, 3.7, 2.6, "low", "Test presence suggests some edge-case coverage.", "Sparse testing suggests edge cases may be under-covered.", [f"test_files={signals.test_files}"]))
    add(22, _bool_score(signals.has_validation, files_matching("schema") + files_matching("validate"), "Validation constructs are present at boundaries.", "No strong validation layer signals were detected.", 4.0, 2.2))
    add(23, _assessment(3.2, "low", "Null handling needs code review; static scan assigns a cautious middle score.", []))
    add(24, _assessment(3.6 if signals.has_error_handling else 2.2, "low", "Async/error-handling constructs are present." if signals.has_error_handling else "Little explicit async error-handling evidence was found.", files_matching("async") + files_matching("error")))
    add(25, _conditional_assessment(signals.has_concurrency_controls, 3.5, 2.4, "low", "Concurrency controls are present.", "Concurrency controls were not clearly detected.", files_matching("lock") + files_matching("semaphore")))
    add(26, _conditional_assessment(signals.has_idempotency, 4.0, 2.3, "medium", "Idempotency or dedupe logic is present.", "No idempotency signals were detected.", files_matching("idempot") + files_matching("dedupe")))
    add(27, _conditional_assessment(signals.has_idempotency and signals.has_retry_logic, 4.0, 2.4, "medium", "Retry and idempotency signals suggest deterministic retry behavior.", "Retry behavior is present without enough deterministic-safety evidence.", files_matching("retry") + files_matching("idempot")))
    add(28, _assessment(3.1, "low", "Mutation side effects are difficult to score statically without deeper semantic analysis.", []))
    add(29, _conditional_assessment(signals.has_validation or signals.has_api_schemas, 3.8, 2.5, "low", "Schemas or validators suggest explicit invariants.", "Few invariants were visible in schemas or validators.", files_matching("schema") + files_matching("models")))
    add(30, _assessment(4.2 if signals.sleep_refs == 0 else 1.8, "medium", "No obvious sleep/timing hacks were found." if signals.sleep_refs == 0 else "Timing-based control flow signals were detected.", [f"sleep_refs={signals.sleep_refs}"]))

    add(31, _assessment(4.5 if not signals.secret_findings and signals.has_env_example else 1.0 if signals.secret_findings else 2.8, "high", "No hardcoded secret patterns detected and env examples exist." if not signals.secret_findings and signals.has_env_example else "Potential hardcoded secrets were detected." if signals.secret_findings else "No hardcoded secrets found, but secret handling patterns are thin.", signals.secret_findings[:5] or files_matching(".env")))
    add(32, _conditional_assessment(signals.has_env_example and (signals.has_ci or signals.has_terraform), 4.0, 2.4, "medium", "Env examples and environment-specific infrastructure signals exist.", "Environment separation is not well evidenced.", files_matching(".env") + files_matching("terraform") + files_matching("settings")))
    add(33, _conditional_assessment(signals.has_auth and signals.test_files > 0, 4.0, 2.4, "medium", "Auth-related modules and tests are present.", "Auth flow evidence is weak or untested.", files_matching("auth") + files_matching("login") + files_matching("token")))
    add(34, _conditional_assessment(signals.has_authorization and signals.has_backend, 4.1, 2.0, "medium", "Server-side permission or policy constructs are present.", "Server-side authorization enforcement was not clearly detected.", files_matching("permission") + files_matching("policy") + files_matching("role")))
    add(35, _conditional_assessment(signals.has_validation, 4.0, 2.1, "medium", "Validation/sanitization signals are present.", "Input sanitization or validation is not strongly evidenced.", files_matching("validate") + files_matching("schema") + files_matching("sanitize")))
    add(36, _conditional_assessment(signals.has_backend and signals.has_authorization, 4.0, 2.1, "medium", "Backend authz signals reduce client-only trust risk.", "Client-side-only trust cannot be ruled out from the repo signals.", files_matching("middleware") + files_matching("permission")))
    add(37, _conditional_assessment(signals.has_lockfile and signals.has_ci, 3.8, 2.5, "medium", "Lockfiles and CI provide a base for vulnerability hygiene.", "Dependency hygiene signals are weak.", [f"has_lockfile={signals.has_lockfile}", f"has_ci={signals.has_ci}"]))
    add(38, _conditional_assessment(signals.has_rate_limiting, 4.0, 2.2, "medium", "Rate limiting or throttling signals are present.", "No rate limiting or abuse controls were detected.", files_matching("rate") + files_matching("throttle")))
    add(39, _conditional_assessment(signals.has_guardrails or signals.has_env_example, 3.8, 2.6, "low", "Guardrails or explicit config examples suggest safer defaults.", "Secure-default posture is not strongly documented.", files_matching("guardrail") + files_matching("config")))
    add(40, _assessment(4.2 if signals.has_backend and not signals.cors_star else 1.5 if signals.cors_star else 2.8, "medium", "No wildcard CORS configuration was detected." if signals.has_backend and not signals.cors_star else "Wildcard CORS configuration detected." if signals.cors_star else "CORS configuration was not clearly found.", files_matching("cors")))

    add(41, _assessment(3.2, "low", "N+1 behavior requires data-flow review; static scan assigns a cautious middle score.", []))
    add(42, _assessment(3.0, "low", "Memory-bound behavior needs runtime analysis; static scan uses a neutral draft.", []))
    add(43, _conditional_assessment(signals.has_frontend and signals.has_store_state, 3.6, 2.8, "low", "Frontend state organization can reduce unnecessary re-renders.", "Frontend render discipline is not obvious from static signals.", files_matching("reducer") + files_matching("context")))
    add(44, _assessment(3.2 if signals.has_python or signals.has_backend else 2.8, "low", "Hot-path blocking I/O needs profiling; static scan assigns a neutral draft.", []))
    add(45, _assessment(3.2 if signals.has_frontend and signals.has_lockfile else 2.8, "low", "Front-end packaging exists, but bundle governance is not strongly evidenced.", files_matching("vite") + files_matching("webpack")))
    add(46, _conditional_assessment(signals.has_caching, 4.0, 2.4, "medium", "Caching signals are present.", "No caching strategy signals were detected.", files_matching("cache") + files_matching("redis")))
    add(47, _conditional_assessment(signals.has_backpressure, 4.0, 2.2, "medium", "Backpressure or queue-bound controls are present.", "Backpressure handling was not detected.", files_matching("queue") + files_matching("semaphore")))
    add(48, _assessment(3.1, "low", "Data-structure choices need code-level review; static scan uses a cautious middle score.", []))
    add(49, _assessment(4.0 if signals.has_cold_start_signals else 3.0, "low", "Cold-start sensitivity is acknowledged in code or docs." if signals.has_cold_start_signals else "No serverless/cold-start evidence found; neutral draft assigned.", files_matching("serverless")))
    add(50, _conditional_assessment(signals.has_concurrency_controls, 4.0, 2.5, "low", "Concurrency settings or controls are visible.", "Concurrency behavior is not clearly documented or constrained.", files_matching("concurrency") + files_matching("pool")))

    add(51, _conditional_assessment(signals.has_logging, 4.2, 2.2, "medium", "Structured logging signals are present.", "No strong structured logging signals were detected.", files_matching("logging") + files_matching("logger") + files_matching("telemetry")))
    add(52, _conditional_assessment(signals.has_error_handling, 3.6, 2.5, "low", "Error handling paths exist; error-message quality still needs review.", "Little explicit error handling was detected.", files_matching("error")))
    add(53, _conditional_assessment(signals.has_metrics, 4.2, 2.0, "medium", "Metrics or telemetry instrumentation is present.", "No strong metrics instrumentation was detected.", files_matching("telemetry") + files_matching("metric")))
    add(54, _conditional_assessment(signals.has_health_checks, 4.2, 2.0, "medium", "Health or readiness checks are present.", "No health check signals were found.", files_matching("health")))
    add(55, _assessment(4.0 if signals.empty_catch_count == 0 and signals.bare_except_pass_count == 0 else 1.8, "medium", "No silent-failure anti-patterns were detected." if signals.empty_catch_count == 0 and signals.bare_except_pass_count == 0 else "Silent failure patterns were detected.", [f"empty_catch_count={signals.empty_catch_count}", f"bare_except_pass_count={signals.bare_except_pass_count}"]))
    add(56, _conditional_assessment(signals.has_tracing, 4.0, 2.3, "medium", "Tracing or correlation ID signals are present.", "No tracing or correlation-ID signals were detected.", files_matching("trace") + files_matching("request_id")))
    add(57, _conditional_assessment(signals.has_alerting, 4.0, 2.3, "low", "Alerting or incident keywords are present.", "Alerting posture is not visible in the repo.", files_matching("alert") + files_matching("pager")))
    add(58, _conditional_assessment(signals.has_slo, 4.0, 2.1, "low", "SLO or error-budget thinking appears in docs/code.", "No SLO or error-budget signals were detected.", files_matching("slo") + files_matching("budget")))
    add(59, _conditional_assessment(signals.has_shutdown, 4.0, 2.2, "medium", "Graceful shutdown handling is present.", "Graceful shutdown handling was not detected.", files_matching("shutdown") + files_matching("signal")))
    add(60, _conditional_assessment(signals.has_feature_flags, 4.0, 2.4, "medium", "Feature flag or rollout control signals are present.", "No feature flag or rollout controls were detected.", files_matching("flag")))

    add(61, _assessment(4.2 if signals.has_unit_tests else 1.8, "medium", "Unit-style tests are present." if signals.has_unit_tests else "No unit test signal was found.", [f"test_files={signals.test_files}"]))
    add(62, _conditional_assessment(signals.has_integration_tests, 4.0, 2.0, "medium", "Integration tests are present.", "No integration test signals were detected.", files_matching("integration")))
    add(63, _conditional_assessment(signals.has_e2e_tests, 4.0, 2.0, "medium", "E2E or browser-flow tests are present.", "No E2E test signals were detected.", files_matching("e2e") + files_matching("playwright") + files_matching("cypress")))
    add(64, _conditional_assessment(signals.has_test_fixtures, 4.0, 2.6, "low", "Fixtures/factories suggest deterministic test setup.", "Deterministic test setup is not strongly evidenced.", files_matching("fixtures") + files_matching("factory") + files_matching("seed")))
    add(65, _conditional_assessment("flaky" not in "\n".join(signals.commit_messages).lower(), 3.6, 2.0, "low", "No explicit flaky-test signal detected.", "Commit history references flaky tests.", signals.commit_messages[:5]))
    add(66, _conditional_assessment(any("error" in path.lower() or "invalid" in path.lower() for path in signals.file_paths if "test" in path.lower()), 4.0, 2.4, "medium", "Tests appear to cover error or invalid paths.", "Error-path test coverage is not strongly visible.", [path for path in signals.file_paths if "test" in path.lower() and ("error" in path.lower() or "invalid" in path.lower())][:5]))
    add(67, _conditional_assessment(signals.has_mocking and signals.has_integration_tests, 3.5, 2.8, "low", "Mocks exist alongside integration tests, which reduces leakage risk.", "Mocking strategy quality is unclear from static analysis.", files_matching("mock")))
    add(68, _conditional_assessment(signals.has_regression_tests, 4.0, 2.5, "medium", "Regression tests or bug-focused tests are present.", "No explicit regression-test signal was detected.", files_matching("regression") + files_matching("bug")))
    add(69, _conditional_assessment(signals.has_perf_tests, 4.0, 2.2, "medium", "Performance or benchmark tests are present.", "No performance-test signals were detected.", files_matching("perf") + files_matching("benchmark") + files_matching("load")))
    add(70, _conditional_assessment(signals.has_security_tests or signals.has_guardrails, 4.0, 2.3, "medium", "Security-focused tests or checks are present.", "Security test/check signals are weak.", files_matching("security") + files_matching("guardrail")))

    add(71, _assessment(4.5 if signals.has_readme else 1.5, "high", "README is present." if signals.has_readme else "README is missing.", files_matching("readme")))
    add(72, _conditional_assessment(signals.has_bootstrap_script, 4.0, 2.3, "medium", "Bootstrap or setup scripts improve reproducibility.", "No setup automation signal detected.", files_matching("bootstrap") + files_matching("setup")))
    add(73, _conditional_assessment(signals.has_env_example, 4.2, 2.0, "high", "Environment example files are present.", "No environment example/documentation file detected.", files_matching(".env")))
    add(74, _conditional_assessment(signals.has_ci, 4.0, 2.3, "medium", "CI or workflow signals suggest lint/format enforcement can run automatically.", "No CI/workflow signals were detected.", files_matching("eslint") + files_matching("prettier") + files_matching("ruff") + files_matching(".github/workflows")))
    add(75, _assessment(4.5 if signals.has_ci else 1.0, "high", "CI pipeline files are present." if signals.has_ci else "No CI pipeline files were found.", ci_paths if False else files_matching(".github/workflows")))
    add(76, _conditional_assessment(signals.has_lockfile and signals.has_bootstrap_script, 4.0, 2.4, "medium", "Lockfiles and setup scripts support reproducible builds.", "Build reproducibility signals are incomplete.", [f"has_lockfile={signals.has_lockfile}", f"has_bootstrap_script={signals.has_bootstrap_script}"]))
    add(77, _conditional_assessment(signals.has_deploy_script or signals.has_terraform, 4.0, 2.3, "medium", "Deploy scripts or infrastructure code describe deployment.", "Deployment strategy is not clearly encoded in the repo.", files_matching("deploy") + files_matching("terraform")))
    add(78, _conditional_assessment(signals.has_versioning_signals, 3.8, 2.4, "low", "Versioning signals exist in manifests or docs.", "Versioning discipline is not well evidenced.", files_matching("package.json") + files_matching("pyproject") + files_matching("changelog")))
    add(79, _conditional_assessment(signals.has_migrations, 4.0, 2.4, "medium", "Migration tooling or files are present.", "No database migration strategy signals were detected.", files_matching("migration") + files_matching("alembic") + files_matching("prisma")))
    add(80, _conditional_assessment(any("rollback" in path.lower() for path in signals.file_paths), 3.8, 2.4, "low", "Rollback handling is documented or scripted.", "Rollback capability is not clearly documented.", files_matching("rollback")))

    dependency_manifests = len([path for path in signals.file_paths if path.endswith(("package.json", "pyproject.toml", "requirements.txt"))])
    add(81, _conditional_assessment(dependency_manifests < max(6, signals.source_files // 40 + 1), 3.8, 2.6, "low", "Dependency footprint is moderate relative to repo size.", "Dependency footprint may be heavy for the amount of source code.", [f"dependency_manifests={dependency_manifests}", f"source_files={signals.source_files}"]))
    add(82, _conditional_assessment(signals.long_function_count < 10 and signals.repo_root_junk_count < 8, 3.8, 2.6, "low", "Indirection depth does not look excessive from static structure.", "Repo structure hints at unnecessary abstraction or indirection.", [f"long_function_count={signals.long_function_count}", f"root_markdown_count={signals.repo_root_junk_count}"]))
    add(83, _conditional_assessment(signals.has_domain_dirs, 4.0, 2.5, "medium", "Domain-specific modules are present.", "Domain model is not obvious in the repo structure.", files_matching("domain") + files_matching("models")))
    add(84, _conditional_assessment(signals.has_module_boundaries, 4.0, 2.5, "low", "Repo structure is consistent across major areas.", "Architecture consistency is weak in the repo structure.", files_matching("apps/") + files_matching("packages/")))
    add(85, _conditional_assessment(signals.repo_root_junk_count <= 6 and signals.has_module_boundaries, 4.0, 2.4, "medium", "Folder structure is reasonably coherent at the top level.", "Top-level folder structure is noisy or weakly organized.", [f"repo_root_junk_count={signals.repo_root_junk_count}"]))
    add(86, _assessment(4.0 if not signals.utility_dump_files else 2.2, "medium", "No oversized utility dumping-ground files were detected." if not signals.utility_dump_files else "Large utility/helper files suggest dumping-ground risk.", signals.utility_dump_files))
    add(87, _conditional_assessment(signals.has_decision_records, 4.0, 2.2, "medium", "Decision records or architecture docs are present.", "No ADR/decision-record signals were detected.", files_matching("adr") + files_matching("decision")))
    add(88, _conditional_assessment(signals.commit_count >= 10, 4.0, 2.1, "medium", "Commit history suggests work was split over multiple commits.", "Low commit count raises risk of oversized changesets.", [f"commit_count={signals.commit_count}"]))
    add(89, _conditional_assessment(signals.has_api_schemas, 4.1, 2.3, "medium", "Schemas or typed models exist at boundaries.", "Typed API boundaries are not strongly evidenced.", files_matching("schema") + files_matching("api") + files_matching("models")))
    add(90, _assessment(4.0 if signals.has_bootstrap_script and signals.localhost_refs < 20 else 2.3, "medium", "Setup automation reduces machine-specific drift." if signals.has_bootstrap_script else "Machine-specific setup risk remains.", [f"localhost_refs={signals.localhost_refs}"] + files_matching("bootstrap")))
    add(91, _assessment(4.2 if signals.has_prompt_assets else 3.0, "medium", "Prompt assets are versioned in the repo." if signals.has_prompt_assets else "No AI prompt assets detected; neutral score used.", files_matching("prompt")))
    add(92, _conditional_assessment(signals.has_model_pinning, 4.0, 2.6, "medium", "Model identifiers or versions appear explicitly in code/docs.", "No model pinning signal was detected.", files_matching("model") + files_matching("prompt")))
    add(93, _conditional_assessment(signals.has_output_validation, 4.0, 2.5, "medium", "Output validation signals are present.", "No explicit AI output-validation signal was detected.", files_matching("validate") + files_matching("schema") + files_matching("output")))
    add(94, _conditional_assessment(signals.has_explicit_model_config, 4.0, 2.5, "medium", "Model temperature/config appears explicitly configured.", "No explicit model runtime configuration was detected.", files_matching("temperature") + files_matching("config")))
    add(95, _conditional_assessment(signals.has_guardrails or signals.has_fallbacks, 4.2, 2.2, "medium", "Guardrails or fallback paths are present.", "No AI guardrails/fallbacks were detected.", files_matching("guardrail") + files_matching("fallback")))
    add(96, _conditional_assessment(signals.has_token_cost_tracking, 4.0, 2.6, "medium", "Token/cost awareness is visible in code or docs.", "No token or cost-awareness signal was detected.", files_matching("token") + files_matching("cost")))
    add(97, _conditional_assessment(signals.has_latency_budget, 4.0, 2.6, "medium", "Latency budgets are mentioned explicitly.", "No explicit latency-budget signal was detected.", files_matching("latency") + files_matching("timeout")))
    add(98, _conditional_assessment(signals.has_audit_logging, 4.0, 2.5, "medium", "Audit logging signals are present.", "No explicit audit logging signal was detected.", files_matching("audit")))
    add(99, _conditional_assessment(signals.has_output_validation or signals.has_guardrails, 4.0, 2.0, "medium", "Validation/guardrails reduce blind trust in model outputs.", "No strong check against blind trust in model outputs was detected.", files_matching("guardrail") + files_matching("validate")))
    add(100, _conditional_assessment(any("playbook" in path.lower() or "navigator" in path.lower() for path in signals.file_paths), 4.0, 2.4, "medium", "Playbooks or automation docs define support boundaries.", "No clear external-UI support-boundary documentation detected.", files_matching("playbook") + files_matching("navigator")))

    metadata = {
        "mode": "hybrid-auto-scan",
        "scanned_root": str(signals.root),
        "scan_summary": {
            "total_files": signals.total_files,
            "source_files": signals.source_files,
            "test_files": signals.test_files,
            "todo_count": signals.todo_count,
            "secret_findings": signals.secret_findings,
            "commit_count": signals.commit_count,
            "import_cycle_count": signals.import_cycle_count,
        },
    }
    return assessments, metadata


def apply_overrides(
    assessments: Dict[int, Dict[str, Any]],
    overrides: Dict[int, Optional[float]],
) -> Dict[int, Dict[str, Any]]:
    merged = {checkpoint_id: dict(assessment) for checkpoint_id, assessment in assessments.items()}
    for checkpoint_id, score in overrides.items():
        assessment = merged.setdefault(checkpoint_id, {})
        assessment["score"] = score
        assessment["source"] = "override"
        assessment["confidence"] = "high"
        assessment["rationale"] = "Score overridden by user-supplied override file."
        assessment["evidence"] = assessment.get("evidence", [])
    return merged


def assessments_to_scores(assessments: Dict[int, Dict[str, Any]]) -> Dict[int, Optional[float]]:
    return {checkpoint_id: assessment.get("score") for checkpoint_id, assessment in assessments.items()}
