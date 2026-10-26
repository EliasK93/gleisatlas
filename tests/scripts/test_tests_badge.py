import json

from scripts.tests_badge import badge, main


def suites(*counts: tuple[int, int, int, int]) -> str:
    """JUnit XML with one <testsuite> per (tests, failures, errors, skipped)."""
    rows = "".join(
        f'<testsuite tests="{t}" failures="{f}" errors="{e}" skipped="{s}"/>'
        for t, f, e, s in counts
    )
    return f"<testsuites>{rows}</testsuites>"


def test_counts_across_reports_without_skipped(tmp_path):
    (tmp_path / "pytest.xml").write_text(suites((60, 0, 0, 0)), encoding="utf-8")
    (tmp_path / "e2e.xml").write_text(suites((80, 1, 0, 10), (70, 0, 1, 14)), encoding="utf-8")
    assert badge([tmp_path / "pytest.xml", tmp_path / "e2e.xml"]) == {
        "schemaVersion": 1,
        "label": "tests",
        "message": "184 pass 2 fail",
        "color": "red",
    }
    (tmp_path / "e2e.xml").write_text(suites((80, 0, 0, 10)), encoding="utf-8")
    assert badge([tmp_path / "pytest.xml", tmp_path / "e2e.xml"])["color"] == "brightgreen"


def test_missing_report_writes_no_badge(tmp_path):
    (tmp_path / "pytest.xml").write_text(suites((60, 0, 0, 0)), encoding="utf-8")
    out = tmp_path / "tests.json"
    main([str(out), str(tmp_path / "pytest.xml"), str(tmp_path / "e2e.xml")])
    assert not out.exists()
    (tmp_path / "e2e.xml").write_text(suites((80, 0, 0, 10)), encoding="utf-8")
    main([str(out), str(tmp_path / "pytest.xml"), str(tmp_path / "e2e.xml")])
    assert json.loads(out.read_text(encoding="utf-8"))["message"] == "130 pass 0 fail"
