"""Calendar facts about the data: German local time, timetable changes and the start of full
station coverage."""

# pyright: reportUnknownMemberType=false
# (Polars' filter, select and sort stubs are partially unknown under strict mode.)
from collections.abc import Mapping
from datetime import date, datetime, timedelta

import polars as pl


def local_time(t: datetime) -> datetime:
    """The naive Europe/Berlin time of an aware instant, the clock the source's times use. Polars
    carries the time zone rules; Python's zoneinfo would need the tzdata package on Windows."""
    return pl.Series([t]).dt.convert_time_zone("Europe/Berlin").dt.replace_time_zone(None).item()


def timetable_changes(first: date, last: date) -> list[date]:
    """Timetable changes in [first, last]: the Sunday after the second Saturday of December."""
    out: list[date] = []
    for year in range(first.year, last.year + 1):
        dec1 = date(year, 12, 1)
        first_saturday = dec1 + timedelta(days=(5 - dec1.weekday()) % 7)
        change = first_saturday + timedelta(days=8)
        if first <= change <= last:
            out.append(change)
    return out


def full_coverage_start(stations_per_month: Mapping[str, int]) -> str | None:
    """First month ('YYYY-MM') with at least half the station count of the largest month."""
    if not stations_per_month:
        return None
    top = max(stations_per_month.values())
    return next(m for m in sorted(stations_per_month) if 2 * stations_per_month[m] >= top)


def large_stations(days: pl.LazyFrame, full_start: str) -> pl.LazyFrame:
    """The distinct `eva`, sorted, with stops on a day of the last month before `full_start`
    ('YYYY-MM'): the stations the source covered before it took every station in."""
    year, month = int(full_start[:4]), int(full_start[5:])
    first = date(year - (month == 1), (month - 2) % 12 + 1, 1)
    return (
        days.filter(pl.col("day").is_between(first, date(year, month, 1), closed="left"))
        .select("eva")
        .unique()
        .sort("eva")
    )
