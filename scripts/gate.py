"""Commit gate: formatting, lint, types, tests, frontend checks, secret scan.

Manual mode stages everything first and fails on unstaged or untracked files.
`--hook` (pre-commit) runs only the checks.
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NPM = "npm.cmd" if sys.platform == "win32" else "npm"

CHECKS: list[tuple[str, list[str], Path]] = [
    ("ruff format", ["uv", "run", "ruff", "format", "--check", "."], ROOT),
    ("ruff check", ["uv", "run", "ruff", "check", "."], ROOT),
    ("pyright", ["uv", "run", "pyright"], ROOT),
    ("pytest", ["uv", "run", "pytest", "-q"], ROOT),
    *(
        (f"frontend {s}", [NPM, "run", s], ROOT / "frontend")
        for s in ("typecheck", "lint", "format:check", "gen:check", "test:e2e")
    ),
    (
        "gitleaks",
        ["gitleaks", "git", "--pre-commit", "--staged", "--redact", "--no-banner"],
        ROOT,
    ),
]


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    if shutil.which(cmd[0]) is None:
        return 127, f"command not found: {cmd[0]}"
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, errors="replace")
    return p.returncode, (p.stdout + p.stderr).strip()


def main() -> int:
    hook = "--hook" in sys.argv[1:]
    if not hook:
        code, out = run(["git", "add", "-A"], ROOT)
        if code:
            print(out)
            return 1
    failed: list[str] = []
    for name, cmd, cwd in CHECKS:
        code, out = run(cmd, cwd)
        print(f"{'PASS' if code == 0 else 'FAIL'} {name}")
        if code:
            failed.append(name)
            print(out)
    if not hook:
        _, status = run(["git", "status", "--porcelain"], ROOT)
        dirty = [line for line in status.splitlines() if line[1:2] != " "]
        print(f"{'FAIL' if dirty else 'PASS'} clean tree")
        if dirty:
            failed.append("clean tree")
            print("\n".join(dirty))
    print(f"gate: {'FAILED (' + ', '.join(failed) + ')' if failed else 'all checks passed'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
