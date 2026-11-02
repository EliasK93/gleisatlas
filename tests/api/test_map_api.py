import os
from collections.abc import Callable
from datetime import date
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main

# Mini data (see tests/conftest.py): station 1 has coordinates, station 2 has none.
# Station 1 buckets: regional 0, 0, 7, cancelled; fern 10. Station 2 (2026-10): regional 10.
# The mini source plants every stop on 2026-09-07 in the day table (station 2 is recorded in
# 2026-10), so `client` here moves station 2 to 2026-10-05: /karte sees station 1 on 2026-09-07
# and station 2 on 2026-10-05, like the months of the aggregate.


@pytest.fixture
def client(client: TestClient, monkeypatch, tmp_path) -> TestClient:
    moved = tmp_path / "karte-days.parquet"
    pl.read_parquet(main.DAYS_PATH).with_columns(
        day=pl.when(pl.col("eva") == "08000002").then(date(2026, 10, 5)).otherwise(pl.col("day"))
    ).write_parquet(moved)
    monkeypatch.setattr(main, "DAYS_PATH", str(moved))
    return client


def edit_days(change: Callable[[pl.DataFrame], pl.DataFrame]) -> None:
    """Rewrite the served day table in place and move its modification time on."""
    path = Path(main.DAYS_PATH)
    change(pl.read_parquet(path)).write_parquet(path)
    os.utime(path, ns=(1, path.stat().st_mtime_ns + 10**9))


def karte(client: TestClient, **params) -> dict:
    r = client.get("/karte", params=params)
    assert r.status_code == 200
    return r.json()


def statistik(client: TestClient, eva: str, **params) -> dict:
    r = client.get(f"/stationen/{eva}/statistik", params=params)
    assert r.status_code == 200
    return r.json()


def test_karte_lists_only_stations_with_coordinates(client: TestClient):
    k = karte(client)
    assert (k["n"], k["ohne_koordinaten"], k["von"], k["bis"]) == (6, 1, "2026-09-07", "2026-10-05")
    (s,) = k["stationen"]
    assert (s["eva"], s["name"], s["lat"], s["lon"]) == ("1", "Alpha", 50.0, 7.0)
    assert (s["n"], s["ausfallquote"], s["median"], s["p90"]) == (5, 0.2, 0.0, 10.0)
    assert s["puenktlich"] == pytest.approx(0.5)


def test_karte_filters_change_n(client: TestClient):
    assert karte(client, gattung="fern")["n"] == 1
    assert karte(client, gattung="fern")["stationen"][0]["n"] == 1
    assert karte(client, bis="2026-09")["n"] == 5
    assert karte(client, bis="2026-09")["ohne_koordinaten"] == 0  # station 2 has no stops then
    k = karte(client, von="2026-10")
    assert (k["n"], k["ohne_koordinaten"], k["stationen"]) == (1, 1, [])


def test_karte_takes_a_day_range(client: TestClient):
    one = karte(client, von="2026-09-07", bis="2026-09-07")
    assert (one["n"], one["von"], one["bis"]) == (5, "2026-09-07", "2026-09-07")
    last = karte(client, von="2026-10-05")
    assert (last["n"], last["von"], last["bis"]) == (1, "2026-10-05", "2026-10-05")
    for gap in ({"von": "2026-09-08", "bis": "2026-10-04"}, {"bis": "2026-09-06"}):
        assert karte(client, **gap)["n"] == 0
        assert karte(client, **gap)["von"] == ""


def test_karte_month_edges_mean_whole_months(client: TestClient):
    assert karte(client, von="2026-09", bis="2026-09") == karte(
        client, von="2026-09-01", bis="2026-09-30"
    )
    assert karte(client, von="2026-10", bis="2026-10") == karte(
        client, von="2026-10-01", bis="2026-10-31"
    )
    assert karte(client, von="2026-09", bis="2026-10-05")["n"] == 6  # a month and a day mix


def test_karte_month_end_is_its_last_day(client: TestClient):
    # one more stop of station 1 on the 31st, the last day of a 31-day month
    edit_days(
        lambda d: pl.concat(
            [
                d,
                d.head(1).with_columns(
                    day=pl.lit(date(2026, 10, 31)),
                    eva=pl.lit("1"),
                    n=pl.lit(1).cast(d.schema["n"]),
                ),
            ]
        )
    )
    whole = karte(client, bis="2026-10")
    assert (whole["n"], whole["bis"]) == (7, "2026-10-31")
    before = karte(client, bis="2026-10-30")
    assert (before["n"], before["bis"]) == (6, "2026-10-05")


def test_karte_default_reaches_the_last_day(client: TestClient):
    k = karte(client)  # from the first day of the full-coverage month to the last day in the file
    assert (k["von"], k["bis"]) == ("2026-09-07", "2026-10-05")
    assert karte(client, von="2026-09-07")["bis"] == "2026-10-05"


def test_karte_is_cached_per_selection_and_follows_the_files(client: TestClient, tmp_path):
    main.karte_for.cache_clear()
    first = karte(client)
    assert karte(client) == first
    assert main.karte_for.cache_info().hits == 1
    karte(client, gattung="fern")  # another selection is computed on its own
    assert main.karte_for.cache_info().misses == 2

    # New data under the same path is never served stale: the modification time is part of the key.
    path = tmp_path / "stations.parquet"
    stations = pl.read_parquet(path).with_columns(
        name=pl.when(pl.col("eva") == "1").then(pl.lit("Renamed")).otherwise(pl.col("name"))
    )
    stations.write_parquet(path)
    os.utime(path, ns=(1, path.stat().st_mtime_ns + 10**9))
    assert karte(client)["stationen"][0]["name"] == "Renamed"

    # The same holds for the day table.
    edit_days(lambda d: d.with_columns(n=pl.col("n") * 2))
    assert karte(client)["n"] == 2 * first["n"]


def test_karte_empty_selection(client: TestClient):
    assert karte(client, von="2027-01") == {
        "von": "",
        "bis": "",
        "n": 0,
        "ohne_koordinaten": 0,
        "stationen": [],
    }


def test_statistik_distribution_cancelled_and_groups(client: TestClient):
    s = statistik(client, "1")
    assert s["station"]["name"] == "Alpha"
    assert (s["n"], s["von"], s["bis"]) == (5, "2026-09", "2026-09")
    assert s["gesamt"]["n"] == 5
    assert s["verteilung"] == [2, 0, 0, 1, 1, 0, 0]  # 0, 0 | 7 | 10
    assert s["ausgefallen"] == 1
    assert [(g["gruppe"], g["n"]) for g in s["gruppen"]] == [("regional", 4), ("fern", 1)]


@pytest.mark.parametrize(
    "eva, params",
    [
        ("1", {}),
        ("1", {"gattung": "regional"}),
        ("1", {"gattung": "fern"}),
        ("08000002", {}),
        ("08000002", {"von": "2026-10"}),
    ],
)
def test_statistik_bins_and_cancelled_sum_to_n(client: TestClient, eva: str, params: dict):
    s = statistik(client, eva, **params)
    assert sum(s["verteilung"]) + s["ausgefallen"] == s["n"] > 0
    assert s["gesamt"]["n"] == s["n"]
    assert sum(g["n"] for g in s["gruppen"]) == s["n"]


def test_statistik_filters_change_n(client: TestClient):
    assert statistik(client, "1", gattung="fern")["n"] == 1
    assert [g["gruppe"] for g in statistik(client, "1", gattung="fern")["gruppen"]] == ["fern"]
    assert statistik(client, "08000002", von="2026-10")["n"] == 1


def test_statistik_without_stops_in_selection(client: TestClient):
    s = statistik(client, "08000002", bis="2026-09")
    assert s["station"]["eva"] == "08000002"
    assert (s["n"], s["gesamt"], s["verteilung"], s["ausgefallen"], s["gruppen"]) == (
        0,
        None,
        [],
        0,
        [],
    )


def test_statistik_unknown_or_unnamed_station_is_404(client: TestClient, tmp_path, monkeypatch):
    assert client.get("/stationen/999/statistik").status_code == 404
    path = tmp_path / "unnamed.parquet"
    pl.DataFrame({"eva": ["1"], "name": [None], "n": [5], "land": [None]}).write_parquet(path)
    monkeypatch.setattr(main, "STATIONS_PATH", str(path))
    assert client.get("/stationen/1/statistik").status_code == 404


@pytest.mark.parametrize(
    "path, params",
    [
        ("/karte", {"gattung": "bahn"}),
        ("/karte", {"von": "2026-9"}),
        ("/karte", {"bis": "26-09"}),
        ("/karte", {"von": "2026-02-31"}),
        ("/karte", {"bis": "2026-9-1"}),
        ("/karte", {"von": "0000-01"}),  # matches the pattern, is no date
        ("/karte", {"bis": "0000-12"}),
        ("/heatmap", {"von": "2026-09-01"}),  # only /karte takes days
        ("/stationen/1/statistik", {"gattung": "bahn"}),
        ("/stationen/1/statistik", {"von": "2026-13"}),
        ("/stationen/abc/statistik", {}),
    ],
)
def test_invalid_input_is_422(client: TestClient, path: str, params: dict):
    assert client.get(path, params=params).status_code == 422


def test_large_responses_are_gzipped(client: TestClient, tmp_path, monkeypatch):
    path = tmp_path / "many.parquet"
    names = [f"Station number {i}" for i in range(100)]
    pl.DataFrame(
        {"eva": [str(i) for i in range(100)], "name": names, "n": 1, "land": None}
    ).write_parquet(path)
    monkeypatch.setattr(main, "STATIONS_PATH", str(path))
    r = client.get("/stationen", params={"limit": 100}, headers={"accept-encoding": "gzip"})
    assert r.headers["content-encoding"] == "gzip"
    assert len(r.json()) == 100
