"""FastAPI routes over the aggregate. Route and parameter names are the public (German) contract."""

import os
from typing import Literal

import polars as pl
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from core.stats import cell_stats

AGG_PATH = os.environ.get("AGGREGATE_PATH", "data/aggregate.parquet")
STATIONS_PATH = os.environ.get("STATIONS_PATH", "data/stations.parquet")

app = FastAPI(title="Verlässlich")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["GET"])


class Cell(BaseModel):
    weekday: int  # 0 = Monday
    hour: int
    n: int  # stops including cancellations
    ausfallquote: float
    median: float | None  # minutes, non-cancelled stops only
    p90: float | None
    puenktlich: float | None  # share below 6 minutes


class Heatmap(BaseModel):
    von: str
    bis: str
    n: int
    cells: list[Cell]


class Station(BaseModel):
    eva: str
    name: str


def heatmap_from(
    lf: pl.LazyFrame,
    gattung: str = "alle",
    eva: str | None = None,
    von: str | None = None,
    bis: str | None = None,
) -> Heatmap:
    """von/bis: months 'YYYY-MM' (inclusive). Stations are always filtered by EVA."""
    if gattung != "alle":
        lf = lf.filter(pl.col("gruppe") == gattung)
    if eva:
        lf = lf.filter(pl.col("eva") == eva)
    if von:
        lf = lf.filter(pl.col("month") >= von)
    if bis:
        lf = lf.filter(pl.col("month") <= bis)
    df = lf.collect()
    if df.is_empty():
        return Heatmap(von="", bis="", n=0, cells=[])
    merged = df.group_by("weekday", "hour", "bucket").agg(n=pl.col("n").sum())
    merged = merged.sort("weekday", "hour")  # group_by order is arbitrary; keep cells stable
    cells: list[Cell] = []
    for (weekday, hour), group in merged.partition_by("weekday", "hour", as_dict=True).items():
        s = cell_stats(group.select("bucket", "n").iter_rows())
        cells.append(
            Cell(
                weekday=int(weekday),  # pyright: ignore[reportArgumentType]
                hour=int(hour),  # pyright: ignore[reportArgumentType]
                n=s.n,
                ausfallquote=s.cancellation_rate,
                median=s.median,
                p90=s.p90,
                puenktlich=s.punctual_share,
            )
        )
    return Heatmap(
        von=str(df["month"].min()), bis=str(df["month"].max()), n=int(df["n"].sum()), cells=cells
    )


@app.get("/heatmap", response_model=Heatmap, operation_id="getHeatmap")
def heatmap(
    gattung: Literal["alle", "regional", "fern"] = "alle",
    eva: str | None = None,
    von: str | None = None,
    bis: str | None = None,
) -> Heatmap:
    return heatmap_from(pl.scan_parquet(AGG_PATH), gattung, eva, von, bis)


@app.get("/stationen", response_model=list[Station], operation_id="getStationen")
def stationen(q: str = "", limit: int = 20) -> list[Station]:
    df = pl.read_parquet(STATIONS_PATH).drop_nulls("name")  # a few EVAs have no name in the source
    if q:
        df = df.filter(pl.col("name").str.to_lowercase().str.contains(q.lower(), literal=True))
    return [Station(**r) for r in df.sort("name").head(limit).iter_rows(named=True)]
