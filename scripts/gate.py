"""Commit gate: formatting, lint, types, tests, frontend checks, Bicep build, secret scan.

Manual mode stages everything first and fails on unstaged or untracked files.
`--hook` (pre-commit) runs only the checks.
`--ci` runs the checks without staging, scans the whole git history for secrets (nothing is
staged in CI) and fails if a check left changed or untracked files behind.
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NPM = "npm.cmd" if sys.platform == "win32" else "npm"
AZ = "az.cmd" if sys.platform == "win32" else "az"

CHECKS: list[tuple[str, list[str], Path]] = [
    ("ruff format", ["uv", "run", "ruff", "format", "--check", "."], ROOT),
    ("ruff check", ["uv", "run", "ruff", "check", "."], ROOT),
    ("pyright", ["uv", "run", "pyright"], ROOT),
    ("pytest", ["uv", "run", "pytest", "-q"], ROOT),
    *(
        (f"frontend {s}", [NPM, "run", s], ROOT / "frontend")
        for s in ("typecheck", "lint", "format:check", "gen:check", "test:e2e")
    ),
    # offline, no login: compiles and lints the infrastructure
    ("bicep", [AZ, "bicep", "build", "--file", "infra/main.bicep", "--stdout"], ROOT),
]
GITLEAKS = ["gitleaks", "git", "--redact", "--no-banner"]


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    if shutil.which(cmd[0]) is None:
        return 127, f"command not found: {cmd[0]}"
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, errors="replace")
    # rstrip only: `git status --porcelain` lines start with a meaningful space
    return p.returncode, (p.stdout + p.stderr).rstrip()


def main() -> int:
    hook, ci = "--hook" in sys.argv[1:], "--ci" in sys.argv[1:]
    if not (hook or ci):
        code, out = run(["git", "add", "-A"], ROOT)
        if code:
            print(out)
            return 1
    secrets = GITLEAKS if ci else [*GITLEAKS, "--pre-commit", "--staged"]
    failed: list[str] = []
    for name, cmd, cwd in [*CHECKS, ("gitleaks", secrets, ROOT)]:
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
