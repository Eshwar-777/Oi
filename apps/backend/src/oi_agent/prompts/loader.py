from pathlib import Path

PROMPTS_DIR = Path("prompts")


def load_prompt(relative_path: str) -> str:
    path = PROMPTS_DIR / relative_path
    return path.read_text(encoding="utf-8")
