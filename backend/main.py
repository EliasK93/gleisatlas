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
from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache
from typing import Annotated, Literal

import polars as pl
from fastapi import FastAPI, HTTPException, Path, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field

from core.categories import FERN, REGIONAL
from core.normal import FLOORS, deviation_class, normal, reference_days, weather
from core.periods import full_coverage_start, timetable_changes
from core.rankings import Metric, counted, higher_is_better, rank
from core.stats import CellStats, cell_stats, cell_stats_frame, delay_bins

AGG_PATH = os.environ.get("AGGREGATE_PATH", "data/aggregate.parquet")
STATIONS_PATH = os.environ.get("STATIONS_PATH", "data/stations.parquet")
MONATE_PATH = os.environ.get("MONATE_PATH", "data/monate.parquet")
LINES_PATH = os.environ.get("LINES_PATH", "data/lines.parquet")
LINIEN_PATH = os.environ.get("LINIEN_PATH", "data/linien.parquet")
DAYS_PATH = os.environ.get("DAYS_PATH", "data/days.parquet")
TAGE_PATH = os.environ.get("TAGE_PATH", "data/tage.parquet")
DATA_FILES = (  # see backend/fetch.py
    AGG_PATH,
    STATIONS_PATH,
    MONATE_PATH,
    LINES_PATH,
    LINIEN_PATH,
    DAYS_PATH,
    TAGE_PATH,
)

# Our own lines go to stdout: uvicorn configures only its own loggers, and its access log is off.
log = logging.getLogger("gleisatlas")
log.setLevel(logging.INFO)
# LOG_FILE (local runs) adds a timestamped copy; Azure leaves it unset and stamps stdout itself.
for old in log.handlers[:]:  # a reload (tests) must not double the lines
    log.removeHandler(old)
    old.close()
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


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """One line at the start and one at the end, with the same id and no client data. A start
    line without an end line is a request that never finished."""
    rid = uuid.uuid4().hex[:8]
    query = f"?{request.url.query}" if request.url.query else ""
    log.info("start %s %s %s%s", rid, request.method, request.url.path, query)
    began = time.perf_counter()
    status = 500  # what the client sees when the handler raises
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        log.info("end %s %d %dms", rid, status, (time.perf_counter() - began) * 1000)


DIGITS = r"^[0-9]+$"  # ASCII only: \d would also accept other scripts' digits
Eva = Annotated[str, Path(pattern=DIGITS)]
Month = Annotated[str | None, Query(pattern=r"^[0-9]{4}-(0[1-9]|1[0-2])$")]
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


class Station(BaseModel):
    eva: str
    name: str
    land: str | None  # federal state; not known for every station
    n: int  # stops over the whole data set, all categories


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


class Wetter(BaseModel):
    """Rank of the day among the reference days: 1 (much better than usual) to 5 (much worse);
    None where the day or the references give no value."""

    puenktlich: int | None
    ausfallquote: int | None
    median: int | None
    p90: int | None


class Klasse(BaseModel):
    """How far a station's day is from its normal, in the usual variation of its reference days:
    1 (much better), 2, 3 (as usual), 4, 5 (much worse). None without a shown value or a normal."""

    puenktlich: int | None
    ausfallquote: int | None
    median: int | None
    p90: int | None


class TageskartenStation(KartenStation):
    normal: Normal
    klasse: Klasse


class Deutschland(Stats):
    normal: Normal
    wetter: Wetter


class Tageskarte(BaseModel):
    tag: str  # 'YYYY-MM-DD', the planned arrival day
    referenztage: list[str]  # the days the normal rests on, nearest first
    fehlende_stunden: int  # hours of the day with incomplete data
    deutschland: Deutschland | None  # None when the selection has no stops that day
    n: int  # all stops of the day, also at stations that are not listed
    ohne_koordinaten: int  # named stations with stops that day but no coordinates
    stationen: list[TageskartenStation]


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


class StationLinie(Stats):
    linie: str
    name: str  # line label
    typ: str


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


def cell_stats_of(group: pl.DataFrame) -> CellStats:
    # column lists: ~5x faster than iter_rows over the ~5k small groups of /karte
    return cell_stats(zip(group["bucket"].to_list(), group["n"].to_list(), strict=True))


def stats_of(group: pl.DataFrame) -> Stats:
    return to_stats(cell_stats_of(group))


def named_stations() -> pl.DataFrame:
    # a few EVAs have no name in the source
    return collect(pl.scan_parquet(STATIONS_PATH)).drop_nulls("name")


@lru_cache(maxsize=1)
def _monate_for(path: str, mtime: int) -> pl.DataFrame:  # mtime is part of the key: never stale
    return collect(pl.scan_parquet(path)).sort("month")


def monate() -> pl.DataFrame:
    """Per month: missing_hours and stations."""
    return _monate_for(MONATE_PATH, os.stat(MONATE_PATH).st_mtime_ns)


@lru_cache(maxsize=1)
def _tage_for(path: str, mtime: int) -> pl.DataFrame:  # mtime is part of the key: never stale
    return collect(pl.scan_parquet(path)).sort("day")


def tage() -> pl.DataFrame:
    """Per calendar day: missing_hours."""
    return _tage_for(TAGE_PATH, os.stat(TAGE_PATH).st_mtime_ns)


def coverage_start() -> str | None:
    df = monate()
    return full_coverage_start(dict(zip(df["month"], df["stations"], strict=True)))


def period_start(von: str | None, bis: str | None) -> str | None:
    """The requested start, else the full-coverage start unless `bis` ends before it."""
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


def span(lf: pl.LazyFrame) -> tuple[str, str, int] | None:
    """(first month, last month, stops) of a selection; None when it is empty."""
    row = collect(
        lf.select(
            von=pl.col("month").min(), bis=pl.col("month").max(), n=pl.col("n").sum(), rows=pl.len()
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
    merged = collect(
        sel.group_by("weekday", "hour", "bucket")
        .agg(n=pl.col("n").sum())
        .sort("weekday", "hour")  # group_by order is arbitrary; keep cells stable
    )
    per_day = merged.group_by("weekday", "bucket").agg(n=pl.col("n").sum()).sort("weekday")
    # partition keys are typed as object; they are the integer weekday and hour
    return Heatmap(
        von=found[0],
        bis=found[1],
        n=found[2],
        cells=[
            Cell(weekday=int(w), hour=int(h), **stats_of(g).model_dump())  # pyright: ignore[reportArgumentType]
            for (w, h), g in merged.partition_by("weekday", "hour", as_dict=True).items()
        ],
        tage=[
            Day(weekday=int(w), **stats_of(g).model_dump())  # pyright: ignore[reportArgumentType]
            for (w,), g in per_day.partition_by("weekday", as_dict=True).items()
        ],
    )


@app.get("/heatmap", response_model=Heatmap, operation_id="getHeatmap")
def heatmap(
    gattung: Gattung = "alle",
    eva: Annotated[str | None, Query(pattern=DIGITS)] = None,
    von: Month = None,
    bis: Month = None,
) -> Heatmap:
    return heatmap_from(pl.scan_parquet(AGG_PATH), gattung, eva, period_start(von, bis), bis)


@app.get("/karte", response_model=Karte, operation_id="getKarte")
def karte(gattung: Gattung = "alle", von: Month = None, bis: Month = None) -> Karte:
    mtimes = (os.stat(AGG_PATH).st_mtime_ns, os.stat(STATIONS_PATH).st_mtime_ns)
    return karte_for(AGG_PATH, mtimes, gattung, period_start(von, bis), bis)


# ponytail: per-process cache, so a month combination is computed once per process; revisit when the
# aggregate grows to many months (memory per entry and the first computation both grow)
@lru_cache(maxsize=16)
def karte_for(
    agg: str,
    mtimes: tuple[int, int],  # part of the key, so new data is never served stale
    gattung: str,
    von: str | None,
    bis: str | None,
) -> Karte:
    found, per_station = station_stats_for(agg, mtimes[0], gattung, von, bis)
    if found is None:
        return Karte(von="", bis="", n=0, ohne_koordinaten=0, stationen=[])
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
    named = named_stations().filter(pl.col("eva").is_in(pl.Series(list(evas)).implode()))
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


@lru_cache(maxsize=16)
def station_stats_for(
    agg: str, mtime: int, gattung: str, von: str | None, bis: str | None
) -> tuple[tuple[str, str, int] | None, dict[str, CellStats]]:
    """(span, statistics per EVA sorted by EVA), shared by /karte and the station rankings."""
    sel = selection(pl.scan_parquet(agg), gattung, None, von, bis)
    found = span(sel)
    if found is None:
        return None, {}
    per_station = collect(sel.group_by("eva", "bucket").agg(n=pl.col("n").sum()))
    parts = sorted(per_station.partition_by("eva", as_dict=True).items())  # pyright: ignore[reportArgumentType]
    return found, {eva: cell_stats_of(g) for (eva,), g in parts}


@dataclass(frozen=True)
class Entry:
    """A ranked station or line."""

    id: str
    name: str
    typ: str | None
    stats: CellStats


def line_entries(sel: pl.LazyFrame, linien: str) -> list[Entry]:
    """Statistics per line of a lines selection."""
    per_line = collect(
        sel.group_by("linie", "bucket")
        .agg(n=pl.col("n").sum())
        .join(pl.scan_parquet(linien), on="linie")
    )
    return [
        Entry(id=linie, name=g["label"][0], typ=g["typ"][0], stats=cell_stats_of(g))
        for (linie,), g in per_line.partition_by("linie", as_dict=True).items()  # pyright: ignore[reportArgumentType]
    ]


@lru_cache(maxsize=16)
def line_stats_for(
    lines_path: str,
    linien: str,
    mtimes: tuple[int, int],
    gattung: str,
    von: str | None,
    bis: str | None,
) -> tuple[tuple[str, str, int] | None, list[Entry]]:
    sel = selection(pl.scan_parquet(lines_path), gattung, None, von, bis)
    found = span(sel)
    return found, [] if found is None else line_entries(sel, linien)


LOW_N = 15  # as in the heatmap and the UI: below it a value is not shown

METRICS: dict[str, Metric] = {
    "puenktlich": "punctual_share",
    "median": "median",
    "p90": "p90",
    "ausfallquote": "cancellation_rate",
}


@app.get("/rankings", response_model=Rangliste, operation_id="getRankings")
def rankings(
    typ: Literal["linien", "bahnhoefe"],
    metrik: Literal["puenktlich", "median", "p90", "ausfallquote"] = "puenktlich",
    min_n: Annotated[int, Query(ge=LOW_N)] = 500,
    gattung: Gattung = "alle",
    von: Month = None,
    bis: Month = None,
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
        found, entries = line_stats_for(LINES_PATH, LINIEN_PATH, mtimes, gattung, von, bis)
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


@app.get("/stationen", response_model=list[Station], operation_id="getStationen")
def stationen(q: str = "", limit: Annotated[int, Query(ge=1, le=100)] = 20) -> list[Station]:
    df = named_stations()
    lower = pl.col("name").str.to_lowercase()
    if q:
        df = df.filter(lower.str.contains(q.lower(), literal=True))
    df = df.sort(
        lower.str.starts_with(q.lower()), "n", "name", descending=[True, True, False]
    )  # prefix matches first, then the busiest station
    return [Station(**r) for r in df.head(limit).iter_rows(named=True)]


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
    groups = dict(per_group.partition_by("gruppe", as_dict=True))  # pyright: ignore[reportArgumentType]
    return Statistik(
        station=st,
        von=found[0],
        bis=found[1],
        n=found[2],
        gesamt=stats_of(merged),
        verteilung=list(bins.bins),
        ausgefallen=bins.cancelled,
        gruppen=[
            Gruppe(gruppe=g, **stats_of(groups[(g,)]).model_dump())  # pyright: ignore[reportArgumentType]
            for g in GRUPPEN
            if (g,) in groups
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


@app.get("/zeitverlauf", response_model=Zeitverlauf, operation_id="getZeitverlauf")
def zeitverlauf(
    eva: Annotated[str | None, Query(pattern=DIGITS)] = None,
    linie: str | None = None,
    gattung: Gattung = "alle",
) -> Zeitverlauf:
    if eva and linie:
        raise HTTPException(status_code=422, detail="Give either eva or linie, not both")
    titel = None
    if linie:
        labels = collect(pl.scan_parquet(LINIEN_PATH).filter(pl.col("linie") == linie))["label"]
        if labels.is_empty():
            raise HTTPException(status_code=404, detail="Unknown line")
        titel = labels[0]
        lf = pl.scan_parquet(LINES_PATH).filter(pl.col("linie") == linie)
    else:
        lf = pl.scan_parquet(AGG_PATH)
        if eva:
            titel = known_station(eva).name
    grouped = collect(
        selection(lf, gattung, eva).group_by("month", "bucket").agg(n=pl.col("n").sum())
    )
    groups = {m: g for (m,), g in grouped.partition_by("month", as_dict=True).items()}  # pyright: ignore[reportArgumentType]
    return Zeitverlauf(
        titel=titel,
        monate=[
            Monat(monat=m, **stats_of(groups[m]).model_dump())
            if m in groups
            else Monat(monat=m, n=0, ausfallquote=None, median=None, p90=None, puenktlich=None)
            for m in monate()["month"]
        ],
    )


def shown(s: CellStats, metric: str) -> bool:
    """True when the UI shows the metric's value: for the cancellation rate the stop count decides,
    for the delay metrics `thin`."""
    return s.n >= LOW_N if metric == "ausfallquote" else not thin(s)


TREND_DAYS = 28  # the trend window; it is centred, so it reaches TREND_DAYS // 2 days ahead
TREND_MIN = 14  # values the window needs
TREND_METRICS = ("puenktlich", "ausfallquote", "median", "p90")


def trends(feed: pl.DataFrame) -> pl.DataFrame:
    """Centred rolling median of each metric. `feed` has a `day` column and one Float64 column per
    metric, None where a day gives no value."""
    ahead = TREND_DAYS // 2
    # Polars' rolling_*_by windows end at their row. The window ending `ahead` days later is the
    # one centred on the day, so the calendar runs past the last day and the result shifts back.
    calendar = pl.DataFrame(
        {"day": pl.date_range(feed["day"][0], feed["day"][-1] + timedelta(ahead), eager=True)}
    )
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
    table = _tage_for(tage_path, mtimes[1])
    grouped = collect(
        selection(pl.scan_parquet(days), gattung, eva)
        .group_by("day", "bucket")
        .agg(n=pl.col("n").sum())
    )
    groups = {d: g for (d,), g in grouped.partition_by("day", as_dict=True).items()}  # pyright: ignore[reportArgumentType]
    cells = {d: cell_stats_of(g) for d, g in groups.items()}
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
    gattung: Gattung = "alle",
) -> Tageskarte:
    try:
        day = date.fromisoformat(tag)
    except ValueError:
        raise HTTPException(status_code=422, detail="Not a calendar day") from None
    days = tage()["day"]
    if not days[0] <= day <= days[-1]:
        raise HTTPException(status_code=404, detail="No data for that day")
    mtimes = tuple(
        os.stat(p).st_mtime_ns for p in (DAYS_PATH, TAGE_PATH, STATIONS_PATH, MONATE_PATH)
    )
    return tageskarte_for(DAYS_PATH, mtimes, gattung, day)


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


def cells_of(frame: pl.LazyFrame, keys: list[str]) -> list[tuple[tuple, CellStats]]:
    """The statistics of every key combination of a (keys, bucket, n) frame, in key order."""
    out = collect(cell_stats_frame(frame, keys).sort(keys))
    return [(row[: len(keys)], CellStats(*row[len(keys) :])) for row in out.iter_rows()]


# ponytail: per-process cache like karte_for, one model per station (about 10 MB of Python objects
# per entry), so only 4 entries. Measured on Windows with one Polars thread and days.parquet in
# row groups of 50,000 rows: 20 distinct days settle at a working set of about 420 MB (peak 580
# MB), one /karte on top peaks at 685 MB; cold about 2.4 s (the scan 0.3 s, the statistics in
# Polars 0.9 s, mostly the sort of the 890k rows, the rest in Python). Revisit if memory or time
# grows.
@lru_cache(maxsize=4)
def tageskarte_for(
    days_path: str,
    mtimes: tuple[int, ...],  # days, tage, stations, monate: part of the key, so no stale data
    gattung: str,
    day: date,
) -> Tageskarte:
    table = tage()
    gap_hours = dict(zip(table["day"], table["missing_hours"], strict=True))
    first = table["day"][0]
    if cov := coverage_start():
        # Before full coverage far fewer stations report: those days say nothing about a day after.
        if day >= (start := date.fromisoformat(f"{cov}-01")):
            first = max(first, start)
    refs = reference_days(day, first, table["day"][-1], {d for d, h in gap_hours.items() if h})
    wanted = [day, *refs]
    grouped = collect(
        selection(pl.scan_parquet(days_path), gattung)
        .filter(pl.col("day").is_between(min(wanted), max(wanted)))  # lets Polars skip row groups
        .filter(pl.col("day").is_in(pl.Series(wanted).implode()))
        .group_by("day", "eva", "bucket")
        .agg(n=pl.col("n").sum())
    )
    nation = {
        d: s
        for (d,), s in cells_of(
            grouped.lazy().group_by("day", "bucket").agg(n=pl.col("n").sum()), ["day"]
        )
    }
    head = {
        "tag": day.isoformat(),
        "referenztage": [d.isoformat() for d in refs],
        "fehlende_stunden": gap_hours[day],
    }
    if day not in nation:
        return Tageskarte(**head, deutschland=None, n=0, ohne_koordinaten=0, stationen=[])

    today: dict[str, CellStats] = {}
    earlier: defaultdict[str, list[CellStats]] = defaultdict(list)
    for (d, eva), cell in cells_of(grouped.lazy(), ["day", "eva"]):
        if d == day:
            today[eva] = cell
        else:
            earlier[eva].append(cell)
    nation_refs = references_of(nation[d] for d in refs if d in nation)
    unlocated, stations = located(today)
    return Tageskarte(
        **head,
        deutschland=Deutschland(
            **to_stats(nation[day]).model_dump(),
            normal=normal_of(nation_refs),
            # a day with missing hours is not ranked: the gap, not the railway, may be the reason
            wetter=Wetter(
                **{
                    m: None
                    if gap_hours[day]
                    else weather(
                        getattr(nation[day], a) if shown(nation[day], m) else None,
                        nation_refs[m],
                        higher_is_better(a),
                    )
                    for m, a in METRICS.items()
                }
            ),
        ),
        n=nation[day].n,
        ohne_koordinaten=unlocated,
        stationen=[
            TageskartenStation(
                **station_fields(stations[eva], s),
                normal=normal_of(references),
                klasse=klasse_of(s, references),
            )
            for eva, s in today.items()  # sorted by EVA
            if eva in stations
            for references in [references_of(earlier[eva])]
        ],
    )


@app.get("/datenstand", response_model=Datenstand, operation_id="getDatenstand")
def datenstand() -> Datenstand:
    df = monate()
    days = tage()
    first, last = df["month"][0], df["month"][-1]
    last_year, last_month = int(last[:4]), int(last[5:])
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
    )
