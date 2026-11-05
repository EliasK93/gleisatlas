from datetime import date, datetime, timedelta
from datetime import datetime as dt
from pathlib import Path

import polars as pl

from core.lines import line_name_expr
from pipeline.aggregate import COLUMNS, days
from pipeline.raw import day_runs, raw_gaps, stop_rows

API = "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1"
EVA = "08000001"

# A response: (snapshot time, "plan" or "fchg", eva, xml, status code)
Response = tuple[datetime, str, str, str, str]


def plan_stop(
    sid: str, planned: str | None, dep: str | None = None, typ: str = "ICE", line: str = "5"
) -> str:
    """A plan stop in the IRIS format; times are YYMMDDHHMM."""
    ar = f'<ar pt="{planned}" pp="1" l="{line}"/>' if planned else ""
    dp = f'<dp pt="{dep}" pp="1" l="{line}"/>' if dep else ""
    return f'<s id="{sid}"><tl f="F" t="p" o="80" c="{typ}" n="123"/>{ar}{dp}</s>'


def fchg_stop(sid: str, ar: str = "", dp: str = "", extra: str = "") -> str:
    return f'<s id="{sid}" eva="{EVA}">{ar}{dp}{extra}</s>'


def xml(*stops: str) -> str:
    body = "".join(stops)
    return f"<?xml version='1.0' encoding='UTF-8'?><timetable station='Alpha'>{body}</timetable>"


def at(when: str, api: str, content: str, eva: str = EVA, status: str = "200") -> Response:
    return (dt.fromisoformat(when), api, eva, content, status)


def write_raw(path: Path, responses: list[Response]) -> Path:
    """One raw source file with the columns the pipeline reads (the real ones have more)."""
    pl.DataFrame(
        {
            "timestamp": [r[0] for r in responses],
            "url": [
                f"{API}/{'plan' if r[1] == 'plan' else 'fchg'}/{r[2]}/260101/08" for r in responses
            ],
            "api_name": [f"timetables/v1/{r[1]}" for r in responses],
            "response_data": [r[3] for r in responses],
            "status_code": [r[4] for r in responses],
        },
        schema={
            "timestamp": pl.Datetime("us"),
            "url": pl.String,
            "api_name": pl.String,
            "response_data": pl.String,
            "status_code": pl.String,
        },
    ).write_parquet(path)
    return path


def rows(tmp_path: Path, *responses: Response) -> pl.DataFrame:
    return stop_rows([write_raw(tmp_path / "raw.parquet", list(responses))])


def test_rows_have_every_source_column(tmp_path):
    out = rows(tmp_path, at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800"))))
    assert set(out.columns) == COLUMNS
    assert out["eva"].to_list() == [EVA]  # the source zero-pads EVAs


def test_the_line_attribute_of_the_event_is_the_line_number(tmp_path):
    plan = at(
        "2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800", typ="RE", line="57"))
    )
    out = rows(tmp_path, plan)
    assert out["line_number"].to_list() == ["57"]
    assert out.select(line_name_expr()).to_series().to_list() == ["RE57"]


def test_the_line_number_comes_from_the_departure_at_a_first_stop_and_from_a_change_alone(tmp_path):
    first = at(
        "2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", None, dep="2610010800", line="S1"))
    )
    extra = fchg_stop(
        "x-1-1", '<ar ps="a" ct="2610010811" pt="2610010800" l="RE9"/>', extra='<tl t="e" c="RE"/>'
    )
    out = rows(tmp_path, first, at("2026-10-01 09:00", "fchg", xml(extra))).sort("id")
    assert out["line_number"].to_list() == ["S1", "RE9"]


def test_a_blank_line_attribute_is_no_line_number(tmp_path):
    plan = at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800", line="")))
    assert rows(tmp_path, plan)["line_number"].to_list() == [None]


def test_a_planned_stop_without_changes_is_on_time(tmp_path):
    out = rows(tmp_path, at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800"))))
    row = out.row(0, named=True)
    assert row["arrival_planned_time"] == row["arrival_change_time"] == dt(2026, 10, 1, 8, 0)
    assert row["arrival_is_canceled"] is False
    assert row["train_type"] == "ICE"
    assert row["time"] == dt(2026, 10, 1, 8, 0)
    assert days(out.lazy()).select("bucket", "n").rows() == [(0, 1)]


def test_a_changed_arrival_time_is_the_delay(tmp_path):
    plan = at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800")))
    change = at(
        "2026-10-01 09:00", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2610010807" pt="2610010800"/>'))
    )
    out = rows(tmp_path, plan, change)
    assert out["arrival_change_time"].to_list() == [dt(2026, 10, 1, 8, 7)]
    assert days(out.lazy()).select("bucket", "n").rows() == [(7, 1)]


def test_a_cancelled_stop_is_never_0_minutes(tmp_path):
    plan = at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800")))
    cancel = at(
        "2026-10-01 07:00", "fchg", xml(fchg_stop("a-1-1", '<ar cs="c" clt="2610010100"/>'))
    )
    out = rows(tmp_path, plan, cancel)
    assert out["arrival_is_canceled"].to_list() == [True]
    assert days(out.lazy()).select("bucket", "n").rows() == [(None, 1)]


def test_the_cancellation_time_alone_cancels(tmp_path):
    plan = at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800")))
    cancel = at("2026-10-01 07:00", "fchg", xml(fchg_stop("a-1-1", '<ar clt="2610010100"/>')))
    assert rows(tmp_path, plan, cancel)["arrival_is_canceled"].to_list() == [True]


def test_the_later_snapshot_wins_across_files(tmp_path):
    plan = at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800")))
    early = at("2026-10-01 07:50", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2610010805"/>')))
    late = at("2026-10-01 08:20", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2610010812"/>')))
    first = write_raw(tmp_path / "1.parquet", [plan, early])
    second = write_raw(tmp_path / "2.parquet", [late])  # the caller passes the files in time order
    assert stop_rows([first, second])["arrival_change_time"].to_list() == [dt(2026, 10, 1, 8, 12)]


def test_the_later_snapshot_wins_whatever_the_row_order_in_a_file(tmp_path):
    plan = at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800")))
    early = at("2026-10-01 07:50", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2610010805"/>')))
    late = at("2026-10-01 08:20", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2610010812"/>')))
    out = rows(tmp_path, late, plan, early)
    assert out["arrival_change_time"].to_list() == [dt(2026, 10, 1, 8, 12)]


def test_a_snapshot_without_change_data_does_not_replace_one_with(tmp_path):
    plan = at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800")))
    change = at("2026-10-01 08:00", "fchg", xml(fchg_stop("a-1-1", '<ar ct="2610010809"/>')))
    bare = at("2026-10-01 09:00", "fchg", xml(fchg_stop("a-1-1", '<ar pt="2610010800"/>')))
    out = rows(tmp_path, plan, change, bare)
    assert out["arrival_change_time"].to_list() == [dt(2026, 10, 1, 8, 9)]


def test_a_stop_without_plan_takes_its_times_from_the_change(tmp_path):
    extra = fchg_stop(
        "x-1-1",
        '<ar ps="a" ct="2610010811" pt="2610010800"/>',
        extra='<tl f="F" t="e" c="ICE" n="9"/>',
    )
    out = rows(tmp_path, at("2026-10-01 09:00", "fchg", xml(extra)))
    row = out.row(0, named=True)
    assert (row["arrival_planned_time"], row["arrival_change_time"]) == (
        dt(2026, 10, 1, 8, 0),
        dt(2026, 10, 1, 8, 11),
    )
    assert row["train_type"] == "ICE"


def test_the_time_is_the_departure_change_where_there_is_one(tmp_path):
    plan = at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800", dep="2610010802")))
    change = at("2026-10-01 08:30", "fchg", xml(fchg_stop("a-1-1", dp='<dp ct="2610010815"/>')))
    row = rows(tmp_path, plan, change).row(0, named=True)
    assert row["time"] == dt(2026, 10, 1, 8, 15)
    assert row["arrival_change_time"] == dt(2026, 10, 1, 8, 0)


def test_failed_responses_are_ignored(tmp_path):
    out = rows(
        tmp_path,
        at("2026-10-01 00:30", "plan", xml(plan_stop("a-1-1", "2610010800")), status="500"),
        at("2026-10-01 00:31", "plan", ""),
    )
    assert out.height == 0
    assert set(out.columns) == COLUMNS


def test_day_runs_take_the_trips_of_the_day_and_on_the_first_day_the_earlier_late_stops(tmp_path):
    stops = [
        plan_stop("a-2610010800-1", None, dep="2610010800"),  # a trip of the 1st
        plan_stop("a-2610010800-2", "2610010810"),
        plan_stop("b-2609302350-1", None, dep="2609302350"),  # started on the 30th, before midnight
        plan_stop("b-2609302350-2", "2610010010"),  # recorded after the boundary
        plan_stop("c-2610020800-1", None, dep="2610020800"),  # a trip of the 2nd
    ]
    raw = rows(tmp_path, at("2026-10-01 00:30", "plan", xml(*stops)))
    boundary = datetime(2026, 10, 1)

    def got(day: date) -> list[tuple]:
        return day_runs(raw, day, boundary).select("trip", "num", "day").rows()

    assert got(date(2026, 10, 1)) == [  # the first raw day: its own trips and the late stops
        ("a-2610010800", 1, date(2026, 10, 1)),
        ("a-2610010800", 2, date(2026, 10, 1)),
        ("b-2609302350", 2, date(2026, 9, 30)),
    ]
    assert got(date(2026, 10, 2)) == [("c-2610020800", 1, date(2026, 10, 2))]


def test_raw_gaps_cover_only_the_given_days_and_find_a_thin_hour():
    first = date(2026, 10, 1)
    day_list = [first + timedelta(days=i) for i in range(21)]  # three weeks of a 31-day month
    hours = pl.DataFrame(
        {"hour": [dt(d.year, d.month, d.day, h) for d in day_list for h in range(24)]}
    ).with_columns(rows=pl.lit(100, pl.UInt32))
    hours = hours.with_columns(
        rows=pl.when(pl.col("hour") == dt(2026, 10, 8, 13)).then(10).otherwise(100).cast(pl.UInt32)
    )
    gaps = raw_gaps(hours, day_list)
    assert gaps.columns == ["day", "missing_hours"]
    assert gaps.schema["missing_hours"] == pl.Int32
    assert gaps["day"].to_list() == day_list  # nothing after the last day
    assert dict(gaps.iter_rows()) == {d: int(d == date(2026, 10, 8)) for d in day_list}


def test_a_day_without_any_row_misses_all_its_hours():
    day_list = [date(2026, 10, 1) + timedelta(days=i) for i in range(21)]
    hours = pl.DataFrame(
        {"hour": [dt(d.year, d.month, d.day, h) for d in day_list[1:] for h in range(24)]}
    ).with_columns(rows=pl.lit(100, pl.UInt32))
    gaps = dict(raw_gaps(hours, day_list).iter_rows())
    assert gaps[date(2026, 10, 1)] == 24
    assert sum(gaps.values()) == 24
