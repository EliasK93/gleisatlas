"""Fix formatting: ruff format, ruff check --fix, frontend `npm run format`."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NPM = "npm.cmd" if sys.platform == "win32" else "npm"

STEPS = [
    (["uv", "run", "ruff", "format", "."], ROOT),
    (["uv", "run", "ruff", "check", "--fix", "."], ROOT),
    ([NPM, "run", "format"], ROOT / "frontend"),
]

if __name__ == "__main__":
    codes = [subprocess.run(cmd, cwd=cwd).returncode for cmd, cwd in STEPS]
    sys.exit(1 if any(codes) else 0)
