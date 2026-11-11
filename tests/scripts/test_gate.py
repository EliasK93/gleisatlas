import io
import os
import re
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


FAST_LINE = "docs-only change since the last green gate: secret scan"


def green_then_change(repo: Path, monkeypatch: pytest.MonkeyPatch, path: str, *flags: str) -> int:
    """A green hook run, then one changed file, then a run with `flags`: its result."""
    gate_main(monkeypatch, "--hook")
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("changed")
    return gate_main(monkeypatch, *flags)


def test_a_docs_only_change_runs_only_the_secret_scan_in_manual_mode(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    gate_main(monkeypatch, "--hook")
    (repo / "README.md").write_text("text")
    capsys.readouterr()
    assert gate_main(monkeypatch) == 0
    out = capsys.readouterr().out
    assert f"{FAST_LINE}, clean tree" in out
    assert "PASS clean tree" in out
    assert runs(repo) == 1


def test_a_docs_only_change_runs_only_the_secret_scan_in_hook_mode(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    gate_main(monkeypatch, "--hook")
    (repo / "README.md").write_text("text")
    capsys.readouterr()
    assert gate_main(monkeypatch, "--hook") == 0
    out = capsys.readouterr().out
    assert FAST_LINE in out
    assert "clean tree" not in out
    assert runs(repo) == 1


def test_a_fast_run_saves_the_fingerprint(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    gate_main(monkeypatch, "--hook")
    (repo / "README.md").write_text("text")
    gate_main(monkeypatch, "--hook")
    capsys.readouterr()
    assert gate_main(monkeypatch, "--hook") == 0
    assert PASS_LINE in capsys.readouterr().out


@pytest.mark.parametrize("path", ["b.txt", "THIRD_PARTY_LICENSES.md", "docs/x.py"])
def test_a_change_that_is_not_docs_runs_every_check(
    repo: Path, monkeypatch: pytest.MonkeyPatch, path: str
):
    assert green_then_change(repo, monkeypatch, path, "--hook") == 0
    assert runs(repo) == 2


def test_a_change_under_docs_images_counts_as_docs(repo: Path, monkeypatch: pytest.MonkeyPatch):
    assert green_then_change(repo, monkeypatch, "docs/images/a.png", "--hook") == 0
    assert runs(repo) == 1


def test_ci_runs_every_check_for_a_docs_only_change(repo: Path, monkeypatch: pytest.MonkeyPatch):
    # the new file stays untracked in CI, so the clean-tree check fails: only the counts matter
    green_then_change(repo, monkeypatch, "README.md", "--ci")
    assert runs(repo) == 2


def test_a_marker_naming_an_unknown_tree_runs_every_check(
    repo: Path, monkeypatch: pytest.MonkeyPatch
):
    gate_main(monkeypatch, "--hook")
    (repo / ".git" / "gate-green").write_text("0" * 40)
    (repo / "README.md").write_text("text")
    assert gate_main(monkeypatch, "--hook") == 0
    assert runs(repo) == 2


def test_a_code_file_renamed_to_markdown_runs_every_check(
    repo: Path, monkeypatch: pytest.MonkeyPatch
):
    gate_main(monkeypatch, "--hook")
    (repo / "a.txt").rename(repo / "notes.md")
    assert gate_main(monkeypatch, "--hook") == 0
    assert runs(repo) == 2


def say(text: str, exit_code: int = 0) -> list[str]:
    # writes utf-8 whatever the console's code page, as Playwright does
    write = f"import sys; sys.stdout.buffer.write(({text!r} + '\\n').encode('utf-8'))"
    return [sys.executable, "-c", f"{write}; raise SystemExit({exit_code})"]


def test_every_result_line_carries_its_duration_and_the_gate_line_the_total(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    assert gate_main(monkeypatch) == 0
    out = capsys.readouterr().out
    assert re.search(r"^PASS count \(\d+\.\d s\)$", out, re.M)
    assert re.search(r"^PASS gitleaks \(\d+\.\d s\)$", out, re.M)
    assert re.search(r"^gate: all checks passed \(\d+ s\)$", out, re.M)


def test_the_first_phase_runs_its_checks_at_the_same_time(
    repo: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Each check waits for the other one's file, so a sequential run times out and fails."""

    def meet(mine: str, other: str) -> list[str]:
        code = (
            "import pathlib, sys, time\n"
            f"pathlib.Path({str(tmp_path / mine)!r}).write_text('x')\n"
            "for _ in range(100):\n"
            f"    if pathlib.Path({str(tmp_path / other)!r}).exists(): sys.exit(0)\n"
            "    time.sleep(0.1)\n"
            "sys.exit(1)\n"
        )
        return [sys.executable, "-c", code]

    monkeypatch.setattr(gate, "CHECKS", [("a", meet("a", "b"), repo), ("b", meet("b", "a"), repo)])
    assert gate_main(monkeypatch) == 0


def test_the_results_print_in_the_order_of_the_check_list(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    slow = [sys.executable, "-c", "import time; time.sleep(1)"]
    monkeypatch.setattr(gate, "CHECKS", [("slow", slow, repo), ("quick", say("hi"), repo)])
    gate_main(monkeypatch)
    out = capsys.readouterr().out
    assert out.index("PASS slow") < out.index("PASS quick") < out.index("PASS gitleaks")


def test_a_failed_first_phase_skips_the_e2e_run_and_the_licence_file(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
):
    late = [("frontend test:e2e", counter(tmp_path / "runs.txt", 0), repo)]
    late.append(("licence file", counter(tmp_path / "runs.txt", 0), repo))
    first = [("bad", say("broken", 1), repo)]
    monkeypatch.setattr(gate, "CHECKS", [*first, *late])
    monkeypatch.setattr(gate, "GITLEAKS", counter(tmp_path / "leaks.txt", 0))
    assert gate_main(monkeypatch) == 1
    out = capsys.readouterr().out
    assert "FAIL bad" in out
    assert "broken" in out
    assert "SKIP frontend test:e2e (earlier checks failed)" in out
    assert "SKIP licence file (earlier checks failed)" in out
    assert runs(repo) == 0
    assert (tmp_path / "leaks.txt").exists()
    assert "PASS clean tree" in out
    assert re.search(r"^gate: FAILED \(bad\) \(\d+ s\)$", out, re.M)


def test_the_e2e_run_starts_after_the_first_phase_and_prints_its_flaky_tests(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
):
    """The slow first-phase check writes a marker when it ends; e2e fails unless it finds it."""
    marker = tmp_path / "phase1-done"
    slow = f"import pathlib, time; time.sleep(0.5); pathlib.Path({str(marker)!r}).write_text('x')"
    e2e = (
        f"import pathlib, sys; ok = pathlib.Path({str(marker)!r}).exists()\n"
        f"sys.stdout.buffer.write({SUMMARY_FLAKY!r}.encode('utf-8'))\n"
        "raise SystemExit(0 if ok else 1)"
    )
    checks = [
        ("frontend test:e2e", [sys.executable, "-c", e2e], repo),
        ("slow", [sys.executable, "-c", slow], repo),
    ]
    monkeypatch.setattr(gate, "CHECKS", checks)
    assert gate_main(monkeypatch) == 0
    out = capsys.readouterr().out
    assert out.index("PASS slow") < out.index("PASS frontend test:e2e")
    lines = out.splitlines()
    at = next(i for i, line in enumerate(lines) if line.startswith("PASS frontend test:e2e"))
    assert lines[at + 1 : at + 4] == FLAKY_BLOCK


def test_a_console_that_cannot_encode_the_output_does_not_stop_the_gate(
    repo: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Playwright's separator and marks (─ ✘) are not in cp1252, the pipe's default on Windows."""
    raw = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(raw, encoding="cp1252"))
    monkeypatch.setattr(gate, "CHECKS", [("frontend test:e2e", say("✘ a › b ───", 1), repo)])
    monkeypatch.setattr(gate, "GITLEAKS", counter(tmp_path / "leaks.txt", 0))
    assert gate_main(monkeypatch) == 1
    sys.stdout.flush()
    assert b"FAIL frontend test:e2e" in raw.getvalue()
    assert (tmp_path / "leaks.txt").exists()


def test_python_checks_write_utf8_even_when_the_console_does_not(
    repo: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("PYTHONIOENCODING", raising=False)
    # a plain print: the child's encoding is decided by PYTHONIOENCODING alone
    shout = [sys.executable, "-c", "print('Bundesländer')"]
    assert gate.run(shout, repo) == (0, "Bundesländer")


def show_ci(path: Path) -> list[str]:
    code = f"import os; open({str(path)!r}, 'w').write(os.environ.get('CI', 'unset'))"
    return [sys.executable, "-c", code]


def test_ci_mode_sets_ci_for_the_checks(
    repo: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setenv("CI", "before")  # main() sets it for good: the fixture restores it
    monkeypatch.setattr(gate, "CHECKS", [("show", show_ci(tmp_path / "ci.txt"), repo)])
    gate_main(monkeypatch, "--ci")
    assert (tmp_path / "ci.txt").read_text() == "1"


def test_the_other_modes_leave_ci_alone(
    repo: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    monkeypatch.setenv("CI", "before")
    monkeypatch.setattr(gate, "CHECKS", [("show", show_ci(tmp_path / "ci.txt"), repo)])
    gate_main(monkeypatch, "--hook")
    assert (tmp_path / "ci.txt").read_text() == "before"


FLAKY_BLOCK = [
    "  2 flaky",
    "    [chromium] › e2e/map.spec.ts:10:5 › the map › opens",
    "    [mobile] › e2e/line.spec.ts:20:5 › the line › fits",
]
# Playwright ends each test line with a space and a rule of ─ up to 100 columns
SUMMARY_FLAKY = "\n".join(
    [
        "Running 5 tests",
        FLAKY_BLOCK[0],
        *(f"{line} {'─' * (60 - len(line))}" for line in FLAKY_BLOCK[1:]),
        "  3 passed (1.0m)",
    ]
)


def test_flaky_lines_returns_the_summary_block():
    assert gate.flaky_lines(SUMMARY_FLAKY) == FLAKY_BLOCK


def test_flaky_lines_ignores_colour_codes():
    coloured = SUMMARY_FLAKY.replace("  2 flaky", "\x1b[33m  2 flaky\x1b[39m")
    coloured = coloured.replace("    [", "\x1b[33m    [").replace("opens", "opens\x1b[39m")
    assert gate.flaky_lines(coloured) == FLAKY_BLOCK


def test_flaky_lines_is_empty_without_flaky_tests():
    assert gate.flaky_lines("Running 5 tests\n  5 passed (1.0m)") == []
