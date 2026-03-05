from pathlib import Path

# Resolve to apps/backend/skills regardless of process cwd.
SKILLS_DIR = Path(__file__).resolve().parents[3] / "skills"


def list_skill_files() -> list[str]:
    if not SKILLS_DIR.exists():
        return []
    return [str(p) for p in SKILLS_DIR.rglob("SKILL.md")]
