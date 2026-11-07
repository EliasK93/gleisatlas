"""Commit gate: format, lint, types, tests, frontend checks, licence file, Bicep, secret scan.

Manual mode stages everything first and fails on unstaged or untracked files.
`--hook` (pre-commit) runs only the checks, and skips them all for a tree that already passed.
Manual and hook mode run only the secret scan when everything changed since the last green tree
is documentation (`*.md` except the licence file, `docs/images/`).
`--ci` runs the checks without staging, scans the whole git history for secrets (nothing is
staged in CI) and fails if a check left changed or untracked files behind.
"""

import os
import shutil
import subprocess
import sys
import tempfile
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
    # after test:e2e, whose production build writes the licence file; on a difference,
    # `uv run python scripts/format.py` copies it over
    (
        "licence file",
        [
            *("git", "diff", "--no-index", "--exit-code"),
            *("frontend/dist-e2e/licenses.txt", "THIRD_PARTY_LICENSES.md"),
        ],
        ROOT,
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


def git_path(name: str) -> Path | None:
    code, out = run(["git", "rev-parse", "--git-path", name], ROOT)
    return ROOT / out if code == 0 and out else None


def fingerprint() -> str | None:
    """The tree `git add -A` would stage, hashed on a copy of the index (None if git fails)."""
    source = os.environ.get("GIT_INDEX_FILE")
    index = ROOT / source if source else git_path("index")
    if index is None:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "index"
        if index.exists():
            # copy2 keeps the mtime, which git's racy-clean check compares entries against
            shutil.copy2(index, copy)
        env = {**os.environ, "GIT_INDEX_FILE": str(copy)}
        for cmd in (["git", "add", "-A"], ["git", "write-tree"]):
            p = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
            if p.returncode:
                return None
        return p.stdout.strip()


def docs_only(tree: str | None, marker: Path | None) -> bool:
    """True if the files changed since the last green tree are all docs (any doubt: False)."""
    if not (tree and marker and marker.exists()):
        return False
    # --no-renames: a code file moved to a *.md path must show up under its old name too
    diff = ["git", "diff", "--name-only", "--no-renames", marker.read_text().strip(), tree]
    code, out = run(diff, ROOT)
    files = out.splitlines()
    return code == 0 and bool(files) and all(is_doc(f) for f in files)


def is_doc(path: str) -> bool:
    if path.startswith("docs/images/"):
        return True
    return path.endswith(".md") and path != "THIRD_PARTY_LICENSES.md"


def main() -> int:
    hook, ci = "--hook" in sys.argv[1:], "--ci" in sys.argv[1:]
    if not (hook or ci):
        code, out = run(["git", "add", "-A"], ROOT)
        if code:
            print(out)
            return 1
    tree, marker = fingerprint(), git_path("gate-green")
    if hook and tree and marker and marker.exists() and marker.read_text().strip() == tree:
        print("PASS all checks (tree unchanged since the last green gate)")
        return 0
    checks = CHECKS
    if not ci and docs_only(tree, marker):
        checks = []
        tail = "" if hook else ", clean tree"
        print(f"docs-only change since the last green gate: secret scan{tail}")
    secrets = GITLEAKS if ci else [*GITLEAKS, "--pre-commit", "--staged"]
    failed: list[str] = []
    for name, cmd, cwd in [*checks, ("gitleaks", secrets, ROOT)]:
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
    if not failed and tree and marker:
        marker.write_text(tree)
    print(f"gate: {'FAILED (' + ', '.join(failed) + ')' if failed else 'all checks passed'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
