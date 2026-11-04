from collections.abc import Sequence

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from tests.conftest import BETA

# The `client` fixture's line RE5:1 stops at station 1 ("Alpha", 4 stops in 2026-09, coordinates)
# and at BETA ("Beta", 1 stop in 2026-10, no coordinates). The mini source has no trip ids, so the
# pipeline wrote empty section tables: the tests below write their own.

LINIE = "RE5:1"
SECTIONS = [  # (linie, from, to, month, n, minutes)
    (LINIE, "1", BETA, "2026-09", 2, 3),
    (LINIE, "1", BETA, "2026-10", 3, 4),
    (LINIE, BETA, "1", "2026-09", 4, -2),
    (LINIE, BETA, "1", "2026-10", 0, 0),  # no trips: left out
    ("OTHER:1", "1", BETA, "2026-09", 9, 9),
]


def write_tables(
    tmp_path,
    monkeypatch,
    axis: Sequence[tuple[str, int]] = (),
    sections: Sequence[tuple] = (),
) -> None:
    """Point the API at section and axis tables: `axis` rows are (eva, position of RE5:1)."""
    pl.DataFrame(
        [(LINIE, p, e) for e, p in axis],
        schema={"linie": pl.String, "pos": pl.Int32, "eva": pl.String},
        orient="row",
    ).write_parquet(tmp_path / "weg.parquet")
    pl.DataFrame(
        list(sections),
        schema={
            "linie": pl.String,
            "from_eva": pl.String,
            "to_eva": pl.String,
            "month": pl.String,
            "n": pl.UInt32,
            "minutes": pl.Int64,
        },
        orient="row",
    ).write_parquet(tmp_path / "abschnitte.parquet")
    monkeypatch.setattr(main, "LINIENWEG_PATH", str(tmp_path / "weg.parquet"))
    monkeypatch.setattr(main, "ABSCHNITTE_PATH", str(tmp_path / "abschnitte.parquet"))


def seite(client: TestClient, **params) -> dict:
    r = client.get("/linie", params={"linie": LINIE, **params})
    assert r.status_code == 200
    return r.json()


def abschnitte(client: TestClient, **params) -> list[dict]:
    r = client.get("/linie/abschnitte", params={"linie": LINIE, **params})
    assert r.status_code == 200
    return r.json()


def test_the_header_names_the_line(client: TestClient):
    body = seite(client)
    assert {k: body[k] for k in ("linie", "name", "label", "typ")} == {
        "linie": LINIE,
        "name": "RE5",
        "label": "RE5 Dortmund Hbf – Warburg (Westf)",
        "typ": "RE",
    }


def test_the_whole_line_is_pooled_over_its_stations_and_the_period(client):
    period = {"von": "2026-09", "bis": "2026-10"}
    body = seite(client, **period)
    # Alpha: 0, 0, +7 and a cancellation (Beta has no arrival of the line)
    assert body["gesamt"] == {
        "n": 4,
        "ausfallquote": 0.25,
        "median": 0.0,
        "p90": 7.0,
        "puenktlich": pytest.approx(2 / 3),
    }


def test_the_stations_are_pooled_not_averaged(client, tmp_path, monkeypatch):
    rows = [  # (linie, eva, gruppe, month, bucket, n)
        (LINIE, "1", "regional", "2026-09", 0, 3),
        (LINIE, "1", "regional", "2026-09", 10, 1),
        (LINIE, BETA, "regional", "2026-09", 30, 6),
        ("OTHER:1", "1", "regional", "2026-09", 0, 50),
    ]
    pl.DataFrame(
        rows,
        schema={
            "linie": pl.String,
            "eva": pl.String,
            "gruppe": pl.String,
            "month": pl.String,
            "bucket": pl.Int32,
            "n": pl.UInt32,
        },
        orient="row",
    ).write_parquet(tmp_path / "two-lines.parquet")
    monkeypatch.setattr(main, "LINES_PATH", str(tmp_path / "two-lines.parquet"))
    # medians 0 and 30 would average to 15, shares 0.75 and 0 to 0.375
    assert seite(client, von="2026-09", bis="2026-09")["gesamt"] == {
        "n": 10,
        "ausfallquote": 0.0,
        "median": 30.0,
        "p90": 30.0,
        "puenktlich": 0.3,
    }


def test_a_period_without_stops_has_no_whole_line_values(client):
    assert seite(client, von="2026-11")["gesamt"] is None


def test_the_line_says_whether_it_is_a_train_and_has_no_live_data(client, tmp_path, monkeypatch):
    body = seite(client)
    assert (body["zug"], body["ohne_echtzeit"]) == (False, False)
    linien = pl.read_parquet(main.LINIEN_PATH).with_columns(zug=True, ohne_echtzeit=True)
    linien.write_parquet(tmp_path / "flagged-linien.parquet")
    monkeypatch.setattr(main, "LINIEN_PATH", str(tmp_path / "flagged-linien.parquet"))
    body = seite(client)
    assert (body["zug"], body["ohne_echtzeit"]) == (True, True)


def test_axis_stations_come_first_in_axis_order_then_the_others(client, tmp_path, monkeypatch):
    write_tables(tmp_path, monkeypatch, axis=[(BETA, 0), ("1", 1)])
    stations = seite(client)["bahnhoefe"]
    assert [(s["eva"], s["pos"]) for s in stations] == [(BETA, 0), ("1", 1)]

    # BETA is off the axis: only the line's sections reach it
    write_tables(tmp_path, monkeypatch, axis=[("1", 0)], sections=SECTIONS)
    stations = seite(client)["bahnhoefe"]
    assert [(s["eva"], s["pos"]) for s in stations] == [("1", 0), (BETA, None)]


def test_an_axis_that_visits_a_station_twice_keeps_every_visit_and_the_first_place(
    client, tmp_path, monkeypatch
):
    write_tables(tmp_path, monkeypatch, axis=[("1", 0), (BETA, 1), ("1", 2)])
    body = seite(client)
    assert body["achse"] == ["1", BETA, "1"]
    assert [(s["eva"], s["pos"]) for s in body["bahnhoefe"]] == [("1", 0), (BETA, 1)]


def test_a_station_carries_its_name_and_coordinates(client, tmp_path, monkeypatch):
    write_tables(tmp_path, monkeypatch, axis=[("1", 0)], sections=SECTIONS)
    alpha, beta = seite(client)["bahnhoefe"]
    assert (alpha["name"], alpha["lat"], alpha["lon"]) == ("Alpha", 50.0, 7.0)
    assert (beta["name"], beta["lat"], beta["lon"]) == ("Beta", None, None)


def test_the_stations_without_a_position_are_ordered_by_stops_then_name(
    client, tmp_path, monkeypatch
):
    write_tables(tmp_path, monkeypatch, sections=SECTIONS)
    stations = seite(client)["bahnhoefe"]
    assert [(s["eva"], s["n"]) for s in stations] == [("1", 4), (BETA, 0)]


def test_the_statistics_of_a_station_equal_its_line_cells(client, tmp_path, monkeypatch):
    write_tables(tmp_path, monkeypatch, axis=[("1", 0)])
    period = {"von": "2026-09", "bis": "2026-10"}
    alpha = seite(client, **period)["bahnhoefe"][0]
    cell = next(
        c for c in client.get("/stationen/1/linien", params=period).json() if c["linie"] == LINIE
    )
    keys = ("n", "ausfallquote", "median", "p90", "puenktlich")
    assert {k: alpha[k] for k in keys} == {k: cell[k] for k in keys}
    assert alpha["n"] == 4


def test_the_period_limits_the_statistics(client, tmp_path, monkeypatch):
    write_tables(tmp_path, monkeypatch, axis=[("1", 0)])
    assert [s["n"] for s in seite(client, von="2026-09", bis="2026-09")["bahnhoefe"]] == [4]
    assert [s["n"] for s in seite(client, von="2026-10", bis="2026-10")["bahnhoefe"]] == [0]


def test_a_period_without_stops_keeps_the_axis_stations_with_empty_values(
    client, tmp_path, monkeypatch
):
    write_tables(tmp_path, monkeypatch, axis=[(BETA, 0), ("1", 1)])
    stations = seite(client, von="2026-11")["bahnhoefe"]
    assert [s["eva"] for s in stations] == [BETA, "1"]
    for s in stations:
        assert s["n"] == 0
        assert (s["ausfallquote"], s["median"], s["p90"], s["puenktlich"]) == (None,) * 4


def test_a_station_without_a_name_is_left_out(client, tmp_path, monkeypatch):
    write_tables(tmp_path, monkeypatch, axis=[("1", 0), ("99", 1)])
    assert [s["eva"] for s in seite(client)["bahnhoefe"]] == ["1"]


def test_sections_are_summed_over_the_months_with_their_mean(client, tmp_path, monkeypatch):
    write_tables(tmp_path, monkeypatch, sections=SECTIONS)
    assert abschnitte(client, von="2026-09", bis="2026-10") == [
        {"von_eva": BETA, "nach_eva": "1", "n": 4, "minuten": -0.5},  # sorted by von_eva
        {"von_eva": "1", "nach_eva": BETA, "n": 5, "minuten": 1.4},
    ]


def test_sections_follow_the_period(client, tmp_path, monkeypatch):
    write_tables(tmp_path, monkeypatch, sections=SECTIONS)
    assert abschnitte(client, von="2026-10") == [
        {"von_eva": "1", "nach_eva": BETA, "n": 3, "minuten": 1.33}
    ]
    assert abschnitte(client, von="2026-11") == []


def test_unknown_line_is_a_404_on_both_routes(client: TestClient):
    for path in ("/linie", "/linie/abschnitte"):
        r = client.get(path, params={"linie": "nope"})
        assert (r.status_code, r.json()["detail"]) == (404, "Unknown line")


@pytest.mark.parametrize("path", ["/linie", "/linie/abschnitte"])
def test_the_parameters_are_checked(client: TestClient, path: str):
    assert client.get(path, params={"linie": "x" * 201}).status_code == 422
    assert client.get(path).status_code == 422
    assert client.get(path, params={"linie": LINIE, "von": "2026-13"}).status_code == 422
    assert client.get(path, params={"linie": LINIE, "bis": "x"}).status_code == 422
