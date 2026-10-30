"""Histogram statistics over (delay bucket, count) pairs. A NULL bucket is a cancelled stop."""

# pyright: reportUnknownMemberType=false
# (Polars' when/then and group_by stubs are partially unknown under strict mode.)
from collections.abc import Iterable
from dataclasses import dataclass

import polars as pl

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


def cell_stats_frame(lf: pl.LazyFrame, keys: list[str]) -> pl.LazyFrame:
    """`cell_stats` for every key combination at once. `lf` has the key columns, `bucket` (NULL =
    cancelled) and `n`, one row per (keys, bucket). One row per key combination comes back, in no
    order, with n, cancellation_rate, median, p90 and punctual_share; None where nothing arrived."""
    # Rows sorted by cell and bucket, a running count of the arrived stops that restarts at each
    # cell, and the cell's arrived total on every row. No window functions (`over`): they were
    # several times slower on hundreds of thousands of rows.
    counted = pl.when(pl.col("bucket").is_not_null()).then(pl.col("n").cast(pl.Int64)).otherwise(0)
    first = pl.any_horizontal(pl.col(k).ne_missing(pl.col(k).shift(1)) for k in keys)
    last = pl.any_horizontal(pl.col(k).ne_missing(pl.col(k).shift(-1)) for k in keys)
    rows = (
        lf.with_columns(n=pl.col("n").cast(pl.Int64), counted=counted)  # sums must not wrap
        .sort(*keys, "bucket")  # a NULL (cancelled) bucket comes first and adds 0
        .with_columns(running=pl.col("counted").cum_sum())
        .with_columns(
            cum=pl.col("running")
            - pl.when(first).then(pl.col("running") - pl.col("counted")).forward_fill()
        )
        .with_columns(ok_n=pl.when(last).then(pl.col("cum")).backward_fill())
    )

    def quantile_of(q: float) -> pl.Expr:
        # the smallest bucket whose cumulative count reaches q * arrived, float64 as in `quantile`
        reached = (pl.col("cum") >= q * pl.col("ok_n")) & (pl.col("ok_n") > 0)
        return pl.when(reached).then(pl.col("bucket")).min().cast(pl.Float64)

    early = pl.when(pl.col("bucket") < PUNCTUAL_BELOW_MIN).then(pl.col("n")).sum()
    return rows.group_by(keys).agg(
        n=pl.col("n").sum(),
        cancellation_rate=(pl.col("n").sum() - pl.col("counted").sum()) / pl.col("n").sum(),
        median=quantile_of(0.5),
        p90=quantile_of(0.9),
        punctual_share=pl.when(pl.col("counted").sum() > 0).then(early / pl.col("counted").sum()),
    )


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
