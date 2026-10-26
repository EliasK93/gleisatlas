from datetime import date

from core.periods import full_coverage_start, timetable_changes


def test_timetable_changes():
    assert timetable_changes(date(2024, 7, 1), date(2026, 12, 31)) == [
        date(2024, 12, 15),
        date(2025, 12, 14),
        date(2026, 12, 13),
    ]


def test_timetable_changes_bounds_are_inclusive():
    assert timetable_changes(date(2025, 12, 14), date(2026, 12, 13)) == [
        date(2025, 12, 14),
        date(2026, 12, 13),
    ]
    assert timetable_changes(date(2025, 12, 15), date(2026, 12, 12)) == []


def test_full_coverage_start():
    assert full_coverage_start({"2025-12": 5100, "2025-10": 100, "2025-11": 5200}) == "2025-11"
    assert full_coverage_start({"2025-10": 50, "2025-11": 100}) == "2025-10"
    assert full_coverage_start({}) is None
