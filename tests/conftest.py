from datetime import date
from datetime import datetime as dt
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from pipeline.aggregate import COLUMNS, aggregate, stations, with_coords
from pipeline.update import update

DAY = "2026-09-07"  # a Monday
BETA = "08000002"  # the real source zero-pads EVAs; station "1" (Alpha) is the unpadded one


def at(hhmm: str | None, day: str = DAY) -> dt | None:
    return dt.fromisoformat(f"{day} {hhmm}") if hhmm else None


def complete(df: pl.DataFrame) -> pl.DataFrame:
    """Add every source column the test does not set as NULL strings (strict schema check)."""
    return df.with_columns(pl.lit(None, pl.String).alias(c) for c in COLUMNS if c not in df.columns)


# (train_type, planned, changed, cancelled, eva, event day for `time`, line, train no., ride id,
# destination as the source spells it)
ROWS = [
    ("ICE", "08:00", "08:10", False, "1", DAY, None, "123", "r1", "Kassel-Wilhelmshöhe"),  # +10
    ("RE", "08:05", "08:05", False, "1", DAY, "RE5", "4701", "r2", "Dortmund Hbf"),  # regional, 0
    ("RE", "08:10", None, True, "1", DAY, "RE5", "4703", "r3", "Dortmund Hbf"),  # cancelled
    ("Bus", "08:15", "08:15", False, "1", DAY, "B1", "9", "r4", "Alpha"),  # bus: excluded
    ("RE", "08:20", "08:27", False, "1", DAY, "RE5", "4705", "r5", "Warburg(Westf)"),  # +7
    ("RE", None, None, False, "1", DAY, "RE5", "4707", "r6", "Dortmund Hbf"),  # no arrival: out
    ("RE", "08:30", None, False, "1", DAY, "RE5", "4709", "r7", "Dortmund Hbf"),  # no change -> 0
    ("RE", "08:40", "08:50", False, BETA, "2026-10-05", "RE5", "4705", "r5", "Warburg(Westf)"),
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
                "final_destination_station": [r[9] for r in ROWS],
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
    data = write_line_tables(source, coords, tmp_path / "pipeline")
    monkeypatch.setattr(main, "LINES_PATH", str(data / "lines.parquet"))
    monkeypatch.setattr(main, "LINIEN_PATH", str(data / "linien.parquet"))
    monkeypatch.setattr(main, "DAYS_PATH", str(data / "days.parquet"))
    monkeypatch.setattr(main, "TAGE_PATH", str(data / "tage.parquet"))
    monkeypatch.setattr(main, "DAY_HOURS_PATH", str(data / "day_hours.parquet"))
    monkeypatch.setattr(main, "HEUTE_PATH", str(tmp_path / "missing-heute.parquet"))
    monkeypatch.setattr(main, "HEUTE_REST_PATH", str(tmp_path / "missing-heute-rest.parquet"))
    write_monate(tmp_path / "monate.parquet", monkeypatch, [("2026-09", 0, 2), ("2026-10", 3, 2)])
    return TestClient(main.app)


def write_line_tables(source: pl.DataFrame, coords: pl.DataFrame, data: Path) -> Path:
    """Run the pipeline's update over the mini source, one source file per month; returns `data`."""
    data.mkdir()
    coords.write_parquet(data / "coords.parquet")
    month = pl.col("time").dt.strftime("%Y-%m")

    def fetch(m: str) -> Path:
        path = data / f"source-{m}.parquet"
        source.filter(month == m).write_parquet(path)
        return path

    update(data, lambda: sorted(source.select(month.unique())["time"]), fetch)
    return data


def write_monate(path, monkeypatch, rows: list[tuple[str, int, int]]) -> None:
    """Point the API at a month table: rows are (month, missing_hours, stations)."""
    pl.DataFrame(
        rows,
        schema={"month": pl.String, "missing_hours": pl.Int32, "stations": pl.UInt32},
        orient="row",
    ).write_parquet(path)
    monkeypatch.setattr(main, "MONATE_PATH", str(path))


def write_tage(path, monkeypatch, rows: list[tuple[str, int]]) -> None:
    """Point the API at a day table: rows are (ISO day, missing_hours)."""
    pl.DataFrame(
        [(date.fromisoformat(d), h) for d, h in rows],
        schema={"day": pl.Date, "missing_hours": pl.Int32},
        orient="row",
    ).write_parquet(path)
    monkeypatch.setattr(main, "TAGE_PATH", str(path))
