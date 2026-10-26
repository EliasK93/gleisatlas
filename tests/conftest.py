from datetime import datetime as dt

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from pipeline.aggregate import aggregate, stations, stop_counts, with_coords

DAY = "2026-09-07"  # a Monday


def at(hhmm: str | None, day: str = DAY) -> dt | None:
    return dt.fromisoformat(f"{day} {hhmm}") if hhmm else None


# (train_type, planned, changed, cancelled, eva, event day for `time`)
ROWS = [
    ("ICE", "08:00", "08:10", False, "1", DAY),  # long-distance, +10
    ("RE", "08:05", "08:05", False, "1", DAY),  # regional, 0
    ("RE", "08:10", None, True, "1", DAY),  # cancelled: NOT 0 min
    ("Bus", "08:15", "08:15", False, "1", DAY),  # bus: excluded
    ("RE", "08:20", "08:27", False, "1", DAY),  # +7
    ("RE", None, None, False, "1", DAY),  # first stop without arrival: excluded
    ("RE", "08:30", None, False, "1", DAY),  # no change time -> 0
    ("RE", "08:40", "08:50", False, "2", "2026-10-05"),  # other station, other month, +10
]


@pytest.fixture
def source() -> pl.DataFrame:
    return pl.DataFrame(
        {
            "eva": [r[4] for r in ROWS],
            "station_name": ["Alpha" if r[4] == "1" else "Beta" for r in ROWS],
            "train_type": [r[0] for r in ROWS],
            "time": [at("08:00", r[5]) for r in ROWS],
            "arrival_planned_time": [at(r[1]) for r in ROWS],
            "arrival_change_time": [at(r[2]) for r in ROWS],
            "arrival_is_canceled": [r[3] for r in ROWS],
        }
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
    """API over mini data; the stations table is built like the pipeline's `main` builds it."""
    agg, st = tmp_path / "agg.parquet", tmp_path / "stations.parquet"
    mini.write_parquet(agg)
    lazy = source.lazy()
    with_coords(stations(lazy).join(stop_counts(lazy), on="eva"), coords).write_parquet(st)
    monkeypatch.setattr(main, "AGG_PATH", str(agg))
    monkeypatch.setattr(main, "STATIONS_PATH", str(st))
    return TestClient(main.app)
