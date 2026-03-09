# Navigator Context Architecture

This architecture adapts the best interaction patterns from the Clawdbot reference without copying its product model.

## Extracted Architecture

In product terms, the reference system works because it does not treat "prompting" as one giant blob.

- A small deterministic system prompt defines identity, safety, tool contract, and context policy.
- Stable workspace docs are split into named files by concern instead of merged into one mega prompt.
- Skills are listed first as metadata and loaded only when relevant.
- Memory is searched first, then only the needed snippets are read.
- Runtime facts are injected separately from human-authored docs.
- Startup and heartbeat flows are isolated from normal chat turns.
- Sub-agents get a smaller prompt mode with fewer global instructions.
- Hooks can alter injected context before the model sees it.
- Prompt size is bounded with explicit truncation and source accounting.

## Mapping To Oi

For the UI navigator, the equivalent separation should be:

- Always-injected system prompt:
  - core identity for the navigator component
  - action contract and output contract
  - stable safety rules
  - context policy explaining what is runtime metadata vs retrieved docs
- Retrieved only when needed:
  - site playbooks
  - navigator design docs
  - relevant backend skills
  - failure/recovery hints
- External memory:
  - prior run history
  - durable user preferences
  - per-site notes
  - long-lived recovery learnings
- Runtime metadata:
  - current URL/title
  - current snapshot id and ref count
  - page registry / active tab
  - completed steps, known variables, current incident
- Human docs:
  - `UI_NAVIGATOR_PROMPT.md`
  - `UI_NAVIGATOR_UI_PROMPT.md`
  - `UI_NAVIGATOR_UX.md`

## Prompt-Building Rules

1. Keep the system prompt stable and task-specific.
2. Put current UI/runtime facts in a dedicated runtime section.
3. Retrieve only the top-matching docs/skills/playbooks for the current run.
4. Truncate retrieved docs aggressively and mark truncation explicitly.
5. Never inline all skills or all human docs into every planner call.
6. Keep retrieved sources inspectable in debug metadata.
7. Use minimal prompt mode for sub-agents or narrow helper calls.
8. Separate user goal text from execution hints and runtime metadata.

## Recommended File Structure

```text
apps/backend/
  prompts/
    system/
      navigator_core.md
    tasks/
      agent_browser_step_planner.md
      browser_prompt_rewriter.md
  playbooks/
    *.md
  skills/
    */SKILL.md
  UI_NAVIGATOR_PROMPT.md
  UI_NAVIGATOR_UI_PROMPT.md
  UI_NAVIGATOR_UX.md
apps/backend/src/oi_agent/services/tools/navigator/
  context_builder.py
```

Future memory layout:

```text
apps/backend/agent_memory/
  MEMORY.md
  sessions/
  sites/
  users/
```

## Pseudocode

### User Input -> Preprocess -> Context -> Model

```text
normalize user prompt
collect runtime metadata from current session
retrieve only top-matching playbooks/docs/skills
assemble:
  system = stable core + task contract + source catalog
  user = goal + runtime metadata + selected retrieved excerpts
call model
validate contract
```

### Memory Retrieval

```text
if task references prior work/preferences/history:
  search memory index
  read only matching snippets
  attach snippets as retrieved memory section
else:
  skip memory loading
```

### Skill / Instruction Loading

```text
catalog all instruction sources once
rank sources by URL host + prompt token overlap
select top N within a char budget
inject excerpted content only for selected sources
record selected sources in debug metadata
```

### Minimal-Context Sub-Agent

```text
build prompt_mode=minimal
omit broad source catalog and user/profile extras
inject only task goal + runtime facts + tiny retrieved hints
return machine-parseable result
```

## Token-Efficiency Strategies To Preserve

- metadata list of skills/instructions instead of full bodies
- bounded per-source truncation
- small stable system prompt
- retrieval only on demand
- runtime metadata as short structured lines
- minimal prompt mode for helper/sub-agent calls

## Safety Boundaries To Preserve

- explicit separation of policy from runtime facts
- explicit "retrieved docs are hints, not permission to invent"
- deterministic output contracts
- bounded prompt growth
- no silent inclusion of private long-term memory
- smaller context for helper flows
