from fastapi.testclient import TestClient

from tests.conftest import write_monate

# The `client` fixture covers 2026-09 and 2026-10 with 2 stations each; 2026-10 misses 3 hours.


def test_datenstand_carries_coverage_gaps_and_timetable_changes(client: TestClient):
    assert client.get("/datenstand").json() == {
        "monate": ["2026-09", "2026-10"],
        "bahnhoefe": 2,
        "vollabdeckung_ab": "2026-09",
        "fehlende_stunden": {"2026-10": 3},
        "fahrplanwechsel": [],
    }


def test_timetable_change_inside_the_data_range(client: TestClient, tmp_path, monkeypatch):
    rows = [("2026-11", 0, 2), ("2026-12", 0, 2)]
    write_monate(tmp_path / "range.parquet", monkeypatch, rows)
    assert client.get("/datenstand").json()["fahrplanwechsel"] == ["2026-12-13"]


def sparse_start(tmp_path, monkeypatch) -> None:
    """September has under half the stations of October, so full coverage starts in October."""
    write_monate(tmp_path / "sparse.parquet", monkeypatch, [("2026-09", 0, 1), ("2026-10", 0, 3)])


def test_default_period_starts_at_full_coverage(client: TestClient, tmp_path, monkeypatch):
    sparse_start(tmp_path, monkeypatch)
    assert client.get("/datenstand").json()["vollabdeckung_ab"] == "2026-10"
    default = client.get("/heatmap").json()
    assert (default["n"], default["von"]) == (1, "2026-10")
    explicit = client.get("/heatmap", params={"von": "2026-09"}).json()
    assert (explicit["n"], explicit["von"]) == (6, "2026-09")


def test_default_period_is_not_applied_when_bis_ends_before_full_coverage(
    client: TestClient, tmp_path, monkeypatch
):
    sparse_start(tmp_path, monkeypatch)
    before = client.get("/heatmap", params={"bis": "2026-09"}).json()
    assert (before["n"], before["von"], before["bis"]) == (5, "2026-09", "2026-09")
    inside = client.get("/heatmap", params={"bis": "2026-10"}).json()
    assert (inside["n"], inside["von"]) == (1, "2026-10")


def test_default_period_applies_to_station_statistics(client: TestClient, tmp_path, monkeypatch):
    sparse_start(tmp_path, monkeypatch)
    assert client.get("/stationen/1/statistik").json()["n"] == 0
    assert client.get("/stationen/1/statistik", params={"von": "2026-09"}).json()["n"] == 5


def test_default_period_applies_to_the_map(client: TestClient, tmp_path, monkeypatch):
    sparse_start(tmp_path, monkeypatch)
    assert client.get("/karte").json()["n"] == 1
    assert client.get("/karte", params={"von": "2026-09"}).json()["n"] == 6
