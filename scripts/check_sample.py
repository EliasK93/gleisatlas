"""Spot check on real data: arrival delay from core vs. raw rows on a random sample.

Usage: uv run python scripts/check_sample.py <source.parquet> [sample_size]
Prints the number of rows where the computed delay differs from the raw timestamps.
"""

import sys
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from core.delay import arrival_delay_expr  # noqa: E402


def main(argv: list[str]) -> None:
    if not argv:
        sys.exit("usage: python scripts/check_sample.py <source.parquet> [sample_size]")
    size = int(argv[1]) if len(argv) > 1 else 100_000
    df = pl.scan_parquet(argv[0]).filter(pl.col("arrival_planned_time").is_not_null()).collect()
    df = df.sample(min(size, df.height), seed=0)
    planned, changed, cancelled = (
        pl.col("arrival_planned_time"),
        pl.col("arrival_change_time"),
        pl.col("arrival_is_canceled"),
    )
    secs = changed.dt.epoch("s") - planned.dt.epoch("s")
    computed = arrival_delay_expr(planned, changed, cancelled, lo=-10_000, hi=10_000)
    checked = df.select(
        got=computed,
        # Independent re-computation from raw seconds, truncated toward zero like total_minutes().
        want=pl.when(cancelled.fill_null(False))
        .then(None)
        .otherwise((secs.sign() * (secs.abs() // 60)).fill_null(0).cast(pl.Int32)),
    )
    mismatches = checked.filter(pl.col("got").ne_missing(pl.col("want"))).height
    print(f"sample: {df.height} rows, mismatches: {mismatches}")


if __name__ == "__main__":
    main(sys.argv[1:])
