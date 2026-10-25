"""Monthly source file -> delay histogram per weekday x hour x category x station x month."""

import sys
from pathlib import Path

import polars as pl

from core.categories import category_expr, is_excluded_expr
from core.delay import arrival_delay_expr

REQUIRED = {
    "eva",
    "station_name",
    "train_type",
    "time",
    "arrival_planned_time",
    "arrival_change_time",
    "arrival_is_canceled",
}


def check_schema(lf: pl.LazyFrame) -> None:
    missing = REQUIRED - set(lf.collect_schema().names())
    if missing:
        sys.exit(f"Schema error: missing columns {sorted(missing)}")


def _arrivals(lf: pl.LazyFrame) -> pl.LazyFrame:
    check_schema(lf)
    train_type = pl.col("train_type")
    return lf.filter(pl.col("arrival_planned_time").is_not_null() & ~is_excluded_expr(train_type))


def aggregate(lf: pl.LazyFrame) -> pl.DataFrame:
    """One row per (weekday, hour, gruppe, eva, month, bucket); bucket NULL = cancelled."""
    planned = pl.col("arrival_planned_time")
    return (
        _arrivals(lf)
        .select(
            weekday=planned.dt.weekday() - 1,  # 0 = Monday
            hour=planned.dt.hour(),
            gruppe=category_expr(pl.col("train_type")),
            eva=pl.col("eva"),
            # Month comes from `time`: a monthly file holds stops planned on the boundary days.
            month=pl.col("time").dt.strftime("%Y-%m"),
            bucket=arrival_delay_expr(
                planned, pl.col("arrival_change_time"), pl.col("arrival_is_canceled")
            ),
        )
        .group_by("weekday", "hour", "gruppe", "eva", "month", "bucket")
        .agg(n=pl.len())
        .sort("month", "eva", "weekday", "hour", "gruppe", "bucket", nulls_last=True)
        .collect()
    )


def stations(lf: pl.LazyFrame) -> pl.DataFrame:
    """Station names per EVA (display only; filtering always uses the EVA)."""
    return (
        _arrivals(lf)
        .group_by("eva")
        .agg(name=pl.col("station_name").mode().sort().first())  # sorted: deterministic on ties
        .sort("eva")
        .collect()
    )


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        sys.exit("usage: python -m pipeline.aggregate <source.parquet> <aggregate.parquet>")
    src, dst = Path(argv[0]), Path(argv[1])
    dst.parent.mkdir(parents=True, exist_ok=True)
    source = pl.scan_parquet(src)
    aggregate(source).write_parquet(dst)
    stations(source).write_parquet(dst.with_name("stations.parquet"))
    print(f"written: {dst}")


if __name__ == "__main__":
    main(sys.argv[1:])
