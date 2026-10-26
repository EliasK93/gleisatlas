from collections.abc import Callable
from datetime import datetime as dt
from pathlib import Path

import polars as pl
import pytest

from pipeline.update import update
from tests.conftest import complete

# (eva, station name, train_type, line_number, train_number, ride id, planned arrival)
Row = tuple[str, str, str, str | None, str, str, str]

SEP: list[Row] = [
    ("1", "Alpha", "ICE", None, "123", "i1", "2026-09-07 08:00"),
    ("2", "Beta", "ICE", None, "123", "i1", "2026-09-07 09:00"),
    # Two S1 networks without a shared station: 3-4 and 5-6.
    ("3", "Gamma", "S", "S1", "31", "a", "2026-09-07 08:00"),
    ("4", "Delta", "S", "S1", "31", "a", "2026-09-07 08:10"),
    ("4", "Delta", "S", "S1", "33", "a", "2026-09-08 08:10"),
    ("5", "Epsilon", "S", "S1", "35", "b", "2026-09-07 08:00"),
    ("5", "Epsilon", "S", "S1", "37", "b", "2026-09-08 08:00"),
    ("6", "Zeta", "S", "S1", "35", "b", "2026-09-07 08:10"),
]
OCT: list[Row] = [("1", "Alpha Neu", "ICE", None, "123", "i1", "2026-10-05 08:00")]


def src(rows: list[Row]) -> pl.DataFrame:
    planned = [dt.fromisoformat(r[6]) for r in rows]
    cols = [
        "eva",
        "station_name",
        "train_type",
        "line_number",
        "train_number",
        "train_line_ride_id",
    ]
    df = pl.DataFrame([r[:6] for r in rows], schema=cols, orient="row")
    return complete(
        df.with_columns(
            time=pl.Series(planned),
            arrival_planned_time=pl.Series(planned),
            arrival_change_time=pl.Series(planned),
            arrival_is_canceled=pl.lit(False),
        )
    )


@pytest.fixture
def data_dir(tmp_path: Path, coords: pl.DataFrame) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    coords.write_parquet(d / "coords.parquet")
    return d


@pytest.fixture
def fetched() -> list[str]:
    return []


@pytest.fixture
def fetch(tmp_path: Path, fetched: list[str]) -> Callable[[str], Path]:
    sources = {"2026-09": src(SEP), "2026-10": src(OCT)}

    def fake(month: str) -> Path:
        fetched.append(month)
        path = tmp_path / f"raw-{month}.parquet"
        sources[month].write_parquet(path)
        return path

    return fake


def run(data_dir: Path, fetch: Callable[[str], Path]) -> None:
    update(data_dir, lambda: ["2026-09", "2026-10"], fetch)


def test_second_run_fetches_nothing_and_still_combines(data_dir, fetch, fetched, capsys):
    run(data_dir, fetch)
    assert fetched == ["2026-09", "2026-10"]
    (data_dir / "aggregate.parquet").unlink()
    run(data_dir, fetch)
    assert fetched == ["2026-09", "2026-10"]
    assert pl.read_parquet(data_dir / "aggregate.parquet")["n"].sum() == 9
    assert "2026-09: skipped" in capsys.readouterr().out


def test_month_missing_a_file_is_reprocessed(data_dir, fetch, fetched):
    run(data_dir, fetch)
    (data_dir / "months" / "2026-09" / "networks.parquet").unlink()
    run(data_dir, fetch)
    assert fetched == ["2026-09", "2026-10", "2026-09"]
    assert (data_dir / "months" / "2026-09" / "networks.parquet").exists()


def test_leftover_temporary_folder_is_not_complete(data_dir, fetch, fetched):
    run(data_dir, fetch)
    months = data_dir / "months"
    (months / "2026-09").rename(months / "2026-09.tmp")  # a crash before the final rename
    run(data_dir, fetch)
    assert fetched == ["2026-09", "2026-10", "2026-09"]
    assert sorted(p.name for p in months.iterdir()) == ["2026-09", "2026-10"]


def test_update_aborts_without_coords_before_fetching(data_dir, fetch, fetched):
    (data_dir / "coords.parquet").unlink()
    with pytest.raises(SystemExit, match="pipeline.coords"):
        run(data_dir, fetch)
    assert fetched == []


def test_cleaning_counts_are_printed(data_dir, tmp_path, capsys):
    rows = SEP + [SEP[0]]  # one duplicate
    path = tmp_path / "dup.parquet"
    src(rows).write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    out = capsys.readouterr().out
    assert "2026-09: processed, dropped 1 duplicates and 0 implausible rows" in out


def test_combine_stations_newest_name_and_summed_n(data_dir, fetch, capsys):
    run(data_dir, fetch)
    st = pl.read_parquet(data_dir / "stations.parquet")
    assert st.columns == ["eva", "name", "n", "lat", "lon", "land"]
    assert st.filter(pl.col("eva") == "1").select("name", "n", "lat").row(0) == (
        "Alpha Neu",
        2,
        50.0,
    )
    assert "named stations with coordinates" in capsys.readouterr().out


def test_combine_station_keeps_the_newest_name_that_is_not_null(data_dir, tmp_path):
    paths = {"2026-09": tmp_path / "sep.parquet", "2026-10": tmp_path / "oct.parquet"}
    src(SEP).write_parquet(paths["2026-09"])
    src(OCT).with_columns(station_name=pl.lit(None, pl.String)).write_parquet(paths["2026-10"])
    update(data_dir, lambda: list(paths), lambda month: paths[month])
    st = pl.read_parquet(data_dir / "stations.parquet")
    assert st.filter(pl.col("eva") == "1").select("name", "n").row(0) == ("Alpha", 2)


def test_combine_lines_networks_and_labels(data_dir, fetch):
    run(data_dir, fetch)
    linien = pl.read_parquet(data_dir / "linien.parquet")
    assert linien.rows() == [
        ("ICE 123:1", "ICE 123", "ICE 123", "ICE"),
        ("S1:3", "S1", "S1 · Delta", "S"),
        ("S1:5", "S1", "S1 · Epsilon", "S"),
    ]
    lines = pl.read_parquet(data_dir / "lines.parquet")
    assert lines.columns == ["linie", "eva", "gruppe", "month", "bucket", "n"]
    ice = lines.filter(pl.col("linie") == "ICE 123:1")
    assert ice.group_by("month").agg(pl.col("n").sum()).sort("month").rows() == [
        ("2026-09", 2),
        ("2026-10", 1),
    ]


def test_lines_sum_back_to_the_aggregate(data_dir, fetch):
    run(data_dir, fetch)
    keys = ["eva", "gruppe", "month", "bucket"]

    def per_key(name: str) -> pl.DataFrame:
        df = pl.read_parquet(data_dir / f"{name}.parquet")
        return df.group_by(keys).agg(pl.col("n").sum()).sort(keys, nulls_last=True)

    assert per_key("lines").equals(per_key("aggregate"))


def test_monate(data_dir, fetch):
    run(data_dir, fetch)
    monate = pl.read_parquet(data_dir / "monate.parquet")
    assert monate.columns == ["month", "missing_hours", "stations"]
    assert monate["month"].to_list() == ["2026-09", "2026-10"]
    assert monate["stations"].to_list() == [6, 1]
