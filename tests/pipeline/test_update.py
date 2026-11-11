import shutil
from collections.abc import Callable
from datetime import date, timedelta
from datetime import datetime as dt
from pathlib import Path

import polars as pl
import pytest

from core.periods import full_coverage_start, large_stations
from pipeline.raw import RawSource
from pipeline.update import day_complete, main, update
from tests.conftest import complete
from tests.pipeline.test_raw import Response, at, fchg_stop, plan_stop, write_raw, xml

# (eva, station name, train_type, line_number, train_number, ride id, planned arrival, destination)
Row = tuple[str, str, str, str | None, str, str, str, str | None]

SEP: list[Row] = [
    ("1", "Alpha", "ICE", None, "123", "i1", "2026-09-07 08:00", "Beta"),
    ("2", "Beta", "ICE", None, "123", "i1", "2026-09-07 09:00", "Beta"),
    # Two S1 networks without a shared station: 3-4 and 5-6.
    ("3", "Gamma", "S", "S1", "31", "a", "2026-09-07 08:00", "Delta"),
    ("4", "Delta", "S", "S1", "31", "a", "2026-09-07 08:10", "Delta"),
    ("4", "Delta", "S", "S1", "33", "a", "2026-09-08 08:10", "Gamma"),
    ("5", "Epsilon", "S", "S1", "35", "b", "2026-09-07 08:00", "Zeta"),
    ("5", "Epsilon", "S", "S1", "37", "b", "2026-09-08 08:00", "Zeta"),
    ("6", "Zeta", "S", "S1", "35", "b", "2026-09-07 08:10", "Zeta"),
]
OCT: list[Row] = [("1", "Alpha Neu", "ICE", None, "123", "i1", "2026-10-05 08:00", "Beta")]


def src(rows: list[Row]) -> pl.DataFrame:
    planned = [dt.fromisoformat(r[6]) for r in rows]
    cols = [
        "eva",
        "station_name",
        "train_type",
        "line_number",
        "train_number",
        "train_line_ride_id",
        "final_destination_station",
    ]
    # Typed, so a month without any line number is a String column, as in the source.
    df = pl.DataFrame(
        [(*r[:6], r[7]) for r in rows], schema=dict.fromkeys(cols, pl.String), orient="row"
    )
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
    assert linien.columns == ["linie", "name", "label", "typ", "zug", "ohne_echtzeit"]
    assert linien.rows() == [
        ("ICE 123:1", "ICE 123", "ICE 123 → Beta", "ICE", True, False),
        ("S1:3", "S1", "S1 Delta – Gamma", "S", False, False),
        ("S1:5", "S1", "S1 Zeta", "S", False, False),
    ]
    lines = pl.read_parquet(data_dir / "lines.parquet")
    assert lines.columns == ["linie", "eva", "gruppe", "month", "bucket", "n"]
    ice = lines.filter(pl.col("linie") == "ICE 123:1")
    assert ice.group_by("month").agg(pl.col("n").sum()).sort("month").rows() == [
        ("2026-09", 2),
        ("2026-10", 1),
    ]


def test_a_line_with_500_stops_all_on_time_is_marked_without_live_data(data_dir, tmp_path):
    def stops(line: str, count: int) -> list[Row]:
        def planned(i: int) -> str:
            return f"2026-09-07 {8 + i // 60:02}:{i % 60:02}"

        return [
            ("1", "Alpha", "S", line, f"{line}{i}", f"{line}-{i}", planned(i), "Beta")
            for i in range(count)
        ]

    rows = stops("S9", 500) + stops("S8", 499) + stops("S7", 500)
    df = src(rows).with_columns(
        # S7 runs ten minutes late, S9 and S8 report no delay at all
        arrival_change_time=pl.when(pl.col("line_number") == "S7")
        .then(pl.col("arrival_planned_time") + pl.duration(minutes=10))
        .otherwise(pl.col("arrival_change_time"))
    )
    path = tmp_path / "sep.parquet"
    df.write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    linien = pl.read_parquet(data_dir / "linien.parquet")
    assert linien.select("name", "zug", "ohne_echtzeit").rows() == [
        ("S7", False, False),  # enough stops, but late
        ("S8", False, False),  # on time, but 499 stops
        ("S9", False, True),
    ]


def test_bare_number_and_prefixed_name_become_one_line(data_dir, tmp_path):
    # The source gave "57" until a timetable change and "RE57" after it.
    sep: list[Row] = [
        ("1", "Alpha", "RE", "57", "4701", "x1", "2026-09-07 08:00", "Beta"),
        ("2", "Beta", "RE", "57", "4701", "x1", "2026-09-07 08:10", "Beta"),
    ]
    oct_: list[Row] = [
        ("1", "Alpha", "RE", "RE57", "4703", "x2", "2026-10-05 08:00", "Beta"),
        ("2", "Beta", "RE", "RE57", "4703", "x2", "2026-10-05 08:10", "Beta"),
    ]
    paths = {"2026-09": tmp_path / "sep.parquet", "2026-10": tmp_path / "oct.parquet"}
    src(sep).write_parquet(paths["2026-09"])
    src(oct_).write_parquet(paths["2026-10"])
    update(data_dir, lambda: list(paths), lambda month: paths[month])
    assert pl.read_parquet(data_dir / "linien.parquet").rows() == [
        ("RE57:1", "RE57", "RE57 Beta", "RE", False, False)
    ]
    lines = pl.read_parquet(data_dir / "lines.parquet")
    assert lines["linie"].unique().to_list() == ["RE57:1"]
    assert lines["n"].sum() == 4


def test_bare_numbers_of_different_train_types_stay_apart(data_dir, tmp_path):
    rows: list[Row] = [
        ("1", "Alpha", "S", "1", "31", "s1", "2026-09-07 08:00", "Beta"),
        ("2", "Beta", "S", "1", "31", "s1", "2026-09-07 08:10", "Beta"),
        ("1", "Alpha", "RE", "1", "4701", "r1", "2026-09-07 08:00", "Gamma"),
        ("3", "Gamma", "RE", "1", "4701", "r1", "2026-09-07 08:20", "Gamma"),
    ]
    path = tmp_path / "sep.parquet"
    src(rows).write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    assert pl.read_parquet(data_dir / "linien.parquet").rows() == [
        ("RE1:1", "RE1", "RE1 Gamma", "RE", False, False),
        ("S1:1", "S1", "S1 Beta", "S", False, False),
    ]


def test_blank_destination_is_not_an_end(data_dir, tmp_path):
    rows: list[Row] = [
        ("1", "Alpha", "S", "S1", "31", "a", "2026-09-07 08:00", "  "),
        ("1", "Alpha", "S", "S1", "33", "a", "2026-09-08 08:00", ""),
        ("2", "Beta", "S", "S1", "31", "a", "2026-09-07 08:10", "Beta"),
        ("2", "Beta", "S", "S1", "33", "a", "2026-09-08 08:10", None),
    ]
    path = tmp_path / "sep.parquet"
    src(rows).write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    assert pl.read_parquet(data_dir / "linien.parquet")["label"].to_list() == ["S1 Beta"]


def test_lines_sum_back_to_the_aggregate(data_dir, fetch):
    run(data_dir, fetch)
    keys = ["eva", "gruppe", "month", "bucket"]

    def per_key(name: str) -> pl.DataFrame:
        df = pl.read_parquet(data_dir / f"{name}.parquet")
        return df.group_by(keys).agg(pl.col("n").sum()).sort(keys, nulls_last=True)

    assert per_key("lines").equals(per_key("aggregate"))


def test_month_without_the_day_tables_is_reprocessed(data_dir, fetch, fetched):
    run(data_dir, fetch)
    (data_dir / "months" / "2026-10" / "days.parquet").unlink()
    run(data_dir, fetch)
    assert fetched == ["2026-09", "2026-10", "2026-10"]
    assert (data_dir / "months" / "2026-10" / "days.parquet").exists()
    assert (data_dir / "months" / "2026-10" / "day_gaps.parquet").exists()


def test_days_sum_back_to_the_aggregate_and_tage_to_monate(data_dir, fetch):
    run(data_dir, fetch)
    keys = ["eva", "gruppe", "bucket"]

    def per_key(name: str) -> pl.DataFrame:
        df = pl.read_parquet(data_dir / f"{name}.parquet")
        return df.group_by(keys).agg(pl.col("n").sum()).sort(keys, nulls_last=True)

    days = pl.read_parquet(data_dir / "days.parquet")
    assert days.columns == ["day", "gruppe", "eva", "bucket", "n"]
    assert per_key("days").equals(per_key("aggregate"))
    tage = pl.read_parquet(data_dir / "tage.parquet")
    assert tage.columns == ["day", "missing_hours"]
    assert tage["day"].is_sorted()
    assert tage.height == 30 + 31  # every calendar day of both months
    month = tage["day"].dt.strftime("%Y-%m")
    by_month = tage.group_by(month.alias("month")).agg(pl.col("missing_hours").sum())
    monate = pl.read_parquet(data_dir / "monate.parquet")
    assert dict(by_month.iter_rows()) == dict(monate.select("month", "missing_hours").iter_rows())


def test_an_edge_day_split_over_two_months_is_summed(data_dir, tmp_path):
    edge: Row = ("1", "Alpha", "ICE", None, "125", "e1", "2026-10-01 00:05", "Beta")
    other: Row = ("1", "Alpha", "ICE", None, "126", "e2", "2026-10-01 00:20", "Beta")
    sep_time = dt(2026, 9, 30, 23, 59)  # recorded in September, planned on the 1st of October
    sep = src(SEP + [edge]).with_columns(
        time=pl.when(pl.col("time") >= dt(2026, 10, 1)).then(sep_time).otherwise(pl.col("time"))
    )
    paths = {"2026-09": tmp_path / "sep.parquet", "2026-10": tmp_path / "oct.parquet"}
    sep.write_parquet(paths["2026-09"])
    src(OCT + [other]).write_parquet(paths["2026-10"])
    update(data_dir, lambda: list(paths), lambda month: paths[month])
    days = pl.read_parquet(data_dir / "days.parquet")
    one = days.filter((pl.col("day") == dt(2026, 10, 1).date()) & (pl.col("eva") == "1"))
    assert one.select("bucket", "n").rows() == [(0, 2)]  # one row: both files summed
    assert days["n"].sum() == 11  # the nine of the fixtures plus the two edge stops


def day_hours_per_day(data_dir: Path) -> pl.DataFrame:
    """`day_hours.parquet` summed over the hour, in the shape and order of `days.parquet`."""
    keys = ["day", "eva", "gruppe", "bucket"]
    hours = pl.read_parquet(data_dir / "day_hours.parquet")
    summed = (
        hours.group_by(keys).agg(pl.col("n").sum()).select("day", "gruppe", "eva", "bucket", "n")
    )
    return summed.sort(keys, nulls_last=True)


# August has one station: it is the large one, the stations the source covered before September
# brought in the rest (September has six, so full coverage starts there).
AUG: list[Row] = [("1", "Alpha", "ICE", None, "120", "a0", "2026-08-10 08:00", "Beta")]


def large_days(data_dir: Path, evas: list[str]) -> pl.DataFrame:
    """`days.parquet` of the given stations only."""
    return pl.read_parquet(data_dir / "days.parquet").filter(pl.col("eva").is_in(evas))


def test_day_hours_sum_an_edge_day_and_add_up_to_days_of_the_large_stations(data_dir, tmp_path):
    edge: Row = ("1", "Alpha", "ICE", None, "125", "e1", "2026-10-01 00:05", "Beta")
    other: Row = ("1", "Alpha", "ICE", None, "126", "e2", "2026-10-01 00:20", "Beta")
    sep = src(SEP + [edge]).with_columns(
        time=pl.when(pl.col("time") >= dt(2026, 10, 1))
        .then(dt(2026, 9, 30, 23, 59))
        .otherwise(pl.col("time"))
    )
    paths = {m: tmp_path / f"{m}.parquet" for m in ("2026-08", "2026-09", "2026-10")}
    src(AUG).write_parquet(paths["2026-08"])
    sep.write_parquet(paths["2026-09"])
    src(OCT + [other]).write_parquet(paths["2026-10"])
    update(data_dir, lambda: list(paths), lambda month: paths[month])
    for month in paths:
        assert (data_dir / "months" / month / "day_hours.parquet").exists()
    hours = pl.read_parquet(data_dir / "day_hours.parquet")
    assert hours.columns == ["day", "hour", "gruppe", "eva", "bucket", "n"]
    assert hours.schema["hour"] == pl.Int8
    edge_hour = hours.filter((pl.col("day") == date(2026, 10, 1)) & (pl.col("hour") == 0))
    assert edge_hour.select("eva", "bucket", "n").rows() == [("1", 0, 2)]  # both files summed
    # Only the large station is in the hour table; days.parquet keeps all six.
    assert hours["eva"].unique().to_list() == ["1"]
    assert pl.read_parquet(data_dir / "days.parquet")["eva"].n_unique() == 6
    assert day_hours_per_day(data_dir).equals(large_days(data_dir, ["1"]))


def test_day_hours_take_the_raw_days_too(data_dir, fetch, tmp_path, raw):
    paths = {"2026-08": tmp_path / "aug.parquet", "2026-09": fetch("2026-09")}
    src([(EVA, "Alpha", "ICE", None, "120", "a0", "2026-08-10 08:00", "Beta")]).write_parquet(
        paths["2026-08"]
    )
    update(data_dir, lambda: list(paths), lambda month: paths[month], raw.source())
    assert (data_dir / "days" / "2026-10-01" / "day_hours.parquet").exists()
    hours = pl.read_parquet(data_dir / "day_hours.parquet")
    oct_1 = hours.filter(pl.col("day") == date(2026, 10, 1)).sort("hour")
    assert oct_1.select("hour", "bucket", "n").rows() == [(8, 10, 1), (23, 25, 1)]
    assert hours["eva"].unique().to_list() == [EVA]  # the six stations of September are left out
    assert day_hours_per_day(data_dir).equals(large_days(data_dir, [EVA]))


def test_combine_writes_the_large_stations_by_the_core_rule(data_dir, tmp_path):
    paths = {m: tmp_path / f"{m}.parquet" for m in ("2026-08", "2026-09", "2026-10")}
    for month, rows in zip(paths, (AUG, SEP, OCT), strict=True):
        src(rows).write_parquet(paths[month])
    update(data_dir, lambda: list(paths), lambda month: paths[month])
    large = pl.read_parquet(data_dir / "large.parquet")
    assert large.schema == pl.Schema({"eva": pl.String})
    monate = pl.read_parquet(data_dir / "monate.parquet")
    start = full_coverage_start(dict(zip(monate["month"], monate["stations"], strict=True)))
    assert start == "2026-09"
    days = pl.scan_parquet(data_dir / "days.parquet")
    assert large["eva"].to_list() == large_stations(days, start).collect()["eva"].to_list() == ["1"]


def test_large_parquet_is_written_empty_without_a_month_before_full_coverage(data_dir, fetch):
    run(data_dir, fetch)  # September already has most of the stations: no month before it
    large = pl.read_parquet(data_dir / "large.parquet")
    assert (large.schema, large.height) == (pl.Schema({"eva": pl.String}), 0)


def test_combine_writes_the_stops_per_station_group_and_month(data_dir, tmp_path):
    def month(rows: list[Row], starts: list[int]) -> pl.DataFrame:
        df = src(rows)  # every row has an arrival; the first stops of a trip have a departure only
        planned = df["arrival_planned_time"]
        return df.with_columns(
            departure_planned_time=planned,
            arrival_planned_time=pl.when(pl.int_range(pl.len()).is_in(starts))
            .then(None)
            .otherwise(planned),
        )

    sep = month(
        [
            ("1", "Alpha", "RE", "RE5", "1", "t1", "2026-09-07 08:00", "Beta"),  # starts here
            ("2", "Beta", "RE", "RE5", "1", "t1", "2026-09-07 08:10", "Beta"),
            ("1", "Alpha", "RE", "RE5", "2", "t2", "2026-09-08 08:00", "Beta"),  # starts here
            ("1", "Alpha", "RE", "RE5", "3", "t3", "2026-09-08 09:00", "Beta"),  # passes through
        ],
        [0, 2],
    )
    paths = {"2026-09": tmp_path / "sep.parquet", "2026-10": tmp_path / "oct.parquet"}
    sep.write_parquet(paths["2026-09"])
    src(OCT).write_parquet(paths["2026-10"])
    update(data_dir, lambda: list(paths), lambda m: paths[m])
    halte = pl.read_parquet(data_dir / "halte.parquet")
    assert halte.columns == ["eva", "gruppe", "month", "n"]
    assert halte.rows() == [  # sorted by station and month
        ("1", "regional", "2026-09", 3),
        ("1", "fern", "2026-10", 1),
        ("2", "regional", "2026-09", 1),
    ]


@pytest.mark.parametrize("table", ["sections", "routes", "line_hours", "line_trips", "stops"])
def test_month_without_the_line_section_tables_is_reprocessed(data_dir, fetch, fetched, table):
    run(data_dir, fetch)
    (data_dir / "months" / "2026-09" / f"{table}.parquet").unlink()
    run(data_dir, fetch)
    assert fetched == ["2026-09", "2026-10", "2026-09"]
    assert (data_dir / "months" / "2026-09" / f"{table}.parquet").exists()


def with_ids(rows: list[Row], nums: list[int], delays: list[int]) -> pl.DataFrame:
    """`src` rows with the source's `id` (ride id, planned day, stop number) and arrival delays."""
    return src(rows).with_columns(
        id=pl.Series([f"{r[5]}-2609070800-{n}" for r, n in zip(rows, nums, strict=True)]),
        train_line_station_num=pl.Series(nums, dtype=pl.Int32),
        arrival_change_time=pl.col("arrival_planned_time")
        + pl.duration(minutes=pl.lit(pl.Series(delays))),
    )


def test_combine_writes_the_sections_and_the_axis_of_a_line(data_dir, tmp_path):
    def trip(ride: str, day: str, evas: list[str], delays: list[int]) -> pl.DataFrame:
        rows: list[Row] = [
            (e, f"S{e}", "RE", "RE5", ride, ride, f"{day} 08:{10 * i:02d}", "Gamma")
            for i, e in enumerate(evas)
        ]
        return with_ids(rows, list(range(1, len(evas) + 1)), delays)

    sep = pl.concat(
        [
            trip("t1", "2026-09-07", ["1", "2", "3"], [0, 3, 5]),
            trip("t2", "2026-09-07", ["1", "2"], [0, 2]),
        ]
    )
    paths = {"2026-09": tmp_path / "sep.parquet", "2026-10": tmp_path / "oct.parquet"}
    sep.write_parquet(paths["2026-09"])
    trip("t3", "2026-10-05", ["1", "2"], [0, 4]).write_parquet(paths["2026-10"])
    update(data_dir, lambda: list(paths), lambda month: paths[month])
    sections = pl.read_parquet(data_dir / "abschnitte.parquet")
    assert sections.columns == ["linie", "from_eva", "to_eva", "month", "n", "minutes"]
    assert sections.rows() == [
        ("RE5:1", "1", "2", "2026-09", 2, 5),
        ("RE5:1", "2", "3", "2026-09", 1, 2),
        ("RE5:1", "1", "2", "2026-10", 1, 4),
    ]
    # the axis comes from the newest month with routes: October only runs 1-2
    axis = pl.read_parquet(data_dir / "linienweg.parquet")
    assert axis.columns == ["linie", "pos", "eva"]
    assert axis.rows() == [("RE5:1", 0, "1"), ("RE5:1", 1, "2")]


def test_combine_turns_the_axis_to_the_label_order(data_dir, tmp_path):
    # The most travelled pattern runs 1-2-3, but the trains' final destination is the third
    # station, so the label starts there and the axis does too.
    rows: list[Row] = [
        (e, f"S{e}", "RE", "RE5", "t1", "t1", f"2026-09-07 08:{10 * i:02d}", "S3")
        for i, e in enumerate(["1", "2", "3"])
    ]
    path = tmp_path / "sep.parquet"
    with_ids(rows, [1, 2, 3], [0, 1, 2]).write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda month: path)
    axis = pl.read_parquet(data_dir / "linienweg.parquet")
    assert axis.rows() == [("RE5:1", 0, "3"), ("RE5:1", 1, "2"), ("RE5:1", 2, "1")]


def test_combine_writes_the_line_hours_per_line_and_network(data_dir, fetch):
    run(data_dir, fetch)
    hours = pl.read_parquet(data_dir / "linien_stunden.parquet")
    assert hours.columns == ["linie", "gruppe", "weekday", "hour", "month", "bucket", "n"]
    # S1 runs in two networks without a shared station: two lines, not one
    assert hours["linie"].unique().sort().to_list() == ["ICE 123:1", "S1:3", "S1:5"]
    assert hours.equals(hours.sort("linie", "month", maintain_order=True))
    per_line = ["linie"]
    cells = pl.read_parquet(data_dir / "lines.parquet")
    expected = cells.group_by(per_line).agg(pl.col("n").sum()).sort(per_line)
    assert hours.group_by(per_line).agg(pl.col("n").sum()).sort(per_line).equals(expected)
    s1 = hours.filter(pl.col("linie") == "S1:3")
    assert s1.select("weekday", "hour", "bucket", "n").rows() == [(0, 8, 0, 2), (1, 8, 0, 1)]


def test_combine_writes_the_trips_per_line_and_network(data_dir, tmp_path):
    def trip(ride: str, evas: list[str], hhmm: str) -> list[Row]:
        return [(e, f"S{e}", "S", "S1", ride, ride, f"2026-09-07 {hhmm}", "Delta") for e in evas]

    # two S1 networks (stations 3-4 and 5-6); the 05:00 trip of the first one is not counted
    rows = (
        trip("a", ["3", "4"], "08:00")
        + trip("c", ["3", "4"], "05:00")
        + trip("b", ["5", "6"], "08:00")
    )
    nums = [1, 2] * 3
    path = tmp_path / "sep.parquet"
    with_ids(rows, nums, [0] * 6).with_columns(
        departure_planned_time=pl.col("arrival_planned_time")
    ).write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    takt = pl.read_parquet(data_dir / "takt.parquet")
    assert takt.columns == ["linie", "gruppe", "month", "trips"]
    assert takt.sort("linie").rows() == [
        ("S1:3", "regional", "2026-09", 1),
        ("S1:5", "regional", "2026-09", 1),
    ]


def test_a_line_whose_month_networks_merge_lands_on_one_id_in_the_line_profiles(data_dir, tmp_path):
    def trip(ride: str, evas: list[str], day: str) -> pl.DataFrame:
        rows: list[Row] = [
            (e, f"S{e}", "S", "S1", ride, ride, f"{day} 08:{10 * i:02d}", "Delta")
            for i, e in enumerate(evas)
        ]
        return with_ids(rows, [1, 2], [0, 0]).with_columns(
            departure_planned_time=pl.col("arrival_planned_time")
        )

    # S1 is the network 3-4 in September (net "3") and 2-3 in October (net "2"): the stations
    # share the 3, so the combined line is one
    paths = {"2026-09": tmp_path / "sep.parquet", "2026-10": tmp_path / "oct.parquet"}
    trip("a", ["3", "4"], "2026-09-07").write_parquet(paths["2026-09"])
    trip("b", ["2", "3"], "2026-10-05").write_parquet(paths["2026-10"])
    update(data_dir, lambda: list(paths), lambda month: paths[month])
    hours = pl.read_parquet(data_dir / "linien_stunden.parquet")
    takt = pl.read_parquet(data_dir / "takt.parquet")
    assert hours["linie"].unique().to_list() == ["S1:2"]
    assert hours["month"].unique().sort().to_list() == ["2026-09", "2026-10"]
    assert takt.rows() == [
        ("S1:2", "regional", "2026-09", 1),
        ("S1:2", "regional", "2026-10", 1),
    ]


def test_combine_without_ids_writes_empty_section_tables(data_dir, fetch):
    run(data_dir, fetch)
    assert pl.read_parquet(data_dir / "abschnitte.parquet").height == 0
    assert pl.read_parquet(data_dir / "linienweg.parquet").height == 0


def test_month_without_the_trip_table_is_reprocessed(data_dir, fetch, fetched):
    run(data_dir, fetch)
    (data_dir / "months" / "2026-09" / "runs.parquet").unlink()
    run(data_dir, fetch)
    assert fetched == ["2026-09", "2026-10", "2026-09"]
    assert (data_dir / "months" / "2026-09" / "runs.parquet").exists()


def daily_trips(days: list[date], line: str = "RE5") -> pl.DataFrame:
    """One two-stop trip of `line` (stations 1 and 2) per day, with the source's `id`."""
    rows: list[Row] = []
    ids: list[str] = []
    for d in days:
        for n, eva in enumerate(["1", "2"], start=1):
            planned = f"{d} 08:{10 * (n - 1):02}"
            rows.append((eva, f"S{eva}", "RE", line, str(d.day), f"t{d.day}", planned, "S2"))
            ids.append(f"t{d.day}-{d:%y%m%d}0800-{n}")
    return src(rows).with_columns(
        id=pl.Series(ids), train_line_station_num=pl.Series([1, 2] * len(days), dtype=pl.Int32)
    )


FAHRTEN_COLUMNS = [
    "linie",
    "day",
    "trip",
    "zug",
    "num",
    "eva",
    "an_plan",
    "an_delay",
    "ab_plan",
    "ab_delay",
    "arrival_is_canceled",
    "departure_is_canceled",
]


def test_combine_writes_the_last_28_days_of_trips_joined_to_their_line(data_dir, tmp_path, capsys):
    path = tmp_path / "sep.parquet"
    daily_trips([date(2026, 9, d) for d in range(1, 31)]).write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    fahrten = pl.read_parquet(data_dir / "fahrten.parquet")
    assert fahrten.columns == FAHRTEN_COLUMNS
    # the last day of tage.parquet is 30 September: exactly the 28 days 3 to 30 September
    assert fahrten["day"].unique().sort().to_list() == [date(2026, 9, d) for d in range(3, 31)]
    assert fahrten["linie"].unique().to_list() == ["RE5:1"]
    assert fahrten.height == 28 * 2
    assert fahrten.equals(fahrten.sort("linie", "day", "trip", "num"))
    assert fahrten.select("zug", "num", "eva").row(0) == ("RE 3", 1, "1")
    assert f"fahrten.parquet: {fahrten.height} rows" in capsys.readouterr().out


def test_the_trip_window_reads_only_the_months_it_reaches_into(data_dir, tmp_path):
    paths = {"2026-08": tmp_path / "aug.parquet", "2026-09": tmp_path / "sep.parquet"}
    daily_trips([date(2026, 8, 31)]).write_parquet(paths["2026-08"])
    daily_trips([date(2026, 9, 1), date(2026, 9, 30)]).write_parquet(paths["2026-09"])
    update(data_dir, lambda: list(paths), lambda month: paths[month])
    (data_dir / "months" / "2026-08" / "runs.parquet").write_bytes(b"not a parquet file")
    update(data_dir, lambda: list(paths), lambda month: paths[month])
    # The window starts on 3 September: August's table is never opened (it is broken now).
    assert pl.read_parquet(data_dir / "fahrten.parquet")["day"].to_list() == [date(2026, 9, 30)] * 2


def test_a_trip_takes_its_line_from_its_first_stop_and_unknown_lines_are_left_out(
    data_dir, tmp_path
):
    # A line of one first stop only never arrives anywhere: it has no entry in linien.parquet.
    known = daily_trips([date(2026, 9, 29)])
    lonely = daily_trips([date(2026, 9, 30)], line="RE9").filter(pl.col("eva") == "1")
    lonely = lonely.with_columns(
        arrival_planned_time=pl.lit(None, pl.Datetime("us")),
        departure_planned_time=pl.col("arrival_change_time"),
    )
    path = tmp_path / "sep.parquet"
    pl.concat([known, lonely]).write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    assert pl.read_parquet(data_dir / "linien.parquet")["linie"].to_list() == ["RE5:1"]
    fahrten = pl.read_parquet(data_dir / "fahrten.parquet")
    assert fahrten["linie"].unique().to_list() == ["RE5:1"]
    assert fahrten["day"].unique().to_list() == [date(2026, 9, 29)]


def test_a_stop_in_two_places_is_kept_once_the_first_copy(data_dir, tmp_path):
    path = tmp_path / "sep.parquet"
    one = daily_trips([date(2026, 9, 30)])
    late = one.with_columns(  # the same stops again, 4 minutes later, from a second file's rows
        train_number=pl.lit("other"),
        arrival_change_time=pl.col("arrival_change_time") + pl.duration(minutes=4),
    )
    pl.concat([one, late]).write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    fahrten = pl.read_parquet(data_dir / "fahrten.parquet")
    assert fahrten.height == 2
    assert fahrten["zug"].unique().to_list() == ["RE 30"]


def test_the_trip_table_holds_minutes_since_the_trip_day_and_the_delays(data_dir, tmp_path):
    first = pl.col("eva") == "1"
    one = daily_trips([date(2026, 9, 30)]).with_columns(
        # leaves at 23:50 without a change time, arrives at 00:20 the next night, 5 minutes late
        departure_planned_time=pl.when(first).then(pl.lit(dt(2026, 9, 30, 23, 50))),
        arrival_planned_time=pl.when(~first).then(pl.lit(dt(2026, 10, 1, 0, 20))),
        arrival_change_time=pl.when(~first).then(pl.lit(dt(2026, 10, 1, 0, 25))),
        time=pl.when(first)
        .then(pl.lit(dt(2026, 9, 30, 23, 50)))
        .otherwise(pl.lit(dt(2026, 10, 1, 0, 20))),
    )
    path = tmp_path / "sep.parquet"
    one.write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    fahrten = pl.read_parquet(data_dir / "fahrten.parquet")
    assert fahrten.schema["an_plan"] == fahrten.schema["an_delay"] == pl.Int16
    assert fahrten.select("num", "an_plan", "an_delay", "ab_plan", "ab_delay").rows() == [
        (1, None, None, 1430, None),
        (2, 1460, 5, None, None),
    ]


def test_a_change_time_far_from_its_plan_reads_as_no_change_and_does_not_stop_the_combine(
    data_dir, tmp_path
):
    first = pl.col("eva") == "1"
    planned = pl.col("arrival_planned_time")
    one = daily_trips([date(2026, 9, 30)]).with_columns(
        departure_planned_time=planned,
        # the first stop leaves 40000 minutes (more than an Int16 holds) after its plan, the second
        # one is cancelled with a change time 2 hours before its plan
        departure_change_time=pl.when(first).then(planned + pl.duration(minutes=40000)),
        arrival_is_canceled=~first,
        arrival_change_time=pl.when(first)
        .then(planned)
        .otherwise(planned - pl.duration(minutes=120)),
    )
    path = tmp_path / "sep.parquet"
    one.write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    fahrten = pl.read_parquet(data_dir / "fahrten.parquet")
    assert fahrten.select("num", "an_delay", "ab_delay").rows() == [(1, 0, None), (2, None, None)]


def test_a_stop_without_a_train_type_takes_the_line_name_as_its_train(data_dir, tmp_path):
    path = tmp_path / "sep.parquet"
    one = daily_trips([date(2026, 9, 30)]).with_columns(  # the first stop has no train type
        train_type=pl.when(pl.col("eva") == "1").then(pl.lit(None)).otherwise("train_type")
    )
    one.write_parquet(path)
    update(data_dir, lambda: ["2026-09"], lambda _: path)
    fahrten = pl.read_parquet(data_dir / "fahrten.parquet")
    assert fahrten.select("num", "zug").rows() == [(1, "RE5"), (2, "RE 30")]


def test_a_raw_day_writes_its_trips_and_combine_adds_them_to_the_window(data_dir, tmp_path):
    sep = tmp_path / "sep.parquet"
    daily_trips([date(2026, 9, d) for d in range(1, 31)]).write_parquet(sep)
    stops = [
        plan_stop("r1-2610010800-1", None, dep="2610010800", typ="RE", line="RE5"),
        plan_stop("r1-2610010800-2", "2610010810", typ="RE", line="RE5"),
    ]
    first = at("2026-10-01 00:30", "plan", xml(stops[0]), eva="1")
    second = at("2026-10-01 00:30", "plan", xml(stops[1]), eva="2")
    late = at(
        "2026-10-01 22:30", "fchg", xml(fchg_stop("r1-2610010800-2", '<ar ct="2610010812"/>'))
    )
    raw = FakeRaw(tmp_path, {date(2026, 10, 1): [first, second]}, {date(2026, 10, 1): [late]})
    update(data_dir, lambda: ["2026-09"], lambda _: sep, raw.source())
    trips = pl.read_parquet(data_dir / "days" / "2026-10-01" / "runs.parquet")
    assert trips.select("name", "zug", "trip", "num", "eva", "day").rows() == [
        ("RE5", "RE 123", "r1-2610010800", 1, "1", date(2026, 10, 1)),
        ("RE5", "RE 123", "r1-2610010800", 2, "2", date(2026, 10, 1)),
    ]
    assert trips["arrival_change_time"][1] == dt(2026, 10, 1, 8, 12)
    fahrten = pl.read_parquet(data_dir / "fahrten.parquet")
    # the window ends on the last raw day: 4 September to 1 October
    assert fahrten["day"].min() == date(2026, 9, 4)
    assert fahrten["day"].max() == date(2026, 10, 1)
    assert fahrten["day"].n_unique() == 28
    assert fahrten.filter(pl.col("day") == date(2026, 10, 1)).select(
        "linie", "num", "eva"
    ).rows() == [
        ("RE5:1", 1, "1"),
        ("RE5:1", 2, "2"),
    ]


def test_a_raw_day_without_the_trip_table_is_processed_again(data_dir, fetch, tmp_path):
    folders = {date(2026, 10, 1): OCT_1}
    run_with_raw(
        data_dir, fetch, FakeRaw(tmp_path, folders, {date(2026, 10, 1): [RUN_AFTER_MIDNIGHT]})
    )
    done = data_dir / "days" / "2026-10-01"
    assert (done / "runs.parquet").exists()
    (done / "runs.parquet").unlink()
    raw = FakeRaw(tmp_path, folders, {date(2026, 10, 1): [RUN_AFTER_MIDNIGHT]})
    run_with_raw(data_dir, fetch, raw)
    assert raw.fetched != []
    assert (done / "runs.parquet").exists()


def test_monate(data_dir, fetch):
    run(data_dir, fetch)
    monate = pl.read_parquet(data_dir / "monate.parquet")
    assert monate.columns == ["month", "missing_hours", "stations"]
    assert monate["month"].to_list() == ["2026-09", "2026-10"]
    assert monate["stations"].to_list() == [6, 1]


# Raw days: one folder per UTC day, one file each. The last complete month is September, so the
# raw days start on 1 October. The plan for 00:05 on the 2nd sits in the folder of the 1st, as
# the real runs write the early plan hours of a day into the folder before it.
SEP_30: list[Response] = [
    # Recorded in September: already in the monthly file, so left out of the raw days.
    at("2026-09-30 23:00", "plan", xml(plan_stop("z-1-1", "2609302355")))
]
OCT_1: list[Response] = [
    at(
        "2026-10-01 00:30",
        "plan",
        xml(
            plan_stop("a-1-1", "2610010800"),
            plan_stop("b-1-1", "2610012355"),
            plan_stop("c-1-1", "2610020005"),
        ),
    ),
    at("2026-10-01 12:00", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2610010810"/>'))),
]
OCT_2: list[Response] = [
    at("2026-10-02 00:10", "plan", xml(plan_stop("d-1-1", "2610021200"))),
    # One run, one `fchg` request: b-1-1 was planned on the 1st and is 25 minutes late after
    # midnight, still a stop of the 1st.
    at(
        "2026-10-02 08:00",
        "fchg",
        xml(
            fchg_stop("b-1-1", '<ar ct="2610020020"/>'),
            fchg_stop("d-1-1", '<ar ct="2610021205"/>'),
        ),
    ),
]
OCT_3: list[Response] = [
    at("2026-10-03 08:00", "fchg", xml(fchg_stop("d-1-1", '<ar ct="2610021210"/>')))
]
OCT_4: list[Response] = [
    # Plan only: the 3rd (whose local midnight is 22:00 UTC) has no run after it yet.
    at("2026-10-04 00:05", "plan", xml(plan_stop("x-1-1", "2610040001")))
]
OCT_DAYS = {date(2026, 9, 30): SEP_30} | {
    date(2026, 10, d): r for d, r in enumerate([OCT_1, OCT_2, OCT_3, OCT_4], start=1)
}
FERN, EVA = "fern", "08000001"


class FakeRaw:
    """A raw source over local files, like the real one but without a network."""

    def __init__(
        self,
        tmp_path: Path,
        folders: dict[date, list[Response]],
        tails: dict[date, list[Response]] | None = None,
    ):
        """One file per folder; `tails` adds a second, later file to some folders."""
        src_dir = tmp_path / "raw-src"
        src_dir.mkdir(exist_ok=True)
        self.keys = {day: [f"{day}/file.parquet"] for day in folders}
        self.paths = {
            self.keys[day][0]: write_raw(src_dir / f"{day}.parquet", responses)
            for day, responses in folders.items()
        }
        for day, responses in (tails or {}).items():
            self.keys[day].append(f"{day}/tail.parquet")
            self.paths[self.keys[day][1]] = write_raw(src_dir / f"{day}-tail.parquet", responses)
        self.fetched: list[str] = []

    def key(self, day: int, month: int = 10) -> str:
        return self.keys[date(2026, month, day)][0]

    def source(self) -> RawSource:
        def files(day: date) -> list[str]:
            return list(self.keys.get(day, []))

        def fchg_span(key: str) -> tuple[dt, dt, int] | None:
            df = pl.read_parquet(self.paths[key]).filter(pl.col("api_name").str.ends_with("fchg"))
            if df.is_empty():
                return None
            first, last = df["timestamp"].min(), df["timestamp"].max()
            return first, last, df.height  # pyright: ignore[reportReturnType]

        def fetch(key: str, dest: Path) -> Path:
            self.fetched.append(key)
            return Path(shutil.copy(self.paths[key], dest / key.replace("/", "_")))

        return RawSource(files, fchg_span, fetch)


@pytest.fixture
def raw(tmp_path: Path) -> FakeRaw:
    return FakeRaw(tmp_path, OCT_DAYS)


def run_with_raw(data_dir: Path, fetch: Callable[[str], Path], raw: FakeRaw) -> None:
    update(data_dir, lambda: ["2026-09"], fetch, raw.source())


def raw_days_table(data_dir: Path) -> list[tuple]:
    days = pl.read_parquet(data_dir / "days.parquet")
    keys = ["day", "eva", "gruppe", "bucket"]
    return days.filter(pl.col("day") >= date(2026, 10, 1)).sort(keys).select(*keys, "n").rows()


def test_complete_raw_days_after_the_last_month_reach_the_day_tables(data_dir, fetch, raw):
    run_with_raw(data_dir, fetch, raw)
    assert raw_days_table(data_dir) == [
        (date(2026, 10, 1), EVA, FERN, 10, 1),
        (date(2026, 10, 1), EVA, FERN, 25, 1),  # after midnight, but planned on the 1st
        (date(2026, 10, 2), EVA, FERN, 0, 1),
        (date(2026, 10, 2), EVA, FERN, 10, 1),  # the later snapshot, from the next day's folder
    ]
    tage = pl.read_parquet(data_dir / "tage.parquet")
    assert tage.columns == ["day", "missing_hours"]
    # September has its 30 days; of October only the two complete raw days, no hours after them.
    assert tage["day"].dt.strftime("%Y-%m-%d").to_list()[-3:] == [
        "2026-09-30",
        "2026-10-01",
        "2026-10-02",
    ]
    assert tage.height == 30 + 2
    days = data_dir / "days"
    assert sorted(p.name for p in days.iterdir()) == ["2026-10-01", "2026-10-02"]
    for name in ("days", "hours", "day_gaps"):
        assert (days / "2026-10-01" / f"{name}.parquet").exists()


def test_raw_days_leave_the_monthly_tables_alone(data_dir, fetch, raw):
    run_with_raw(data_dir, fetch, raw)
    assert pl.read_parquet(data_dir / "aggregate.parquet")["n"].sum() == 8
    assert pl.read_parquet(data_dir / "monate.parquet")["month"].to_list() == ["2026-09"]
    assert pl.read_parquet(data_dir / "lines.parquet")["n"].sum() == 8


def test_a_second_run_downloads_nothing_new(data_dir, fetch, raw):
    run_with_raw(data_dir, fetch, raw)
    # A day reads the folders before it, of its own and after it; each is downloaded once.
    assert raw.fetched == [raw.key(30, 9), raw.key(1), raw.key(2), raw.key(3)]
    run_with_raw(data_dir, fetch, raw)
    assert len(raw.fetched) == 4
    assert len(raw_days_table(data_dir)) == 4


def test_a_raw_day_keeps_a_stop_whose_plan_is_in_the_previous_folder(data_dir, fetch, raw):
    run_with_raw(data_dir, fetch, raw)
    # c-1-1 (00:05 on the 2nd) is planned in the folder of the 1st only.
    assert (date(2026, 10, 2), EVA, FERN, 0, 1) in raw_days_table(data_dir)


def test_files_nobody_needs_any_more_are_deleted(data_dir, fetch, raw):
    seen: list[set[str]] = []
    real = raw.source()

    def fetch_and_look(key: str, dest: Path) -> Path:
        seen.append({p.name for p in dest.iterdir()})  # what is on disk when a download starts
        return real.fetch(key, dest)

    update(data_dir, lambda: ["2026-09"], fetch, real._replace(fetch=fetch_and_look))
    names = [k.replace("/", "_") for k in (raw.key(30, 9), raw.key(1), raw.key(2))]
    # Fetching the 3rd folder (for the 2nd day) happens after the 1st day dropped the 30th.
    assert seen[3] == set(names[1:])


# 1 October: Berlin is on summer time, so the local midnight that ends the day is 22:00 UTC.
RUN_AFTER_MIDNIGHT = at(
    "2026-10-01 22:30", "fchg", xml(fchg_stop("b-1-1", '<ar ct="2610012358"/>'))
)
RUN_BEFORE_MIDNIGHT = at(
    "2026-10-01 21:59", "fchg", xml(fchg_stop("b-1-1", '<ar ct="2610012358"/>'))
)


def day_rows(data_dir: Path, day: date) -> int:
    return sum(r[4] for r in raw_days_table(data_dir) if r[0] == day)


def test_a_run_after_local_midnight_completes_the_day(data_dir, fetch, tmp_path):
    raw = FakeRaw(tmp_path, {date(2026, 10, 1): OCT_1}, {date(2026, 10, 1): [RUN_AFTER_MIDNIGHT]})
    run_with_raw(data_dir, fetch, raw)
    assert day_rows(data_dir, date(2026, 10, 1)) == 2  # the 08:00 and the 23:55 stop


def test_a_run_before_local_midnight_does_not_complete_the_day(data_dir, fetch, tmp_path):
    # Even with a later folder (a plan only, no run): the late stops of the day are not settled.
    folders = {
        date(2026, 10, 1): OCT_1,
        date(2026, 10, 2): [at("2026-10-02 06:30", "plan", xml(plan_stop("d-1-1", "2610021200")))],
    }
    raw = FakeRaw(tmp_path, folders, {date(2026, 10, 1): [RUN_BEFORE_MIDNIGHT]})
    run_with_raw(data_dir, fetch, raw)
    assert raw.fetched == []
    assert raw_days_table(data_dir) == []


# A run started 23:59:21 UTC wrote its first 39 s into the folder of the 1st and the rest into
# the folder of the 2nd (seen in the source on 22/23 October).
FRAGMENT = [
    at("2026-10-01 23:59:21.000000", "fchg", xml()),
    at("2026-10-01 23:59:59.940000", "fchg", xml(fchg_stop("b-1-1", '<ar ct="2610012358"/>'))),
]
REST_OF_RUN = [
    at("2026-10-02 00:00:00.003000", "fchg", xml()),
    at("2026-10-02 00:03:50.000000", "fchg", xml()),
]


@pytest.mark.parametrize(
    ("day", "run", "complete"),
    [
        (date(2026, 10, 24), "2026-10-24 21:59", False),  # summer time: midnight is 22:00 UTC
        (date(2026, 10, 24), "2026-10-24 22:01", True),
        (date(2026, 10, 25), "2026-10-25 22:30", False),  # the night summer time ends: 23:00 UTC
        (date(2026, 10, 25), "2026-10-25 23:01", True),
        (date(2027, 3, 27), "2027-03-27 22:30", False),  # winter time before the change: 23:00
        (date(2027, 3, 27), "2027-03-27 23:01", True),
        (date(2027, 3, 28), "2027-03-28 21:30", False),  # summer time after it: 22:00
        (date(2027, 3, 28), "2027-03-28 22:01", True),
    ],
)
def test_the_local_midnight_that_ends_the_day_follows_daylight_saving_time(
    tmp_path, day, run, complete
):
    raw = FakeRaw(tmp_path, {day: [at(run, "fchg", xml())]})
    assert day_complete(raw.source(), raw.keys[day], day) is complete


def a_run(start: str, requests: int) -> list[Response]:
    """One collector run: `requests` fchg requests a second apart from `start` (naive UTC)."""
    first = dt.fromisoformat(start)
    return [
        at((first + timedelta(seconds=s)).isoformat(sep=" "), "fchg", xml())
        for s in range(requests)
    ]


@pytest.mark.parametrize(("requests", "complete"), [(3, False), (8, False), (9, True), (10, True)])
def test_a_short_run_after_local_midnight_does_not_complete_the_day(
    data_dir, fetch, tmp_path, requests, complete
):
    # A full run of 10 requests before the local midnight (22:00 UTC) sets the size of a run; one
    # after it counts only from 90 % of that.
    plan = OCT_1[:1]
    folders = {date(2026, 10, 1): [*plan, *a_run("2026-10-01 21:00:00", 10)]}
    tails = {date(2026, 10, 1): a_run("2026-10-01 22:30:00", requests)}
    raw = FakeRaw(tmp_path, folders, tails)
    run_with_raw(data_dir, fetch, raw)
    assert (raw.fetched != []) is complete
    assert (day_rows(data_dir, date(2026, 10, 1)) == 2) is complete


def test_the_first_fragment_of_a_split_run_does_not_complete_the_day(data_dir, fetch, tmp_path):
    raw = FakeRaw(tmp_path, {date(2026, 10, 1): OCT_1}, {date(2026, 10, 1): FRAGMENT})
    run_with_raw(data_dir, fetch, raw)
    assert raw.fetched == []


def test_both_halves_of_a_split_run_complete_the_day(data_dir, fetch, tmp_path):
    folders = {date(2026, 10, 1): OCT_1, date(2026, 10, 2): REST_OF_RUN}
    run_with_raw(data_dir, fetch, FakeRaw(tmp_path, folders, {date(2026, 10, 1): FRAGMENT}))
    assert day_rows(data_dir, date(2026, 10, 1)) == 2


def test_a_last_file_without_fchg_does_not_hide_a_late_snapshot_before_it(
    data_dir, fetch, tmp_path
):
    # The source has runs where every `fchg` request failed: the newest file then has none.
    plan_only = [at("2026-10-02 23:00", "plan", xml(plan_stop("q-1-1", "2610030100")))]
    raw = FakeRaw(
        tmp_path,
        {date(2026, 10, 1): OCT_1, date(2026, 10, 2): OCT_2},
        {date(2026, 10, 2): plan_only},
    )
    run_with_raw(data_dir, fetch, raw)
    assert [r[0] for r in raw_days_table(data_dir)] == [date(2026, 10, 1)] * 2


def test_an_added_day_is_processed_by_the_next_run(data_dir, fetch, tmp_path):
    folders = {d: r for d, r in OCT_DAYS.items() if d.day <= 3}
    run_with_raw(data_dir, fetch, FakeRaw(tmp_path, folders))
    assert len(raw_days_table(data_dir)) == 4  # the 3rd waits for a run after its local midnight
    late = [at("2026-10-04 08:00", "fchg", xml(fchg_stop("x-1-1", '<ar ct="2610040001"/>')))]
    raw = FakeRaw(tmp_path, {**folders, date(2026, 10, 4): late})
    run_with_raw(data_dir, fetch, raw)
    assert raw.fetched == [raw.key(2), raw.key(3), raw.key(4)]  # the 2nd is the day before
    assert (data_dir / "days" / "2026-10-03" / "days.parquet").exists()


def test_the_first_raw_day_keeps_the_late_stops_of_the_last_monthly_day(data_dir, fetch, tmp_path):
    # Planned at 23:55 on 30 September, 25 minutes late: recorded in October, so not in
    # September's file. The first raw day keeps it, under its planned day.
    folders = {
        date(2026, 9, 30): [at("2026-09-30 23:00", "plan", xml(plan_stop("q-1-1", "2609302355")))],
        date(2026, 10, 1): [
            at("2026-10-01 00:30", "fchg", xml(fchg_stop("q-1-1", '<ar ct="2610010020"/>'))),
            at("2026-10-01 00:31", "plan", xml(plan_stop("a-1-1", "2610010800"))),
        ],
        date(2026, 10, 2): [
            at("2026-10-02 08:00", "fchg", xml(fchg_stop("z-1-1", '<ar ct="2610020900"/>')))
        ],
    }
    run_with_raw(data_dir, fetch, FakeRaw(tmp_path, folders))
    days = pl.read_parquet(data_dir / "days.parquet")
    late = days.filter((pl.col("day") == date(2026, 9, 30)) & (pl.col("eva") == EVA))
    assert late.select("bucket", "n").rows() == [(25, 1)]
    assert raw_days_table(data_dir) == [(date(2026, 10, 1), EVA, FERN, 0, 1)]


def test_the_boundary_shift_reprocesses_the_new_first_day(data_dir, fetch, raw):
    run_with_raw(data_dir, fetch, raw)
    days = data_dir / "days"
    # An earlier run under another boundary left a folder for the first day after October.
    shutil.copytree(days / "2026-10-02", days / "2026-11-01")
    update(data_dir, lambda: ["2026-09", "2026-10"], fetch, raw.source())
    assert not (days / "2026-11-01").exists()  # the day is judged again against the new boundary
    assert list(days.glob("2026-10-*")) == []


def test_an_empty_folder_of_the_day_is_reported(data_dir, fetch, tmp_path, capsys):
    folders = {d: r for d, r in OCT_DAYS.items() if d != date(2026, 10, 1)}
    run_with_raw(data_dir, fetch, FakeRaw(tmp_path, folders))
    assert "2026-10-01: no raw files in its own folder" in capsys.readouterr().out


def test_a_day_folder_is_dropped_once_its_month_is_complete(data_dir, fetch, raw):
    run_with_raw(data_dir, fetch, raw)
    assert (data_dir / "days" / "2026-10-01").exists()
    update(data_dir, lambda: ["2026-09", "2026-10"], fetch, raw.source())
    assert list((data_dir / "days").glob("2026-10-*")) == []
    days = pl.read_parquet(data_dir / "days.parquet")
    # October now comes from its monthly file alone: its one stop on the 5th, nothing from raw.
    assert days.filter(pl.col("day") >= date(2026, 10, 1))["day"].to_list() == [date(2026, 10, 5)]
    assert pl.read_parquet(data_dir / "tage.parquet").height == 30 + 31


def test_combine_sums_a_raw_day_with_the_same_day_from_a_monthly_file(data_dir, tmp_path):
    # A September stop planned at 00:05 on 1 October but recorded on 30 September ...
    edge: Row = (EVA, "Alpha", "ICE", None, "125", "e1", "2026-10-01 00:05", "Beta")
    sep = src([*SEP, edge]).with_columns(
        time=pl.when(pl.col("time") >= dt(2026, 10, 1))
        .then(dt(2026, 9, 30, 23, 59))
        .otherwise(pl.col("time"))
    )
    path = tmp_path / "sep.parquet"
    sep.write_parquet(path)
    # ... is in the raw data too, next to a stop at 08:00 on 1 October that only raw has.
    folders = {
        date(2026, 10, 1): [
            at(
                "2026-10-01 00:30",
                "plan",
                xml(plan_stop("a-1-1", "2610010800"), plan_stop("e-1-1", "2610010005")),
            ),
            at("2026-10-01 00:40", "fchg", xml(fchg_stop("e-1-1", '<ar ct="2609302359"/>'))),
        ],
        date(2026, 10, 2): [
            at("2026-10-02 08:00", "fchg", xml(fchg_stop("z-1-1", '<ar ct="2610020900"/>')))
        ],
    }
    raw = FakeRaw(tmp_path, folders)
    update(data_dir, lambda: ["2026-09"], lambda _: path, raw.source())
    days = pl.read_parquet(data_dir / "days.parquet")
    one = days.filter((pl.col("day") == date(2026, 10, 1)) & (pl.col("eva") == EVA))
    # The monthly stop and the raw 08:00 stop are summed; the raw copy of the monthly one
    # (recorded before October) is left out, so nothing is counted twice.
    assert one.select("bucket", "n").rows() == [(0, 2)]


@pytest.mark.parametrize("exists", [False, True])
def test_main_fetches_the_coordinates_only_when_the_file_is_missing(tmp_path, monkeypatch, exists):
    monkeypatch.chdir(tmp_path)
    if exists:
        (tmp_path / "data").mkdir()
        (tmp_path / "data" / "coords.parquet").touch()
    calls: list[str] = []
    monkeypatch.setattr("pipeline.update.fetch_coords", lambda argv: calls.append("coords"))
    monkeypatch.setattr("pipeline.update.remote_source", lambda: None)
    monkeypatch.setattr("pipeline.update.update", lambda *args: calls.append("update"))
    main([])
    assert calls == (["update"] if exists else ["coords", "update"])
