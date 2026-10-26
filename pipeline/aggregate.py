"""Monthly source file -> delay histogram per weekday x hour x category x station x month."""

import sys
from pathlib import Path

import polars as pl

from core.categories import category_expr, is_excluded_expr
from core.delay import arrival_delay_expr
from core.stations import ibnr_expr

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


def stop_counts(lf: pl.LazyFrame) -> pl.DataFrame:
    """Stops per EVA over the whole source: all categories and months, cancelled included."""
    return _arrivals(lf).group_by("eva").agg(n=pl.len()).sort("eva").collect()


def with_coords(st: pl.DataFrame, coords: pl.DataFrame) -> pl.DataFrame:
    """Add lat, lon, land; coords are keyed by IBNR, our EVAs carry a leading zero.

    A secondary EVA (e.g. the S-Bahn platforms of a station) is often missing in Wikidata; it
    takes the coordinates of the one located station with exactly the same name.
    """
    keyed = st.with_columns(ibnr=ibnr_expr(pl.col("eva")))
    out = keyed.join(coords, on="ibnr", how="left").drop("ibnr")
    geo = ["lat", "lon", "land"]
    namesake = (
        out.drop_nulls(["name", "lat"])
        .filter(pl.len().over("name") == 1)
        .select("name", *(pl.col(c).alias(f"{c}_same") for c in geo))
    )
    missing = pl.col("lat").is_null()
    return (
        out.join(namesake, on="name", how="left", maintain_order="left")
        .with_columns(
            pl.when(missing).then(pl.col(f"{c}_same")).otherwise(pl.col(c)).alias(c) for c in geo
        )
        .drop(f"{c}_same" for c in geo)
    )


def coverage_report(st: pl.DataFrame) -> str:
    named = st.drop_nulls("name")
    hit = named.filter(pl.col("lat").is_not_null())
    stops, hit_stops = int(named["n"].sum()), int(hit["n"].sum())
    lines = [
        f"named stations with coordinates: {hit.height} of {named.height}"
        f" ({100 * hit.height / named.height:.1f} %)",
        f"share of stops with coordinates: {100 * hit_stops / stops:.1f} %",
        "20 unmatched named stations with the most stops (eva, name, n):",
    ]
    miss = named.filter(pl.col("lat").is_null()).sort("n", descending=True).head(20)
    lines += [f"  {eva}  {name}  {n}" for eva, name, n, *_ in miss.iter_rows()]
    return "\n".join(lines)


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        sys.exit("usage: python -m pipeline.aggregate <source.parquet> <aggregate.parquet>")
    src, dst = Path(argv[0]), Path(argv[1])
    coords_path = dst.with_name("coords.parquet")
    if not coords_path.exists():
        sys.exit(f"Missing {coords_path}: run `uv run python -m pipeline.coords` first")
    dst.parent.mkdir(parents=True, exist_ok=True)
    source = pl.scan_parquet(src)
    aggregate(source).write_parquet(dst)
    joined = stations(source).join(stop_counts(source), on="eva")
    out = with_coords(joined, pl.read_parquet(coords_path))
    out.write_parquet(dst.with_name("stations.parquet"))
    print(f"written: {dst}")
    print(coverage_report(out))


if __name__ == "__main__":
    main(sys.argv[1:])
