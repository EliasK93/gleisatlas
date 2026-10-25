from datetime import datetime as dt

import polars as pl
import pytest

from pipeline.aggregate import aggregate

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
def mini(source: pl.DataFrame) -> pl.DataFrame:
    return aggregate(source.lazy())
