from datetime import UTC, date, datetime

from core.periods import full_coverage_start, local_time, timetable_changes


def test_local_time_is_naive_german_time_in_winter_summer_and_the_doubled_hour():
    assert local_time(datetime(2026, 11, 4, 13, 37, tzinfo=UTC)) == datetime(2026, 11, 4, 14, 37)
    assert local_time(datetime(2026, 7, 9, 23, 30, tzinfo=UTC)) == datetime(2026, 7, 10, 1, 30)
    # 25 October: 02:30 summer time, then 02:30 winter time an hour later
    assert local_time(datetime(2026, 10, 25, 0, 30, tzinfo=UTC)) == datetime(2026, 10, 25, 2, 30)
    assert local_time(datetime(2026, 10, 25, 1, 30, tzinfo=UTC)) == datetime(2026, 10, 25, 2, 30)


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
