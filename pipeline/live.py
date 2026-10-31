"""Today so far at the large stations, from the DB Timetables API: `python -m pipeline.live`, one
run per call (cron calls it every 15 minutes; ADR 0002).

A run fetches `fchg` for every large station, then today's missing `plan` slices, folds the
responses into the day's state with `pipeline.raw.parse` (the rules of the raw days) and writes
`data/heute.parquet`: today's arrivals before the last full hour, in the shape of `day_hours`, plus
the run's start time `stand`. A station counts only when its changes came in this run and its plan
slices up to that hour are all fetched; when everything fails, the file is empty."""

import http.client
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import polars as pl

from core.periods import full_coverage_start, local_time
from pipeline.aggregate import day_hours
from pipeline.raw import FCHG, FCHG_COLUMNS, PLAN, PLAN_COLUMNS, Stops, frame, merge, parse

API = "https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1"
TIMEOUT = 30  # seconds per request
PACE = 1.0  # seconds between requests: about 11 a minute on average, the documented 60 at most
# No request starts later than this after the run's start, so runs every 15 minutes never overlap
# (and never add up to more than 60 a minute) unless one request hangs for its whole TIMEOUT.
# ponytail: at most 720 requests a run, 589 slices after the 131 changes. A first run of the day at
# 14:00 needs 131 x 14 slices before the cut: about 42 stations become ready per run, all of them
# in the fourth run (14:45), the slices ahead in the fifth. Shorter if DB grants more than 60 a
# minute (a smaller PACE).
DEADLINE = timedelta(minutes=12)
AHEAD = 3  # plan slices up to this many hours after now, so the next hours are ready in time

Get = Callable[[str], tuple[int, str]]  # url -> (status, body)


def large_stations(data_dir: Path) -> list[str]:
    """The EVAs of the last month before full coverage: the stations the source had before it
    took every station in, the large ones.
    ponytail: frozen to that month; a new large station needs a rule beyond the old source."""
    monate = pl.read_parquet(data_dir / "monate.parquet")
    start = full_coverage_start(dict(zip(monate["month"], monate["stations"], strict=True)))
    before = sorted(m for m in monate["month"] if start and m < start)
    if not before:
        sys.exit("no month before full coverage in data/monate.parquet: run pipeline.update first")
    return sorted(pl.read_parquet(data_dir / "months" / before[-1] / "stations.parquet")["eva"])


def _write(df: pl.DataFrame, path: Path) -> None:
    """Write to a temporary sibling, then rename: no reader and no later run sees half a file."""
    tmp = path.with_name(f"{path.name}.tmp")
    df.write_parquet(tmp)
    os.replace(tmp, path)


def _stops(path: Path) -> Stops:
    return {r[0]: r[1:] for r in pl.read_parquet(path).iter_rows()} if path.exists() else {}


def run(
    data_dir: Path, get: Get, now: Callable[[], datetime], sleep: Callable[[float], None]
) -> str:
    """One run against `get`; `now` gives aware UTC times. Returns a one-line summary.
    ponytail: the day's state (a few MB) is reread and rewritten whole on every run; append per
    run if the runs get slow on the VPS."""
    t0 = now()  # the time of the data: the changes come first
    start = local_time(t0)
    day, hour = start.date(), start.hour
    live = data_dir / "live"
    for old in live.glob("????-??-??"):
        if old.name < (day - timedelta(days=1)).isoformat():
            shutil.rmtree(old)
    state = live / day.isoformat()
    state.mkdir(parents=True, exist_ok=True)
    plan, fchg = _stops(state / "plan.parquet"), _stops(state / "fchg.parquet")
    slices_path = state / "slices.parquet"
    slices = set(pl.read_parquet(slices_path).iter_rows()) if slices_path.exists() else set()

    evas = large_stations(data_dir)
    # The changes, then the slices before the cut station by station (so a first run of the day
    # makes stations ready one after another), then the hours ahead of all stations.
    jobs: list[tuple[str, int | None]] = [(e, None) for e in evas]
    jobs += [(e, h) for e in evas for h in range(hour) if (e, h) not in slices]
    ahead = range(hour, min(24, hour + AHEAD + 1))
    jobs += [(e, h) for h in ahead for e in evas if (e, h) not in slices]
    fresh: set[str] = set()  # stations whose changes came in this run
    made, failed, stop = 0, 0, ""
    for eva, h in jobs:
        if made:
            sleep(PACE)
        if now() - t0 >= DEADLINE:
            stop = ", stopped at the deadline"
            break
        url = f"{API}/fchg/{eva}" if h is None else f"{API}/plan/{eva}/{day:%y%m%d}/{h:02d}"
        status, body = get(url)
        made += 1
        if status == 429:  # throttled: try again next run
            stop = ", stopped by HTTP 429"
            break
        ok = status == 200 and bool(body.strip())
        if ok:
            try:
                parse(FCHG if h is None else PLAN, eva, body, plan, fchg)
            except ET.ParseError:
                ok = False
        if not ok:  # skipped: a slice is asked for again next run
            failed += 1
            continue
        if h is None:
            fresh.add(eva)
        else:
            slices.add((eva, h))

    _write(frame(plan, PLAN_COLUMNS), state / "plan.parquet")
    _write(frame(fchg, FCHG_COLUMNS), state / "fchg.parquet")
    _write(
        pl.DataFrame(sorted(slices), schema={"eva": pl.String, "hour": pl.Int8}, orient="row"),
        slices_path,
    )
    # Without this run's changes a station's planned stops would all look on time.
    ready = [e for e in evas if e in fresh and all((e, h) in slices for h in range(hour))]
    rows = merge(plan, fchg).sort("time", "id")  # the tie order of the raw days
    today = rows.lazy().filter(pl.col("arrival_planned_time").dt.date() == day)
    heute = day_hours(today).filter(pl.col("hour") < hour, pl.col("eva").is_in(ready))
    stand = pl.lit(t0, pl.Datetime("us", "UTC"))
    _write(heute.with_columns(stand=stand), data_dir / "heute.parquet")
    return (
        f"{day} before {hour:02d}:00: {made} requests ({failed} failed),"
        f" {len(ready)} of {len(evas)} stations{stop}"
    )


def _http(client_id: str, key: str) -> Get:
    headers = {"DB-Client-ID": client_id, "DB-Api-Key": key, "Accept": "application/xml"}

    def get(url: str) -> tuple[int, str]:
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.status, r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            return e.code, ""
        except (OSError, http.client.HTTPException):  # timeout, connection lost
            return 0, ""

    return get


def main(argv: list[str]) -> None:
    if argv:
        sys.exit("usage: python -m pipeline.live")
    # Stripped: a value read from a file ends in a newline, and urllib's error for that header
    # value would print the key.
    client_id, key = (os.environ.get(k, "").strip() for k in ("DB_CLIENT_ID", "DB_API_KEY"))
    if not client_id or not key:
        sys.exit("set DB_CLIENT_ID and DB_API_KEY (the DB API Marketplace application)")
    print(run(Path("data"), _http(client_id, key), lambda: datetime.now(UTC), time.sleep))


if __name__ == "__main__":
    main(sys.argv[1:])
