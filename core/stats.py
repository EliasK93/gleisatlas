"""Histogram statistics over (delay bucket, count) pairs. A NULL bucket is a cancelled stop."""

from collections.abc import Iterable
from dataclasses import dataclass

PUNCTUAL_BELOW_MIN = 6


@dataclass(frozen=True)
class CellStats:
    n: int  # stops including cancellations
    cancellation_rate: float
    median: float | None  # minutes, non-cancelled stops only
    p90: float | None
    punctual_share: float | None  # share below PUNCTUAL_BELOW_MIN minutes


def quantile(buckets: list[tuple[int, int]], q: float) -> float:
    """Smallest bucket whose cumulative count reaches q * total; buckets sorted ascending."""
    total = sum(n for _, n in buckets)
    acc = 0
    for bucket, n in buckets:
        acc += n
        if acc >= q * total:
            return float(bucket)
    raise ValueError("no buckets")


@dataclass(frozen=True)
class DelayBins:
    bins: tuple[int, ...]  # 7 counts, see BIN_EDGES
    cancelled: int


# Lower edges in whole minutes: bins are <1, [1,3), [3,6), [6,10), [10,20), [20,30), >=30
BIN_EDGES = (1, 3, 6, 10, 20, 30)


def delay_bins(rows: Iterable[tuple[int | None, int]]) -> DelayBins:
    """Counts per delay bin. Buckets are whole minutes (core.delay), so a bucket falls in the
    bin whose lower edge is the largest one <= bucket; early arrivals (negative) share the
    first bin. A NULL bucket is a cancelled stop and is counted separately."""
    bins = [0] * (len(BIN_EDGES) + 1)
    cancelled = 0
    for bucket, n in rows:
        if bucket is None:
            cancelled += n
        else:
            bins[sum(bucket >= e for e in BIN_EDGES)] += n
    return DelayBins(bins=tuple(bins), cancelled=cancelled)


def cell_stats(rows: Iterable[tuple[int | None, int]]) -> CellStats:
    pairs = list(rows)
    ok = sorted((b, n) for b, n in pairs if b is not None)
    ok_n = sum(n for _, n in ok)
    n = sum(c for _, c in pairs)
    return CellStats(
        n=n,
        cancellation_rate=(n - ok_n) / n,
        median=quantile(ok, 0.5) if ok_n else None,
        p90=quantile(ok, 0.9) if ok_n else None,
        punctual_share=sum(c for b, c in ok if b < PUNCTUAL_BELOW_MIN) / ok_n if ok_n else None,
    )
