#!/usr/bin/env python3
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import httpx

BASE_URL = "http://127.0.0.1:8080"
TIMEZONE = "Asia/Kolkata"
LOCALE = "en-US"
POLL_INTERVAL_SECONDS = 2.0
DEFAULT_TIMEOUT_SECONDS = 300.0
ACTIVE_RUN_GRACE_SECONDS = 180.0


CaseKind = Literal["chat", "schedule_once", "schedule_interval", "schedule_delete_last_once", "schedule_delete_last_interval"]


@dataclass(frozen=True)
class LiveCase:
    case_id: str
    category: str
    prompt: str
    kind: CaseKind = "chat"
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS


def ts_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_cases() -> list[LiveCase]:
    cases: list[LiveCase] = []

    public_web = [
        "search google for OpenAI pricing and open the official pricing page",
        "search google for Python asyncio subprocess docs and open the official docs.python.org result",
        "search google for FastAPI first steps and open the official FastAPI docs result",
        "search google for Playwright Python locators and open the official Playwright docs result",
        "search google for React useEffect docs and open the official React docs result",
        "search google for TypeScript generics handbook and open the official TypeScript docs result",
        "search google for MDN Array map docs and open the official MDN result",
        "search google for Docker bind mounts docs and open the official Docker docs result",
        "search google for Kubernetes pods docs and open the official Kubernetes docs result",
        "search google for Stripe webhook docs and open the official Stripe docs result",
        "open wikipedia and search for Alan Turing, then open the article page",
        "open wikipedia and search for Artificial intelligence, then open the article page",
        "open YouTube and search for OpenAI, then open the official OpenAI channel if visible",
        "open Google Maps and search for Bengaluru airport",
        "open OpenAI docs and navigate to the Responses API documentation",
    ]
    for idx, prompt in enumerate(public_web, start=1):
        cases.append(LiveCase(f"WEB-{idx:03d}", "public-web", prompt))

    github = [
        "open github, go to the openai/openai-python repository, and open issue 2919 now",
        "open github and navigate to the openai/openai-python repository root",
        "open github and navigate to the openai/openai-python repository releases page",
        "open github and navigate to the openai/openai-python issues list",
        "open github and search within the openai/openai-python repository for AsyncOpenAI",
        "open github and open the README file in openai/openai-python",
        "open github and navigate to the contributors page for openai/openai-python",
        "open github and navigate to the pull requests tab for openai/openai-python",
        "open github and navigate from issue 2919 back to the openai/openai-python repository root",
        "open github and open the openai/openai-python repository code tab",
        "open github and search for the repository openai/openai-node, then open it",
        "open github and open the first visible issue in the openai/openai-python repository issues list",
        "open github and open the openai/openai-python repository tags or releases section",
        "open github and open the issue search results for websocket in openai/openai-python",
        "open github and open the Actions tab for openai/openai-python",
    ]
    for idx, prompt in enumerate(github, start=1):
        cases.append(LiveCase(f"GITHUB-{idx:03d}", "github", prompt))

    gmail = [
        "open gmail and search for ui-nav smoke 16, then open the latest matching thread",
        "open gmail and go to the Sent folder",
        "open gmail and go to the Drafts folder",
        "open gmail and search for emails from me",
        "open gmail and open the latest visible sent email thread",
        "open gmail and open Compose, start a draft to yandrapueshwar2000@gmail.com with subject ui-nav draft 1 and body draft only, then stop without sending",
        "open gmail and open Compose, then close compose without sending",
        "open gmail and open the Inbox view",
        "open gmail and search for has:attachment",
        "send an email now to yandrapueshwar2000@gmail.com with subject ui-nav smoke suite and body hello from the live suite",
    ]
    for idx, prompt in enumerate(gmail, start=1):
        cases.append(LiveCase(f"GMAIL-{idx:03d}", "gmail", prompt))

    calendar = [
        "open Google Calendar and switch to day view",
        "open Google Calendar and switch to month view",
        "open Google Calendar and go to next week",
        "open Google Calendar and return to today",
        "open Google Calendar and search for ui-nav smoke",
        "open Google Calendar and open settings",
        "open Google Calendar and open the Tasks side panel",
        "open Google Calendar and start creating an event titled ui-nav draft event for tomorrow at 4 PM, then cancel before saving",
        "open Google Calendar and open the first visible event details if one is visible",
        "open Google Calendar and switch to week view",
    ]
    for idx, prompt in enumerate(calendar, start=1):
        cases.append(LiveCase(f"CAL-{idx:03d}", "calendar", prompt))

    whatsapp = [
        "open WhatsApp Web and search for Tortoise, then open the chat only",
        "open WhatsApp Web and search within chats for the text automated message",
        "open WhatsApp Web and open the latest visible chat from the sidebar",
        "open WhatsApp Web and open settings or profile menu if visible",
        "open WhatsApp Web and return to the main chat list",
    ]
    for idx, prompt in enumerate(whatsapp, start=1):
        cases.append(LiveCase(f"WA-{idx:03d}", "whatsapp", prompt))

    docs_reference = [
        "open docs.python.org and navigate to asyncio subprocess documentation",
        "open FastAPI docs and navigate to the first steps tutorial",
        "open Playwright Python docs and navigate to the locators guide",
        "open React docs and navigate to useEffect documentation",
        "open TypeScript handbook and navigate to the Generics page",
        "open MDN and navigate to localStorage documentation",
        "open Docker docs and navigate to bind mounts documentation",
        "open Kubernetes docs and navigate to Pods documentation",
        "open Stripe docs and navigate to webhook signature verification",
        "open Twilio docs and navigate to the WhatsApp quickstart",
    ]
    for idx, prompt in enumerate(docs_reference, start=1):
        cases.append(LiveCase(f"DOCS-{idx:03d}", "docs", prompt))

    commerce_and_info = [
        "open Amazon India and search for usb c hub, then open the first visible non-sponsored result if possible",
        "open Amazon India and search for mechanical keyboard, then open the first visible result",
        "open Flipkart and search for laptop stand, then open the first visible result",
        "open Myntra and search for men's running shoes, then open the first visible result",
        "open Airbnb and search for stays in Bengaluru, then stop on the results page",
        "open Booking.com and search for hotels in Bengaluru, then stop on the results page",
        "open BBC News and open the first visible headline",
        "open Hacker News and open the first visible story",
        "open IMDb and search for Interstellar, then open the movie page",
        "open Google News and search for OpenAI, then open the first visible result",
    ]
    for idx, prompt in enumerate(commerce_and_info, start=1):
        cases.append(LiveCase(f"INFO-{idx:03d}", "commerce-info", prompt))

    app_navigation = [
        "open npmjs and navigate to the react package page",
        "open PyPI and navigate to the fastapi package page",
        "open Stack Overflow and search for python list comprehension, then open the first visible result",
        "open Reddit and search for OpenAI, then open the first visible result if accessible",
        "open ESPN Cricinfo and navigate to live scores",
        "open Google Maps and get directions from Bengaluru to Mysuru",
        "open YouTube and search for OpenAI DevDay, then open the first official video if visible",
        "open OpenAI and navigate to the pricing page",
        "open Python.org and navigate to the release schedule page",
        "open Mozilla MDN and search for fetch API, then open the main documentation result",
    ]
    for idx, prompt in enumerate(app_navigation, start=1):
        cases.append(LiveCase(f"NAV-{idx:03d}", "app-navigation", prompt))

    edge_cases = [
        "search google for openai api docs and open the official result, not a sponsored result",
        "open github and go to the openai/openai-python repository, then return to the previously opened issue page if possible",
        "open gmail and search for ui-nav smoke 17, then return to inbox",
        "open Google Calendar and go to next week, then return to today",
        "open WhatsApp Web and search for Tortoise twice, then open the same chat once",
        "open github and search within openai/openai-python for responses websocket, then open the most relevant visible result",
        "open google search results for Python docs and open the official result while avoiding any ads",
        "open gmail and open Compose, then focus the subject field only",
        "open Google Calendar and open the create event dialog, then close it",
        "open github and open issue 2919, then verify the title is visible",
    ]
    for idx, prompt in enumerate(edge_cases, start=1):
        cases.append(LiveCase(f"EDGE-{idx:03d}", "edge-cases", prompt))

    schedule_cases = [
        LiveCase("SCHED-001", "schedule", "Create a one-time browser automation schedule 10 minutes from now", "schedule_once"),
        LiveCase("SCHED-002", "schedule", "Delete the most recent one-time browser automation schedule", "schedule_delete_last_once"),
        LiveCase("SCHED-003", "schedule", "Create an hourly browser automation schedule", "schedule_interval"),
        LiveCase("SCHED-004", "schedule", "Delete the most recent hourly browser automation schedule", "schedule_delete_last_interval"),
        LiveCase("SCHED-005", "schedule", "Create another one-time browser automation schedule 15 minutes from now", "schedule_once"),
    ]
    cases.extend(schedule_cases)

    assert len(cases) == 100, len(cases)
    return cases


def chat_turn(client: httpx.Client, session_id: str, prompt: str) -> dict[str, Any]:
    # Force immediate execution so the suite exercises live browser behavior
    # instead of stopping in the generic "when should I run this?" timing flow.
    immediate_prompt = prompt if " now" in prompt.lower() else f"{prompt} now"
    response = client.post(
        f"{BASE_URL}/api/chat/turn",
        json={
            "session_id": session_id,
            "inputs": [{"type": "text", "text": immediate_prompt}],
            "client_context": {"timezone": TIMEZONE, "locale": LOCALE},
        },
    )
    response.raise_for_status()
    return response.json()


def get_active_run_id(client: httpx.Client, session_id: str) -> str | None:
    response = client.get(f"{BASE_URL}/api/chat/sessions/{session_id}")
    response.raise_for_status()
    payload = response.json()
    active_run = payload.get("active_run") or {}
    run_id = active_run.get("run_id")
    return str(run_id) if run_id else None


def get_session_payload(client: httpx.Client, session_id: str) -> dict[str, Any]:
    response = client.get(f"{BASE_URL}/api/chat/sessions/{session_id}")
    response.raise_for_status()
    return response.json()


def poll_run(client: httpx.Client, run_id: str, timeout_seconds: float) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_payload: dict[str, Any] | None = None
    while time.time() < deadline:
        response = client.get(f"{BASE_URL}/api/runs/{run_id}")
        response.raise_for_status()
        payload = response.json()
        last_payload = payload
        state = str(((payload.get("run") or {}).get("state")) or "")
        if state in {"completed", "failed", "waiting_for_human", "cancelled", "canceled", "timed_out", "expired"}:
            return payload
        time.sleep(POLL_INTERVAL_SECONDS)
    last_state = str((((last_payload or {}).get("run") or {}).get("state")) or "")
    if last_state in {"queued", "starting", "running"}:
        grace_deadline = time.time() + ACTIVE_RUN_GRACE_SECONDS
        while time.time() < grace_deadline:
            response = client.get(f"{BASE_URL}/api/runs/{run_id}")
            response.raise_for_status()
            payload = response.json()
            last_payload = payload
            state = str(((payload.get("run") or {}).get("state")) or "")
            if state in {"completed", "failed", "waiting_for_human", "cancelled", "canceled", "timed_out", "expired"}:
                return payload
            time.sleep(POLL_INTERVAL_SECONDS)
    if last_payload:
        timed_out_payload = dict(last_payload)
        run = dict((timed_out_payload.get("run") or {}))
        run["state"] = "timed_out"
        run["last_error"] = {
            "code": "TIMEOUT",
            "message": "Timed out waiting for run completion.",
        }
        timed_out_payload["run"] = run
        return timed_out_payload
    return {"run": {"state": "timed_out", "last_error": {"code": "TIMEOUT", "message": "Timed out waiting for run completion."}}}


def create_schedule_once(client: httpx.Client) -> dict[str, Any]:
    run_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).replace(microsecond=0).isoformat()
    response = client.post(
        f"{BASE_URL}/browser/agent/schedules",
        json={
            "prompt": "Open GitHub and navigate to the openai/openai-python repository root.",
            "schedule_type": "once",
            "run_at": run_at,
        },
    )
    response.raise_for_status()
    return response.json()


def create_schedule_interval(client: httpx.Client) -> dict[str, Any]:
    response = client.post(
        f"{BASE_URL}/browser/agent/schedules",
        json={
            "prompt": "Open OpenAI and navigate to the pricing page.",
            "schedule_type": "interval",
            "interval_seconds": 3600,
        },
    )
    response.raise_for_status()
    return response.json()


def list_schedules(client: httpx.Client) -> list[dict[str, Any]]:
    response = client.get(f"{BASE_URL}/browser/agent/schedules")
    response.raise_for_status()
    return list(response.json().get("items") or [])


def delete_schedule(client: httpx.Client, schedule_id: str) -> dict[str, Any]:
    response = client.delete(f"{BASE_URL}/browser/agent/schedules/{schedule_id}")
    response.raise_for_status()
    return response.json()


def execute_case(client: httpx.Client, case: LiveCase, state: dict[str, Any]) -> dict[str, Any]:
    started_at = ts_now()
    result: dict[str, Any] = {
        "case_id": case.case_id,
        "category": case.category,
        "kind": case.kind,
        "prompt": case.prompt,
        "started_at": started_at,
    }
    try:
        if case.kind == "chat":
            session_id = f"live-suite-{case.case_id.lower()}-{uuid.uuid4().hex[:8]}"
            chat_turn(client, session_id, case.prompt)
            run_id = get_active_run_id(client, session_id)
            if not run_id:
                # Some browser tasks still land in the generic timing clarifier.
                # Give the system one explicit immediate-execution nudge before
                # treating it as a real no-run classification failure.
                chat_turn(client, session_id, "run now")
                run_id = get_active_run_id(client, session_id)
            result["session_id"] = session_id
            result["run_id"] = run_id
            if not run_id:
                payload = get_session_payload(client, session_id)
                result["status"] = "no_run"
                result["error"] = "No active run was created."
                result["conversation"] = payload.get("conversation")
            else:
                payload = poll_run(client, run_id, case.timeout_seconds)
                run = payload.get("run") or {}
                result["status"] = str(run.get("state") or "unknown")
                result["run"] = {
                    "state": run.get("state"),
                    "last_error": run.get("last_error"),
                    "updated_at": run.get("updated_at"),
                }
        elif case.kind == "schedule_once":
            created = create_schedule_once(client)
            schedule = created.get("schedule") or {}
            state["last_once_schedule_id"] = schedule.get("schedule_id")
            result["status"] = "completed"
            result["schedule"] = schedule
        elif case.kind == "schedule_interval":
            created = create_schedule_interval(client)
            schedule = created.get("schedule") or {}
            state["last_interval_schedule_id"] = schedule.get("schedule_id")
            result["status"] = "completed"
            result["schedule"] = schedule
        elif case.kind == "schedule_delete_last_once":
            schedule_id = state.get("last_once_schedule_id")
            if not schedule_id:
                result["status"] = "blocked"
                result["error"] = "No once schedule id available to delete."
            else:
                deleted = delete_schedule(client, str(schedule_id))
                result["status"] = "completed"
                result["schedule"] = deleted
        elif case.kind == "schedule_delete_last_interval":
            schedule_id = state.get("last_interval_schedule_id")
            if not schedule_id:
                result["status"] = "blocked"
                result["error"] = "No interval schedule id available to delete."
            else:
                deleted = delete_schedule(client, str(schedule_id))
                result["status"] = "completed"
                result["schedule"] = deleted
        else:
            result["status"] = "unsupported"
            result["error"] = f"Unsupported case kind {case.kind}"
    except Exception as exc:  # noqa: BLE001
        result["status"] = "error"
        result["error"] = str(exc)
    result["finished_at"] = ts_now()
    return result


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for row in results:
        key = str(row.get("status") or "unknown")
        counts[key] = counts.get(key, 0) + 1
    return {"total": len(results), "counts": counts}


def write_markdown(path: Path, results: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    lines = [
        "# UI Navigator 100 Live Suite Results",
        "",
        f"- Generated at: {ts_now()}",
        f"- Total cases: {summary['total']}",
        "- Counts:",
    ]
    for key, value in sorted(summary["counts"].items()):
        lines.append(f"  - {key}: {value}")
    lines.extend(["", "| Case | Category | Kind | Status | Notes |", "|---|---|---|---|---|"])
    for row in results:
        notes = ""
        if row.get("error"):
            notes = str(row["error"]).replace("\n", " ")
        else:
            run = row.get("run") or {}
            last_error = run.get("last_error") or {}
            if last_error:
                notes = str(last_error.get("message") or last_error.get("code") or "")
        lines.append(
            f"| {row['case_id']} | {row['category']} | {row['kind']} | {row['status']} | {notes} |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf8")


def main() -> None:
    cases = build_cases()
    out_dir = Path("/Users/yandrapue/.codex/worktrees/d237/Oi/docs")
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "UI_NAVIGATOR_100_LIVE_RESULTS.json"
    md_path = out_dir / "UI_NAVIGATOR_100_LIVE_RESULTS.md"

    client = httpx.Client(timeout=30.0)
    state: dict[str, Any] = {}
    results: list[dict[str, Any]] = []
    for case in cases:
        row = execute_case(client, case, state)
        results.append(row)
        json_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf8")
        write_markdown(md_path, results, summarize(results))
        time.sleep(1.0)

    summary = summarize(results)
    json_path.write_text(json.dumps({"summary": summary, "results": results}, indent=2) + "\n", encoding="utf8")
    write_markdown(md_path, results, summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
