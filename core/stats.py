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
