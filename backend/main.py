"""FastAPI routes over the aggregate. Route and parameter names are the public (German) contract."""

import os
from functools import lru_cache
from typing import Annotated, Literal

import polars as pl
from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field

from core.categories import FERN, REGIONAL
from core.stats import cell_stats, delay_bins

AGG_PATH = os.environ.get("AGGREGATE_PATH", "data/aggregate.parquet")
STATIONS_PATH = os.environ.get("STATIONS_PATH", "data/stations.parquet")

app = FastAPI(title="Gleisatlas")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["GET"])
app.add_middleware(GZipMiddleware)  # the all-stations map response is large and repetitive


DIGITS = r"^[0-9]+$"  # ASCII only: \d would also accept other scripts' digits
Eva = Annotated[str, Path(pattern=DIGITS)]
Month = Annotated[str | None, Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")]
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


class Datenstand(BaseModel):
    monate: list[str]  # 'YYYY-MM'
    bahnhoefe: int  # named stations


def stats_of(group: pl.DataFrame) -> Stats:
    # column lists: ~5x faster than iter_rows over the ~5k small groups of /karte
    s = cell_stats(zip(group["bucket"].to_list(), group["n"].to_list(), strict=True))
    return Stats(
        n=s.n,
        ausfallquote=s.cancellation_rate,
        median=s.median,
        p90=s.p90,
        puenktlich=s.punctual_share,
    )


def named_stations() -> pl.DataFrame:
    # a few EVAs have no name in the source
    return pl.read_parquet(STATIONS_PATH).drop_nulls("name")


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
) -> pl.DataFrame:
    """von/bis: months 'YYYY-MM' (inclusive). Stations are always filtered by EVA."""
    if gattung != "alle":
        lf = lf.filter(pl.col("gruppe") == gattung)
    if eva:
        lf = lf.filter(pl.col("eva") == eva)
    if von:
        lf = lf.filter(pl.col("month") >= von)
    if bis:
        lf = lf.filter(pl.col("month") <= bis)
    return lf.collect()


def heatmap_from(
    lf: pl.LazyFrame,
    gattung: str = "alle",
    eva: str | None = None,
    von: str | None = None,
    bis: str | None = None,
) -> Heatmap:
    df = selection(lf, gattung, eva, von, bis)
    if df.is_empty():
        return Heatmap(von="", bis="", n=0, cells=[], tage=[])
    merged = df.group_by("weekday", "hour", "bucket").agg(n=pl.col("n").sum())
    merged = merged.sort("weekday", "hour")  # group_by order is arbitrary; keep cells stable
    per_day = df.group_by("weekday", "bucket").agg(n=pl.col("n").sum()).sort("weekday")
    # partition keys are typed as object; they are the integer weekday and hour
    return Heatmap(
        von=str(df["month"].min()),
        bis=str(df["month"].max()),
        n=int(df["n"].sum()),
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
    return heatmap_from(pl.scan_parquet(AGG_PATH), gattung, eva, von, bis)


@app.get("/karte", response_model=Karte, operation_id="getKarte")
def karte(gattung: Gattung = "alle", von: Month = None, bis: Month = None) -> Karte:
    mtimes = (os.stat(AGG_PATH).st_mtime_ns, os.stat(STATIONS_PATH).st_mtime_ns)
    return karte_for(AGG_PATH, STATIONS_PATH, mtimes, gattung, von, bis)


# ponytail: per-process cache, so a month combination is computed once per process; revisit when the
# aggregate grows to many months (memory per entry and the first computation both grow)
@lru_cache(maxsize=16)
def karte_for(
    agg: str,
    stations_path: str,
    mtimes: tuple[int, int],  # part of the key, so new data is never served stale
    gattung: str,
    von: str | None,
    bis: str | None,
) -> Karte:
    df = selection(pl.scan_parquet(agg), gattung, None, von, bis)
    if df.is_empty():
        return Karte(von="", bis="", n=0, ohne_koordinaten=0, stationen=[])
    per_station = df.group_by("eva", "bucket").agg(n=pl.col("n").sum())
    named = named_stations().filter(pl.col("eva").is_in(per_station["eva"].implode()))
    located = named.drop_nulls("lat").sort("eva")
    stations = {r["eva"]: r for r in located.iter_rows(named=True)}
    listed = per_station.filter(pl.col("eva").is_in(located["eva"].implode()))
    return Karte(
        von=str(df["month"].min()),
        bis=str(df["month"].max()),
        n=int(df["n"].sum()),
        ohne_koordinaten=named.height - located.height,
        stationen=[
            KartenStation(
                eva=eva,
                name=stations[eva]["name"],
                lat=stations[eva]["lat"],
                lon=stations[eva]["lon"],
                **stats_of(g).model_dump(),
            )
            for (eva,), g in sorted(listed.partition_by("eva", as_dict=True).items())  # pyright: ignore[reportArgumentType]
        ],
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
    df = selection(pl.scan_parquet(AGG_PATH), gattung, eva, von, bis)
    if df.is_empty():
        return Statistik(
            station=st, von="", bis="", n=0, gesamt=None, verteilung=[], ausgefallen=0, gruppen=[]
        )
    merged = df.group_by("bucket").agg(n=pl.col("n").sum())
    bins = delay_bins(merged.iter_rows())
    per_group = df.group_by("gruppe", "bucket").agg(n=pl.col("n").sum())
    groups = dict(per_group.partition_by("gruppe", as_dict=True))  # pyright: ignore[reportArgumentType]
    return Statistik(
        station=st,
        von=str(df["month"].min()),
        bis=str(df["month"].max()),
        n=int(df["n"].sum()),
        gesamt=stats_of(merged),
        verteilung=list(bins.bins),
        ausgefallen=bins.cancelled,
        gruppen=[
            Gruppe(gruppe=g, **stats_of(groups[(g,)]).model_dump())  # pyright: ignore[reportArgumentType]
            for g in GRUPPEN
            if (g,) in groups
        ],
    )


@app.get("/datenstand", response_model=Datenstand, operation_id="getDatenstand")
def datenstand() -> Datenstand:
    months = pl.scan_parquet(AGG_PATH).select("month").unique().sort("month").collect()
    return Datenstand(monate=months["month"].to_list(), bahnhoefe=named_stations().height)
