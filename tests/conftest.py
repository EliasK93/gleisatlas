from datetime import datetime as dt

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from pipeline.aggregate import COLUMNS, aggregate, stations, with_coords

DAY = "2026-09-07"  # a Monday


def at(hhmm: str | None, day: str = DAY) -> dt | None:
    return dt.fromisoformat(f"{day} {hhmm}") if hhmm else None


def complete(df: pl.DataFrame) -> pl.DataFrame:
    """Add every source column the test does not set as NULL strings (strict schema check)."""
    return df.with_columns(pl.lit(None, pl.String).alias(c) for c in COLUMNS if c not in df.columns)


# (train_type, planned, changed, cancelled, eva, event day for `time`, line, train no., ride id)
ROWS = [
    ("ICE", "08:00", "08:10", False, "1", DAY, None, "123", "r1"),  # long-distance, +10
    ("RE", "08:05", "08:05", False, "1", DAY, "RE5", "4701", "r2"),  # regional, 0
    ("RE", "08:10", None, True, "1", DAY, "RE5", "4703", "r3"),  # cancelled: NOT 0 min
    ("Bus", "08:15", "08:15", False, "1", DAY, "B1", "9", "r4"),  # bus: excluded
    ("RE", "08:20", "08:27", False, "1", DAY, "RE5", "4705", "r5"),  # +7
    ("RE", None, None, False, "1", DAY, "RE5", "4707", "r6"),  # first stop, no arrival: excluded
    ("RE", "08:30", None, False, "1", DAY, "RE5", "4709", "r7"),  # no change time -> 0
    ("RE", "08:40", "08:50", False, "2", "2026-10-05", "RE5", "4705", "r5"),  # other station/month
]


@pytest.fixture
def source() -> pl.DataFrame:
    return complete(
        pl.DataFrame(
            {
                "eva": [r[4] for r in ROWS],
                "station_name": ["Alpha" if r[4] == "1" else "Beta" for r in ROWS],
                "train_type": [r[0] for r in ROWS],
                "time": [at("08:00", r[5]) for r in ROWS],
                "arrival_planned_time": [at(r[1]) for r in ROWS],
                "arrival_change_time": [at(r[2]) for r in ROWS],
                "arrival_is_canceled": [r[3] for r in ROWS],
                "line_number": [r[6] for r in ROWS],
                "train_number": [r[7] for r in ROWS],
                "train_line_ride_id": [r[8] for r in ROWS],
            }
        )
    )


@pytest.fixture
def coords() -> pl.DataFrame:
    """Wikidata-style coordinates: IBNR without leading zero; only station 1 is known."""
    return pl.DataFrame(
        {"ibnr": ["1"], "lat": [50.0], "lon": [7.0], "land": ["Nordrhein-Westfalen"]}
    )


@pytest.fixture
def mini(source: pl.DataFrame) -> pl.DataFrame:
    return aggregate(source.lazy())


@pytest.fixture
def client(
    mini: pl.DataFrame, source: pl.DataFrame, coords: pl.DataFrame, tmp_path, monkeypatch
) -> TestClient:
    """API over mini data; the stations table is built like the pipeline's combine step."""
    agg, st = tmp_path / "agg.parquet", tmp_path / "stations.parquet"
    mini.write_parquet(agg)
    with_coords(stations(source.lazy()), coords).write_parquet(st)
    monkeypatch.setattr(main, "AGG_PATH", str(agg))
    monkeypatch.setattr(main, "STATIONS_PATH", str(st))
    write_monate(tmp_path / "monate.parquet", monkeypatch, [("2026-09", 0, 2), ("2026-10", 3, 2)])
    return TestClient(main.app)


def write_monate(path, monkeypatch, rows: list[tuple[str, int, int]]) -> None:
    """Point the API at a month table: rows are (month, missing_hours, stations)."""
    pl.DataFrame(
        rows,
        schema={"month": pl.String, "missing_hours": pl.Int32, "stations": pl.UInt32},
        orient="row",
    ).write_parquet(path)
    monkeypatch.setattr(main, "MONATE_PATH", str(path))
