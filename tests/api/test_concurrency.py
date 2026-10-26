import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main


@pytest.fixture
def peak(monkeypatch) -> dict[str, int]:
    """Count the collects running at the same moment; `max` is the highest count seen."""
    state = {"active": 0, "max": 0}
    lock = threading.Lock()
    original = pl.LazyFrame.collect

    def tracked(self, *args, **kwargs):
        with lock:
            state["active"] += 1
            state["max"] = max(state["max"], state["active"])
        try:
            time.sleep(0.05)
            return original(self, *args, **kwargs)
        finally:
            with lock:
                state["active"] -= 1

    monkeypatch.setattr(pl.LazyFrame, "collect", tracked)
    return state


def test_concurrent_requests_run_at_most_max_queries_collects(client: TestClient, peak):
    for cached in (main.karte_for, main.station_stats_for, main.line_stats_for):
        cached.cache_clear()
    paths = [
        "/heatmap",
        "/karte?gattung=regional",
        "/rankings?typ=bahnhoefe",
        "/rankings?typ=linien",
        "/stationen/1/statistik",
        "/stationen/1/linien",
        "/zeitverlauf?eva=1",
        "/zeitverlauf",
    ] * 2
    with ThreadPoolExecutor(len(paths)) as pool:
        codes = list(pool.map(lambda p: client.get(p).status_code, paths))
    assert codes == [200] * len(paths)
    assert 0 < peak["max"] <= main.MAX_QUERIES


def test_every_collect_goes_through_the_cap():
    source = Path(main.__file__).read_text(encoding="utf-8")
    assert source.count(".collect(") == 1
    assert "read_parquet" not in source
    assert "collect_all" not in source
