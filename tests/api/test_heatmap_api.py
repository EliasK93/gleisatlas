import os

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main

ALPHA = {"eva": "1", "name": "Alpha", "land": "Nordrhein-Westfalen", "n": 5}


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
    assert heatmap(client, eva="08000002")["n"] == 1
    assert heatmap(client, eva="2")["n"] == 0  # a zero-padded EVA is not the unpadded one
    assert heatmap(client, eva="999")["n"] == 0
    # the name is not a key
    assert client.get("/heatmap", params={"eva": "Beta"}).status_code == 422


def test_stations_without_name_are_skipped(client: TestClient, tmp_path, monkeypatch):
    path = tmp_path / "named.parquet"
    pl.DataFrame(
        {"eva": ["1", "3"], "name": ["Alpha", None], "n": [5, 2], "land": ["Hessen", None]}
    ).write_parquet(path)
    monkeypatch.setattr(main, "STATIONS_PATH", str(path))
    assert client.get("/stationen").json() == [
        {"eva": "1", "name": "Alpha", "land": "Hessen", "n": 5}
    ]


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


@pytest.mark.parametrize(
    "path, params",
    [
        ("/stationen", {"limit": 0}),
        ("/stationen", {"limit": 101}),
        ("/heatmap", {"von": "2026-9"}),
        ("/heatmap", {"bis": "26-09"}),
        ("/heatmap", {"von": "٢٠٢٦-01"}),  # Arabic-Indic digits
        ("/heatmap", {"eva": "abc"}),
        ("/stationen/abc", {}),
    ],
)
def test_invalid_input_is_422(client: TestClient, path: str, params: dict):
    assert client.get(path, params=params).status_code == 422


def test_weekday_totals_from_histogram(client: TestClient):
    tage = heatmap(client)["tage"]
    assert [t["weekday"] for t in tage] == [0]
    monday = tage[0]  # buckets: 0, 0, 7, 10, 10 plus one cancelled stop
    assert (monday["n"], monday["median"], monday["p90"]) == (6, 7.0, 10.0)
    assert monday["ausfallquote"] == pytest.approx(1 / 6)
    assert monday["puenktlich"] == pytest.approx(2 / 5)
    assert heatmap(client, von="2027-01")["tage"] == []


def test_station_by_eva(client: TestClient):
    assert client.get("/stationen/1").json() == ALPHA
    assert client.get("/stationen/999").status_code == 404


def test_station_carries_land_and_stop_count(client: TestClient):
    assert client.get("/stationen/1").json() == ALPHA
    assert client.get("/stationen/08000002").json() == {
        "eva": "08000002",
        "name": "Beta",
        "land": None,
        "n": 1,
    }


def test_search_puts_prefix_matches_first_then_busiest(client: TestClient, tmp_path, monkeypatch):
    path = tmp_path / "search.parquet"
    names = ["Bad Alpha", "Alpha Dorf", "Alphaville", "Alpha B", "Beta"]
    pl.DataFrame(
        {"eva": list("12345"), "name": names, "n": [100, 1, 50, 1, 500], "land": None}
    ).write_parquet(path)
    monkeypatch.setattr(main, "STATIONS_PATH", str(path))
    found = client.get("/stationen", params={"q": "ALP"}).json()
    assert [s["name"] for s in found] == ["Alphaville", "Alpha B", "Alpha Dorf", "Bad Alpha"]
    assert client.get("/stationen", params={"q": "."}).json() == []  # literal, not a regex


def test_a_search_term_over_100_characters_is_422(client: TestClient):
    assert client.get("/stationen", params={"q": "a" * 100}).status_code == 200
    assert client.get("/stationen", params={"q": "a" * 101}).status_code == 422


def test_datenstand(client: TestClient):
    d = client.get("/datenstand").json()
    assert (d["monate"], d["bahnhoefe"]) == (["2026-09", "2026-10"], 2)


LINE = "RE5:1"  # the client's line, label "RE5 Dortmund Hbf – Warburg (Westf)"
LABEL = "RE5 Dortmund Hbf – Warburg (Westf)"


def write_line_hours(tmp_path, monkeypatch) -> None:
    """RE5: Monday 08 h 3 on time and 1 at +10 (September), Friday 17 h 2 on time (October);
    ICE 123: Monday 08 h 2 cancelled (fern); OTHER: Tuesday 09 h 5 on time."""
    rows = [
        (LINE, "regional", 0, 8, "2026-09", 0, 3),
        (LINE, "regional", 0, 8, "2026-09", 10, 1),
        (LINE, "fern", 4, 17, "2026-10", 0, 2),
        ("ICE 123:1", "fern", 0, 8, "2026-09", None, 2),
        ("OTHER:1", "regional", 1, 9, "2026-09", 0, 5),
    ]
    schema = {
        "linie": pl.String,
        "gruppe": pl.String,
        "weekday": pl.Int8,
        "hour": pl.Int8,
        "month": pl.String,
        "bucket": pl.Int32,
        "n": pl.UInt32,
    }
    path = tmp_path / "linien_stunden.parquet"
    pl.DataFrame(rows, schema=schema, orient="row").write_parquet(path)
    monkeypatch.setattr(main, "LINIEN_STUNDEN_PATH", str(path))


def test_a_line_has_its_own_heatmap_and_a_title(client: TestClient, tmp_path, monkeypatch):
    write_line_hours(tmp_path, monkeypatch)
    h = heatmap(client, linie=LINE)
    assert h["titel"] == LABEL
    assert [(c["weekday"], c["hour"], c["n"]) for c in h["cells"]] == [(0, 8, 4), (4, 17, 2)]
    assert (h["n"], h["von"], h["bis"]) == (6, "2026-09", "2026-10")
    assert h["cells"][0]["ausfallquote"] == 0.0 and h["cells"][0]["p90"] == 10.0
    assert [t["weekday"] for t in h["tage"]] == [0, 4]
    assert heatmap(client, linie="ICE 123:1")["cells"][0]["ausfallquote"] == 1.0  # another line


def test_a_line_heatmap_follows_gattung_and_period(client: TestClient, tmp_path, monkeypatch):
    write_line_hours(tmp_path, monkeypatch)
    assert heatmap(client, linie=LINE, gattung="fern")["n"] == 2
    assert heatmap(client, linie=LINE, gattung="regional")["n"] == 4
    assert heatmap(client, linie=LINE, von="2026-10")["n"] == 2
    empty = heatmap(client, linie=LINE, von="2027-01")
    assert (empty["n"], empty["cells"], empty["titel"]) == (0, [], LABEL)


def test_the_heatmap_without_a_line_has_no_title(client: TestClient):
    assert heatmap(client)["titel"] is None
    assert heatmap(client, eva="1")["titel"] is None


def test_a_line_heatmap_needs_a_known_line_and_no_station(
    client: TestClient, tmp_path, monkeypatch
):
    write_line_hours(tmp_path, monkeypatch)
    assert client.get("/heatmap", params={"linie": "NOPE:1"}).status_code == 404
    assert client.get("/heatmap", params={"linie": LINE, "eva": "1"}).status_code == 422
    assert client.get("/heatmap", params={"linie": "x" * 201}).status_code == 422


def test_the_line_heatmap_cache_follows_a_rewritten_file(client: TestClient, tmp_path, monkeypatch):
    write_line_hours(tmp_path, monkeypatch)
    assert heatmap(client, linie=LINE)["n"] == 6
    pl.DataFrame(
        [(LINE, "regional", 0, 8, "2026-09", 0, 1)],
        schema={
            "linie": pl.String,
            "gruppe": pl.String,
            "weekday": pl.Int8,
            "hour": pl.Int8,
            "month": pl.String,
            "bucket": pl.Int32,
            "n": pl.UInt32,
        },
        orient="row",
    ).write_parquet(main.LINIEN_STUNDEN_PATH)
    stat = os.stat(main.LINIEN_STUNDEN_PATH)
    os.utime(main.LINIEN_STUNDEN_PATH, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
    assert heatmap(client, linie=LINE)["n"] == 1


def test_endpoints(client: TestClient):
    r = client.get("/heatmap", params={"gattung": "fern", "eva": "1", "von": "2026-09"})
    assert r.status_code == 200 and r.json()["n"] == 1
    assert client.get("/stationen", params={"q": "alp"}).json() == [ALPHA]
