"""Calendar facts about the data: timetable changes and the start of full station coverage."""

from collections.abc import Mapping
from datetime import date, timedelta


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
