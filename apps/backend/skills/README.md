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
