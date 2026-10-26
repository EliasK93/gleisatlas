from collections.abc import Callable
from datetime import datetime as dt
from datetime import timedelta

import polars as pl
import pytest

from pipeline.aggregate import aggregate, clean, dropped, lines, meta, stations, with_coords
from tests.conftest import complete


def test_delay_and_cancel(mini: pl.DataFrame):
    reg = mini.filter((pl.col("gruppe") == "regional") & (pl.col("eva") == "1"))
    assert reg["n"].sum() == 4
    assert reg.filter(pl.col("bucket").is_null())["n"].item() == 1  # cancelled
    ok = reg.filter(pl.col("bucket").is_not_null())
    assert sorted(ok.select(pl.col("bucket").repeat_by("n").explode())["bucket"]) == [0, 0, 7]


def test_month_from_time_not_planned(mini: pl.DataFrame):
    assert sorted(mini["month"].unique()) == ["2026-09", "2026-10"]


def test_stations(source: pl.DataFrame):
    s = stations(source.lazy())
    assert dict(s.select("eva", "name").iter_rows()) == {"1": "Alpha", "2": "Beta"}


def test_station_name_tie_is_deterministic(source: pl.DataFrame):
    for names in (["Zulu", "Alpha"], ["Alpha", "Zulu"]):
        two = source.filter((pl.col("train_type") == "RE") & (pl.col("eva") == "1")).head(2)
        tied = two.with_columns(station_name=pl.Series(names))  # one row each: a real tie
        assert stations(tied.lazy())["name"].to_list() == ["Alpha"]


def test_schema_abort(source: pl.DataFrame):
    with pytest.raises(SystemExit, match="arrival_is_canceled"):
        aggregate(source.drop("arrival_is_canceled").lazy())


def test_schema_abort_names_a_new_column(source: pl.DataFrame):
    with pytest.raises(SystemExit, match="platform"):
        aggregate(source.with_columns(platform=pl.lit("3")).lazy())


def test_station_stop_counts(source: pl.DataFrame):
    # all categories and months, cancelled included; bus and no-arrival rows excluded
    assert dict(stations(source.lazy()).select("eva", "n").iter_rows()) == {"1": 5, "2": 1}


def test_join_coords_on_normalised_eva(source: pl.DataFrame, coords: pl.DataFrame):
    s = stations(source.lazy())
    s = s.with_columns(eva=pl.col("eva").str.pad_start(8, "0"))
    out = with_coords(s, coords).sort("eva")
    assert out.columns == ["eva", "name", "n", "lat", "lon", "land"]
    assert out["lat"].to_list() == [50.0, None]
    assert out["land"].to_list() == ["Nordrhein-Westfalen", None]


def test_unlocated_station_takes_coords_of_its_only_namesake():
    # A secondary EVA (S-Bahn platforms) shares the name of the located main station.
    st = pl.DataFrame(
        {
            "eva": ["08000001", "08089001", "08000002", "08000003", "08000004", "08089003"],
            "name": ["Alpha", "Alpha", "Beta", "Gamma", "Gamma", "Gamma"],
            "n": [10, 5, 3, 2, 2, 1],
        }
    )
    coords = pl.DataFrame(
        {
            "ibnr": ["8000001", "8000003", "8000004"],
            "lat": [50.0, 51.0, 52.0],
            "lon": [7.0, 8.0, 9.0],
            "land": ["Hessen", None, None],
        }
    )
    out = with_coords(st, coords).sort("eva")
    lat = dict(zip(out["eva"], out["lat"], strict=True))
    assert lat["08089001"] == 50.0  # its only located namesake
    assert out.filter(pl.col("eva") == "08089001")["land"].item() == "Hessen"
    assert lat["08000002"] is None  # no located namesake
    assert lat["08089003"] is None  # two located namesakes: ambiguous
    assert out.columns == ["eva", "name", "n", "lat", "lon", "land"]


def test_cleaning_drops_duplicates_and_implausible_delays(source: pl.DataFrame):
    base = source.filter(pl.col("eva") == "2")  # one regional stop, +10
    planned = pl.col("arrival_planned_time")

    def other(number: str, minutes: int, cancelled: bool = False) -> pl.DataFrame:
        return base.with_columns(
            train_number=pl.lit(number),
            arrival_change_time=planned + timedelta(minutes=minutes),
            arrival_is_canceled=pl.lit(cancelled),
        )

    dirty = pl.concat(
        [base, base, other("1", 2000), other("2", -45), other("3", 2000, cancelled=True)]
    ).lazy()
    assert dropped(dirty) == (1, 2)
    agg = aggregate(dirty)
    assert dict(agg.select("bucket", "n").iter_rows()) == {10: 1, None: 1}  # cancelled kept
    assert lines(dirty)["n"].sum() == 2


def test_a_plausible_copy_survives_an_implausible_first_one(source: pl.DataFrame):
    base = source.filter(pl.col("eva") == "2")  # +10
    planned = pl.col("arrival_planned_time")
    late = base.with_columns(arrival_change_time=planned + timedelta(minutes=2000))
    ok = base.with_columns(arrival_change_time=planned + timedelta(minutes=5))
    both = pl.concat([late, ok]).lazy()  # same duplicate key, the implausible one first
    assert dropped(both) == (0, 1)
    assert dict(aggregate(both).select("bucket", "n").iter_rows()) == {5: 1}


def test_stops_without_arrival_are_never_duplicates(source: pl.DataFrame):
    first = source.filter(pl.col("train_number") == "4707")  # no arrival: only feeds the networks
    other_day = first.with_columns(time=pl.col("time") + timedelta(days=1))
    both = pl.concat([first, other_day]).lazy()
    assert dropped(both) == (0, 0)
    assert clean(both).collect().height == 2


def hourly(month_start: dt, month_end: dt, skip: set[dt]) -> pl.DataFrame:
    """One regional stop per naive local hour of the month, except `skip`."""
    hours = pl.datetime_range(month_start, month_end, "1h", closed="left", eager=True)
    hours = hours.filter(~hours.is_in(list(skip)))
    return complete(
        pl.DataFrame(
            {
                "eva": "1",
                "station_name": "Alpha",
                "train_type": "RE",
                "train_number": [str(i) for i in range(hours.len())],
                "time": hours,
                "arrival_planned_time": hours,
                "arrival_change_time": hours,
                "arrival_is_canceled": False,
            }
        )
    )


def test_meta_counts_thin_hours_as_missing():
    usual = 20
    odd = {dt(2026, 9, 5, 3): usual // 4, dt(2026, 9, 6, 4): usual * 6 // 10, dt(2026, 9, 7, 5): 0}
    hours = pl.datetime_range(dt(2026, 9, 1), dt(2026, 10, 1), "1h", closed="left", eager=True)
    stamps = [h for h in hours for _ in range(odd.get(h, usual))]
    month = complete(
        pl.DataFrame(
            {
                "eva": "1",
                "train_type": "RE",
                "train_number": [str(i) for i in range(len(stamps))],
                "time": stamps,
                "arrival_planned_time": stamps,
                "arrival_change_time": stamps,
                "arrival_is_canceled": False,
            }
        )
    )
    # a quarter of the usual rows and a missing hour count, 60 % does not
    assert meta(month.lazy(), "2026-09")["missing_hours"].item() == 2


def weighted(month_start: dt, month_end: dt, rows_at: Callable[[dt], int]) -> pl.DataFrame:
    """`rows_at(hour)` regional stops in every naive local hour of the month."""
    hours = pl.datetime_range(month_start, month_end, "1h", closed="left", eager=True)
    stamps = [h for h in hours for _ in range(rows_at(h))]
    return complete(
        pl.DataFrame(
            {
                "eva": "1",
                "train_type": "RE",
                "train_number": [str(i) for i in range(len(stamps))],
                "time": stamps,
                "arrival_planned_time": stamps,
                "arrival_change_time": stamps,
                "arrival_is_canceled": False,
            }
        )
    )


def test_meta_compares_an_hour_with_its_usual_level_on_that_weekday():
    def normal(h: dt) -> int:
        return 7 if h.weekday() == 6 and h.hour < 9 else 20  # quiet Sunday mornings

    month = weighted(dt(2026, 9, 1), dt(2026, 10, 1), normal)
    assert meta(month.lazy(), "2026-09")["missing_hours"].item() == 0

    def with_gaps(h: dt) -> int:
        return {dt(2026, 9, 9, 12): 2, dt(2026, 9, 10, 14): 0}.get(h, normal(h))

    gaps = weighted(dt(2026, 9, 1), dt(2026, 10, 1), with_gaps)
    assert meta(gaps.lazy(), "2026-09")["missing_hours"].item() == 2  # 10 % and no rows


def test_meta_doubled_october_hour_is_not_missing():
    def rows(h: dt) -> int:
        return 40 if h == dt(2026, 10, 25, 2) else 20  # both 02:00 hours land in one naive hour

    month = weighted(dt(2026, 10, 1), dt(2026, 11, 1), rows)
    assert meta(month.lazy(), "2026-10")["missing_hours"].item() == 0


def test_meta_counts_missing_hours_against_the_real_month():
    gap = hourly(dt(2026, 9, 1), dt(2026, 10, 1), {dt(2026, 9, 12, 3)})
    assert meta(gap.lazy(), "2026-09").rows() == [("2026-09", 1, 1)]
    # Clocks skip 02:00 on the last Sunday of March: that hour is not missing.
    march = hourly(dt(2026, 3, 1), dt(2026, 4, 1), {dt(2026, 3, 29, 2)})
    assert meta(march.lazy(), "2026-03")["missing_hours"].item() == 0
