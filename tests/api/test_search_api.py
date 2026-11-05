import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from tests.conftest import BETA

# The `client` fixture knows the stations Alpha ("1") and Beta, the lines RE5:1 (4 stops, label
# "RE5 Dortmund Hbf – Warburg (Westf)"), RE5:<BETA> (1 stop) and the single train ICE 123:1. Its
# mini pipeline wrote no axis, so most tests write one: RE5:1 runs Alpha -> Beta.


def write_axis(tmp_path, monkeypatch) -> None:
    pl.DataFrame(
        [("RE5:1", 0, "1"), ("RE5:1", 1, BETA)],
        schema={"linie": pl.String, "pos": pl.Int32, "eva": pl.String},
        orient="row",
    ).write_parquet(tmp_path / "weg.parquet")
    monkeypatch.setattr(main, "LINIENWEG_PATH", str(tmp_path / "weg.parquet"))


def add_lines(tmp_path, monkeypatch, *rows: tuple[str, str, str]) -> None:
    """The client's lines plus `rows` of (linie, name, label), typed RE."""
    linien = pl.read_parquet(main.LINIEN_PATH)
    extra = pl.DataFrame(rows, schema=["linie", "name", "label"], orient="row").with_columns(
        typ=pl.lit("RE"), zug=pl.lit(False)
    )
    pl.concat([linien, extra], how="diagonal_relaxed").write_parquet(tmp_path / "more.parquet")
    monkeypatch.setattr(main, "LINIEN_PATH", str(tmp_path / "more.parquet"))


def suche(client: TestClient, q: str, **params) -> dict:
    r = client.get("/suche", params={"q": q, **params})
    assert r.status_code == 200
    return r.json()


def test_a_place_lists_its_stations_first_and_no_line(client: TestClient):
    body = suche(client, "alpha")
    assert body["zuerst"] == "bahnhoefe"
    assert body["bahnhoefe"] == [
        {"eva": "1", "name": "Alpha", "land": "Nordrhein-Westfalen", "n": 5}
    ]
    assert body["linien"] == []


def test_the_stations_are_the_stationen_ranking(client: TestClient):
    assert suche(client, "a")["bahnhoefe"] == client.get("/stationen", params={"q": "a"}).json()
    assert (
        suche(client, "a", limit=1)["bahnhoefe"]
        == client.get("/stationen", params={"q": "a", "limit": 1}).json()
    )


def test_a_line_name_lists_every_id_with_its_label_and_leads(client: TestClient):
    body = suche(client, "re5")
    assert body["zuerst"] == "linien"
    assert body["bahnhoefe"] == []
    assert body["linien"] == [  # more stops first; a network without an axis has no direction
        {
            "linie": "RE5:1",
            "label": "RE5 Dortmund Hbf – Warburg (Westf)",
            "typ": "RE",
            "zug": False,
            "richtung": None,
            "ziel": None,
        },
        {
            "linie": f"RE5:{BETA}",
            "label": "RE5 Warburg (Westf)",
            "typ": "RE",
            "zug": False,
            "richtung": None,
            "ziel": None,
        },
    ]


def test_spaces_hyphens_and_case_do_not_matter(client: TestClient):
    assert suche(client, "R E-5")["linien"] == suche(client, "re5")["linien"]
    assert [x["linie"] for x in suche(client, "ice 123")["linien"]] == ["ICE 123:1"]
    assert suche(client, "ICE123")["linien"][0]["zug"] is True


def test_a_line_pick_with_an_end_station_carries_the_direction(client, tmp_path, monkeypatch):
    write_axis(tmp_path, monkeypatch)
    body = suche(client, "re5 alpha")
    assert body["zuerst"] == "linien"
    assert [(x["linie"], x["richtung"], x["ziel"]) for x in body["linien"]] == [
        ("RE5:1", 2, "Alpha")  # toward the first station, which names the target
    ]
    assert [
        (x["linie"], x["richtung"], x["ziel"]) for x in suche(client, "RE 5 beta")["linien"]
    ] == [
        ("RE5:1", 1, "Beta")  # toward the last; RE5:<BETA> has no axis and drops out
    ]


def test_an_end_station_word_also_matches_the_label_without_a_direction(
    client, tmp_path, monkeypatch
):
    write_axis(tmp_path, monkeypatch)  # RE5:1 runs Alpha -> Beta; its label names Dortmund
    add_lines(tmp_path, monkeypatch, ("RE50:1", "RE50", "RE50 Dortmund Hbf – Soest"))
    # RE50 names Dortmund too, but RE5 is the exact name
    body = suche(client, "re5 dortmund")
    assert [(x["linie"], x["richtung"], x["ziel"]) for x in body["linien"]] == [
        ("RE5:1", None, None)
    ]
    assert body["zuerst"] == "linien"
    # a prefix keeps every line whose label names the place
    assert [x["linie"] for x in suche(client, "re dortmund")["linien"]] == ["RE5:1", "RE50:1"]


def test_lines_do_not_lead_when_a_station_starts_with_the_query(client, tmp_path, monkeypatch):
    add_lines(tmp_path, monkeypatch, ("ALPHA:1", "ALPHA", "ALPHA Gamma"))
    body = suche(client, "alpha")
    assert [x["linie"] for x in body["linien"]] == ["ALPHA:1"]
    assert body["bahnhoefe"][0]["name"] == "Alpha"
    assert body["zuerst"] == "bahnhoefe"


def test_an_end_station_alone_never_finds_a_line(client, tmp_path, monkeypatch):
    write_axis(tmp_path, monkeypatch)
    assert suche(client, "beta")["linien"] == []
    assert suche(client, "beta")["zuerst"] == "bahnhoefe"


def test_lines_do_not_lead_when_nothing_matched(client: TestClient):
    body = suche(client, "re5 nowhere")
    assert (body["linien"], body["bahnhoefe"], body["zuerst"]) == ([], [], "bahnhoefe")


def test_a_prefix_leaves_the_stations_first(client: TestClient):
    body = suche(client, "re")  # a prefix of the line names, not an exact name
    assert body["zuerst"] == "bahnhoefe"
    assert [x["linie"] for x in body["linien"]] == ["RE5:1", f"RE5:{BETA}"]


def test_the_limit_applies_to_each_group(client: TestClient):
    assert len(suche(client, "re5", limit=1)["linien"]) == 1
    assert suche(client, "a", limit=1)["bahnhoefe"][0]["name"] == "Alpha"


def test_the_line_frame_follows_a_rewritten_file(client, tmp_path, monkeypatch):
    assert suche(client, "re5 alpha")["linien"] == []
    write_axis(tmp_path, monkeypatch)
    assert len(suche(client, "re5 alpha")["linien"]) == 1


@pytest.mark.parametrize(
    "params",
    [{}, {"q": ""}, {"q": "a" * 101}, {"q": "a", "limit": 0}, {"q": "a", "limit": 21}],
)
def test_the_parameters_are_checked(client: TestClient, params: dict):
    assert client.get("/suche", params=params).status_code == 422


def test_a_query_of_100_characters_is_fine(client: TestClient):
    assert client.get("/suche", params={"q": "a" * 100}).status_code == 200
