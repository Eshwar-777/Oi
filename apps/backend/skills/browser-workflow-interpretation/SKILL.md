---
name: browser-workflow-interpretation
description: Interpret broad browser automation requests into workflow intent, execution timing, and clarification needs. Use when refining prompts, system instructions, or planning contracts for cross-site, cross-tab browser operators.
---

# Browser Workflow Interpretation

Use this when working on:
- natural-language browser task interpretation
- prompt contracts for intent extraction or prompt rewriting
- workflow decomposition for cross-app browser tasks
- reducing brittle field-based routing

## Principles

- Treat the product as a general browser operator, not an email/message-specific form parser.
- Let the model do semantic interpretation; keep code deterministic for validation, policy, and execution.
- Prefer browser-session language in user-facing and planning contracts. Tabs/pages are internal execution state.
- Preserve platform-native semantics:
  - on GitHub, repository is a native object
  - on Jira, board/issue are native objects
  - on Gmail/WhatsApp, thread/chat/message are native objects
- Avoid repeating native object nouns inside search queries when the platform already scopes them.

## Output expectations

Interpreter outputs should answer:
- what the user wants to achieve
- whether it is immediate, once, recurring, or unspecified
- what subgoals exist in execution order
- what values may need to flow between steps
- what genuinely blocks execution and needs clarification

## Guardrails

- Do not collapse broad workflows into `recipient` / `message_text` style slots unless the prompt truly is that narrow.
- Do not force clarification when the platform and target are already inferable from the request.
- Keep workflow steps concise and execution-oriented.
