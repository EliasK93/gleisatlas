from datetime import UTC, date, datetime

import polars as pl

from core.periods import full_coverage_start, large_stations, local_time, timetable_changes


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


def test_large_stations_are_those_with_stops_in_the_month_before_full_coverage():
    days = pl.LazyFrame(
        {
            "day": [date(2025, 9, 30), date(2025, 10, 1), date(2025, 10, 31), date(2025, 10, 15)]
            + [date(2025, 11, 1), date(2025, 12, 31), date(2026, 1, 1)],
            "eva": ["early", "b", "a", "a", "late", "dec", "jan"],
        }
    )

    def large(start: str) -> list[str]:
        return large_stations(days, start).collect()["eva"].to_list()

    assert large("2025-11") == ["a", "b"]  # distinct and sorted; the 30th and the 1st stay out
    assert large("2026-01") == ["dec"]  # the month before January is December of the year before
    assert large("2025-09") == []
