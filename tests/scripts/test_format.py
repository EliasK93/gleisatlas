from pathlib import Path

import pytest

from scripts import format as fmt


def test_refresh_licences_copies_the_build_file(tmp_path: Path) -> None:
    build = tmp_path / "frontend" / "dist-e2e"
    build.mkdir(parents=True)
    (build / "licenses.txt").write_text("new licences\n")
    (tmp_path / "THIRD_PARTY_LICENSES.md").write_text("old licences\n")

    fmt.refresh_licences(tmp_path)

    assert (tmp_path / "THIRD_PARTY_LICENSES.md").read_text() == "new licences\n"


def test_refresh_licences_skips_without_a_build(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    fmt.refresh_licences(tmp_path)

    assert not (tmp_path / "THIRD_PARTY_LICENSES.md").exists()
    assert "no e2e build" in capsys.readouterr().out
