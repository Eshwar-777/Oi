#!/usr/bin/env python3
"""CLI for production-readiness scoring of vibe-coded repositories."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from production_readiness_core import (
    CATEGORY_NA_WARNING_RATIO,
    CHECKPOINT_BY_ID,
    TOTAL_PASS_THRESHOLD,
    category_label_mapping_notes,
    compute_report,
    create_overrides_template_payload,
    create_template_payload,
    iter_checkpoints,
    normalize_partial_scores,
    normalize_scores,
)
from production_readiness_scan import (
    apply_overrides,
    assessments_to_scores,
    auto_assess_repository,
)


DEFAULT_REPORT_PATH = Path("score_report.json")
DEFAULT_TEMPLATE_PATH = Path("score_template.json")
DEFAULT_OVERRIDES_TEMPLATE_PATH = Path("score_overrides.json")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Score a repository against 100 production-readiness checkpoints. "
            "Supports interactive entry, JSON file input, or hybrid auto-scan mode, emits a console report, and writes score_report.json."
        ),
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 scripts/production_readiness_scorer.py --interactive\n"
            "  python3 scripts/production_readiness_scorer.py --input score_template.json\n"
            "  python3 scripts/production_readiness_scorer.py --scan\n"
            "  python3 scripts/production_readiness_scorer.py --scan --overrides score_overrides.json\n"
            "  python3 scripts/production_readiness_scorer.py --write-template\n"
            "  python3 scripts/production_readiness_scorer.py --write-overrides-template\n"
            "  python3 scripts/production_readiness_scorer.py --input scores.json --output reports/repo_score.json\n\n"
            "Input JSON shape:\n"
            "  {\n"
            '    "scores": {\n'
            '      "1": 4.5,\n'
            '      "2": "NA",\n'
            '      "3": null\n'
            "    }\n"
            "  }\n\n"
            f"NA handling:\n"
            f"  Use null or 'NA' for not-applicable checkpoints. NA values are excluded from category averages.\n"
            f"  A warning is shown when more than {int(CATEGORY_NA_WARNING_RATIO * 100)}% of a category is NA.\n\n"
            "Gates:\n"
            f"  Any category score below 3.0 fails.\n"
            f"  Critical checkpoints below 3.0 fail.\n"
            f"  Weighted total must be at least {TOTAL_PASS_THRESHOLD:.1f} to pass.\n"
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--interactive", action="store_true", help="Prompt for each checkpoint score.")
    mode.add_argument("--input", type=Path, help="Read scores from a JSON file.")
    mode.add_argument("--scan", action="store_true", help="Auto-scan the repository and produce draft scores with evidence.")
    parser.add_argument(
        "--write-template",
        nargs="?",
        const=str(DEFAULT_TEMPLATE_PATH),
        metavar="PATH",
        help="Write a JSON score template with null values and exit. Defaults to score_template.json.",
    )
    parser.add_argument(
        "--write-overrides-template",
        nargs="?",
        const=str(DEFAULT_OVERRIDES_TEMPLATE_PATH),
        metavar="PATH",
        help="Write an empty partial override file for hybrid scan mode and exit.",
    )
    parser.add_argument(
        "--overrides",
        type=Path,
        help="Optional partial JSON override file used with --scan.",
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path("."),
        help="Repository root to scan in --scan mode. Defaults to current directory.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_REPORT_PATH,
        help="Path for the JSON report artifact. Defaults to score_report.json.",
    )
    return parser


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def prompt_for_score(checkpoint_id: int) -> Optional[float]:
    checkpoint = CHECKPOINT_BY_ID[checkpoint_id]
    while True:
        prompt = (
            f"[{checkpoint.id:03d}] {checkpoint.title} ({checkpoint.description})\n"
            "Enter score 0..5, decimal allowed, or NA: "
        )
        raw = input(prompt).strip()
        if not raw:
            print("Value required. Enter 0..5 or NA.", file=sys.stderr)
            continue
        if raw.upper() == "NA":
            return None
        try:
            value = float(raw)
        except ValueError:
            print("Invalid value. Enter a number between 0 and 5, or NA.", file=sys.stderr)
            continue
        if 0.0 <= value <= 5.0:
            return value
        print("Score must be between 0 and 5.", file=sys.stderr)


def collect_interactive_scores() -> Dict[int, Optional[float]]:
    print("Production Readiness Scorer")
    print("Enter scores from 0.0 to 5.0. Use NA if a checkpoint genuinely does not apply.\n")
    scores: Dict[int, Optional[float]] = {}
    for checkpoint in iter_checkpoints():
        scores[checkpoint.id] = prompt_for_score(checkpoint.id)
    return scores


def load_scores_from_file(path: Path) -> Dict[int, Optional[float]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Input file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {path}: {exc}") from exc
    try:
        return normalize_scores(payload)
    except ValueError as exc:
        raise SystemExit(f"Invalid score payload: {exc}") from exc


def load_partial_scores_from_file(path: Path) -> Dict[int, Optional[float]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Override file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in override file {path}: {exc}") from exc
    try:
        return normalize_partial_scores(payload)
    except ValueError as exc:
        raise SystemExit(f"Invalid override payload: {exc}") from exc


def format_score(value: Optional[float]) -> str:
    return "NA" if value is None else f"{value:.2f}"


def print_report(report: Dict[str, Any]) -> None:
    print("\nData Model")
    print("  Checkpoint: id, category_key, title, description, remediation_hint, is_critical")
    print("  Category: key, name, weight, checkpoint_ids (derived by catalog membership)")
    print(
        "  Report: timestamp, checkpoint_scores, category_rollups, total_score, status, "
        "failed_gates, top_issues, assessment_summary, report_metadata"
    )

    print("\nNA Handling")
    print("  NA values are excluded from category averages and retained in the report as non-applicable.")
    print(
        f"  Categories with more than {int(CATEGORY_NA_WARNING_RATIO * 100)}% NA receive a warning so sparse scoring is visible."
    )

    print("\nGates")
    print("  Category gate: any category average below 3.00 fails.")
    print("  Critical checkpoint gate: critical checkpoints below 3.00 fail.")
    print(f"  Total gate: weighted total must be at least {TOTAL_PASS_THRESHOLD:.2f}.")

    if category_label_mapping_notes():
        print("\nCategory Mapping Notes")
        for note in category_label_mapping_notes():
            print(f"  - {note}")

    metadata = report.get("report_metadata", {})
    if metadata:
        print("\nAssessment Mode")
        mode = metadata.get("mode", "manual")
        print(f"  Mode: {mode}")
        scan_summary = metadata.get("scan_summary")
        if scan_summary:
            print(
                "  Scan summary: "
                f"files={scan_summary.get('total_files', 0)} "
                f"source={scan_summary.get('source_files', 0)} "
                f"tests={scan_summary.get('test_files', 0)} "
                f"todos={scan_summary.get('todo_count', 0)} "
                f"cycles={scan_summary.get('import_cycle_count', 0)}"
            )
            if scan_summary.get("secret_findings"):
                print(f"  Secret findings: {', '.join(scan_summary['secret_findings'][:5])}")

    assessment_summary = report.get("assessment_summary", {})
    if assessment_summary:
        print("\nAssessment Summary")
        source_bits = ", ".join(f"{key}={value}" for key, value in sorted(assessment_summary.get("by_source", {}).items()))
        confidence_bits = ", ".join(f"{key}={value}" for key, value in sorted(assessment_summary.get("by_confidence", {}).items()))
        if source_bits:
            print(f"  Sources: {source_bits}")
        if confidence_bits:
            print(f"  Confidence: {confidence_bits}")

    print("\nCategory Scores")
    for rollup in report["category_rollups"]:
        print(
            "  "
            f"{rollup['category_name']}: score={format_score(rollup['score'])} "
            f"weight={rollup['weight']:.0%} contribution={rollup['weighted_contribution']:.2f} "
            f"(applicable={rollup['applicable_count']}, NA={rollup['na_count']}/{rollup['total_checkpoints']})"
        )
        if rollup["warning"]:
            print(f"    warning: {rollup['warning']}")

    print("\nSummary")
    print(f"  Total score: {report['total_score']:.2f}")
    print(f"  Result: {report['status']}")

    print("\nFailed Gates")
    category_gates = report["failed_gates"]["category_gates"]
    critical_gates = report["failed_gates"]["critical_checkpoint_gates"]
    total_gate = report["failed_gates"]["total_score_gate"]
    if not category_gates and not critical_gates and total_gate is None:
        print("  None")
    else:
        for gate in category_gates:
            print(
                f"  Category: {gate['category_name']} score={format_score(gate['score'])} "
                f"threshold={gate['threshold']:.2f} reason={gate['reason']}"
            )
        for gate in critical_gates:
            print(
                f"  Critical checkpoint {gate['id']}: {gate['title']} score={gate['score']:.2f} "
                f"threshold={gate['threshold']:.2f}"
            )
        if total_gate:
            print(
                f"  Total score gate: score={total_gate['score']:.2f} "
                f"threshold={total_gate['threshold']:.2f} reason={total_gate['reason']}"
            )

    print("\nLowest 10 Checkpoints")
    if not report["top_issues"]:
        print("  None")
    else:
        for issue in report["top_issues"]:
            print(
                f"  [{issue['id']:03d}] {issue['title']} score={issue['score']:.2f} "
                f"- {issue['remediation_hint']}"
            )

    low_confidence = [entry for entry in report["checkpoint_scores"] if entry.get("assessment_confidence") == "low"]
    if low_confidence:
        print("\nLow-Confidence Auto Scores")
        for entry in sorted(low_confidence, key=lambda item: (item["score"] if item["score"] is not None else 99, item["id"]))[:10]:
            print(
                f"  [{entry['id']:03d}] {entry['title']} score={format_score(entry['score'])} "
                f"source={entry['assessment_source']} rationale={entry['assessment_rationale']}"
            )


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.write_template:
        template_path = Path(args.write_template)
        write_json(template_path, create_template_payload())
        print(f"Wrote template to {template_path}")
        return 0

    if args.write_overrides_template:
        overrides_path = Path(args.write_overrides_template)
        write_json(overrides_path, create_overrides_template_payload())
        print(f"Wrote overrides template to {overrides_path}")
        return 0

    assessments = None
    report_metadata: Dict[str, Any] = {}
    if args.interactive:
        scores = collect_interactive_scores()
    elif args.input:
        scores = load_scores_from_file(args.input)
    elif args.scan:
        assessments, report_metadata = auto_assess_repository(args.repo)
        if args.overrides:
            overrides = load_partial_scores_from_file(args.overrides)
            assessments = apply_overrides(assessments, overrides)
            report_metadata["override_count"] = len(overrides)
        scores = assessments_to_scores(assessments)
    else:
        parser.print_help()
        return 1

    report = compute_report(scores, assessments=assessments, report_metadata=report_metadata)
    print_report(report)
    write_json(args.output, report)
    print(f"\nWrote JSON report to {args.output}")
    return 0 if report["pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
