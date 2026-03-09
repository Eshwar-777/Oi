---
name: agent-browser-planning
description: Plan Oi browser automation in native agent-browser terms using snapshots, refs, semantic commands, tabs, frames, waits, uploads, and key presses. Use when updating planner prompts, retrieval context, or execution semantics for the browser operator.
---

# Agent Browser Planning

Use this skill when changing how Oi interprets browser tasks into executable steps.

Core rules:
- Prefer native agent-browser commands over project-specific abstractions.
- Prefer `snapshot` and ref-based follow-up actions on unfamiliar pages.
- Use `press` for key submissions like `Enter`.
- Use `tab` and `frame` explicitly for cross-tab or iframe workflows.
- Use `upload` for file inputs instead of generic `type`.
- Keep prompts and planning contracts aligned with the installed CLI.

References:
- Read [/Users/yandrapue/eshwar-777/Oi/agent-browser-readme.md](/Users/yandrapue/eshwar-777/Oi/agent-browser-readme.md) for command coverage and safety options.
- Read [/Users/yandrapue/eshwar-777/Oi/agent-browser-agent-readme.md](/Users/yandrapue/eshwar-777/Oi/agent-browser-agent-readme.md) for repo-specific guidance.

Implementation notes:
- Runtime retrieval should be lightweight and local-first. Prefer deterministic snippet selection from the pinned docs over a separate vector store unless the document set grows significantly.
- The planner prompt should state the exact supported actions and target forms.
- The executor must support every action the planner is allowed to emit.
