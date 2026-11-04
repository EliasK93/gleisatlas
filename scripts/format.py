"""Fix formatting: ruff format, ruff check --fix, frontend `npm run format`, and copy the build's
licence file over THIRD_PARTY_LICENSES.md (the gate only checks all of it)."""

import shutil
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


def refresh_licences(root: Path) -> None:
    source = root / "frontend" / "dist-e2e" / "licenses.txt"
    if source.exists():
        shutil.copyfile(source, root / "THIRD_PARTY_LICENSES.md")
    else:
        print("licence file skipped: no e2e build yet (frontend/dist-e2e/licenses.txt)")


if __name__ == "__main__":
    codes = [subprocess.run(cmd, cwd=cwd).returncode for cmd, cwd in STEPS]
    refresh_licences(ROOT)
    sys.exit(1 if any(codes) else 0)
