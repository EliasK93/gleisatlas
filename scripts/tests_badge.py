"""Shields.io endpoint JSON for the README's tests badge, from the JUnit reports of pytest and
Playwright that CI writes. Skipped tests are left out of the count. If a report is missing (the
gate stopped before that suite ran), no badge is written, so CI keeps the last one.

Usage: python scripts/tests_badge.py <out.json> <report.xml>...
"""

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def badge(reports: list[Path]) -> dict[str, object]:
    passed = failed = 0
    for report in reports:
        for suite in ET.parse(report).getroot().iter("testsuite"):
            tests, failures, errors, skipped = (
                int(suite.get(k, 0)) for k in ("tests", "failures", "errors", "skipped")
            )
            failed += failures + errors
            passed += tests - failures - errors - skipped
    return {
        "schemaVersion": 1,
        "label": "tests",
        "message": f"{passed} pass {failed} fail",
        "color": "red" if failed else "brightgreen",
    }


def main(argv: list[str]) -> None:
    out, reports = Path(argv[0]), [Path(a) for a in argv[1:]]
    missing = [str(r) for r in reports if not r.exists()]
    if missing:
        print(f"no badge: missing {', '.join(missing)}")
        return
    out.write_text(json.dumps(badge(reports)), encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1:])
