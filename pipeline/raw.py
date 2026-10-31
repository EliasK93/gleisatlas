"""Raw DB Timetables responses (piebro's `raw_data`) -> stop rows in the monthly schema, and the
per-day tables the day views read.

A `plan` response lists the planned stops of one station and hour, a `fchg` response the changes of
one station. Both are IRIS XML in `response_data`; `stop_rows` combines them the way piebro's
monthly release does (see the SQL in his `create_monthly_data_release.py`, MIT): `parse` folds each
response into dicts, `merge` turns them into rows. The live collector (`pipeline.live`) uses the
same two steps."""

import xml.etree.ElementTree as ET
from collections.abc import Callable
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import NamedTuple

import polars as pl
from huggingface_hub import HfApi, hf_hub_download
from huggingface_hub.errors import EntryNotFoundError

from pipeline.aggregate import COLUMNS, clean, day_hours, days, hour_table
from pipeline.download import REPO

PLAN, FCHG = "timetables/v1/plan", "timetables/v1/fchg"
PLAN_COLUMNS = ("id", "eva", "p_type", "p_number", "p_ar", "p_dp")
FCHG_COLUMNS = (
    *("id", "f_eva", "f_type", "f_number"),
    *("f_ar", "f_ar_ct", "f_ar_clt", "f_ar_cs", "f_dp", "f_dp_ct", "f_dp_clt", "f_dp_cs"),
)
Stops = dict[str, tuple[str | None, ...]]  # stop id -> the other columns of PLAN/FCHG_COLUMNS


class RawSource(NamedTuple):
    """Where the raw days come from: the files of one UTC day folder (repo paths in time order),
    the newest `fchg` snapshot time in one file (naive UTC, as stored) and a download."""

    files: Callable[[date], list[str]]
    last_fchg: Callable[[str], datetime | None]
    fetch: Callable[[str, Path], Path]


def _eva(url: str, api: str) -> str:
    return url.split(f"/{api}/", 1)[1].split("/")[0]


def fchg_pass(path: Path) -> tuple[datetime | None, set[str]]:
    """The `fchg` pass of one raw file (one collector run): its first request time (naive UTC)
    and the stations that answered with a body. An unparsable body never gets this far:
    `stop_rows` would fail on it."""
    passed = (
        pl.scan_parquet(path)
        .filter(pl.col("api_name") == FCHG)
        .select(
            "timestamp",
            "url",
            ok=(pl.col("status_code") == "200") & (pl.col("response_data").fill_null("") != ""),
        )
        .collect()
    )
    start = passed.select(pl.col("timestamp").min()).item()
    return start, {_eva(u, FCHG) for u in passed.filter("ok")["url"]}


def _has_change(s: ET.Element) -> bool:
    """Whether a `fchg` stop carries more than messages: a change, a cancellation, an added stop,
    an extra train or a replaced one. Only such snapshots can replace an earlier one."""
    ar, dp, tl, ref = s.find("ar"), s.find("dp"), s.find("tl"), s.find("ref/tl")
    changed = any(
        e is not None and (e.get("ct") or e.get("clt") or e.get("cs") or e.get("ps") == "a")
        for e in (ar, dp)
    )
    return bool(
        changed or (tl is not None and tl.get("t") == "e") or (ref is not None and ref.attrib)
    )


def _event(e: ET.Element | None) -> tuple[str | None, str | None, str | None, str | None]:
    """Planned time, changed time, cancellation time and change status of an arrival/departure."""
    if e is None:
        return None, None, None, None
    return e.get("pt"), e.get("ct"), e.get("clt"), e.get("cs")


def frame(rows: Stops, columns: tuple[str, ...]) -> pl.DataFrame:
    """A `plan` or `fchg` dict as a table of strings, the stop id first."""
    return pl.DataFrame(
        [(sid, *r) for sid, r in rows.items()],
        schema=dict.fromkeys(columns, pl.String),
        orient="row",
    )


def parse(api: str, eva: str, text: str, plan: Stops, fchg: Stops) -> None:
    """Fold one response of station `eva` into the dicts, responses in time order: a `plan` stop
    replaces the earlier one of its id, a `fchg` stop only when it carries a change."""
    for s in ET.fromstring(text).findall("s"):
        sid, tl, ar, dp = s.get("id"), s.find("tl"), s.find("ar"), s.find("dp")
        if sid is None:
            continue
        kind = (tl.get("c"), tl.get("n")) if tl is not None else (None, None)
        if api == PLAN:
            plan[sid] = (eva, *kind, _event(ar)[0], _event(dp)[0])
        elif _has_change(s):
            fchg[sid] = (eva, *kind, *_event(ar), *_event(dp))


def stop_rows(files: list[Path]) -> pl.DataFrame:
    """One row per stop id in the monthly source schema (unused columns NULL), from the raw files in
    time order. The latest `plan` snapshot gives the timetable; the latest `fchg` snapshot that
    carries a change gives the changes, and its fields replace the plan's as a whole. Times are the
    local naive ones of the source. The table is not cleaned."""
    plan: Stops = {}
    fchg: Stops = {}
    for path in files:
        responses = (
            pl.scan_parquet(path)
            .filter(
                pl.col("status_code") == "200",
                pl.col("api_name").is_in([PLAN, FCHG]),
                pl.col("response_data").fill_null("") != "",
            )
            .sort("timestamp")  # a file holds its responses in request order, but do not rely on it
            .select("url", "api_name", "response_data")
            .collect()
        )
        for url, api, text in responses.iter_rows():
            parse(api, _eva(url, api), text, plan, fchg)
    return merge(plan, fchg)


def merge(plan: Stops, fchg: Stops) -> pl.DataFrame:
    """The stop rows of `stop_rows` from the folded dicts."""
    merged = frame(plan, PLAN_COLUMNS).join(
        frame(fchg, FCHG_COLUMNS), on="id", how="full", coalesce=True
    )

    def moment(*cols: str) -> pl.Expr:
        return pl.coalesce(*cols).str.to_datetime("%y%m%d%H%M", strict=False)

    def cancelled(prefix: str) -> pl.Expr:  # a plan-only stop has neither status nor time
        return pl.coalesce(
            pl.col(f"{prefix}_cs") == "c", pl.col(f"{prefix}_clt").is_not_null()
        ).fill_null(False)

    out = merged.select(
        "id",
        eva=pl.coalesce("eva", "f_eva"),
        train_type=pl.coalesce("p_type", "f_type"),
        train_number=pl.coalesce("p_number", "f_number"),
        arrival_planned_time=moment("p_ar", "f_ar"),
        departure_planned_time=moment("p_dp", "f_dp"),
        arrival_change_time=moment("f_ar_ct", "p_ar", "f_ar"),
        departure_change_time=moment("f_dp_ct", "p_dp", "f_dp"),
        arrival_is_canceled=cancelled("f_ar"),
        departure_is_canceled=cancelled("f_dp"),
    ).with_columns(time=pl.coalesce("departure_change_time", "arrival_change_time"))
    return out.with_columns(
        pl.lit(None, pl.String).alias(c) for c in COLUMNS if c not in out.columns
    )


def day_tables(
    rows: pl.DataFrame, day: date, boundary: datetime
) -> tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    """(days, hours, day_hours) of one raw day: the delay histogram of the stops planned on `day`,
    the cleaned rows per local hour of `time` on `day` (what `raw_gaps` judges) and the delay
    histogram per planned arrival hour as well. Rows recorded before `boundary` are left out: they
    are already in the last monthly file. The first raw day (the day of `boundary`) also keeps the
    stops planned on earlier days but recorded after the boundary, mostly the late stops of the
    last monthly day: no monthly file holds them yet."""
    # Like the monthly files, so the first duplicate is the same; the id breaks ties.
    # ponytail: the monthly release leaves ties open (DuckDB), so about 3 stops a day (one train's
    # two ids, same time) keep the other duplicate and sit 1-2 minutes off. Ends once the monthly
    # file replaces the raw days; no rule on the id reproduces it.
    lf = rows.sort("time", "id").lazy()
    planned_day = pl.col("arrival_planned_time").dt.date()
    ours = (planned_day <= day) if day == boundary.date() else (planned_day == day)
    mine = lf.filter(ours & (pl.col("time") >= boundary))
    hours = (
        clean(lf)
        .filter(pl.col("time").dt.date() == day)
        .group_by(hour=pl.col("time").dt.truncate("1h"))
        .agg(rows=pl.len())
        .sort("hour")
        .collect()
    )
    return days(mine), hours, day_hours(mine)


def raw_gaps(hours: pl.DataFrame, day_list: list[date]) -> pl.DataFrame:
    """(day, missing_hours) for the raw days of one month, by the monthly rule (`meta`): the usual
    level of an hour of day is the lowest, over the weekdays, of the median row count of that
    (weekday, hour), and an hour is missing below GAP_SHARE of it. Only the hours of `day_list` are
    judged, so the rest of the month is never missing, and the level comes from these days alone.
    ponytail: early in a month there is one value per weekday, so a gap is only found once the
    weekday has come round about three times; a gap in the first two weeks may stay unflagged until
    the monthly file replaces the raw days. Pool the previous month's level if that matters."""
    start, end = (
        datetime.combine(d, time()) for d in (min(day_list), max(day_list) + timedelta(1))
    )
    return (
        hour_table(hours, start, end)
        .group_by(day=pl.col("hour").dt.date())
        .agg(missing_hours=pl.col("thin").sum().cast(pl.Int32))
        .sort("day")
    )


def remote_source() -> RawSource:
    api = HfApi()

    def files(day: date) -> list[str]:
        folder = f"raw_data/year={day.year}/month={day.month}/day={day.day}"  # no zero padding
        try:
            tree = api.list_repo_tree(REPO, path_in_repo=folder, repo_type="dataset")
            return sorted(f.path for f in tree if f.path.endswith(".parquet"))
        except EntryNotFoundError:
            return []

    def last_fchg(path: str) -> datetime | None:
        lf = pl.scan_parquet(f"hf://datasets/{REPO}/{path}")  # two small columns, read remotely
        return (
            lf.filter(pl.col("api_name") == FCHG).select(pl.col("timestamp").max()).collect().item()
        )

    def fetch(path: str, dest: Path) -> Path:
        return Path(hf_hub_download(REPO, path, repo_type="dataset", local_dir=dest))

    return RawSource(files, last_fchg, fetch)
