import os
import subprocess
import sys
from pathlib import Path

import pytest

from scripts import gate

PASS_LINE = "PASS all checks (tree unchanged since the last green gate)"


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway git repo whose checks are one counter command; the real repo stays untouched."""
    # inside the real pre-commit hook git exports GIT_INDEX_FILE and friends: drop them all
    for name in [n for n in os.environ if n.startswith("GIT_")]:
        monkeypatch.delenv(name)
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "config", "user.name", "test")
    git(root, "config", "user.email", "test@example.org")
    (root / "a.txt").write_text("one")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "first")
    monkeypatch.setattr(gate, "ROOT", root)
    monkeypatch.setattr(gate, "CHECKS", [("count", counter(tmp_path / "runs.txt", 0), root)])
    monkeypatch.setattr(gate, "GITLEAKS", [sys.executable, "-c", "pass"])
    return root


def counter(path: Path, exit_code: int) -> list[str]:
    code = f"open({str(path)!r}, 'a').write('x\\n'); raise SystemExit({exit_code})"
    return [sys.executable, "-c", code]


def runs(repo: Path) -> int:
    log = repo.parent / "runs.txt"
    return len(log.read_text().splitlines()) if log.exists() else 0


def gate_main(monkeypatch: pytest.MonkeyPatch, *flags: str) -> int:
    monkeypatch.setattr(sys, "argv", ["gate.py", *flags])
    return gate.main()


def test_the_hook_skips_a_tree_that_already_passed(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    assert gate_main(monkeypatch, "--hook") == 0
    assert runs(repo) == 1
    capsys.readouterr()
    assert gate_main(monkeypatch, "--hook") == 0
    assert runs(repo) == 1
    assert PASS_LINE in capsys.readouterr().out


def test_the_hook_runs_the_checks_after_a_changed_byte(repo: Path, monkeypatch: pytest.MonkeyPatch):
    gate_main(monkeypatch, "--hook")
    (repo / "a.txt").write_text("two")
    assert gate_main(monkeypatch, "--hook") == 0
    assert runs(repo) == 2


def test_the_hook_runs_the_checks_after_a_same_size_edit_in_the_index_timestamp(
    repo: Path, monkeypatch: pytest.MonkeyPatch
):
    """Same size and mtime as the index entry: only git's racy-clean check, which compares the
    entry with the index file's own mtime, makes git read the content."""
    old = (1_000_000_000_000_000_000, 1_000_000_000_000_000_000)
    os.utime(repo / "a.txt", ns=old)
    git(repo, "add", "-A")
    gate_main(monkeypatch, "--hook")
    (repo / "a.txt").write_text("two")
    for path in (repo / "a.txt", repo / ".git" / "index"):
        os.utime(path, ns=old)
    assert gate_main(monkeypatch, "--hook") == 0
    assert runs(repo) == 2


def test_the_hook_runs_the_checks_after_a_new_untracked_file(
    repo: Path, monkeypatch: pytest.MonkeyPatch
):
    gate_main(monkeypatch, "--hook")
    (repo / "b.txt").write_text("new")
    assert gate_main(monkeypatch, "--hook") == 0
    assert runs(repo) == 2


def test_a_failed_run_saves_no_fingerprint(repo: Path, monkeypatch: pytest.MonkeyPatch):
    passing = gate.CHECKS
    monkeypatch.setattr(gate, "CHECKS", [("count", counter(repo.parent / "runs.txt", 1), repo)])
    assert gate_main(monkeypatch, "--hook") == 1
    monkeypatch.setattr(gate, "CHECKS", passing)
    assert gate_main(monkeypatch, "--hook") == 0
    assert runs(repo) == 2


def test_ci_always_runs_the_checks(repo: Path, monkeypatch: pytest.MonkeyPatch):
    gate_main(monkeypatch, "--hook")
    assert gate_main(monkeypatch, "--ci") == 0
    assert runs(repo) == 2


def test_manual_mode_always_runs_the_checks(repo: Path, monkeypatch: pytest.MonkeyPatch):
    gate_main(monkeypatch, "--hook")
    assert gate_main(monkeypatch) == 0
    assert runs(repo) == 2
