from datetime import UTC, date
from datetime import datetime as dt
from pathlib import Path

import polars as pl
import pytest

from pipeline.update import update, update_rest
from tests.pipeline.test_live import HEUTE_SCHEMA
from tests.pipeline.test_raw import EVA, at, fchg_stop, plan_stop, xml
from tests.pipeline.test_update import OCT_DAYS, SEP, FakeRaw, src

FERN = "fern"
# Local day 4 November (winter time, UTC + 1). The UTC folder of the 3rd holds the plan of the
# first local hours; the newest file of the 4th has no `fchg`, so the snapshot before it counts.
NOV = {
    date(2026, 11, 3): [
        at(
            "2026-11-03 22:30",
            "plan",
            xml(plan_stop("y-1-1", "2611032300"), plan_stop("a-1-1", "2611040030")),
        )
    ],
    date(2026, 11, 4): [
        at(
            "2026-11-04 05:00",
            "plan",
            xml(plan_stop("b-1-1", "2611040900"), plan_stop("c-1-1", "2611041400")),
        ),
        at("2026-11-04 12:40", "fchg", xml(fchg_stop("b-1-1", '<ar ct="2611040906"/>'))),
    ],
}
NOV_TAIL = {
    date(2026, 11, 4): [at("2026-11-04 13:00", "plan", xml(plan_stop("d-1-1", "2611041500")))]
}
AT_14_00 = dt(2026, 11, 4, 13, 0, tzinfo=UTC)


def rest(data_dir: Path) -> pl.DataFrame:
    return pl.read_parquet(data_dir / "heute_rest.parquet")


def stands(df: pl.DataFrame) -> list[dt]:
    return df.select(pl.col("stand").dt.replace_time_zone(None)).to_series().unique().to_list()


B = "08000002"
LARGE = [EVA, B]


def test_a_station_that_is_not_large_is_left_out(tmp_path):
    folders = {
        date(2026, 11, 4): [
            at("2026-11-04 05:00", "plan", xml(plan_stop("a-1-1", "2611041100"))),
            at("2026-11-04 05:00", "plan", xml(plan_stop("b-1-1", "2611041100")), eva=B),
            at("2026-11-04 11:30", "fchg", xml()),
            at("2026-11-04 11:31", "fchg", xml(), eva=B),  # B answered too
        ]
    }
    update_rest(tmp_path, FakeRaw(tmp_path, folders).source(), AT_14_00, [EVA])
    assert rest(tmp_path).select("hour", "eva").rows() == [(11, EVA)]


def test_a_station_whose_changes_failed_in_the_newest_pass_is_left_out(tmp_path):
    folders = {
        date(2026, 11, 4): [
            at("2026-11-04 05:00", "plan", xml(plan_stop("a-1-1", "2611041100"))),
            at("2026-11-04 05:00", "plan", xml(plan_stop("b-1-1", "2611041100")), eva=B),
            at("2026-11-04 06:00", "fchg", xml(), eva=B),  # an earlier pass, before the delay
        ]
    }
    newest = {
        date(2026, 11, 4): [
            at("2026-11-04 11:30", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2611041102"/>'))),
            at("2026-11-04 11:31", "fchg", "", eva=B, status="500"),
        ]
    }
    update_rest(tmp_path, FakeRaw(tmp_path, folders, newest).source(), AT_14_00, LARGE)
    # B's stop ran late, but without B's changes it would count as on time
    assert rest(tmp_path).select("hour", "eva", "bucket").rows() == [(11, EVA, 2)]


def test_the_cut_and_stand_come_from_the_start_of_the_newest_pass(tmp_path):
    folders = {
        date(2026, 11, 4): [
            at(
                "2026-11-04 05:00",
                "plan",
                xml(plan_stop("a-1-1", "2611041230"), plan_stop("a-2-1", "2611041330")),
            ),
            # The pass starts at 13:58 local and ends at 14:03: the 13:30 stop is not settled.
            at("2026-11-04 12:58", "fchg", xml()),
            at("2026-11-04 13:03", "fchg", xml(), eva=B),
        ]
    }
    now = dt(2026, 11, 4, 14, 0, tzinfo=UTC)
    update_rest(tmp_path, FakeRaw(tmp_path, folders).source(), now, LARGE)
    out = rest(tmp_path)
    assert out.select("hour", "eva").rows() == [(12, EVA)]
    assert stands(out) == [dt(2026, 11, 4, 12, 58)]


def test_the_combined_files_are_written_before_the_partial_day_is_fetched(tmp_path, coords):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    coords.write_parquet(data_dir / "coords.parquet")
    sep = tmp_path / "sep.parquet"
    src(SEP).write_parquet(sep)
    # A run on the 4th, so the 3rd is complete and its day reads the folder of the 4th.
    run = at("2026-10-04 00:05", "fchg", xml(fchg_stop("x-1-1", '<ar ct="2610040001"/>')))
    fake = FakeRaw(tmp_path, OCT_DAYS | {date(2026, 10, 4): [run]})
    real = fake.source()
    reads: list[str] = []

    def fetch(key: str, dest: Path) -> Path:
        reads.append(key)
        if reads.count(fake.key(4)) == 2:  # the second read of that folder is the partial day's
            raise OSError("download failed")
        return real.fetch(key, dest)

    raw = real._replace(fetch=fetch)
    now = dt(2026, 10, 4, 10, 0, tzinfo=UTC)
    with pytest.raises(OSError, match="download failed"):
        update(data_dir, lambda: ["2026-09"], lambda _: sep, raw, lambda: now)
    days = pl.read_parquet(data_dir / "days.parquet")
    assert days["day"].max() == date(2026, 10, 2)  # the raw days of this run are combined
    assert (data_dir / "days" / "2026-10-03").exists()


def test_the_partial_day_counts_todays_stops_before_the_newest_snapshots_hour(tmp_path):
    raw = FakeRaw(tmp_path, NOV, NOV_TAIL)
    update_rest(tmp_path, raw.source(), AT_14_00, LARGE)
    out = rest(tmp_path)
    assert out.schema == HEUTE_SCHEMA
    # The 00:30 stop from the folder before and the delayed 09:00 one; not the 14:00 stop (the
    # snapshot is from 13:40 local), not yesterday's 23:00 stop.
    assert out.select("day", "hour", "gruppe", "eva", "bucket", "n").rows() == [
        (date(2026, 11, 4), 0, FERN, EVA, 0, 1),
        (date(2026, 11, 4), 9, FERN, EVA, 6, 1),
    ]
    assert stands(out) == [dt(2026, 11, 4, 12, 40)]  # the newest `fchg`, UTC
    assert not (tmp_path / "days").exists()
    assert not list(tmp_path.glob("*.tmp"))


def test_the_cut_is_the_local_hour_across_the_utc_date(tmp_path):
    # 23:30 UTC on 9 July is 01:30 summer time on the 10th: hour 0 counts, hour 1 not yet.
    folders = {
        date(2026, 7, 9): [
            at(
                "2026-07-09 21:00",
                "plan",
                xml(plan_stop("a-1-1", "2607100020"), plan_stop("b-1-1", "2607100110")),
            ),
            at("2026-07-09 23:30", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2607100022"/>'))),
        ]
    }
    now = dt(2026, 7, 10, 0, 10, tzinfo=UTC)
    update_rest(tmp_path, FakeRaw(tmp_path, folders).source(), now, LARGE)
    assert rest(tmp_path).select("hour", "bucket", "n").rows() == [(0, 2, 1)]


def test_a_newest_snapshot_from_yesterday_gives_no_rows_and_no_download(tmp_path):
    folders = {
        date(2026, 7, 9): [
            at("2026-07-09 21:00", "plan", xml(plan_stop("a-1-1", "2607100020"))),
            # 23:30 local on the 9th: nothing of the 10th is settled yet
            at("2026-07-09 21:30", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2607100022"/>'))),
        ]
    }
    raw = FakeRaw(tmp_path, folders)
    update_rest(tmp_path, raw.source(), dt(2026, 7, 10, 0, 10, tzinfo=UTC), LARGE)
    assert rest(tmp_path).height == 0
    assert raw.fetched == []


def test_no_files_write_an_empty_table_over_an_earlier_one(tmp_path):
    pl.DataFrame({"stale": [1]}).write_parquet(tmp_path / "heute_rest.parquet")
    update_rest(tmp_path, FakeRaw(tmp_path, {}).source(), AT_14_00, LARGE)
    out = rest(tmp_path)
    assert out.height == 0
    assert out.schema == HEUTE_SCHEMA


def test_update_writes_the_partial_day_and_leaves_the_day_folders_alone(tmp_path, coords):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    coords.write_parquet(data_dir / "coords.parquet")
    paths = {"2026-08": tmp_path / "aug.parquet", "2026-09": tmp_path / "sep.parquet"}
    src([(EVA, "Alpha", "ICE", None, "120", "a0", "2026-08-10 08:00", "Beta")]).write_parquet(
        paths["2026-08"]
    )  # the large station of the raw days; September has six stations
    src(SEP).write_parquet(paths["2026-09"])
    now = dt(2026, 10, 2, 10, 0, tzinfo=UTC)  # 12:00 summer time; newest `fchg` 10:00 local
    raw = FakeRaw(tmp_path, OCT_DAYS).source()
    update(data_dir, lambda: list(paths), lambda m: paths[m], raw, lambda: now)
    assert rest(data_dir).select("day", "hour", "bucket", "n").rows() == [
        (date(2026, 10, 2), 0, 0, 1)
    ]
    assert sorted(p.name for p in (data_dir / "days").iterdir()) == ["2026-10-01", "2026-10-02"]
