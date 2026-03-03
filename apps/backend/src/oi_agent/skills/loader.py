from pathlib import Path

SKILLS_DIR = Path("skills")


def list_skill_files() -> list[str]:
    return [str(p) for p in SKILLS_DIR.rglob("SKILL.md")]
