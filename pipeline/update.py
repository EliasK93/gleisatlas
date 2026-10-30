"""The one pipeline command: process every remote month not yet done, then combine all months."""

import re
import shutil
import sys
from collections.abc import Callable
from pathlib import Path

import polars as pl
from huggingface_hub import list_repo_files

from core.lines import line_ids, line_table, networks
from pipeline.aggregate import (
    aggregate,
    coverage_report,
    day_gaps,
    days,
    dropped,
    ends,
    lines,
    meta,
    month_networks,
    stations,
    with_coords,
)
from pipeline.download import REPO, download

MONTH_FILES = ("aggregate", "lines", "ends", "networks", "stations", "meta", "days", "day_gaps")
AGGREGATE_ORDER = ("month", "eva", "weekday", "hour", "gruppe", "bucket")
DAYS_ORDER = ("day", "eva", "gruppe", "bucket")
# About one day's rows (24.5 M rows over 822 days), so a one-day filter skips the other row groups.
# ponytail: no test reads the row groups (neither Polars nor an installed library exposes them);
# the evidence is the /tageskarte memory measurement in docs/day-history.md §5
DAYS_ROW_GROUP = 50_000


def _complete(month_dir: Path) -> bool:
    return all((month_dir / f"{name}.parquet").exists() for name in MONTH_FILES)


def process(src: Path, month: str, out: Path) -> str:
    """Write the month's tables to `out` via a temporary sibling, renamed only when all are
    written, so a crash never leaves a half-complete month. Returns the cleaning summary."""
    lf = pl.scan_parquet(src)
    dups, bad = dropped(lf)
    tmp = out.with_name(f"{out.name}.tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    tables = {
        "aggregate": aggregate(lf),
        "lines": lines(lf),
        "ends": ends(lf),
        "networks": month_networks(lf),
        "stations": stations(lf),
        "meta": meta(lf, month),
        "days": days(lf),
        "day_gaps": day_gaps(lf, month),
    }
    for name, df in tables.items():
        df.write_parquet(tmp / f"{name}.parquet")
    shutil.rmtree(out, ignore_errors=True)  # an incomplete earlier attempt
    tmp.rename(out)
    return f"dropped {dups} duplicates and {bad} implausible rows"


def _read(dirs: list[Path], name: str) -> pl.DataFrame:
    """One table over all months, with `month` from the folder name where the table has none."""
    frames = [pl.read_parquet(d / f"{name}.parquet") for d in dirs]
    return pl.concat(
        df if "month" in df.columns else df.with_columns(month=pl.lit(d.name))
        for d, df in zip(dirs, frames, strict=True)
    )


def combine(data_dir: Path) -> None:
    """Write the files the API reads from all complete month folders."""
    dirs = sorted(d for d in (data_dir / "months").glob("????-??") if _complete(d))
    aggregates = [d / "aggregate.parquet" for d in dirs]
    pl.scan_parquet(aggregates).sort(*AGGREGATE_ORDER, nulls_last=True).sink_parquet(
        data_dir / "aggregate.parquet"
    )

    # An edge day can sit in two month files: sum it per key.
    (
        pl.scan_parquet([d / "days.parquet" for d in dirs])
        .group_by(DAYS_ORDER)
        .agg(pl.col("n").sum())
        .select("day", "gruppe", "eva", "bucket", "n")
        .sort(DAYS_ORDER, nulls_last=True)
        .sink_parquet(data_dir / "days.parquet", row_group_size=DAYS_ROW_GROUP)
    )
    pl.concat(pl.read_parquet(d / "day_gaps.parquet") for d in dirs).sort("day").write_parquet(
        data_dir / "tage.parquet"
    )

    per_month = _read(dirs, "stations")
    names = (
        per_month.sort("month")  # group_by keeps the row order inside a group
        .group_by("eva")
        .agg(name=pl.col("name").drop_nulls().last(), n=pl.col("n").sum())
    )
    st = with_coords(names.sort("eva"), pl.read_parquet(data_dir / "coords.parquet"))
    st.write_parquet(data_dir / "stations.parquet")
    print(coverage_report(st))

    month_nets = _read(dirs, "networks")
    nets = networks(
        month_nets.select("name", group=pl.concat_str("month", pl.lit("|"), "net"), eva="eva")
    )
    by_name = _read(dirs, "lines")
    stops = by_name.group_by("name", "eva", "train_type").agg(pl.col("n").sum())
    all_ends = _read(dirs, "ends").group_by("name", "eva", "dest").agg(pl.col("n").sum())
    line_table(nets, stops, all_ends).write_parquet(data_dir / "linien.parquet")
    keys = ["linie", "eva", "gruppe", "month", "bucket"]
    (
        by_name.join(line_ids(nets).select("name", "eva", "linie"), on=["name", "eva"])
        .group_by(keys)
        .agg(pl.col("n").sum())
        .sort(keys, nulls_last=True)
        .write_parquet(data_dir / "lines.parquet")
    )

    _read(dirs, "meta").sort("month").write_parquet(data_dir / "monate.parquet")


def update(
    data_dir: Path, remote_months: Callable[[], list[str]], fetch: Callable[[str], Path]
) -> None:
    coords = data_dir / "coords.parquet"
    if not coords.exists():
        sys.exit(f"Missing {coords}: run `uv run python -m pipeline.coords` first")
    for month in remote_months():
        out = data_dir / "months" / month
        if _complete(out):
            print(f"{month}: skipped, already complete")
            continue
        print(f"{month}: processed, {process(fetch(month), month, out)}")
    combine(data_dir)


def remote_months() -> list[str]:
    pattern = r"monthly_processed_data/data-(\d{4}-\d{2})\.parquet"
    files = list_repo_files(REPO, repo_type="dataset")
    return sorted(m[1] for f in files if (m := re.fullmatch(pattern, f)))


def main(argv: list[str]) -> None:
    if argv:
        sys.exit("usage: python -m pipeline.update")
    update(Path("data"), remote_months, lambda month: Path(download(month)))


if __name__ == "__main__":
    main(sys.argv[1:])
