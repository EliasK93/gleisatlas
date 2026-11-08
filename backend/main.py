"""FastAPI routes over the aggregate. Route and parameter names are the public (German) contract."""

import calendar
import logging
import os
import sys
import threading
import time
import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from typing import Annotated, Literal
from urllib.parse import quote

import polars as pl
from fastapi import FastAPI, HTTPException, Path, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import AfterValidator, BaseModel, Field

from backend import fetch
from core.categories import FERN, REGIONAL
from core.normal import FLOORS, deviation_class, normal, reference_days
from core.periods import full_coverage_start, local_time, timetable_changes
from core.rankings import Metric, counted, higher_is_better, rank
from core.search import line_hits, norm
from core.stations import LAND_CODES
from core.stats import CellStats, cell_stats_frame, delay_bins

AGG_PATH = os.environ.get("AGGREGATE_PATH", "data/aggregate.parquet")
STATIONS_PATH = os.environ.get("STATIONS_PATH", "data/stations.parquet")
MONATE_PATH = os.environ.get("MONATE_PATH", "data/monate.parquet")
LINES_PATH = os.environ.get("LINES_PATH", "data/lines.parquet")
LINIEN_PATH = os.environ.get("LINIEN_PATH", "data/linien.parquet")
ABSCHNITTE_PATH = os.environ.get("ABSCHNITTE_PATH", "data/abschnitte.parquet")
LINIENWEG_PATH = os.environ.get("LINIENWEG_PATH", "data/linienweg.parquet")
# like the aggregate, but per line: weekday x hour x delay bucket; and the trips per line and month
LINIEN_STUNDEN_PATH = os.environ.get("LINIEN_STUNDEN_PATH", "data/linien_stunden.parquet")
TAKT_PATH = os.environ.get("TAKT_PATH", "data/takt.parquet")
# every stop per station, group and month: the aggregate counts arrivals only
HALTE_PATH = os.environ.get("HALTE_PATH", "data/halte.parquet")
DAYS_PATH = os.environ.get("DAYS_PATH", "data/days.parquet")
TAGE_PATH = os.environ.get("TAGE_PATH", "data/tage.parquet")
DAY_HOURS_PATH = os.environ.get("DAY_HOURS_PATH", "data/day_hours.parquet")
HEUTE_PATH = os.environ.get("HEUTE_PATH", "data/heute.parquet")  # optional: the collector's output
# optional: today's other stations from piebro's raw data, written by pipeline.update
HEUTE_REST_PATH = os.environ.get("HEUTE_REST_PATH", "data/heute_rest.parquet")
# optional: the collector's finished days after the last complete day (pipeline.live)
LIVE_TAGE_PATH = os.environ.get("LIVE_TAGE_PATH", "data/live_tage.parquet")
# the large stations (one column `eva`), written by pipeline.update
LARGE_PATH = os.environ.get("LARGE_PATH", "data/large.parquet")
# the last 28 days' trips, one row per stop (pipeline.update); the Bildfahrplan reads one line's day
FAHRTEN_PATH = os.environ.get("FAHRTEN_PATH", "data/fahrten.parquet")
# see backend/fetch.py. These are downloaded at start. The files of the collector (HEUTE_PATH,
# LIVE_TAGE_PATH) change while the API runs: fetch.refresh_live keeps them current, and
# HEUTE_REST_PATH (piebro's raw data, written by pipeline.update) is never downloaded.
DATA_FILES = (
    AGG_PATH,
    STATIONS_PATH,
    MONATE_PATH,
    LINES_PATH,
    LINIEN_PATH,
    ABSCHNITTE_PATH,
    LINIENWEG_PATH,
    LINIEN_STUNDEN_PATH,
    TAKT_PATH,
    HALTE_PATH,
    DAYS_PATH,
    TAGE_PATH,
    DAY_HOURS_PATH,
    LARGE_PATH,
    FAHRTEN_PATH,
)
HEUTE_MAX_AGE = timedelta(hours=2)  # an older collector run is no "today"

# Our own lines go to stdout: uvicorn configures only its own loggers, and its access log is off.
log = logging.getLogger("gleisatlas")
log.setLevel(logging.INFO)
# LOG_FILE (local runs) adds a timestamped copy; Azure leaves it unset and stamps stdout itself.
for old in log.handlers[:]:  # a reload (tests) must not double the lines
    log.removeHandler(old)
    old.close()
# ponytail: stdout lines carry no timestamp (Log Analytics adds TimeGenerated), and the 8-hex id
# pairs a start with its end but is not unique forever; add both if logs leave Azure.
log.addHandler(logging.StreamHandler(sys.stdout))
if log_file := os.environ.get("LOG_FILE"):
    os.makedirs(os.path.dirname(os.path.abspath(log_file)), exist_ok=True)
    to_file = logging.FileHandler(log_file, encoding="utf-8")
    to_file.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    log.addHandler(to_file)

app = FastAPI(title="Gleisatlas", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.environ.get("CORS_ORIGINS", "http://localhost:5317").split(",")
        if o.strip()
    ],
    allow_methods=["GET"],
)
app.add_middleware(GZipMiddleware)  # the all-stations map response is large and repetitive


_busy = 0  # requests in flight; only the event loop runs the middleware, so no lock
_last_end = 0.0  # time.monotonic() when the last request ended
warming: threading.Thread | None = None  # the process's warm-up, once started
QUIET = 2.0  # seconds without a request before the warm-up runs its next page


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """One line at the start and one at the end, with the same id and no client data. A start
    line without an end line is a request that never finished. Starts the warm-up."""
    global _busy, _last_end, warming
    rid = uuid.uuid4().hex[:8]
    query = f"?{request.url.query}" if request.url.query else ""
    # quoted: ASGI decodes the path, and a decoded line break or space could forge a line or field
    log.info("start %s %s %s%s", rid, request.method, quote(request.url.path), query)
    began = time.perf_counter()
    status = 500  # what the client sees when the handler raises
    _busy += 1
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        _busy -= 1
        _last_end = time.monotonic()
        log.info("end %s %d %dms", rid, status, (time.perf_counter() - began) * 1000)
        # The first answered request starts the warm-up, which waits for a quiet moment before each
        # page (`_quiet`). Only on the deploy (DATA_URL): there every wake-up is a fresh process
        # with cold caches.
        if warming is None and os.environ.get("DATA_URL"):
            warming = threading.Thread(target=warm_up, name="warm-up", daemon=True)
            warming.start()


DIGITS = r"^[0-9]+$"  # ASCII only: \d would also accept other scripts' digits
Eva = Annotated[str, Path(pattern=DIGITS)]
Month = Annotated[str | None, Query(pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])$")]


def real_period(value: str | None) -> str | None:
    """A month 'YYYY-MM' or day 'YYYY-MM-DD' must exist in the calendar ('2026-02-31' and
    '0000-01' are a 422)."""
    if value:
        date.fromisoformat(value if len(value) == 10 else f"{value}-01")
    return value


# a month 'YYYY-MM' or a day 'YYYY-MM-DD'; only /karte takes it
Period = Annotated[
    str | None,
    Query(pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$"),
    AfterValidator(real_period),
]
Gattung = Literal["alle", "regional", "fern"]
GRUPPEN = (REGIONAL, FERN)  # display order


class Stats(BaseModel):
    n: int  # stops including cancellations
    ausfallquote: float
    median: float | None  # minutes, non-cancelled stops only
    p90: float | None
    puenktlich: float | None  # share below 6 minutes


class Day(Stats):
    weekday: int  # 0 = Monday


class Cell(Day):
    hour: int


class Heatmap(BaseModel):
    von: str
    bis: str
    n: int
    cells: list[Cell]
    tage: list[Day]  # same statistics per weekday over all hours
    titel: str | None = None  # the line label for a line's heatmap; None otherwise


class Station(BaseModel):
    eva: str
    name: str
    land: str | None  # federal state; not known for every station
    n: int  # stops over the whole data set, all categories


class SuchLinie(BaseModel):
    linie: str
    label: str
    typ: str
    zug: bool  # a single train number ("ICE 679"), not a line
    richtung: Literal[1, 2] | None  # the line page's direction toward the end station searched for
    ziel: str | None  # that end station's name; set exactly when richtung is


class Suche(BaseModel):
    bahnhoefe: list[Station]
    linien: list[SuchLinie]
    zuerst: Literal["bahnhoefe", "linien"]  # the group to list first


class KartenStation(Stats):
    eva: str
    name: str
    lat: float
    lon: float


class Karte(BaseModel):
    von: str
    bis: str
    n: int  # all stops in the selection, also at stations that are not listed
    ohne_koordinaten: int  # named stations with stops in the selection but no coordinates
    stationen: list[KartenStation]


class Normal(BaseModel):
    """The median of a metric over the reference days; None with fewer than 8 valid days."""

    puenktlich: float | None
    ausfallquote: float | None
    median: float | None
    p90: float | None


class Klasse(BaseModel):
    """How far a day is from its normal (a station's, a state's or Germany's), in the usual
    variation of its reference days: 1 (much better), 2, 3 (as usual), 4, 5 (much worse).
    None without a shown value or a normal."""

    puenktlich: int | None
    ausfallquote: int | None
    median: int | None
    p90: int | None


class TageskartenStation(KartenStation):
    land: str | None  # code of the federal state ('be', 'by', ...); None where not known
    normal: Normal
    klasse: Klasse
    live: bool = False  # today only: the values come from the collector, not from the raw data


class Deutschland(Stats):
    normal: Normal
    klasse: Klasse


class Land(BaseModel):
    """A federal state, valued like Germany from the large stations that feed Germany's value."""

    land: str  # code, as in TageskartenStation.land
    bahnhoefe: int  # distinct station names among those with stops that day
    alle: Deutschland
    fern: Deutschland | None
    regional: Deutschland | None


class Tageskarte(BaseModel):
    tag: str  # 'YYYY-MM-DD', the planned arrival day
    referenztage: list[str]  # the days the normal rests on, nearest first
    fehlende_stunden: int  # hours of the day with incomplete data
    deutschland: Deutschland | None  # all trains; None when the large stations have no stops
    deutschland_fern: Deutschland | None  # the same for fern stops only; None without any
    deutschland_regional: Deutschland | None  # ... and for regional stops only
    n: int  # = deutschland.n: stops at the large stations, today those at the reporting ones
    laender: list[Land]  # by code; only states with stops that day
    ohne_koordinaten: int  # named stations with stops that day but no coordinates
    # large stations only; today: all of them, n = 0 without data
    stationen: list[TageskartenStation]
    stand: str | None = None  # today: the collector's run time, ISO UTC; None without live data
    bis_stunde: int | None = None  # arrivals planned before this local hour count (live stations)
    stand_rest: str | None = None  # today: the raw data's newest snapshot; None without it
    bis_stunde_rest: int | None = None  # the same cut for the stations from the raw data
    deutschland_live: bool | None = None  # today: the card uses live (True) or rest stations


class Gruppe(Stats):
    gruppe: str  # 'regional' or 'fern'


class Statistik(BaseModel):
    station: Station
    von: str
    bis: str
    n: int
    gesamt: Stats | None
    verteilung: list[int] = Field(
        description="Non-cancelled stops per delay bin in whole minutes, 7 values: "
        "< 1 (early included), [1, 3), [3, 6), [6, 10), [10, 20), [20, 30), >= 30. "
        "Empty when n is 0."
    )
    ausgefallen: int  # cancelled stops; verteilung plus ausgefallen sums to n
    gruppen: list[Gruppe]  # only groups with stops


class RanglistenEintrag(Stats):
    id: str  # EVA of a station, `linie` key of a line
    name: str  # station name or line label
    typ: str | None  # train type of a line; None for stations


class Rangliste(BaseModel):
    typ: Literal["linien", "bahnhoefe"]
    metrik: Literal["puenktlich", "median", "p90", "ausfallquote"]
    min_n: int
    von: str
    bis: str
    anzahl: int  # entries that meet min_n and have a value for the metric
    schlechteste: list[RanglistenEintrag]  # worst first, at most 10
    beste: list[RanglistenEintrag]  # best first, at most 10


class AbschnittLinie(BaseModel):
    id: str  # `linie` key
    label: str
    n: int  # trips of the line through the section
    # the line page's direction in which the section is a row of the route; None for a section off
    # the line's axis (a branch, a skipped stop): the page cannot select it
    richtung: Literal[1, 2] | None


class RanglistenAbschnitt(BaseModel):
    von_eva: str
    von_name: str
    nach_eva: str
    nach_name: str
    n: int  # trips over the section in the period, all lines
    minuten: float  # mean change of the delay over the section; negative: minutes made up
    linien_anzahl: int
    linien: list[AbschnittLinie]  # the three busiest, ties by id


class AbschnittsRangliste(BaseModel):
    min_n: int
    von: str
    bis: str
    anzahl: int  # sections that meet min_n
    schlechteste: list[RanglistenAbschnitt]  # most minutes lost first, at most 10
    beste: list[RanglistenAbschnitt]  # most minutes made up first, at most 10


class RekordEintrag(BaseModel):
    id: str  # EVA of a station, `linie` key of a line
    name: str  # station name or line label
    wert: float  # stops per day (halte) or trips per hour of service (takt), 2 decimals
    n: int  # stops it rests on, cancelled included: a station's all, a line's arrivals


class Rekorde(BaseModel):
    art: Literal["halte", "takt"]
    min_n: int
    von: str
    bis: str
    anzahl: int  # entries that meet min_n
    meiste: list[RekordEintrag]  # highest value first, at most 10
    wenigste: list[RekordEintrag]  # lowest value first, at most 10


class StationLinie(Stats):
    linie: str
    name: str  # line label
    typ: str


class LinienBahnhof(BaseModel):
    eva: str
    name: str
    lat: float | None
    lon: float | None
    pos: int | None  # first place on the line's axis, from 0; None off it (a branch)
    n: int  # 0 when the line has no stops there in the period: then all statistics are None
    ausfallquote: float | None
    median: float | None
    p90: float | None
    puenktlich: float | None


class Linie(BaseModel):
    linie: str
    name: str
    label: str
    typ: str
    zug: bool  # a single train number ("ICE 679"), not a line
    ohne_echtzeit: bool  # almost all stops at exactly 0 minutes: the line has no live data
    gesamt: Stats | None  # all the line's stations pooled for the period; None without stops
    achse: list[str]  # EVAs of the axis in order; a station may repeat (ring, reversal)
    bahnhoefe: list[LinienBahnhof]  # axis stations by first position, then the others by stops
    fahrplan_von: date | None  # first and last day of the line's trips; None without any
    fahrplan_bis: date | None


class Abschnitt(BaseModel):
    von_eva: str
    nach_eva: str
    n: int  # trips over the section in the period
    minuten: float  # mean change of the delay over the section; negative: minutes made up


class Halt(BaseModel):
    """Minutes since local midnight of the Fahrplan's day (beyond 1440 past midnight), None where
    the time is missing. `ist` is the change time, else the planned time; None when cancelled."""

    eva: str
    an_plan: int | None
    an_ist: int | None
    ab_plan: int | None
    ab_ist: int | None
    ausfall_an: bool
    ausfall_ab: bool


class Fahrt(BaseModel):
    zug: str  # "RE 10423"
    halte: list[Halt]  # in stop order


class Fahrplan(BaseModel):
    tag: str  # 'YYYY-MM-DD', the day the trips start
    fahrten: list[Fahrt]  # by the departure of their first stop


class Monat(BaseModel):
    monat: str  # 'YYYY-MM'
    n: int  # 0 when the selection has no stops in the month: then all statistics are None
    ausfallquote: float | None
    median: float | None
    p90: float | None
    puenktlich: float | None


class Zeitverlauf(BaseModel):
    titel: str | None  # station name or line label; None nationwide
    monate: list[Monat]  # every month of the data, ascending


class Trend(BaseModel):
    """Centred 28-day rolling median of the daily values; None with fewer than 14 values."""

    puenktlich: float | None
    ausfallquote: float | None
    median: float | None
    p90: float | None


class Tag(BaseModel):
    tag: str  # 'YYYY-MM-DD', the planned arrival day
    n: int  # 0 when the selection has no stops that day: then all statistics are None
    ausfallquote: float | None
    median: float | None
    p90: float | None
    puenktlich: float | None
    fehlende_stunden: int  # hours of the day with incomplete data
    trend: Trend


class Tagesverlauf(BaseModel):
    titel: str | None  # station name; None nationwide
    tage: list[Tag]  # every calendar day of the data, ascending


class Datenstand(BaseModel):
    monate: list[str]  # 'YYYY-MM'
    bahnhoefe: int  # named stations
    vollabdeckung_ab: str  # first month with at least half the stations of the largest month
    fehlende_stunden: dict[str, int]  # month -> hours with incomplete data; only months with gaps
    fahrplanwechsel: list[str]  # ISO dates of the timetable changes inside the data range
    erster_tag: str  # ISO dates of the first and last calendar day of the data
    letzter_tag: str
    fehlende_stunden_tage: dict[str, int]  # day -> hours with incomplete data; only days with gaps
    heute: str | None  # ISO day of today (live or rest data) after letzter_tag; None without
    heute_stand: str | None  # the collector's run time (large stations) for `heute`, ISO UTC
    heute_stand_rest: str | None  # the newest raw-data snapshot (the other stations), ISO UTC
    # ISO days the collector kept after letzter_tag and before today (Europe/Berlin), ascending:
    # /tageskarte serves them like complete days
    live_tage: list[str]


MAX_QUERIES = 4
_queries = threading.BoundedSemaphore(MAX_QUERIES)


def collect(lf: pl.LazyFrame) -> pl.DataFrame:
    """Run a query with at most MAX_QUERIES in flight, so dozens of routes in FastAPI's thread pool
    cannot run their queries at once and compete for CPU and memory. The only place a query is
    executed."""
    # ponytail: one cap per process; revisit with async routes or several replicas
    with _queries:
        return lf.collect()


def to_stats(s: CellStats) -> Stats:
    return Stats(
        n=s.n,
        ausfallquote=s.cancellation_rate,
        median=s.median,
        p90=s.p90,
        puenktlich=s.punctual_share,
    )


def cells_of(frame: pl.LazyFrame, keys: list[str]) -> list[tuple[tuple, CellStats]]:
    """The statistics of every key combination of a (keys, bucket, n) frame, in key order."""
    out = collect(cell_stats_frame(frame, keys).sort(keys))
    return [(row[: len(keys)], CellStats(*row[len(keys) :])) for row in out.iter_rows()]


def named_stations() -> pl.DataFrame:
    # a few EVAs have no name in the source
    return collect(pl.scan_parquet(STATIONS_PATH)).drop_nulls("name")


@lru_cache(maxsize=8)
def _frame(path: str, mtime: int, column: str | None) -> pl.DataFrame:
    """The parquet file at `path`, or the distinct values of one column of it. The mtime is part of
    the key, so a rewritten file is never served stale."""
    lf = pl.scan_parquet(path)
    return collect(lf.select(column).unique() if column else lf)


def frame(path: str, column: str | None = None) -> pl.DataFrame:
    """`_frame` of the file as it is now; FileNotFoundError when it is missing."""
    return _frame(path, os.stat(path).st_mtime_ns, column)


def monate() -> pl.DataFrame:
    """Per month: missing_hours and stations."""
    return frame(MONATE_PATH).sort("month")


def tage() -> pl.DataFrame:
    """Per calendar day: missing_hours."""
    return frame(TAGE_PATH).sort("day")


@dataclass(frozen=True)
class Heute:
    """One source of today: its day, its `stand` (UTC) and the local hour it is cut at."""

    day: date
    stand: datetime
    cut: int
    mtime: int  # of the file it was read from: part of the cache key of the day map
    # today's rows, read together with the fields above, so one version of the file is used
    rows: pl.DataFrame = field(compare=False, hash=False, repr=False)


def now() -> datetime:
    return datetime.now(UTC)


def _source(path: str) -> Heute | None:
    """The live or the rest file as a source of today; None when it is missing or empty."""
    try:
        mtime = os.stat(path).st_mtime_ns
    except FileNotFoundError:
        return None
    rows = _frame(path, mtime, None)
    if rows.is_empty():
        return None
    day, stand = rows.select(
        pl.col("day").first(),
        pl.col("stand").dt.replace_time_zone(None).first(),  # stand is UTC
    ).row(0)
    # whole seconds, so every browser parses the ISO string the API sends
    stand = stand.replace(tzinfo=UTC, microsecond=0)
    return Heute(day, stand, local_time(stand).hour, mtime, rows)


def today_sources() -> tuple[Heute | None, Heute | None]:
    """(live, rest): today's two sources, each None when it does not count. Today is the local
    date of now(), after the last complete day; the live file (the collector's, large stations)
    must also be under HEUTE_MAX_AGE old, the rest file (piebro's raw data) has no age limit.
    Both need day_hours.parquet for the reference days: without it there is no today."""
    if not os.path.exists(DAY_HOURS_PATH):
        return None, None
    last = tage()["day"][-1]
    t = now()
    # the file's day must be the local date now: just after midnight yesterday's file is still young
    local_now = local_time(t).date()

    def counts(h: Heute | None) -> Heute | None:
        return h if h and h.day == local_now and h.day > last else None

    live = _source(HEUTE_PATH)
    live = live if live and t - live.stand < HEUTE_MAX_AGE else None
    return counts(live), counts(_source(HEUTE_REST_PATH))


def live_tage() -> tuple[date, ...]:
    """The collector's finished days, ascending: those in LIVE_TAGE_PATH after the last complete
    day and before today (local date of now()). Empty without the file. A complete day always
    wins: its uploaded values are never replaced by the collector's."""
    try:
        kept = frame(LIVE_TAGE_PATH, "day")["day"]
    except FileNotFoundError:
        return ()
    last, today = tage()["day"][-1], local_time(now()).date()
    return tuple(sorted(d for d in kept if last < d < today))


def refresh() -> None:
    """Fetch the collector's files again when the blob changed (no-op without DATA_URL)."""
    fetch.refresh_live((HEUTE_PATH, LIVE_TAGE_PATH))


def coverage_start() -> str | None:
    df = monate()
    return full_coverage_start(dict(zip(df["month"], df["stations"], strict=True)))


def large() -> list[str]:
    """The EVAs of the large stations, sorted: those the source covered before full coverage, as
    pipeline.update wrote them to LARGE_PATH with the core rule."""
    return sorted(frame(LARGE_PATH)["eva"].to_list())


def period_start(von: str | None, bis: str | None) -> str | None:
    """The requested start, else the full-coverage start unless `bis` ends before it.
    ponytail: with only an early `bis` the default is off, so /karte labels its range from the
    file's first day (a day before `erster_tag`); only hand-made URLs reach it, clamp `von` to
    `erster_tag` if one ever matters."""
    if von:
        return von
    start = coverage_start()
    return start if start and (not bis or bis >= start) else None


def known_station(eva: str) -> Station:
    rows = named_stations().filter(pl.col("eva") == eva).iter_rows(named=True)
    found = next(rows, None)
    if found is None:
        raise HTTPException(status_code=404, detail="Unknown station")
    return Station(**found)


def selection(
    lf: pl.LazyFrame,
    gattung: str = "alle",
    eva: str | None = None,
    von: str | None = None,
    bis: str | None = None,
) -> pl.LazyFrame:
    """von/bis: months 'YYYY-MM' (inclusive). Stations are always filtered by EVA."""
    if gattung != "alle":
        lf = lf.filter(pl.col("gruppe") == gattung)
    if eva:
        lf = lf.filter(pl.col("eva") == eva)
    if von:
        lf = lf.filter(pl.col("month") >= von)
    if bis:
        lf = lf.filter(pl.col("month") <= bis)
    return lf


def span(lf: pl.LazyFrame, by: str = "month") -> tuple[str, str, int] | None:
    """(first, last, stops) of a selection by its month or day column, as ISO strings; None when
    it is empty."""
    row = collect(
        lf.select(
            von=pl.col(by).min().cast(pl.String),
            bis=pl.col(by).max().cast(pl.String),
            n=pl.col("n").sum(),
            rows=pl.len(),
        )
    )
    return (
        None if row["rows"].item() == 0 else (row["von"].item(), row["bis"].item(), row["n"].item())
    )


def heatmap_from(
    lf: pl.LazyFrame,
    gattung: str = "alle",
    eva: str | None = None,
    von: str | None = None,
    bis: str | None = None,
) -> Heatmap:
    sel = selection(lf, gattung, eva, von, bis)
    found = span(sel)
    if found is None:
        return Heatmap(von="", bis="", n=0, cells=[], tage=[])
    merged = collect(sel.group_by("weekday", "hour", "bucket").agg(n=pl.col("n").sum())).lazy()
    per_day = merged.group_by("weekday", "bucket").agg(n=pl.col("n").sum())
    return Heatmap(
        von=found[0],
        bis=found[1],
        n=found[2],
        cells=[
            Cell(weekday=w, hour=h, **to_stats(s).model_dump())
            for (w, h), s in cells_of(merged, ["weekday", "hour"])
        ],
        tage=[
            Day(weekday=w, **to_stats(s).model_dump()) for (w,), s in cells_of(per_day, ["weekday"])
        ],
    )


@app.get("/heatmap", response_model=Heatmap, operation_id="getHeatmap")
def heatmap(
    gattung: Gattung = "alle",
    eva: Annotated[str | None, Query(pattern=DIGITS)] = None,
    von: Month = None,
    bis: Month = None,
    linie: Annotated[str | None, Query(max_length=200)] = None,
) -> Heatmap:
    if eva and linie:
        raise HTTPException(status_code=422, detail="Give either eva or linie, not both")
    path = LINIEN_STUNDEN_PATH if linie else AGG_PATH
    label = known_line(linie)["label"] if linie else None
    found = heatmap_for(
        path, os.stat(path).st_mtime_ns, gattung, eva, period_start(von, bis), bis, linie
    )
    return found.model_copy(update={"titel": label})


# ponytail: per-process cache like karte_for; 16 entries hold the nationwide views and a few
# stations or lines, revisit when the station page's heatmap is used heavily
@lru_cache(maxsize=16)
def heatmap_for(
    agg: str,  # the aggregate, or with `linie` the per-line hours
    mtime: int,  # part of the key, so new data is never served stale
    gattung: str,
    eva: str | None,
    von: str | None,
    bis: str | None,
    linie: str | None = None,
) -> Heatmap:
    lf = pl.scan_parquet(agg)
    if linie:
        lf = lf.filter(pl.col("linie") == linie)
    return heatmap_from(lf, gattung, eva, von, bis)


@app.get("/karte", response_model=Karte, operation_id="getKarte")
def karte(gattung: Gattung = "alle", von: Period = None, bis: Period = None) -> Karte:
    """A month `von` means its first day, a month `bis` its last day."""
    von = period_start(von, bis)
    if von and len(von) == 7:
        von += "-01"
    if bis and len(bis) == 7:
        bis += f"-{calendar.monthrange(int(bis[:4]), int(bis[5:]))[1]:02d}"
    mtimes = (os.stat(DAYS_PATH).st_mtime_ns, os.stat(STATIONS_PATH).st_mtime_ns)
    return karte_for(DAYS_PATH, mtimes, gattung, von, bis)


# ponytail: per-process cache, so a day range is computed once per process; revisit when many
# different ranges are asked for (memory per entry and the first computation both grow)
@lru_cache(maxsize=16)
def karte_for(
    days: str,
    mtimes: tuple[int, int],  # part of the key, so new data is never served stale
    gattung: str,
    von: str | None,  # days 'YYYY-MM-DD', inclusive
    bis: str | None,
) -> Karte:
    sel = pl.scan_parquet(days)
    if gattung != "alle":
        sel = sel.filter(pl.col("gruppe") == gattung)
    if von:
        sel = sel.filter(pl.col("day") >= date.fromisoformat(von))
    if bis:
        sel = sel.filter(pl.col("day") <= date.fromisoformat(bis))
    found = span(sel, "day")
    if found is None:
        return Karte(von="", bis="", n=0, ohne_koordinaten=0, stationen=[])
    per_station = stats_per_eva(sel)
    unlocated, stations = located(per_station)
    return Karte(
        von=found[0],
        bis=found[1],
        n=found[2],
        ohne_koordinaten=unlocated,
        stationen=[
            KartenStation(**station_fields(stations[eva], s))
            for eva, s in per_station.items()  # sorted by EVA
            if eva in stations
        ],
    )


def located(evas: Iterable[str]) -> tuple[int, dict[str, dict]]:
    """For the named stations among `evas`: how many have no coordinates, and the rows of those
    that have, by EVA."""
    named = named_stations().filter(
        pl.col("eva").is_in(pl.Series(list(evas), dtype=pl.String).implode())
    )
    with_coords = named.drop_nulls("lat")
    return named.height - with_coords.height, {
        r["eva"]: r for r in with_coords.iter_rows(named=True)
    }


def station_fields(row: dict, s: CellStats) -> dict:
    """The fields of a KartenStation: a station row of `located` and its statistics."""
    return {
        "eva": row["eva"],
        "name": row["name"],
        "lat": row["lat"],
        "lon": row["lon"],
        **to_stats(s).model_dump(),
    }


def stats_per_eva(sel: pl.LazyFrame) -> dict[str, CellStats]:
    """Statistics per EVA of a selection, sorted by EVA."""
    per_station = sel.group_by("eva", "bucket").agg(n=pl.col("n").sum())
    return {eva: s for (eva,), s in cells_of(per_station, ["eva"])}


@lru_cache(maxsize=16)
def station_stats_for(
    agg: str, mtime: int, gattung: str, von: str | None, bis: str | None
) -> tuple[tuple[str, str, int] | None, dict[str, CellStats]]:
    """(span, statistics per EVA sorted by EVA), behind the station rankings."""
    sel = selection(pl.scan_parquet(agg), gattung, None, von, bis)
    found = span(sel)
    if found is None:
        return None, {}
    return found, stats_per_eva(sel)


@dataclass(frozen=True)
class Entry:
    """A ranked station or line."""

    id: str
    name: str
    typ: str | None
    stats: CellStats


def line_entries(sel: pl.LazyFrame, linien: str) -> list[Entry]:
    """Statistics per line of a lines selection."""
    per_line = (
        sel.group_by("linie", "bucket")
        .agg(n=pl.col("n").sum())
        .join(pl.scan_parquet(linien).select("linie", "label", "typ"), on="linie")
    )
    return [
        Entry(id=linie, name=label, typ=typ, stats=s)
        for (linie, label, typ), s in cells_of(per_line, ["linie", "label", "typ"])
    ]


@lru_cache(maxsize=16)
def line_stats_for(
    lines_path: str,
    linien: str,
    mtimes: tuple[int, int],
    gattung: str,
    von: str | None,
    bis: str | None,
    art: str,
) -> tuple[tuple[str, str, int] | None, list[Entry]]:
    """(span of the period, ranked lines): the lines (or the single trains, `art`) with live data;
    the span counts every line."""
    sel = selection(pl.scan_parquet(lines_path), gattung, None, von, bis)
    found = span(sel)
    if found is None:
        return None, []
    ranked = pl.scan_parquet(linien).filter(
        ~pl.col("ohne_echtzeit") & (pl.col("zug") == (art == "zuege"))
    )
    return found, line_entries(sel.join(ranked.select("linie"), on="linie", how="semi"), linien)


LOW_N = 15  # as in the heatmap and the UI: below it a value is not shown

METRICS: dict[str, Metric] = {
    "puenktlich": "punctual_share",
    "median": "median",
    "p90": "p90",
    "ausfallquote": "cancellation_rate",
}


MinN = Annotated[int, Query(ge=LOW_N)]


@app.get("/rankings", response_model=Rangliste, operation_id="getRankings")
def rankings(
    typ: Literal["linien", "bahnhoefe"],
    metrik: Literal["puenktlich", "median", "p90", "ausfallquote"] = "puenktlich",
    min_n: MinN = 500,
    gattung: Gattung = "alle",
    von: Month = None,
    bis: Month = None,
    art: Annotated[
        Literal["linien", "zuege"],
        Query(description="With typ=linien: lines or single trains; ignored for stations."),
    ] = "linien",
) -> Rangliste:
    von = period_start(von, bis)
    if typ == "bahnhoefe":
        found, per_station = station_stats_for(
            AGG_PATH, os.stat(AGG_PATH).st_mtime_ns, gattung, von, bis
        )
        entries = [
            Entry(id=eva, name=name, typ=None, stats=per_station[eva])
            for eva, name in named_stations().select("eva", "name").iter_rows()
            if eva in per_station
        ]
    else:
        mtimes = (os.stat(LINES_PATH).st_mtime_ns, os.stat(LINIEN_PATH).st_mtime_ns)
        found, entries = line_stats_for(LINES_PATH, LINIEN_PATH, mtimes, gattung, von, bis, art)
    worst, best = rank(entries, METRICS[metrik], min_n, k=len(entries))

    def show(e: Entry) -> RanglistenEintrag:
        return RanglistenEintrag(id=e.id, name=e.name, typ=e.typ, **to_stats(e.stats).model_dump())

    return Rangliste(
        typ=typ,
        metrik=metrik,
        min_n=min_n,
        von=found[0] if found else "",
        bis=found[1] if found else "",
        anzahl=len(worst),
        schlechteste=[show(e) for e in worst[:10]],
        beste=[show(e) for e in best[:10]],
    )


def files_of(*paths: str) -> tuple[tuple[str, int], ...]:
    """(path, mtime) of each file: the cache key of a result computed from them."""
    return tuple((p, os.stat(p).st_mtime_ns) for p in paths)


@lru_cache(maxsize=16)
def sections_for(
    files: tuple[tuple[str, int], ...],  # abschnitte, linien, lines, linienweg, stations
    gattung: str,
    von: str | None,
    bis: str | None,
    min_n: int,
) -> AbschnittsRangliste:
    """All lines' sections pooled by direction and ranked by the mean change of the delay."""
    abschnitte, linien, lines, weg, _ = (p for p, _ in files)
    sel = selection(pl.scan_parquet(abschnitte), "alle", None, von, bis)
    if gattung != "alle":
        members = collect(
            pl.scan_parquet(lines).filter(pl.col("gruppe") == gattung).select("linie").unique()
        )["linie"]
        sel = sel.filter(pl.col("linie").is_in(members.implode()))
    found = span(sel)
    if found is None:
        return AbschnittsRangliste(min_n=min_n, von="", bis="", anzahl=0, schlechteste=[], beste=[])
    # In-memory joins: Polars 2.0's streaming join panics on an empty side.
    live = collect(
        pl.scan_parquet(linien).filter(~pl.col("ohne_echtzeit")).select("linie", "label")
    )
    per_line = collect(
        sel.group_by("linie", "from_eva", "to_eva").agg(
            n=pl.col("n").sum().cast(pl.Int64), minutes=pl.col("minutes").sum()
        )
    ).join(live, on="linie")
    names = named_stations().select("eva", "name")
    pooled = (
        per_line.group_by("from_eva", "to_eva")
        .agg(n=pl.col("n").sum(), minutes=pl.col("minutes").sum(), linien_anzahl=pl.len())
        .filter(pl.col("n") >= min_n)
        .join(names.rename({"eva": "from_eva", "name": "von_name"}), on="from_eva")
        .join(names.rename({"eva": "to_eva", "name": "nach_name"}), on="to_eva")
        .with_columns(minuten=(pl.col("minutes") / pl.col("n")).round(2))
        .drop("minutes")
    )
    rows = list(pooled.iter_rows(named=True))
    worst = sorted(rows, key=lambda r: (-r["minuten"], -r["n"], r["von_name"], r["nach_name"]))
    best = sorted(rows, key=lambda r: (r["minuten"], -r["n"], r["von_name"], r["nach_name"]))
    shown = worst[:10] + best[:10]

    busiest: dict[tuple[str, str], list[tuple[str, str, int]]] = defaultdict(list)
    wanted = {(r["from_eva"], r["to_eva"]) for r in shown}
    for linie, a, b, n, label in (
        per_line.sort("n", "linie", descending=[True, False])
        .select("linie", "from_eva", "to_eva", "n", "label")
        .iter_rows()
    ):
        if (a, b) in wanted and len(busiest[a, b]) < 3:
            busiest[a, b].append((linie, label, n))

    # The line page's rule (frontend `cutLine`): richtung 1 reads the axis forwards, richtung 2
    # backwards; its rows are the pairs of consecutive named axis stations.
    top = {linie for lines_ in busiest.values() for linie, _, _ in lines_}
    walk = collect(
        pl.scan_parquet(weg)
        .filter(pl.col("linie").is_in(pl.Series(sorted(top), dtype=pl.String).implode()))
        .sort("linie", "pos")
        .select("linie", "eva")
    )
    named = set(names["eva"])
    forward: dict[str, set[tuple[str, str]]] = {}
    for linie, evas in walk.group_by("linie", maintain_order=True).agg("eva").iter_rows():
        axis = [e for e in evas if e in named]
        forward[linie] = set(zip(axis, axis[1:], strict=False))

    def richtung(linie: str, a: str, b: str) -> Literal[1, 2] | None:
        steps = forward.get(linie, set())
        return 1 if (a, b) in steps else 2 if (b, a) in steps else None

    def show(r: dict) -> RanglistenAbschnitt:
        a, b = r["from_eva"], r["to_eva"]
        return RanglistenAbschnitt(
            von_eva=a,
            von_name=r["von_name"],
            nach_eva=b,
            nach_name=r["nach_name"],
            n=r["n"],
            minuten=r["minuten"],
            linien_anzahl=r["linien_anzahl"],
            linien=[
                AbschnittLinie(id=linie, label=label, n=n, richtung=richtung(linie, a, b))
                for linie, label, n in busiest[a, b]
            ],
        )

    return AbschnittsRangliste(
        min_n=min_n,
        von=found[0],
        bis=found[1],
        anzahl=len(rows),
        schlechteste=[show(r) for r in worst[:10]],
        beste=[show(r) for r in best[:10]],
    )


@app.get(
    "/rankings/abschnitte",
    response_model=AbschnittsRangliste,
    operation_id="getRankingsAbschnitte",
)
def rankings_abschnitte(
    min_n: MinN = 500, gattung: Gattung = "alle", von: Month = None, bis: Month = None
) -> AbschnittsRangliste:
    files = files_of(ABSCHNITTE_PATH, LINIEN_PATH, LINES_PATH, LINIENWEG_PATH, STATIONS_PATH)
    return sections_for(files, gattung, period_start(von, bis), bis, min_n)


SERVICE_HOURS = 16  # the hours the trips of takt.parquet start in: 06:00 to 21:59


Record = tuple[float, str, str, int]  # (unrounded value, id, name, n): sorted before it is rounded


def days_of(months: list[str]) -> int:
    """The calendar days of the months 'YYYY-MM'."""
    return sum(calendar.monthrange(int(m[:4]), int(m[5:]))[1] for m in months)


def stops_per_day(
    files: tuple[tuple[str, int], ...], gattung: str, von: str | None, bis: str | None, min_n: int
) -> tuple[tuple[str, str, int] | None, list[Record]]:
    """(span, stations with their stops per calendar day of their own months in the period), over
    every stop (`halte.parquet`: the stops where a train starts included)."""
    sel = selection(pl.scan_parquet(files[0][0]), gattung, None, von, bis)
    found = span(sel)
    if found is None:
        return None, []
    per_eva = collect(
        sel.group_by("eva").agg(n=pl.col("n").sum().cast(pl.Int64), months=pl.col("month").unique())
    ).join(named_stations().select("eva", "name"), on="eva")
    return found, [
        (n / days_of(months), eva, name, n)
        for eva, n, months, name in per_eva.select("eva", "n", "months", "name").iter_rows()
        if n >= min_n
    ]


def trips_per_hour(
    files: tuple[tuple[str, int], ...], gattung: str, von: str | None, bis: str | None, min_n: int
) -> tuple[tuple[str, str, int] | None, list[Record]]:
    """(span, lines with their trips per hour of service over the days of the months they have
    stops in), over the lines that are no single train and have live data. A line without trips
    in the service hours is left out."""
    lines, linien, takt = (p for p, _ in files)
    sel = selection(pl.scan_parquet(lines), gattung, None, von, bis)
    found = span(sel)
    if found is None:
        return None, []
    stops = collect(
        sel.group_by("linie").agg(
            n=pl.col("n").sum().cast(pl.Int64), months=pl.col("month").unique()
        )
    )
    ranked = collect(
        pl.scan_parquet(linien)
        .filter(~pl.col("zug") & ~pl.col("ohne_echtzeit"))
        .select("linie", "label")
    )
    trips = collect(
        selection(pl.scan_parquet(takt), gattung, None, von, bis)
        .group_by("linie")
        .agg(trips=pl.col("trips").sum().cast(pl.Int64))
    )
    both = stops.join(ranked, on="linie").join(trips, on="linie")
    return found, [
        (count / (days_of(months) * SERVICE_HOURS), linie, label, n)
        for linie, n, months, label, count in both.select(
            "linie", "n", "months", "label", "trips"
        ).iter_rows()
        if n >= min_n
    ]


@lru_cache(maxsize=16)
def records_for(
    art: str,
    files: tuple[tuple[str, int], ...],  # halte: halte, stations; takt: lines, linien, takt
    gattung: str,
    von: str | None,
    bis: str | None,
    min_n: int,
) -> Rekorde:
    found, entries = (stops_per_day if art == "halte" else trips_per_hour)(
        files, gattung, von, bis, min_n
    )

    def show(rows: list[Record]) -> list[RekordEintrag]:
        return [
            RekordEintrag(id=i, name=name, wert=round(v, 2), n=n) for v, i, name, n in rows[:10]
        ]

    return Rekorde(
        art="halte" if art == "halte" else "takt",
        min_n=min_n,
        von=found[0] if found else "",
        bis=found[1] if found else "",
        anzahl=len(entries),
        meiste=show(sorted(entries, key=lambda e: (-e[0], -e[3], e[2]))),
        wenigste=show(sorted(entries, key=lambda e: (e[0], -e[3], e[2]))),
    )


@app.get("/rankings/rekorde", response_model=Rekorde, operation_id="getRankingsRekorde")
def rankings_rekorde(
    art: Literal["halte", "takt"],
    min_n: MinN = 500,
    gattung: Gattung = "alle",
    von: Month = None,
    bis: Month = None,
) -> Rekorde:
    files = (
        files_of(HALTE_PATH, STATIONS_PATH)
        if art == "halte"
        else files_of(LINES_PATH, LINIEN_PATH, TAKT_PATH)
    )
    return records_for(art, files, gattung, period_start(von, bis), bis, min_n)


@app.get("/stationen", response_model=list[Station], operation_id="getStationen")
def stationen(
    q: Annotated[str, Query(max_length=100)] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[Station]:
    return find_stations(q, limit)


def find_stations(q: str, limit: int) -> list[Station]:
    df = named_stations()
    lower = pl.col("name").str.to_lowercase()
    if q:
        df = df.filter(lower.str.contains(q.lower(), literal=True))
    df = df.sort(
        lower.str.starts_with(q.lower()), "n", "name", descending=[True, True, False]
    )  # prefix matches first, then the busiest station
    return [Station(**r) for r in df.head(limit).iter_rows(named=True)]


@lru_cache(maxsize=1)
def _search_lines(files: tuple[tuple[str, int], ...]) -> tuple[pl.DataFrame, frozenset[str]]:
    """Every line id as (linie, name, label, typ, zug, n, first, last) for the search: its stops
    over the whole data set and the names of its axis's end stations (null without an axis), and
    the normalised line names. `files` (path, mtime) of the four sources is the cache key."""
    # The three tables are collected first and joined in memory: Polars 2.0's streaming join
    # panics when a side is empty (a data set without axes).
    names = named_stations().select("eva", "name")
    axis = collect(
        pl.scan_parquet(LINIENWEG_PATH)
        .sort("linie", "pos")
        .group_by("linie", maintain_order=True)
        .agg(first=pl.col("eva").first(), last=pl.col("eva").last())
    )
    stops = collect(
        pl.scan_parquet(LINES_PATH).group_by("linie").agg(n=pl.col("n").sum().cast(pl.Int64))
    )
    linien = collect(pl.scan_parquet(LINIEN_PATH).select("linie", "name", "label", "typ", "zug"))
    lines = (
        linien.join(stops, on="linie", how="left")
        .join(axis, on="linie", how="left")
        .join(names.rename({"eva": "first", "name": "first_name"}), on="first", how="left")
        .join(names.rename({"eva": "last", "name": "last_name"}), on="last", how="left")
        .select(
            "linie",
            "name",
            "label",
            pl.col("typ").fill_null(""),
            "zug",
            pl.col("n").fill_null(0),
            first=pl.col("first_name"),
            last=pl.col("last_name"),
        )
    )
    return lines, frozenset(map(norm, lines["name"].unique()))


@app.get("/suche", response_model=Suche, operation_id="getSuche")
def suche(
    q: Annotated[str, Query(min_length=1, max_length=100)],
    limit: Annotated[int, Query(ge=1, le=20)] = 8,
) -> Suche:
    paths = (LINIEN_PATH, LINES_PATH, LINIENWEG_PATH, STATIONS_PATH)
    lines, names = _search_lines(tuple((p, os.stat(p).st_mtime_ns) for p in paths))
    hits, exact = line_hits(lines, names, q, limit)
    bahnhoefe = find_stations(q, limit)
    # Lines lead after an exact line name, unless a station starts with the query: the source
    # has line names like "Leer", "E" and "RE", which are also the start of station names.
    station_named = any(s.name.lower().startswith(q.lower()) for s in bahnhoefe)
    return Suche(
        bahnhoefe=bahnhoefe,
        linien=[SuchLinie(**r) for r in hits.iter_rows(named=True)],
        zuerst="linien" if hits.height and exact and not station_named else "bahnhoefe",
    )


@app.get("/stationen/{eva}", response_model=Station, operation_id="getStation")
def station(eva: Eva) -> Station:
    return known_station(eva)


@app.get("/stationen/{eva}/statistik", response_model=Statistik, operation_id="getStatistik")
def statistik(
    eva: Eva, gattung: Gattung = "alle", von: Month = None, bis: Month = None
) -> Statistik:
    st = known_station(eva)
    sel = selection(pl.scan_parquet(AGG_PATH), gattung, eva, period_start(von, bis), bis)
    found = span(sel)
    if found is None:
        return Statistik(
            station=st, von="", bis="", n=0, gesamt=None, verteilung=[], ausgefallen=0, gruppen=[]
        )
    per_group = collect(sel.group_by("gruppe", "bucket").agg(n=pl.col("n").sum()))
    merged = per_group.group_by("bucket").agg(n=pl.col("n").sum())
    bins = delay_bins(merged.iter_rows())
    every = merged.select(gruppe=pl.lit(ALLE), bucket="bucket", n="n")  # all trains as one group
    groups = {g: s for (g,), s in cells_of(pl.concat([per_group, every]).lazy(), ["gruppe"])}
    return Statistik(
        station=st,
        von=found[0],
        bis=found[1],
        n=found[2],
        gesamt=to_stats(groups[ALLE]),
        verteilung=list(bins.bins),
        ausgefallen=bins.cancelled,
        gruppen=[
            Gruppe(gruppe=g, **to_stats(groups[g]).model_dump()) for g in GRUPPEN if g in groups
        ],
    )


def thin(s: CellStats) -> bool:
    """True when the UI shows no value: fewer than LOW_N stops, or fewer arrived stops."""
    return s.n < LOW_N or (s.punctual_share is not None and counted(s, "median") < LOW_N)


@app.get(
    "/stationen/{eva}/linien", response_model=list[StationLinie], operation_id="getStationLinien"
)
def station_linien(
    eva: Eva, gattung: Gattung = "alle", von: Month = None, bis: Month = None
) -> list[StationLinie]:
    # ponytail: not cached, the biggest station takes about 0.1 s; add an lru_cache like the
    # rankings have if the page calls it often
    known_station(eva)
    sel = selection(pl.scan_parquet(LINES_PATH), gattung, eva, period_start(von, bis), bis)
    entries = sorted(
        line_entries(sel, LINIEN_PATH),
        key=lambda e: (
            thin(e.stats),  # lines the UI shows as "–" after the others
            e.stats.punctual_share is None,  # lines without a value last
            e.stats.punctual_share or 0.0,
            -e.stats.n,
            e.name,
        ),
    )
    return [
        StationLinie(linie=e.id, name=e.name, typ=e.typ or "", **to_stats(e.stats).model_dump())
        for e in entries
    ]


def known_line(linie: str) -> dict:
    """The row of `linien.parquet` (linie, name, label, typ, zug, ohne_echtzeit); 404 for an unknown
    line."""
    rows = collect(pl.scan_parquet(LINIEN_PATH).filter(pl.col("linie") == linie))
    if rows.is_empty():
        raise HTTPException(status_code=404, detail="Unknown line")
    return rows.row(0, named=True)


LineId = Annotated[str, Query(max_length=200)]


def line_sections(linie: str, von: str | None, bis: str | None) -> pl.DataFrame:
    """The sections of a line in the period summed over its months: from_eva, to_eva, n, minutes;
    only sections with trips, sorted."""
    sel = selection(
        pl.scan_parquet(ABSCHNITTE_PATH).filter(pl.col("linie") == linie), "alle", None, von, bis
    )
    return collect(
        sel.group_by("from_eva", "to_eva")
        .agg(n=pl.col("n").sum(), minutes=pl.col("minutes").sum())
        .filter(pl.col("n") > 0)
        .sort("from_eva", "to_eva")
    )


def fahrplan_fenster(linie: str) -> tuple[date | None, date | None]:
    """The first and last day of the line's trips in the trip table; (None, None) without any. The
    file is sorted by line, so the filter reads only that line's row groups."""
    if not os.path.exists(FAHRTEN_PATH):
        return None, None
    days = pl.scan_parquet(FAHRTEN_PATH).filter(pl.col("linie") == linie)
    return collect(days.select(pl.col("day").min(), bis=pl.col("day").max())).row(0)


@app.get("/linie", response_model=Linie, operation_id="getLinie")
def line_page(linie: LineId, von: Month = None, bis: Month = None) -> Linie:
    head = known_line(linie)
    start = period_start(von, bis)
    sel = selection(
        pl.scan_parquet(LINES_PATH).filter(pl.col("linie") == linie), "alle", None, start, bis
    )
    stats = stats_per_eva(sel)
    pooled = cells_of(
        sel.group_by("bucket").agg(n=pl.col("n").sum()).with_columns(linie=pl.lit(linie)), ["linie"]
    )
    walk = collect(
        pl.scan_parquet(LINIENWEG_PATH)
        .filter(pl.col("linie") == linie)
        .sort("pos")
        .select("eva", "pos")
    )
    achse = walk["eva"].to_list()  # a ring or a reversal visits a station twice
    axis = dict(reversed(list(walk.iter_rows())))  # so a station keeps its first place
    sections = line_sections(linie, start, bis)
    evas = {*axis, *stats, *sections["from_eva"], *sections["to_eva"]}
    named = named_stations().filter(
        pl.col("eva").is_in(pl.Series(sorted(evas), dtype=pl.String).implode())
    )  # a station without a name in the source is left out
    empty = {"n": 0, "ausfallquote": None, "median": None, "p90": None, "puenktlich": None}
    stations = [
        LinienBahnhof(
            eva=row["eva"],
            name=row["name"],
            lat=row["lat"],
            lon=row["lon"],
            pos=axis.get(row["eva"]),
            **(to_stats(stats[row["eva"]]).model_dump() if row["eva"] in stats else empty),
        )
        for row in named.iter_rows(named=True)
    ]
    stations.sort(key=lambda s: (s.pos is None, s.pos or 0, -s.n, s.name))
    von_tag, bis_tag = fahrplan_fenster(linie)
    return Linie(
        linie=head["linie"],
        name=head["name"],
        label=head["label"],
        typ=head["typ"] or "",
        zug=head["zug"],
        ohne_echtzeit=head["ohne_echtzeit"],
        gesamt=to_stats(pooled[0][1]) if pooled else None,
        achse=achse,
        bahnhoefe=stations,
        fahrplan_von=von_tag,
        fahrplan_bis=bis_tag,
    )


@app.get("/linie/abschnitte", response_model=list[Abschnitt], operation_id="getLinieAbschnitte")
def line_abschnitte(linie: LineId, von: Month = None, bis: Month = None) -> list[Abschnitt]:
    known_line(linie)
    return [
        Abschnitt(von_eva=a, nach_eva=b, n=n, minuten=round(minutes / n, 2))
        for a, b, n, minutes in line_sections(linie, period_start(von, bis), bis).iter_rows()
    ]


@app.get("/linie/fahrplan", response_model=Fahrplan, operation_id="getLinieFahrplan")
def line_fahrplan(linie: LineId, tag: date) -> Fahrplan:
    known_line(linie)
    von, bis = fahrplan_fenster(linie)
    if von is None or bis is None or not von <= tag <= bis:
        window = f"{von}..{bis}" if von and bis else "none"
        raise HTTPException(status_code=422, detail=f"No trips for that day; available: {window}")

    def event(kind: str, short: str) -> dict[str, pl.Expr]:
        """The table holds minutes since the trip day and the delay (null: on time)."""
        plan, delay = pl.col(f"{short}_plan").cast(pl.Int32), pl.col(f"{short}_delay")
        gone = pl.col(f"{kind}_is_canceled").fill_null(False)
        return {
            f"{short}_plan": plan,
            f"{short}_ist": pl.when(~gone).then(plan + delay.fill_null(0)),
            f"ausfall_{short}": gone,
        }

    rows = collect(
        pl.scan_parquet(FAHRTEN_PATH)
        .filter((pl.col("linie") == linie) & (pl.col("day") == tag))
        .sort("trip", "num")
        .select(
            "trip",
            "zug",
            "eva",
            **event("arrival", "an"),
            **event("departure", "ab"),
        )
    )
    trips: dict[str, Fahrt] = {}  # in trip order; the sort below is stable
    for row in rows.iter_rows(named=True):
        trips.setdefault(row["trip"], Fahrt(zug=row["zug"], halte=[])).halte.append(
            Halt(**{k: row[k] for k in Halt.model_fields})
        )

    def first_departure(fahrt: Fahrt) -> int:
        first = fahrt.halte[0]
        return first.ab_plan if first.ab_plan is not None else first.an_plan or 0

    return Fahrplan(tag=tag.isoformat(), fahrten=sorted(trips.values(), key=first_departure))


@app.get("/zeitverlauf", response_model=Zeitverlauf, operation_id="getZeitverlauf")
def zeitverlauf(
    eva: Annotated[str | None, Query(pattern=DIGITS)] = None,
    linie: Annotated[str | None, Query(max_length=200)] = None,
    gattung: Gattung = "alle",
) -> Zeitverlauf:
    if eva and linie:
        raise HTTPException(status_code=422, detail="Give either eva or linie, not both")
    titel = None
    if linie:
        titel = known_line(linie)["label"]
        lf = pl.scan_parquet(LINES_PATH).filter(pl.col("linie") == linie)
    else:
        lf = pl.scan_parquet(AGG_PATH)
        if eva:
            titel = known_station(eva).name
    grouped = selection(lf, gattung, eva).group_by("month", "bucket").agg(n=pl.col("n").sum())
    groups = {m: s for (m,), s in cells_of(grouped, ["month"])}
    return Zeitverlauf(
        titel=titel,
        monate=[
            Monat(monat=m, **to_stats(groups[m]).model_dump())
            if m in groups
            else Monat(monat=m, n=0, ausfallquote=None, median=None, p90=None, puenktlich=None)
            for m in monate()["month"]
        ],
    )


def shown(s: CellStats, metric: str) -> bool:
    """True when the UI shows the metric's value: for the cancellation rate the stop count decides,
    for the delay metrics `thin`.
    ponytail: the UI's `show()` (frontend/src/ui.tsx) is a second implementation of this rule and
    nothing checks that they agree; serve the flag in the API if one of them changes."""
    return s.n >= LOW_N if metric == "ausfallquote" else not thin(s)


TREND_DAYS = 28  # the trend window; it is centred, so it reaches TREND_DAYS // 2 days ahead
TREND_MIN = 14  # values the window needs
TREND_METRICS = ("puenktlich", "ausfallquote", "median", "p90")


def trends(feed: pl.DataFrame) -> pl.DataFrame:
    """Centred rolling median of each metric. `feed` has a `day` column and one Float64 column per
    metric, None where a day gives no value.
    ponytail: around the start of full coverage (2025-11) the nationwide window blends about 135
    stations with all of them for two weeks on each side; reset the window at `vollabdeckung_ab` if
    the step matters more than the marker that explains it."""
    ahead = TREND_DAYS // 2
    # Polars' rolling_*_by windows end at their row. The window ending `ahead` days later is the
    # one centred on the day, so the calendar runs past the last day and the result shifts back.
    calendar = pl.DataFrame(
        {"day": pl.date_range(feed["day"][0], feed["day"][-1] + timedelta(ahead), eager=True)}
    )
    # ponytail: at the end the window shrinks to the last 14 days and still needs TREND_MIN values,
    # so each gap or thin day there cuts a day off the trend's tail; allow half the minimum in the
    # windows past the last day if the tail should reach the newest day anyway.
    rolled = calendar.join(feed, on="day", how="left").select(
        "day",
        *(
            pl.col(m)
            .rolling_median_by("day", f"{TREND_DAYS}d", min_samples=TREND_MIN)
            .shift(-ahead)
            for m in TREND_METRICS
        ),
    )
    return feed.select("day").join(rolled, on="day", how="left")


# ponytail: per-process cache like karte_for; 16 entries hold the nationwide series and the busiest
# stations, revisit when the station page is used heavily (entry size = one model per day)
@lru_cache(maxsize=16)
def tage_for(
    days: str,
    tage_path: str,
    mtimes: tuple[int, int],  # part of the key, so new data is never served stale
    gattung: str,
    eva: str | None,
) -> list[Tag]:
    table = _frame(tage_path, mtimes[1], None).sort("day")
    grouped = (
        selection(pl.scan_parquet(days), gattung, eva)
        .group_by("day", "bucket")
        .agg(n=pl.col("n").sum())
    )
    cells = {d: s for (d,), s in cells_of(grouped, ["day"])}
    stats = {d: to_stats(c) for d, c in cells.items()}
    gap_hours = dict(zip(table["day"], table["missing_hours"], strict=True))

    # Only a value the UI shows feeds the trend: days with a gap in the data or too little data
    # show their values but are left out.
    def feeds(d: date, metric: str) -> bool:
        return d in cells and not gap_hours[d] and shown(cells[d], metric)

    feed = pl.DataFrame(
        {
            "day": table["day"],
            **{
                m: [getattr(stats[d], m) if feeds(d, m) else None for d in table["day"]]
                for m in TREND_METRICS
            },
        },
        schema={"day": pl.Date, **dict.fromkeys(TREND_METRICS, pl.Float64)},
    )
    trend = trends(feed).drop("day").iter_rows(named=True)
    return [
        Tag(
            tag=d.isoformat(),
            fehlende_stunden=gap_hours[d],
            trend=Trend(**t),
            **(
                stats[d].model_dump()
                if d in stats
                else {"n": 0, "ausfallquote": None, "median": None, "p90": None, "puenktlich": None}
            ),
        )
        for d, t in zip(table["day"], trend, strict=True)
    ]


@app.get("/tagesverlauf", response_model=Tagesverlauf, operation_id="getTagesverlauf")
def tagesverlauf(
    eva: Annotated[str | None, Query(pattern=DIGITS)] = None, gattung: Gattung = "alle"
) -> Tagesverlauf:
    titel = known_station(eva).name if eva else None
    mtimes = (os.stat(DAYS_PATH).st_mtime_ns, os.stat(TAGE_PATH).st_mtime_ns)
    return Tagesverlauf(titel=titel, tage=tage_for(DAYS_PATH, TAGE_PATH, mtimes, gattung, eva))


@app.get("/tageskarte", response_model=Tageskarte, operation_id="getTageskarte")
def tageskarte(
    tag: Annotated[str, Query(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")],
) -> Tageskarte:
    """The day against its normal at the large stations (all trains), Germany per category too."""
    try:
        day = date.fromisoformat(tag)
    except ValueError:
        raise HTTPException(status_code=422, detail="Not a calendar day") from None
    refresh()
    days = tage()["day"]
    live, rest = today_sources()
    extra = live_tage()
    is_today = any(s and s.day == day for s in (live, rest))
    if not is_today and not (days[0] <= day <= days[-1] or day in extra):
        raise HTTPException(status_code=404, detail="No data for that day")
    paths = (DAYS_PATH, TAGE_PATH, STATIONS_PATH, MONATE_PATH)
    # The live files only key today's entry (`live` and `rest` carry the mtimes of their files) and
    # the collector days, so past days stay cached while the collector runs.
    if is_today:
        paths += (DAY_HOURS_PATH,)
    if extra and (is_today or day in extra):
        paths += (LIVE_TAGE_PATH,)
    mtimes = tuple(os.stat(p).st_mtime_ns for p in paths)
    path = DAY_HOURS_PATH if is_today else DAYS_PATH
    sources = (live, rest) if is_today else (None, None)
    return tageskarte_for(path, mtimes, day, *sources)


def counting(cells: Iterable[CellStats], m: str) -> list[float | None]:
    """Metric `m` of the cells whose value the UI shows."""
    return [getattr(c, METRICS[m]) for c in cells if shown(c, m)]


def references_of(cells: Iterable[CellStats]) -> dict[str, list[float | None]]:
    """The values the UI shows in the reference cells, per metric: counted once, used for the
    normal and the class."""
    cells = list(cells)
    return {m: counting(cells, m) for m in METRICS}


def normal_of(references: dict[str, list[float | None]]) -> Normal:
    return Normal(**{m: normal(references[m]) for m in METRICS})


def klasse_of(day: CellStats, references: dict[str, list[float | None]]) -> Klasse:
    return Klasse(
        **{
            m: deviation_class(
                getattr(day, a) if shown(day, m) else None,
                references[m],
                higher_is_better(a),
                FLOORS[a],
            )
            for m, a in METRICS.items()
        }
    )


NO_STOPS = CellStats(n=0, cancellation_rate=0.0, median=None, p90=None, punctual_share=None)
ALLE = "alle"  # the group of all trains next to REGIONAL and FERN
DE = "de"  # the area of the whole country next to the states' codes
CELL = ("day", "eva", "gruppe", "bucket")  # what the day map's counts are grouped by


# ponytail: per-process cache like karte_for, one model per large station (about 0.35 MB of Python
# objects per entry), 16 entries so the seven day chips stay warm. Measured on Windows with one
# Polars thread and days.parquet in row groups of 50,000 rows: a cold day takes 0.04 to 0.16 s,
# today 0.11 s; 20 distinct days settle at a working set of about 310 MB (172 MB when idle).
# Revisit if the large set grows to the whole network (about 10 MB and 2.4 s per entry then).
@lru_cache(maxsize=16)
def tageskarte_for(
    days_path: str,  # days.parquet; for today (live or rest) day_hours.parquet
    mtimes: tuple[int, ...],  # days, tage, stations, monate (+ day hours): no stale data
    day: date,
    # Set for today, whose cells come from these files, each station from the live one if it is
    # in there, else from the rest one; its reference days are cut at that source's hour.
    live: Heute | None = None,
    rest: Heute | None = None,
) -> Tageskarte:
    table = tage()
    # ponytail: collector days have no gap hours (they are not in the day table), so the 12-hour
    # rule between runs is their only check and a quiet hour of the source shows as no gap; judge
    # their hours like the raw days' if a gap ever slips through.
    extra = live_tage()
    gap_hours = dict(zip(table["day"], table["missing_hours"], strict=True))
    # The large stations are covered over the whole history: no clamp at full coverage
    last = table["day"][-1]
    gaps = {d for d, h in gap_hours.items() if h}
    # A day after the last complete one counts only if the collector kept it.
    refs = [
        d
        for d in reference_days(day, table["day"][0], max([last, *extra]), gaps)
        if d <= last or d in extra
    ]
    wanted = [day, *refs]
    is_today = bool(live or rest)
    large_evas = set(large())
    live_evas = set(live.rows["eva"]) & large_evas if live else set()
    rest_evas = (set(rest.rows["eva"]) & large_evas) - live_evas if rest else set()

    def in_(evas: set[str]) -> pl.Expr:
        return pl.col("eva").is_in(pl.Series(sorted(evas), dtype=pl.String).implode())

    sel = pl.scan_parquet(days_path).filter(in_(large_evas))
    if collected := [d for d in wanted if d in extra]:
        # The collector's hours; summed over the hour unless the day map's today needs them. Days
        # up to the last complete day are never in `extra`, so they never read this file.
        more = pl.scan_parquet(LIVE_TAGE_PATH).filter(
            in_(large_evas), pl.col("day").is_in(pl.Series(collected, dtype=pl.Date).implode())
        )
        if not is_today:
            more = more.group_by(*CELL).agg(n=pl.col("n").sum())
        sel = pl.concat([sel, more.select(sel.collect_schema().names())], how="vertical_relaxed")
    if is_today:
        keep = pl.lit(False)  # every station's reference days end where its own source ends
        for source, evas in ((live, live_evas), (rest, rest_evas)):
            if source:
                keep |= in_(evas) & (pl.col("hour") < source.cut)
        sel = sel.filter(keep)
    # the between filter lets Polars skip row groups
    grouped = collect(
        sel.filter(pl.col("day").is_between(min(wanted), max(wanted)))
        .filter(
            pl.col("day").is_in(pl.Series(refs if is_today else wanted, dtype=pl.Date).implode())
        )
        .group_by(*CELL)
        .agg(n=pl.col("n").sum())
    )
    nation_src = grouped
    card_live = False
    if is_today:
        grouped = pl.concat(
            [
                grouped,
                *(
                    collect(
                        source.rows.lazy()
                        .filter(in_(evas))
                        .group_by(*CELL)
                        .agg(n=pl.col("n").sum())
                    )
                    for source, evas in ((live, live_evas), (rest, rest_evas))
                    if source
                ),
            ]
        )
        # Germany: the live stations that report today, else the rest stations, against
        # themselves on the reference days; decided once on all trains for all three lines
        today_cells = grouped.filter(pl.col("day") == day)
        reporting = today_cells.filter(in_(live_evas))["eva"].unique()
        card_live = not reporting.is_empty()
        if not card_live:
            reporting = today_cells.filter(in_(rest_evas))["eva"].unique()
        nation_src = grouped.filter(pl.col("eva").is_in(reporting.implode()))
    elif day in extra:
        # A collector day keeps only the stations that finished it: Germany and the states count
        # those, against the same stations on the reference days.
        kept = grouped.filter(pl.col("day") == day)["eva"].unique()
        nation_src = grouped.filter(pl.col("eva").is_in(kept.implode()))
    # Germany ("de") and each state: per gruppe, and all trains as one more group
    named = nation_src.join(
        named_stations().select(
            # a table without any state reads the column as all-null, not as strings
            "eva",
            "name",
            pl.col("land").cast(pl.String).replace_strict(LAND_CODES, default=None),
        ),
        on="eva",
        how="left",
    )
    areas = pl.concat(
        [
            named.lazy().with_columns(area=pl.lit(DE)),
            named.lazy().filter(pl.col("land").is_not_null()).with_columns(area=pl.col("land")),
        ]
    )
    per_gruppe = areas.group_by("day", "area", "gruppe", "bucket").agg(n=pl.col("n").sum())
    every = (
        per_gruppe.group_by("day", "area", "bucket")
        .agg(n=pl.col("n").sum())
        .select("day", "area", pl.lit(ALLE).alias("gruppe"), "bucket", "n")
    )
    nation = dict(cells_of(pl.concat([per_gruppe, every]), ["day", "area", "gruppe"]))
    head = {
        "tag": day.isoformat(),
        "referenztage": [d.isoformat() for d in refs],
        "fehlende_stunden": gap_hours.get(day, 0),  # today is not in the day table
        "stand": live.stand.isoformat() if live else None,
        "bis_stunde": live.cut if live else None,
        # the rest file counts only where it feeds a station: the collector may cover them all
        "stand_rest": rest.stand.isoformat() if rest and rest_evas else None,
        "bis_stunde_rest": rest.cut if rest and rest_evas else None,
        "deutschland_live": card_live if is_today else None,
    }
    if (day, DE, ALLE) not in nation:
        return Tageskarte(
            **head,
            deutschland=None,
            deutschland_fern=None,
            deutschland_regional=None,
            laender=[],
            n=0,
            ohne_koordinaten=0,
            stationen=[],
        )

    def area(code: str, gruppe: str) -> Deutschland | None:
        if (day, code, gruppe) not in nation:
            return None
        cell = nation[day, code, gruppe]
        references = references_of(
            nation[d, code, gruppe] for d in refs if (d, code, gruppe) in nation
        )
        return Deutschland(
            **to_stats(cell).model_dump(),
            normal=normal_of(references),
            # a day with missing hours is not classed: the gap, not the railway, may be the reason
            klasse=Klasse(**dict.fromkeys(METRICS))
            if gap_hours.get(day)
            else klasse_of(cell, references),
        )

    # stations per state: names, so Berlin's split EVAs count once
    names = named.filter(pl.col("day") == day, pl.col("land").is_not_null())
    counts = dict(names.select("land", "name").unique().group_by("land").len().iter_rows())
    laender = [
        Land(
            land=code,
            bahnhoefe=counts[code],
            alle=alle,
            fern=area(code, FERN),
            regional=area(code, REGIONAL),
        )
        for code in sorted(counts)
        if (alle := area(code, ALLE))
    ]
    today: dict[str, CellStats] = {}
    earlier: defaultdict[str, list[CellStats]] = defaultdict(list)
    per_station = grouped.lazy().group_by("day", "eva", "bucket").agg(n=pl.col("n").sum())
    for (d, eva), cell in cells_of(per_station, ["day", "eva"]):
        if d == day:
            today[eva] = cell
        else:
            earlier[eva].append(cell)
    unlocated, stations = located(today)
    if is_today:
        # Large stations no source covers yet are drawn grey, as n = 0.
        stations = located(large_evas)[1]
    return Tageskarte(
        **head,
        deutschland=area(DE, ALLE),
        deutschland_fern=area(DE, FERN),
        deutschland_regional=area(DE, REGIONAL),
        laender=laender,
        n=nation[day, DE, ALLE].n,
        ohne_koordinaten=unlocated,
        stationen=[
            TageskartenStation(
                **station_fields(stations[eva], s),
                land=LAND_CODES.get(stations[eva]["land"]),
                normal=normal_of(references),
                klasse=klasse_of(s, references),
                live=eva in live_evas,
            )
            for eva in sorted(stations if is_today else today)
            if eva in stations
            for s in [today.get(eva, NO_STOPS)]
            for references in [references_of(earlier[eva] if eva in today else [])]
        ],
    )


@app.get("/datenstand", response_model=Datenstand, operation_id="getDatenstand")
def datenstand() -> Datenstand:
    refresh()
    df = monate()
    days = tage()
    first, last = df["month"][0], df["month"][-1]
    last_year, last_month = int(last[:4]), int(last[5:])
    live, rest = today_sources()
    today = live or rest
    return Datenstand(
        monate=df["month"].to_list(),
        bahnhoefe=named_stations().height,
        vollabdeckung_ab=coverage_start() or "",
        fehlende_stunden={
            m: h for m, h in zip(df["month"], df["missing_hours"], strict=True) if h > 0
        },
        fahrplanwechsel=[
            d.isoformat()
            for d in timetable_changes(
                date.fromisoformat(f"{first}-01"),
                date(last_year, last_month, calendar.monthrange(last_year, last_month)[1]),
            )
        ],
        erster_tag=days["day"][0].isoformat(),
        letzter_tag=days["day"][-1].isoformat(),
        fehlende_stunden_tage={
            d.isoformat(): h
            for d, h in zip(days["day"], days["missing_hours"], strict=True)
            if h > 0
        },
        heute=today.day.isoformat() if today else None,
        heute_stand=live.stand.isoformat() if live else None,
        heute_stand_rest=rest.stand.isoformat() if rest else None,
        live_tage=[d.isoformat() for d in live_tage()],
    )


def _quiet() -> None:
    """Wait until no request is in flight and none ended in the last QUIET seconds, so a visitor's
    next request (Live-Lage's day after /datenstand, the next click) goes first."""
    while _busy or time.monotonic() - _last_end < QUIET:
        time.sleep(min(0.25, QUIET / 4))


def warm_up() -> None:
    """Run each cached page's default query once, one after another, each after a quiet moment, so
    the caches are warm by the time a visitor after a wake-up clicks on: the Karte, Live-Lage's
    newest day, the Muster heatmap, the station rankings and the daily Zeitverlauf. The arguments
    are the ones the web app sends without URL keys, so they hit the same cache keys. A failure is
    logged and the next page warms anyway.
    ponytail: a visitor's request for a page still warming computes it again in parallel (the caches
    do not merge requests in flight); share a future per cache key if that shows in the log."""
    began = time.perf_counter()

    def newest_day() -> str:  # as the web app's lageDays
        d = datenstand()
        return d.heute or (d.live_tage[-1] if d.live_tage else d.letzter_tag)

    pages = (
        ("karte", lambda: karte()),
        ("tageskarte", lambda: tageskarte(tag=newest_day())),
        ("heatmap", lambda: heatmap()),
        ("rankings", lambda: rankings(typ="bahnhoefe")),
        ("tagesverlauf", lambda: tagesverlauf()),
    )
    for name, page in pages:
        _quiet()
        try:
            page()
        except Exception as e:  # a warm-up must never take the process down
            log.info("warm-up failed: %s: %s", name, e)
    log.info("warm-up done in %dms", (time.perf_counter() - began) * 1000)
