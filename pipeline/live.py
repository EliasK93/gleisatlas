"""Today so far at the large stations, from the DB Timetables API: `python -m pipeline.live`, one
run per call (a schedule calls it every 15 minutes: the Azure job, or cron; ADR 0002).

A run fetches `fchg` for every large station, then today's missing `plan` slices, folds the
responses into the day's state with `pipeline.raw.parse` (the rules of the raw days) and writes
`data/heute.parquet`: today's arrivals before the last full hour, in the shape of `day_hours`, plus
the run's start time `stand`. A station counts only when its changes came in this run and its plan
slices up to that hour are all fetched; when everything fails, the file is empty.

The collector also keeps its finished days. From midnight on, every run folds its changes into
yesterday's state too (no extra requests), and the first run at or after FINAL_HOUR finalizes
yesterday into `data/live_tage.parquet` (`day_hours` rows), so the days after the last monthly or
raw day stay available.

With DATA_URL set (the Azure job) the files come from and go back to that blob container (`sync`).
A refused key (HTTP 401 or 403) ends the run at once without saving this run's state."""

import http.client
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl

from core.normal import WEEKS
from core.periods import local_midnight_utc, local_time
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
# The first run from this local hour on finalizes the day before: an hour after midnight its last
# trains have arrived (the source's runs from 00:15 on already gave the settled day).
FINAL_HOUR = 1
# The `fchg` window is 13-14 h (ADR 0002): two answered runs further apart than this miss changes.
MAX_RUN_GAP = timedelta(hours=12)
# live_tage.parquet keeps the days from this many days before the newest on: the same weekday of
# every reference week (core.normal), so the normals stay whole however long uploads lag.
KEEP_DAYS = 7 * WEEKS
FINAL = "final"  # marker in a day's state folder: finalized (or given up), never tried again
STATE = ("plan.parquet", "fchg.parquet", "slices.parquet", "runs.parquet", FINAL)  # a day's folder
BLOB_VERSION = "2021-08-06"  # x-ms-version of the Blob REST calls; a token needs 2017-11-09 on

Get = Callable[[str], tuple[int, str]]  # url -> (status, body)


def large_evas(data_dir: Path) -> list[str]:
    """The EVAs of the large stations, from `data/large.parquet` (written by `pipeline.update`
    from the core rule, `core.periods.large_stations`); empty without the file."""
    path = data_dir / "large.parquet"
    return pl.read_parquet(path)["eva"].to_list() if path.exists() else []


def _write(df: pl.DataFrame, path: Path) -> None:
    """Write to a temporary sibling, then rename: no reader and no later run sees half a file."""
    tmp = path.with_name(f"{path.name}.tmp")
    df.write_parquet(tmp)
    os.replace(tmp, path)


def _stops(path: Path) -> Stops:
    return {r[0]: r[1:] for r in pl.read_parquet(path).iter_rows()} if path.exists() else {}


def _slices(path: Path) -> set[tuple[str, int]]:
    """The fetched plan slices (eva, local hour) in a slices.parquet."""
    return set(pl.read_parquet(path).iter_rows()) if path.exists() else set()


def _hours(day: date) -> list[int]:
    """The local hours `day` has, the hours of its plan slices: no 02:00 on the night the clocks go
    forward; on the night they go back the doubled 02:00 is one slice."""
    start, end = local_midnight_utc(day), local_midnight_utc(day + timedelta(days=1))
    steps = (end - start) // timedelta(hours=1)
    at = (start.replace(tzinfo=UTC) + timedelta(hours=k) for k in range(steps))
    return sorted({local_time(t).hour for t in at})


def _naive(t: datetime) -> datetime:
    """Run times are stored as naive UTC: Python's zoneinfo needs the tzdata package on Windows to
    read an aware column."""
    return t.astimezone(UTC).replace(tzinfo=None)


def _runs(path: Path) -> list[datetime]:
    """The run times in a runs.parquet (naive UTC)."""
    return pl.read_parquet(path)["t0"].to_list() if path.exists() else []


def _add_run(path: Path, t0: datetime) -> None:
    """Record a run that got changes in a runs.parquet."""
    _write(pl.DataFrame({"t0": [*_runs(path), _naive(t0)]}, schema={"t0": pl.Datetime}), path)


def _finalize(
    data_dir: Path,
    state: Path,
    day: date,
    stops: tuple[Stops, Stops],
    fresh: set[str],
    evas: list[str],
) -> str:
    """Write the day of the state folder `state` (folded up to this run, whose start is among its
    runs) into live_tage.parquet and mark the folder; returns a note for the summary. Only stations
    with every plan slice of the day (`_hours`) and changes from this run count. A day is dropped
    when the gap from its local midnight to the first answered run, or between two runs, is longer
    than MAX_RUN_GAP (`fchg` reaches only that far back), or when it had no run of its own.
    ponytail: a station whose changes failed in this run is lost for the day, even when it
    answered in the runs since midnight; the next run could still add it, at the price of keeping
    the day open for hours."""
    times = sorted([local_midnight_utc(day), *_runs(state / "runs.parquet")])
    if len(times) < 2 or times[1] >= local_midnight_utc(day + timedelta(days=1)):
        note = f", dropped {day}: no runs"
    else:
        note = f", dropped {day}: runs more than {MAX_RUN_GAP.total_seconds() / 3600:g} hours apart"
    if all(b - a <= MAX_RUN_GAP for a, b in zip(times, times[1:], strict=False)):
        slices, hours = _slices(state / "slices.parquet"), _hours(day)
        ready = [e for e in evas if e in fresh and all((e, h) in slices for h in hours)]
        rows = merge(*stops).sort("time", "id")  # the tie order of the raw days
        planned = rows.lazy().filter(pl.col("arrival_planned_time").dt.date() == day)
        new = day_hours(planned).filter(pl.col("eva").is_in(ready))
        path = data_dir / "live_tage.parquet"
        old = pl.read_parquet(path) if path.exists() else new.clear()
        oldest = day - timedelta(days=KEEP_DAYS)
        out = pl.concat([old.filter(pl.col("day") != day, pl.col("day") >= oldest), new])
        _write(out.sort("day", "hour", "eva", "gruppe", "bucket", nulls_last=True), path)
        note = f", kept {day}: {len(ready)} stations"
    (state / FINAL).write_bytes(b"")
    return note


def run(
    data_dir: Path, get: Get, now: Callable[[], datetime], sleep: Callable[[float], None]
) -> str:
    """One run against `get`; `now` gives aware UTC times. Returns a one-line summary.
    ponytail: the day's state (a few MB) is reread and rewritten whole on every run; append per
    run if the runs get slow."""
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
    # Yesterday's open state: this run's changes belong to it too, until it is finalized.
    before = live / (day - timedelta(days=1)).isoformat()
    folding = before.is_dir() and not (before / FINAL).exists()
    plan_before, fchg_before = (
        (_stops(before / "plan.parquet"), _stops(before / "fchg.parquet")) if folding else ({}, {})
    )
    slices_path = state / "slices.parquet"
    slices, hours = _slices(slices_path), _hours(day)
    past = [h for h in hours if h < hour]

    evas = large_evas(data_dir)
    if not evas:
        sys.exit(
            "no large stations (data/large.parquet is missing or empty): run pipeline.update first"
        )
    # The changes, then the slices before the cut station by station (so a first run of the day
    # makes stations ready one after another), then the hours ahead of all stations.
    # ponytail: a slice that never succeeds is asked for again on every run and keeps its station
    # grey, which the API cannot tell from a station without arrivals; count the misses per slice
    # and give up after a few if the first full runs show such slices.
    jobs: list[tuple[str, int | None]] = [(e, None) for e in evas]
    jobs += [(e, h) for e in evas for h in past if (e, h) not in slices]
    ahead = [h for h in hours if hour <= h <= hour + AHEAD]
    jobs += [(e, h) for h in ahead for e in evas if (e, h) not in slices]
    fresh: set[str] = set()  # stations whose changes came in this run
    made, failed, empty, stop = 0, 0, 0, ""
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
        if status in (401, 403):  # the key is refused: no more requests, and nothing is written
            sys.exit(f"stopped by HTTP {status}: the DB API refused the key")
        if h is not None and status == 404:  # an hour without trains: fetched, nothing to fold
            slices.add((eva, h))
            empty += 1
            continue
        ok = status == 200 and bool(body.strip())
        if ok:
            try:
                parse(FCHG if h is None else PLAN, eva, body, plan, fchg)
                if h is None and folding:
                    parse(FCHG, eva, body, plan_before, fchg_before)
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
    note = ""
    if fresh:  # a run without any answered changes covers nothing, so it is not a run of the day
        _add_run(state / "runs.parquet", t0)
    if folding:
        _write(frame(plan_before, PLAN_COLUMNS), before / "plan.parquet")
        _write(frame(fchg_before, FCHG_COLUMNS), before / "fchg.parquet")
        if fresh:  # the run covers yesterday's last hour too: it counts in its gap check
            _add_run(before / "runs.parquet", t0)
        # A run cut short (throttled, deadline) may lack stations' changes: the next one finalizes.
        if hour >= FINAL_HOUR and fresh and not stop:
            stops = (plan_before, fchg_before)
            note = _finalize(data_dir, before, day - timedelta(days=1), stops, fresh, evas)
    # Without this run's changes a station's planned stops would all look on time.
    ready = [e for e in evas if e in fresh and all((e, h) in slices for h in past)]
    rows = merge(plan, fchg).sort("time", "id")  # the tie order of the raw days
    today = rows.lazy().filter(pl.col("arrival_planned_time").dt.date() == day)
    heute = day_hours(today).filter(pl.col("hour") < hour, pl.col("eva").is_in(ready))
    stand = pl.lit(t0, pl.Datetime("us", "UTC"))
    _write(heute.with_columns(stand=stand), data_dir / "heute.parquet")
    return (
        f"{day} before {hour:02d}:00: {made} requests ({failed} failed, {empty} empty),"
        f" {len(ready)} of {len(evas)} stations{stop}{note}"
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


def _token() -> str:
    """A Blob Storage token of the job's user-assigned identity (its client id in AZURE_CLIENT_ID),
    from the identity endpoint Container Apps gives the container."""
    query = urllib.parse.urlencode(
        {
            "resource": "https://storage.azure.com/",
            "api-version": "2019-08-01",
            "client_id": os.environ["AZURE_CLIENT_ID"],
        }
    )
    headers = {"X-IDENTITY-HEADER": os.environ["IDENTITY_HEADER"]}
    req = urllib.request.Request(f"{os.environ['IDENTITY_ENDPOINT']}?{query}", headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)["access_token"]


def _blob(method: str, url: str, token: str, body: bytes | None = None) -> bytes:
    """One Blob REST call with the token (PUT a block blob, DELETE, the listing); its body."""
    headers = {"Authorization": f"Bearer {token}", "x-ms-version": BLOB_VERSION}
    if method == "PUT":
        headers |= {"x-ms-blob-type": "BlockBlob", "Content-Type": "application/octet-stream"}
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def _pull(base: str, data_dir: Path, names: list[str]) -> None:
    """Download each blob by its public URL into `data_dir` under its name; a 404 means none."""
    for name in names:
        try:
            with urllib.request.urlopen(base + name, timeout=TIMEOUT) as r:
                body = r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            sys.exit(f"download failed: {name}: HTTP {e.code}")
        except (OSError, http.client.HTTPException) as e:
            sys.exit(f"download failed: {name}: {e}")
        path = data_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)


def _stamps(data_dir: Path) -> dict[str, int]:
    """Every file under `data_dir` by its path relative to it (as a blob name): its mtime."""
    return {
        p.relative_to(data_dir).as_posix(): p.stat().st_mtime_ns
        for p in data_dir.rglob("*")
        if p.is_file()
    }


def sync(base: str, data_dir: Path, collect: Callable[[], str], now: Callable[[], datetime]) -> str:
    """The job on Azure, whose `data_dir` starts empty: pull the large stations, the kept days and
    the state of yesterday and today from the blob container at `base` (DATA_URL), `collect` (one
    run), then push the files the run wrote and delete the container's state folders the run let
    go. Returns the run's summary with the counts. A failed pull stops before the run: without its
    state a run would write live_tage.parquet from nothing. A run that exits pushes nothing.
    ponytail: the whole state is pulled and pushed on every run (a few MB), and the listing reads
    one page (5,000 names, the job keeps about ten); fine at 131 stations, append per run if it
    grows."""
    try:  # first, so a broken identity fails before three minutes of requests
        token = _token()
    except (OSError, http.client.HTTPException, KeyError, ValueError) as e:
        sys.exit(f"token failed: {e!r}")
    day = local_time(now()).date()
    state = [f"live/{d}/{n}" for d in (day - timedelta(days=1), day) for n in STATE]
    _pull(base, data_dir, ["large.parquet", "live_tage.parquet", *state])
    before = _stamps(data_dir)
    summary = collect()
    after = _stamps(data_dir)
    # The top-level files first: a finished day is in live_tage.parquet before its FINAL marker.
    changed = sorted(
        (n for n, t in after.items() if before.get(n) != t), key=lambda n: ("/" in n, n)
    )
    container = base.rstrip("/")
    try:
        for name in changed:
            _blob("PUT", base + name, token, (data_dir / name).read_bytes())
        listing = _blob("GET", f"{container}?restype=container&comp=list&prefix=live/", token)
        names = [e.text or "" for e in ET.fromstring(listing).iter("Name")]
        gone = [n for n in names if n not in after]
        for name in gone:
            _blob("DELETE", base + name, token)
    except urllib.error.HTTPError as e:
        sys.exit(f"blob sync failed: {e.url.removeprefix(base)}: HTTP {e.code}")
    except (OSError, http.client.HTTPException) as e:  # timeout, connection lost
        sys.exit(f"blob sync failed: {e}")
    return f"{summary}, {len(changed)} files uploaded, {len(gone)} deleted"


def main(argv: list[str]) -> None:
    if argv:
        sys.exit("usage: python -m pipeline.live")
    # Stripped: a value read from a file ends in a newline, and urllib's error for that header
    # value would print the key.
    client_id, key = (os.environ.get(k, "").strip() for k in ("DB_CLIENT_ID", "DB_API_KEY"))
    if not client_id or not key:
        sys.exit("set DB_CLIENT_ID and DB_API_KEY (the DB API Marketplace application)")
    data_dir, get = Path("data"), _http(client_id, key)

    def clock() -> datetime:
        return datetime.now(UTC)

    def collect() -> str:
        return run(data_dir, get, clock, time.sleep)

    # On Azure the job's files live in the blob container the API reads (backend/fetch.py).
    base = os.environ.get("DATA_URL")
    print(sync(base, data_dir, collect, clock) if base else collect())


if __name__ == "__main__":
    main(sys.argv[1:])
