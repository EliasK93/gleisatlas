import pytest
from fastapi.testclient import TestClient

from backend import main

# The `client` fixture covers 2026-09 (station 1: 5 stops, 4 in RE5, 1 in ICE 123) and
# 2026-10 (station 2: 1 stop in RE5), built by the pipeline from the mini source.


def verlauf(client: TestClient, **params) -> dict:
    r = client.get("/zeitverlauf", params=params)
    assert r.status_code == 200
    return r.json()


def counts(body: dict) -> list[tuple[str, int]]:
    return [(m["monat"], m["n"]) for m in body["monate"]]


def test_nationwide_sums_match_the_heatmap_per_month(client: TestClient):
    body = verlauf(client)
    assert body["titel"] is None
    months = [m["monat"] for m in body["monate"]]
    assert months == client.get("/datenstand").json()["monate"] == ["2026-09", "2026-10"]
    for m in body["monate"]:
        heat = client.get("/heatmap", params={"von": m["monat"], "bis": m["monat"]}).json()
        assert m["n"] == heat["n"]
    assert counts(body) == [("2026-09", 5), ("2026-10", 1)]


def test_a_month_carries_the_statistics(client: TestClient):
    september = verlauf(client)["monate"][0]
    heat = client.get("/stationen/1/statistik", params={"von": "2026-09"}).json()["gesamt"]
    assert {k: september[k] for k in heat} == heat


def test_station_names_the_station_and_keeps_months_without_stops(client: TestClient):
    body = verlauf(client, eva="1")
    assert body["titel"] == "Alpha"
    assert counts(body) == [("2026-09", 5), ("2026-10", 0)]
    empty = body["monate"][1]
    assert (empty["ausfallquote"], empty["median"], empty["p90"], empty["puenktlich"]) == (
        None,
        None,
        None,
        None,
    )


def test_line_names_the_line_label(client: TestClient):
    body = verlauf(client, linie="RE5:1")
    assert body["titel"] == "RE5 Dortmund Hbf – Warburg (Westf)"
    assert counts(body) == [("2026-09", 4), ("2026-10", 0)]


def test_the_series_is_computed_once_per_selection(client: TestClient):
    main.zeitverlauf_for.cache_clear()
    first = verlauf(client, eva="1")
    assert verlauf(client, eva="1") == first
    assert main.zeitverlauf_for.cache_info().hits == 1
    verlauf(client, eva="1", gattung="fern")  # another selection is computed on its own
    assert main.zeitverlauf_for.cache_info().misses == 2


def test_gattung_filters(client: TestClient):
    assert counts(verlauf(client, gattung="fern")) == [("2026-09", 1), ("2026-10", 0)]
    assert counts(verlauf(client, eva="1", gattung="regional")) == [("2026-09", 4), ("2026-10", 0)]
    assert counts(verlauf(client, linie="RE5:1", gattung="fern")) == [
        ("2026-09", 0),
        ("2026-10", 0),
    ]


def test_unknown_station_or_line_is_404(client: TestClient):
    assert client.get("/zeitverlauf", params={"eva": "999"}).status_code == 404
    assert client.get("/zeitverlauf", params={"linie": "X9:1"}).status_code == 404


def test_station_and_line_together_is_422(client: TestClient):
    r = client.get("/zeitverlauf", params={"eva": "1", "linie": "RE5:1"})
    assert r.status_code == 422
    assert "eva" in r.json()["detail"] and "linie" in r.json()["detail"]


def test_a_line_key_over_200_characters_is_422(client: TestClient):
    assert client.get("/zeitverlauf", params={"linie": "a" * 200}).status_code == 404
    assert client.get("/zeitverlauf", params={"linie": "a" * 201}).status_code == 422


@pytest.mark.parametrize("params", [{"eva": "x"}, {"gattung": "bahn"}])
def test_invalid_input_is_422(client: TestClient, params: dict):
    assert client.get("/zeitverlauf", params=params).status_code == 422
