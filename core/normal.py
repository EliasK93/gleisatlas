"""The normal of a day: the same weekday over the previous weeks, and how far a day is from it."""

from collections.abc import Collection, Sequence
from datetime import date, timedelta
from statistics import median

from core.holidays import nationwide_holidays
from core.rankings import Metric

WEEKS = 12
MIN_DAYS = 8  # valid days a normal or a class needs
USUAL_Z = 1  # a day within this many spreads of its normal is as usual
MUCH_Z = 2  # from this many spreads on it is much better or much worse
# The smallest spread a metric is taken to have, in its own unit: when the reference days agree
# almost exactly, a tiny difference must not read as unusual.
FLOORS: dict[Metric, float] = {
    "punctual_share": 0.01,  # one percentage point
    "cancellation_rate": 0.005,
    "median": 1.5,  # minutes; the stored medians are whole minutes
    "p90": 1.5,
}


def reference_days(day: date, first: date, last: date, gap_days: Collection[date]) -> list[date]:
    """The same weekday of the previous WEEKS weeks, nearest first, without days outside
    first..last, gap days and nationwide public holidays."""
    days = [day - timedelta(weeks=k) for k in range(1, WEEKS + 1)]
    return [
        d
        for d in days
        if first <= d <= last and d not in gap_days and d not in nationwide_holidays(d.year)
    ]


def normal(values: Sequence[float | None]) -> float | None:
    """The median of the given values; None with fewer than MIN_DAYS of them."""
    valid = [v for v in values if v is not None]
    return median(valid) if len(valid) >= MIN_DAYS else None


def spread(values: Sequence[float | None], floor: float) -> float | None:
    """The usual day-to-day variation: 1.4826 times the median absolute deviation from the
    median, at least `floor`; None with fewer than MIN_DAYS values."""
    valid = [v for v in values if v is not None]
    if len(valid) < MIN_DAYS:
        return None
    mid = median(valid)
    return max(1.4826 * median(abs(v - mid) for v in valid), floor)


def deviation_class(
    value: float | None, references: Sequence[float | None], higher_is_better: bool, floor: float
) -> int | None:
    """1 (much better) to 5 (much worse) by the distance from the normal in spreads: under
    USUAL_Z is 3, under MUCH_Z is 2 or 4, beyond is 1 or 5. None without a value or a normal."""
    mid, noise = normal(references), spread(references, floor)
    if value is None or mid is None or noise is None:
        return None
    z = (value - mid) / noise * (1 if higher_is_better else -1)  # positive: better
    if abs(z) < USUAL_Z:
        return 3
    far = abs(z) >= MUCH_Z
    return (1 if far else 2) if z > 0 else (5 if far else 4)
