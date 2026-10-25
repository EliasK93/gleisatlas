import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from pipeline.aggregate import stations


@pytest.fixture
def client(mini: pl.DataFrame, source: pl.DataFrame, tmp_path, monkeypatch) -> TestClient:
    agg, st = tmp_path / "agg.parquet", tmp_path / "stations.parquet"
    mini.write_parquet(agg)
    stations(source.lazy()).write_parquet(st)
    monkeypatch.setattr(main, "AGG_PATH", str(agg))
    monkeypatch.setattr(main, "STATIONS_PATH", str(st))
    return TestClient(main.app)


def heatmap(client: TestClient, **params) -> dict:
    r = client.get("/heatmap", params=params)
    assert r.status_code == 200
    return r.json()


def test_stats_from_histogram(client: TestClient):
    c = heatmap(client, gattung="regional", eva="1")["cells"][0]
    assert (c["n"], c["ausfallquote"], c["median"], c["p90"]) == (4, 0.25, 0.0, 7.0)
    assert c["puenktlich"] == pytest.approx(2 / 3)
    assert (c["weekday"], c["hour"]) == (0, 8)


def test_regional_has_no_fern(client: TestClient):
    assert heatmap(client, gattung="regional")["n"] == 5
    assert heatmap(client, gattung="fern")["n"] == 1
    assert heatmap(client)["n"] == 6


def test_period_filter_changes_n(client: TestClient):
    assert heatmap(client)["n"] == 6
    assert heatmap(client, bis="2026-09")["n"] == 5
    h = heatmap(client, von="2026-10")
    assert (h["n"], h["von"], h["bis"]) == (1, "2026-10", "2026-10")
    assert heatmap(client, von="2027-01")["n"] == 0


def test_station_filter_by_eva_not_name(client: TestClient):
    assert heatmap(client, eva="2")["n"] == 1
    assert heatmap(client, eva="Beta")["n"] == 0  # the name is not a key


def test_stations_without_name_are_skipped(client: TestClient, tmp_path, monkeypatch):
    path = tmp_path / "named.parquet"
    pl.DataFrame({"eva": ["1", "3"], "name": ["Alpha", None]}).write_parquet(path)
    monkeypatch.setattr(main, "STATIONS_PATH", str(path))
    assert client.get("/stationen").json() == [{"eva": "1", "name": "Alpha"}]


def test_cells_are_sorted_by_weekday_and_hour():
    keys = [(4, 9), (0, 17), (0, 8), (6, 0), (4, 3)]
    agg = pl.DataFrame(
        {
            "weekday": [k[0] for k in keys],
            "hour": [k[1] for k in keys],
            "gruppe": "regional",
            "eva": "1",
            "month": "2026-09",
            "bucket": 0,
            "n": 1,
        }
    )
    cells = main.heatmap_from(agg.lazy()).cells
    assert [(c.weekday, c.hour) for c in cells] == sorted(keys)


def test_endpoints(client: TestClient):
    r = client.get("/heatmap", params={"gattung": "fern", "eva": "1", "von": "2026-09"})
    assert r.status_code == 200 and r.json()["n"] == 1
    assert client.get("/stationen", params={"q": "alp"}).json() == [{"eva": "1", "name": "Alpha"}]
