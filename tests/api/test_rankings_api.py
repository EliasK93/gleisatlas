import os

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from tests.conftest import write_monate

# Ranking data (replaces the client's mini data): month 2026-10 is the default period.
# eva  name  month    buckets
# 10   Anna  2026-10  0 x90, 10 x10                (n 100, punctual 0.9, p90 0)
# 10   Anna  2026-09  30 x100                      (outside the default period)
# 20   Bert  2026-10  0 x50, 10 x50                (n 100, punctual 0.5, p90 10)
# 30   Cora  2026-10  0 x20, cancelled x20, fern   (n 40, punctual 1.0, cancellation 0.5)
# 40   no name        20 x100                      (never listed)
# 50   Dora  2026-10  0 x10                        (n 10, below every min_n)
AGG = [  # (eva, gruppe, month, bucket, n)
    ("10", "regional", "2026-10", 0, 90),
    ("10", "regional", "2026-10", 10, 10),
    ("10", "regional", "2026-09", 30, 100),
    ("20", "regional", "2026-10", 0, 50),
    ("20", "regional", "2026-10", 10, 50),
    ("30", "fern", "2026-10", 0, 20),
    ("30", "fern", "2026-10", None, 20),
    ("40", "regional", "2026-10", 20, 100),
    ("50", "regional", "2026-10", 0, 10),
]
NAMES = {"10": "Anna", "20": "Bert", "30": "Cora", "40": None, "50": "Dora"}
HALTE = [  # (eva, gruppe, month, n): all stops; Bert's terminus adds 30 departures to its 100
    ("10", "regional", "2026-10", 100),
    ("10", "regional", "2026-09", 100),
    ("20", "regional", "2026-10", 130),
    ("30", "fern", "2026-10", 40),
    ("40", "regional", "2026-10", 100),
    ("50", "regional", "2026-10", 10),
]
LINES = [  # (linie, eva, gruppe, month, bucket, n)
    ("ICE 1:10", "10", "fern", "2026-10", 0, 100),  # punctual 1.0
    ("RE5:10", "10", "regional", "2026-10", 10, 300),
    ("RE5:10", "20", "regional", "2026-10", 0, 300),  # RE5: n 600, punctual 0.5
    ("S1:10", "10", "regional", "2026-10", 0, 10),
    ("S1:10", "10", "regional", "2026-10", 10, 10),  # S1: n 20, punctual 0.5
    ("RB9:10", "10", "regional", "2026-09", 0, 50),  # outside the default period
]
LINIEN = [  # (linie, name, label, typ); zug and ohne_echtzeit are False, the tests below set them
    ("ICE 1:10", "ICE 1", "ICE 1", "ICE"),
    ("RE5:10", "RE5", "RE5", "RE"),
    ("S1:10", "S1", "S1 · Anna", "S"),
    ("RB9:10", "RB9", "RB9", "RB"),
]
LINIEN_COLUMNS = ["linie", "name", "label", "typ", "zug", "ohne_echtzeit"]
LINES_COLUMNS = ["linie", "eva", "gruppe", "month", "bucket", "n"]


def frame(rows: list[tuple], columns: list[str]) -> pl.DataFrame:
    return pl.DataFrame(rows, schema=columns, orient="row")


@pytest.fixture
def ranked(client: TestClient, tmp_path, monkeypatch) -> TestClient:
    agg = [(0, 8, g, e, m, b, n) for e, g, m, b, n in AGG]
    columns = ["weekday", "hour", "gruppe", "eva", "month", "bucket", "n"]
    frame(agg, columns).cast({"bucket": pl.Int32}).write_parquet(tmp_path / "r-agg.parquet")
    frame(
        [(e, name, 1, None) for e, name in NAMES.items()], ["eva", "name", "n", "land"]
    ).write_parquet(tmp_path / "r-stations.parquet")
    frame(LINES, ["linie", "eva", "gruppe", "month", "bucket", "n"]).cast(
        {"bucket": pl.Int32}
    ).write_parquet(tmp_path / "r-lines.parquet")
    frame([(*row, False, False) for row in LINIEN], LINIEN_COLUMNS).write_parquet(
        tmp_path / "r-linien.parquet"
    )
    frame(HALTE, ["eva", "gruppe", "month", "n"]).cast({"n": pl.UInt32}).write_parquet(
        tmp_path / "r-halte.parquet"
    )
    for name, file in [
        ("HALTE_PATH", "r-halte"),
        ("AGG_PATH", "r-agg"),
        ("STATIONS_PATH", "r-stations"),
        ("LINES_PATH", "r-lines"),
        ("LINIEN_PATH", "r-linien"),
    ]:
        monkeypatch.setattr(main, name, str(tmp_path / f"{file}.parquet"))
    write_monate(
        tmp_path / "r-monate.parquet", monkeypatch, [("2026-09", 0, 1), ("2026-10", 0, 10)]
    )
    return client


def rankings(client: TestClient, **params) -> dict:
    r = client.get("/rankings", params=params)
    assert r.status_code == 200
    return r.json()


def names(entries: list[dict]) -> list[str]:
    return [e["name"] for e in entries]


def test_stations_ranked_by_punctuality(ranked: TestClient):
    r = rankings(ranked, typ="bahnhoefe", min_n=15)
    assert (r["typ"], r["metrik"], r["min_n"]) == ("bahnhoefe", "puenktlich", 15)
    assert (r["von"], r["bis"], r["anzahl"]) == ("2026-10", "2026-10", 3)
    assert names(r["beste"]) == ["Cora", "Anna", "Bert"]  # Dora (n 10) and the unnamed 40 are out
    assert names(r["schlechteste"]) == ["Bert", "Anna", "Cora"]
    first = r["beste"][0]
    assert (first["id"], first["typ"], first["n"], first["puenktlich"]) == ("30", None, 40, 1.0)
    assert first["ausfallquote"] == 0.5


def test_default_period_is_the_heatmaps(ranked: TestClient):
    heat = ranked.get("/heatmap").json()
    r = rankings(ranked, typ="bahnhoefe", min_n=15)
    assert (r["von"], r["bis"]) == (heat["von"], heat["bis"]) == ("2026-10", "2026-10")
    older = rankings(ranked, typ="bahnhoefe", min_n=15, von="2026-09")
    assert older["von"] == "2026-09"
    assert [e["n"] for e in older["beste"] if e["name"] == "Anna"] == [200]


@pytest.mark.parametrize(
    "metrik, best, worst",
    [
        ("puenktlich", ["Cora", "Anna", "Bert"], ["Bert", "Anna", "Cora"]),  # higher is better
        ("median", ["Anna", "Bert", "Cora"], ["Anna", "Bert", "Cora"]),  # all 0: ties by n, name
        ("p90", ["Anna", "Cora", "Bert"], ["Bert", "Anna", "Cora"]),  # lower is better
        ("ausfallquote", ["Anna", "Bert", "Cora"], ["Cora", "Anna", "Bert"]),
    ],
)
def test_order_follows_the_metric_direction(ranked: TestClient, metrik, best, worst):
    r = rankings(ranked, typ="bahnhoefe", min_n=15, metrik=metrik)
    assert (names(r["beste"]), names(r["schlechteste"])) == (best, worst)


def test_min_n_leaves_entries_out(ranked: TestClient):
    r = rankings(ranked, typ="bahnhoefe", min_n=50)
    assert (r["anzahl"], names(r["beste"])) == (2, ["Anna", "Bert"])
    assert all(e["n"] >= 50 for e in r["beste"] + r["schlechteste"])
    assert rankings(ranked, typ="bahnhoefe", min_n=500)["anzahl"] == 0


def test_entries_without_a_value_are_left_out(ranked: TestClient, tmp_path, monkeypatch):
    # only cancelled stops: no median, p90 or punctuality
    path = tmp_path / "cancelled.parquet"
    frame(
        [(0, 8, "regional", "10", "2026-10", None, 40)],
        ["weekday", "hour", "gruppe", "eva", "month", "bucket", "n"],
    ).cast({"bucket": pl.Int32}).write_parquet(path)
    monkeypatch.setattr(main, "AGG_PATH", str(path))
    assert rankings(ranked, typ="bahnhoefe", min_n=15, metrik="median")["anzahl"] == 0
    assert rankings(ranked, typ="bahnhoefe", min_n=15, metrik="ausfallquote")["anzahl"] == 1


def test_lines_carry_their_label_and_train_type(ranked: TestClient):
    r = rankings(ranked, typ="linien", min_n=15)
    assert r["anzahl"] == 3
    assert [(e["id"], e["name"], e["typ"]) for e in r["beste"]] == [
        ("ICE 1:10", "ICE 1", "ICE"),
        ("RE5:10", "RE5", "RE"),  # ties on punctuality go to the larger n
        ("S1:10", "S1 · Anna", "S"),
    ]
    assert rankings(ranked, typ="linien", min_n=50)["anzahl"] == 2


def flagged_lines(tmp_path, monkeypatch) -> None:
    """RE5 and S1 are lines, ICE 7 is a single train, S9 reports no live data."""
    frame(
        [
            ("RE5:10", "10", "regional", "2026-10", 10, 300),
            ("ICE 7:10", "10", "fern", "2026-10", 0, 100),
            ("S9:10", "10", "regional", "2026-10", 0, 600),
        ],
        ["linie", "eva", "gruppe", "month", "bucket", "n"],
    ).cast({"bucket": pl.Int32}).write_parquet(tmp_path / "f-lines.parquet")
    frame(
        [
            ("RE5:10", "RE5", "RE5", "RE", False, False),
            ("ICE 7:10", "ICE 7", "ICE 7 → Köln Hbf", "ICE", True, False),
            ("S9:10", "S9", "S9", "S", False, True),
        ],
        LINIEN_COLUMNS,
    ).write_parquet(tmp_path / "f-linien.parquet")
    monkeypatch.setattr(main, "LINES_PATH", str(tmp_path / "f-lines.parquet"))
    monkeypatch.setattr(main, "LINIEN_PATH", str(tmp_path / "f-linien.parquet"))


def test_lines_and_single_trains_rank_apart(ranked: TestClient, tmp_path, monkeypatch):
    flagged_lines(tmp_path, monkeypatch)
    assert names(rankings(ranked, typ="linien", min_n=15)["beste"]) == ["RE5"]  # default: Linien
    assert names(rankings(ranked, typ="linien", min_n=15, art="linien")["beste"]) == ["RE5"]
    zuege = rankings(ranked, typ="linien", min_n=15, art="zuege")  # after the Linien: same cache
    assert names(zuege["beste"]) == ["ICE 7 → Köln Hbf"]
    assert zuege["anzahl"] == 1


def test_a_line_without_live_data_never_ranks(ranked: TestClient, tmp_path, monkeypatch):
    flagged_lines(tmp_path, monkeypatch)
    for art in ("linien", "zuege"):
        assert "S9" not in names(rankings(ranked, typ="linien", min_n=15, art=art)["beste"])
    # the period still reports what the lines cover
    assert rankings(ranked, typ="linien", min_n=15)["von"] == "2026-10"


def test_art_does_not_change_the_station_rankings(ranked: TestClient):
    plain = rankings(ranked, typ="bahnhoefe", min_n=15)
    assert rankings(ranked, typ="bahnhoefe", min_n=15, art="zuege") == plain


def test_cache_follows_a_rewritten_aggregate(ranked: TestClient):
    before = rankings(ranked, typ="bahnhoefe", min_n=15)
    assert names(before["beste"])[0] == "Cora"
    pl.DataFrame(
        [(0, 8, "regional", "20", "2026-10", 0, 100)],
        schema={
            "weekday": pl.Int64,
            "hour": pl.Int64,
            "gruppe": pl.String,
            "eva": pl.String,
            "month": pl.String,
            "bucket": pl.Int32,
            "n": pl.Int64,
        },
        orient="row",
    ).write_parquet(main.AGG_PATH)
    stat = os.stat(main.AGG_PATH)
    os.utime(main.AGG_PATH, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
    after = rankings(ranked, typ="bahnhoefe", min_n=15)
    assert (after["anzahl"], names(after["beste"])) == (1, ["Bert"])


def test_lines_follow_gattung_and_period(ranked: TestClient):
    assert names(rankings(ranked, typ="linien", min_n=15, gattung="fern")["beste"]) == ["ICE 1"]
    older = rankings(ranked, typ="linien", min_n=15, von="2026-09")
    assert "RB9" in names(older["beste"])
    assert "RB9" not in names(rankings(ranked, typ="linien", min_n=15)["beste"])


def test_empty_selection(ranked: TestClient):
    r = rankings(ranked, typ="linien", min_n=15, von="2027-01")
    assert (r["von"], r["bis"], r["anzahl"], r["beste"], r["schlechteste"]) == ("", "", 0, [], [])


def test_at_most_ten_entries(ranked: TestClient, tmp_path, monkeypatch):
    path = tmp_path / "many.parquet"
    rows = [(0, 8, "regional", str(i), "2026-10", 0, 20 + i) for i in range(25)]
    frame(rows, ["weekday", "hour", "gruppe", "eva", "month", "bucket", "n"]).cast(
        {"bucket": pl.Int32}
    ).write_parquet(path)
    stations = tmp_path / "many-stations.parquet"
    frame(
        [(str(i), f"S{i:02}", 1, None) for i in range(25)], ["eva", "name", "n", "land"]
    ).write_parquet(stations)
    monkeypatch.setattr(main, "AGG_PATH", str(path))
    monkeypatch.setattr(main, "STATIONS_PATH", str(stations))
    r = rankings(ranked, typ="bahnhoefe", min_n=15)
    assert (r["anzahl"], len(r["beste"]), len(r["schlechteste"])) == (25, 10, 10)


@pytest.mark.parametrize(
    "params",
    [
        {},  # typ is required
        {"typ": "zuege"},
        {"typ": "linien", "metrik": "mittel"},
        {"typ": "linien", "art": "alle"},
        {"typ": "linien", "min_n": 14},
        {"typ": "linien", "min_n": "x"},
        {"typ": "linien", "gattung": "bahn"},
        {"typ": "linien", "von": "2026-9"},
    ],
)
def test_invalid_input_is_422(client: TestClient, params: dict):
    assert client.get("/rankings", params=params).status_code == 422


def station_lines(client: TestClient, eva: str, **params) -> list[dict]:
    r = client.get(f"/stationen/{eva}/linien", params=params)
    assert r.status_code == 200
    return r.json()


def test_station_lines_worst_first(ranked: TestClient):
    lines = station_lines(ranked, "10")
    assert [(x["linie"], x["name"], x["typ"], x["n"]) for x in lines] == [
        ("RE5:10", "RE5", "RE", 300),  # 0.0
        ("S1:10", "S1 · Anna", "S", 20),  # 0.5
        ("ICE 1:10", "ICE 1", "ICE", 100),  # 1.0
    ]
    assert lines[0]["puenktlich"] == 0.0
    assert lines[0]["ausfallquote"] == 0.0


def test_station_lines_follow_gattung_and_period(ranked: TestClient):
    assert [x["linie"] for x in station_lines(ranked, "10", gattung="fern")] == ["ICE 1:10"]
    assert [x["linie"] for x in station_lines(ranked, "10", von="2026-09")][-1] == "RB9:10"
    assert station_lines(ranked, "10", von="2027-01") == []


def test_station_lines_without_a_value_come_last(ranked: TestClient, tmp_path, monkeypatch):
    path = tmp_path / "cancelled-lines.parquet"
    frame(
        [
            ("ICE 1:10", "10", "fern", "2026-10", None, 5),
            ("S1:10", "10", "regional", "2026-10", 0, 5),
        ],
        ["linie", "eva", "gruppe", "month", "bucket", "n"],
    ).cast({"bucket": pl.Int32}).write_parquet(path)
    monkeypatch.setattr(main, "LINES_PATH", str(path))
    lines = station_lines(ranked, "10")
    assert [(x["linie"], x["puenktlich"]) for x in lines] == [("S1:10", 1.0), ("ICE 1:10", None)]


def test_station_lines_with_too_little_data_come_last(ranked: TestClient, tmp_path, monkeypatch):
    # the UI shows "–" below 15 stops and below 15 arrived stops: those lines must not lead
    path = tmp_path / "thin-lines.parquet"
    frame(
        [
            ("S1:10", "10", "regional", "2026-10", 10, 3),  # 3 stops, 0 %: would sort first
            ("ICE 1:10", "10", "fern", "2026-10", 0, 8),  # 20 stops, 8 arrived, 100 %
            ("ICE 1:10", "10", "fern", "2026-10", None, 12),
            ("RE5:10", "10", "regional", "2026-10", 10, 20),  # 20 stops, 0 %
            ("RE5:10", "10", "regional", "2026-10", 0, 20),  # RE5: 40 stops, 50 %
            ("RB9:10", "10", "regional", "2026-10", 10, 15),  # 15 stops, 0 %
        ],
        ["linie", "eva", "gruppe", "month", "bucket", "n"],
    ).cast({"bucket": pl.Int32}).write_parquet(path)
    monkeypatch.setattr(main, "LINES_PATH", str(path))
    lines = station_lines(ranked, "10")
    assert [x["linie"] for x in lines] == ["RB9:10", "RE5:10", "S1:10", "ICE 1:10"]  # kept order


def test_station_lines_unknown_station_is_404(ranked: TestClient):
    assert ranked.get("/stationen/999/linien").status_code == 404
    assert ranked.get("/stationen/40/linien").status_code == 404  # unnamed
    assert ranked.get("/stationen/abc/linien").status_code == 422


def test_pipeline_built_mini_lines(client: TestClient):
    """The client's lines come from the pipeline's combine step over the mini source."""
    lines = station_lines(client, "1")
    assert [(x["linie"], x["name"], x["typ"], x["n"]) for x in lines] == [
        ("ICE 123:1", "ICE 123 → Kassel-Wilhelmshöhe", "ICE", 1),  # +10: not punctual
        ("RE5:1", "RE5 Dortmund Hbf – Warburg (Westf)", "RE", 4),  # 0, 0, +7 and a cancellation
    ]
    assert lines[0]["puenktlich"] == 0.0
    assert [x["linie"] for x in station_lines(client, "1", gattung="fern")] == ["ICE 123:1"]
    assert [x["linie"] for x in station_lines(client, "08000002")] == ["RE5:08000002"]


# Sections and records. Anna 10, Bert 20, Cora 30 and the unnamed 40 are the ranked fixture's
# stations. Each line runs along its axis; S1 runs against RE5's and ICE 1's direction.
AXES = {
    "RE5:10": ["10", "20", "30", "40"],
    "ICE 1:10": ["10", "20"],
    "S1:10": ["20", "10"],
    "RB9:10": ["10", "20"],
    "S9:10": ["10", "20"],
}
SECTION_COLUMNS = ["linie", "from_eva", "to_eva", "month", "n", "minutes"]
SECTIONS = [  # (linie, from, to, month, n, minutes)
    ("RE5:10", "10", "20", "2026-10", 300, 600),  # +2.0
    ("RE5:10", "20", "10", "2026-10", 300, -300),  # -1.0
    ("RE5:10", "20", "30", "2026-10", 500, -50),  # -0.1
    ("RE5:10", "30", "40", "2026-10", 500, 100),  # the unnamed 40: left out
    ("RE5:10", "10", "30", "2026-10", 40, 40),  # skips Bert: no place on the axis
    ("ICE 1:10", "10", "20", "2026-10", 100, 500),  # +5.0
    ("S1:10", "10", "20", "2026-10", 20, 20),  # 10 to 20 pooled: 420 trips, +2.67
    ("RB9:10", "10", "20", "2026-09", 50, 0),  # outside the default period
    ("S9:10", "10", "20", "2026-10", 1000, 9000),  # no live data: left out
]


def write_sections(path, rows: list[tuple]) -> None:
    frame(rows, SECTION_COLUMNS).cast({"n": pl.UInt32, "minutes": pl.Int64}).write_parquet(path)


@pytest.fixture
def sektionen(ranked: TestClient, tmp_path, monkeypatch) -> TestClient:
    frame(
        [(linie, pos, eva) for linie, axis in AXES.items() for pos, eva in enumerate(axis)],
        ["linie", "pos", "eva"],
    ).cast({"pos": pl.Int32}).write_parquet(tmp_path / "s-weg.parquet")
    write_sections(tmp_path / "s-abschnitte.parquet", SECTIONS)
    linien = [(*row, False, False) for row in LINIEN] + [("S9:10", "S9", "S9", "S", False, True)]
    frame(linien, LINIEN_COLUMNS).write_parquet(tmp_path / "s-linien.parquet")
    monkeypatch.setattr(main, "LINIEN_PATH", str(tmp_path / "s-linien.parquet"))
    monkeypatch.setattr(main, "LINIENWEG_PATH", str(tmp_path / "s-weg.parquet"))
    monkeypatch.setattr(main, "ABSCHNITTE_PATH", str(tmp_path / "s-abschnitte.parquet"))
    return ranked


def sections(client: TestClient, **params) -> dict:
    r = client.get("/rankings/abschnitte", params={"min_n": 100, **params})
    assert r.status_code == 200
    return r.json()


def pair(e: dict) -> str:
    return f"{e['von_name']}>{e['nach_name']}"


def test_sections_pool_over_the_lines_and_keep_each_direction(sektionen: TestClient):
    r = sections(sektionen)
    assert (r["min_n"], r["von"], r["bis"], r["anzahl"]) == (100, "2026-10", "2026-10", 3)
    assert [pair(e) for e in r["schlechteste"]] == ["Anna>Bert", "Bert>Cora", "Bert>Anna"]
    assert [pair(e) for e in r["beste"]] == ["Bert>Anna", "Bert>Cora", "Anna>Bert"]
    worst = r["schlechteste"][0]
    assert (worst["von_eva"], worst["nach_eva"]) == ("10", "20")
    assert (worst["n"], worst["minuten"], worst["linien_anzahl"]) == (420, 2.67, 3)
    assert r["beste"][0]["minuten"] == -1.0


def test_a_section_names_its_busiest_lines_with_their_direction(sektionen: TestClient):
    r = sections(sektionen)
    assert r["schlechteste"][0]["linien"] == [  # S1 runs 20 to 10: the section is its richtung 2
        {"id": "RE5:10", "label": "RE5", "n": 300, "richtung": 1},
        {"id": "ICE 1:10", "label": "ICE 1", "n": 100, "richtung": 1},
        {"id": "S1:10", "label": "S1 · Anna", "n": 20, "richtung": 2},
    ]
    assert [(x["id"], x["richtung"]) for x in r["beste"][0]["linien"]] == [("RE5:10", 2)]


def test_only_the_three_busiest_lines_are_named(sektionen: TestClient, tmp_path, monkeypatch):
    rows = [(f"L{i}:10", "10", "20", "2026-10", 10 * (i + 1), 0) for i in range(5)]
    write_sections(tmp_path / "many-lines.parquet", rows)
    linien = [(f"L{i}:10", f"L{i}", f"L{i}", "L", False, False) for i in range(5)]
    frame(linien, LINIEN_COLUMNS).write_parquet(tmp_path / "many-linien.parquet")
    monkeypatch.setattr(main, "ABSCHNITTE_PATH", str(tmp_path / "many-lines.parquet"))
    monkeypatch.setattr(main, "LINIEN_PATH", str(tmp_path / "many-linien.parquet"))
    only = sections(sektionen, min_n=15)["schlechteste"][0]
    assert (only["n"], only["linien_anzahl"]) == (150, 5)
    assert [x["id"] for x in only["linien"]] == ["L4:10", "L3:10", "L2:10"]
    assert {x["richtung"] for x in only["linien"]} == {None}  # no axis rows for them


def test_a_section_off_the_axis_has_no_richtung(sektionen: TestClient):
    shown = sections(sektionen, min_n=15)["schlechteste"]
    skip = next(e for e in shown if pair(e) == "Anna>Cora")
    assert skip["n"] == 40
    assert skip["linien"][0]["richtung"] is None


def test_min_n_period_and_unnamed_stations(sektionen: TestClient):
    r = sections(sektionen, min_n=500)
    assert [(pair(e), e["n"]) for e in r["schlechteste"]] == [("Bert>Cora", 500)]  # not 30 to 40
    older = sections(sektionen, von="2026-09", bis="2026-09", min_n=50)
    assert [(pair(e), e["n"]) for e in older["schlechteste"]] == [("Anna>Bert", 50)]
    assert (older["von"], older["bis"]) == ("2026-09", "2026-09")


def test_lines_without_live_data_are_left_out_of_the_sections(sektionen: TestClient):
    n = [e["n"] for e in sections(sektionen)["schlechteste"] if pair(e) == "Anna>Bert"]
    assert n == [420]  # not 1420


def test_sections_follow_the_gattung(sektionen: TestClient):
    fern = sections(sektionen, gattung="fern")
    assert [(pair(e), e["n"], e["minuten"]) for e in fern["schlechteste"]] == [
        ("Anna>Bert", 100, 5.0)
    ]
    regional = sections(sektionen, gattung="regional")
    assert [e["n"] for e in regional["schlechteste"] if pair(e) == "Anna>Bert"] == [320]


def test_equal_sections_go_to_the_larger_n_then_the_names(
    sektionen: TestClient, tmp_path, monkeypatch
):
    rows = [
        ("RE5:10", "10", "20", "2026-10", 100, 100),
        ("RE5:10", "20", "30", "2026-10", 200, 200),
        ("RE5:10", "20", "10", "2026-10", 200, 200),
    ]
    write_sections(tmp_path / "ties.parquet", rows)
    monkeypatch.setattr(main, "ABSCHNITTE_PATH", str(tmp_path / "ties.parquet"))
    r = sections(sektionen)
    assert [pair(e) for e in r["schlechteste"]] == ["Bert>Anna", "Bert>Cora", "Anna>Bert"]


def test_at_most_ten_sections_each_and_the_lists_overlap(
    sektionen: TestClient, tmp_path, monkeypatch
):
    rows = [("RE5:10", str(i), str(i + 1), "2026-10", 100, i * 100) for i in range(12)]
    write_sections(tmp_path / "twelve.parquet", rows)
    names = [(str(i), f"S{i:02}", 1, None) for i in range(13)]
    frame(names, ["eva", "name", "n", "land"]).write_parquet(tmp_path / "twelve-stations.parquet")
    monkeypatch.setattr(main, "ABSCHNITTE_PATH", str(tmp_path / "twelve.parquet"))
    monkeypatch.setattr(main, "STATIONS_PATH", str(tmp_path / "twelve-stations.parquet"))
    r = sections(sektionen)
    assert (r["anzahl"], len(r["schlechteste"]), len(r["beste"])) == (12, 10, 10)
    assert r["schlechteste"][0]["minuten"] == 11.0
    assert r["beste"][0]["minuten"] == 0.0
    assert {e["von_eva"] for e in r["schlechteste"]} & {e["von_eva"] for e in r["beste"]}


def test_an_empty_period_has_no_sections(sektionen: TestClient):
    r = sections(sektionen, von="2027-01")
    assert (r["von"], r["bis"], r["anzahl"], r["schlechteste"], r["beste"]) == ("", "", 0, [], [])


def test_the_sections_cache_follows_a_rewritten_file(sektionen: TestClient):
    assert sections(sektionen)["anzahl"] == 3
    write_sections(main.ABSCHNITTE_PATH, [("RE5:10", "10", "20", "2026-10", 400, 400)])
    stat = os.stat(main.ABSCHNITTE_PATH)
    os.utime(main.ABSCHNITTE_PATH, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
    assert sections(sektionen)["anzahl"] == 1


@pytest.mark.parametrize(
    "params",
    [
        {"min_n": 14},
        {"min_n": "x"},
        {"gattung": "bahn"},
        {"von": "2026-9"},
        {"bis": "2026-13"},
    ],
)
def test_the_section_and_record_parameters_are_checked(client: TestClient, params: dict):
    assert client.get("/rankings/abschnitte", params=params).status_code == 422
    assert client.get("/rankings/rekorde", params={"art": "halte", **params}).status_code == 422


def test_records_need_a_known_art(client: TestClient):
    assert client.get("/rankings/rekorde").status_code == 422
    assert client.get("/rankings/rekorde", params={"art": "zuege"}).status_code == 422


def records(client: TestClient, **params) -> dict:
    r = client.get("/rankings/rekorde", params={"min_n": 15, **params})
    assert r.status_code == 200
    return r.json()


def test_stops_per_day_count_every_stop_over_the_days_of_the_period(ranked: TestClient):
    r = records(ranked, art="halte")
    assert (r["art"], r["min_n"], r["von"], r["bis"]) == ("halte", 15, "2026-10", "2026-10")
    assert r["anzahl"] == 3
    assert [(e["id"], e["name"], e["n"], e["wert"]) for e in r["meiste"]] == [
        # 130 stops in 31 days: the aggregate's 100 arrivals plus the 30 departures of its terminus
        ("20", "Bert", 130, 4.19),
        ("10", "Anna", 100, 3.23),
        ("30", "Cora", 40, 1.29),  # cancelled stops count: 20 + 20
    ]
    assert [e["name"] for e in r["wenigste"]] == ["Cora", "Anna", "Bert"]
    older = records(ranked, art="halte", von="2026-09")  # Anna's months: 30 + 31 days
    anna = next(e for e in older["meiste"] if e["name"] == "Anna")
    assert (anna["n"], anna["wert"]) == (200, 3.28)


def test_stop_records_follow_min_n_and_gattung(ranked: TestClient):
    assert records(ranked, art="halte", min_n=50)["anzahl"] == 2
    fern = records(ranked, art="halte", gattung="fern")
    assert [(e["name"], e["wert"]) for e in fern["meiste"]] == [("Cora", 1.29)]


def test_an_empty_period_has_no_records(ranked: TestClient):
    r = records(ranked, art="halte", von="2027-01")
    assert (r["von"], r["bis"], r["anzahl"], r["meiste"], r["wenigste"]) == ("", "", 0, [], [])
    assert records(ranked, art="takt", von="2027-01")["anzahl"] == 0


@pytest.fixture
def takt(ranked: TestClient, tmp_path, monkeypatch) -> TestClient:
    """RE5 and ICE 1 are lines, S1 has no trips, ICE 7 is a single train, S9 has no live data."""
    lines = [
        *LINES,
        ("RE5:10", "10", "regional", "2026-09", 0, 50),  # RE5 ran in September too
        ("ICE 7:10", "10", "fern", "2026-10", 0, 100),
        ("S9:10", "10", "regional", "2026-10", 0, 600),
    ]
    frame(lines, ["linie", "eva", "gruppe", "month", "bucket", "n"]).cast(
        {"bucket": pl.Int32}
    ).write_parquet(tmp_path / "t-lines.parquet")
    linien = [(*row, False, False) for row in LINIEN]
    linien += [("ICE 7:10", "ICE 7", "ICE 7 → Köln Hbf", "ICE", True, False)]
    linien += [("S9:10", "S9", "S9", "S", False, True)]
    frame(linien, LINIEN_COLUMNS).write_parquet(tmp_path / "t-linien.parquet")
    trips = [
        ("RE5:10", "regional", "2026-10", 620),
        ("RE5:10", "regional", "2026-09", 1000),  # outside the default period
        ("ICE 1:10", "fern", "2026-10", 100),
        ("ICE 7:10", "fern", "2026-10", 50),
        ("S9:10", "regional", "2026-10", 400),
    ]
    frame(trips, ["linie", "gruppe", "month", "trips"]).cast({"trips": pl.UInt32}).write_parquet(
        tmp_path / "t-takt.parquet"
    )
    monkeypatch.setattr(main, "LINES_PATH", str(tmp_path / "t-lines.parquet"))
    monkeypatch.setattr(main, "LINIEN_PATH", str(tmp_path / "t-linien.parquet"))
    monkeypatch.setattr(main, "TAKT_PATH", str(tmp_path / "t-takt.parquet"))
    return ranked


def test_trips_per_hour_of_service_come_from_the_takt_table(takt: TestClient):
    r = records(takt, art="takt")
    assert (r["von"], r["bis"], r["anzahl"]) == ("2026-10", "2026-10", 2)
    assert [(e["id"], e["name"], e["n"], e["wert"]) for e in r["meiste"]] == [
        ("RE5:10", "RE5", 600, 1.25),  # 620 trips in 31 days of 16 hours
        ("ICE 1:10", "ICE 1", 100, 0.2),
    ]  # S1 has no trips in the service hours: it is no record
    assert [e["name"] for e in r["wenigste"]] == ["ICE 1", "RE5"]


def test_trip_records_follow_min_n_gattung_and_period(takt: TestClient):
    assert [e["name"] for e in records(takt, art="takt", min_n=50)["meiste"]] == ["RE5", "ICE 1"]
    fern = records(takt, art="takt", gattung="fern")
    assert [(e["name"], e["wert"]) for e in fern["meiste"]] == [("ICE 1", 0.2)]
    older = records(takt, art="takt", von="2026-09")  # RE5: 1620 trips in its 61 days
    re5 = next(e for e in older["meiste"] if e["id"] == "RE5:10")
    assert (re5["n"], re5["wert"]) == (650, 1.66)


def test_the_record_cache_follows_a_rewritten_halte_file(ranked: TestClient):
    assert records(ranked, art="halte")["anzahl"] == 3
    pl.DataFrame(
        [("20", "regional", "2026-10", 100)],
        schema={"eva": pl.String, "gruppe": pl.String, "month": pl.String, "n": pl.UInt32},
        orient="row",
    ).write_parquet(main.HALTE_PATH)
    stat = os.stat(main.HALTE_PATH)
    os.utime(main.HALTE_PATH, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
    assert [e["name"] for e in records(ranked, art="halte")["meiste"]] == ["Bert"]


def test_a_station_is_divided_by_the_days_of_its_own_months(ranked: TestClient):
    pl.DataFrame(
        [  # (eva, gruppe, month, n): Anna all three months, Bert only September, 4 stops a day
            ("10", "regional", "2026-08", 124),
            ("10", "regional", "2026-09", 120),
            ("10", "regional", "2026-10", 124),
            ("20", "regional", "2026-09", 120),
        ],
        schema={"eva": pl.String, "gruppe": pl.String, "month": pl.String, "n": pl.UInt32},
        orient="row",
    ).write_parquet(main.HALTE_PATH)
    r = records(ranked, art="halte", von="2026-08", bis="2026-10")
    assert {e["name"]: e["wert"] for e in r["meiste"]} == {"Anna": 4.0, "Bert": 4.0}


def write_takt(
    tmp_path, monkeypatch, stops: list[tuple[str, str, int]], trips: list[tuple[str, str, int]]
) -> None:
    """Point the records at lines made of `stops` (linie, month, n) and `trips` (linie, month,
    trips); every line is a regular regional line with live data."""
    frame([(lin, "10", "regional", m, 0, n) for lin, m, n in stops], LINES_COLUMNS).cast(
        {"bucket": pl.Int32}
    ).write_parquet(tmp_path / "w-lines.parquet")
    linien = [(lin, lin, lin, "RE", False, False) for lin in sorted({s[0] for s in stops})]
    frame(linien, LINIEN_COLUMNS).write_parquet(tmp_path / "w-linien.parquet")
    frame(
        [(lin, "regional", m, t) for lin, m, t in trips], ["linie", "gruppe", "month", "trips"]
    ).cast({"trips": pl.UInt32}).write_parquet(tmp_path / "w-takt.parquet")
    for name, file in [
        ("LINES_PATH", "w-lines"),
        ("LINIEN_PATH", "w-linien"),
        ("TAKT_PATH", "w-takt"),
    ]:
        monkeypatch.setattr(main, name, str(tmp_path / f"{file}.parquet"))


def test_a_line_is_divided_by_the_days_of_the_months_it_ran(
    ranked: TestClient, tmp_path, monkeypatch
):
    write_takt(
        tmp_path,
        monkeypatch,
        stops=[("FULL", m, 100) for m in ("2026-08", "2026-09", "2026-10")]
        + [("PART", "2026-09", 100)],
        # 8 trips a day, i.e. 0.5 an hour of service, for the days of each line's months
        trips=[("FULL", "2026-08", 248), ("FULL", "2026-09", 240), ("FULL", "2026-10", 248)]
        + [("PART", "2026-09", 240)],
    )
    r = records(ranked, art="takt", von="2026-08", bis="2026-10")
    assert {e["name"]: e["wert"] for e in r["meiste"]} == {"FULL": 0.5, "PART": 0.5}


def test_a_close_tie_in_the_rounded_value_is_ordered_by_the_unrounded_one(
    ranked: TestClient, tmp_path, monkeypatch
):
    write_takt(
        tmp_path,
        monkeypatch,
        stops=[("BIG", "2026-10", 600), ("SMALL", "2026-10", 20)],
        # 31 days of 16 hours: 10 trips are 0.0202 an hour, 11 trips 0.0222; both round to 0.02
        trips=[("BIG", "2026-10", 10), ("SMALL", "2026-10", 11)],
    )
    r = records(ranked, art="takt")
    assert [(e["name"], e["wert"]) for e in r["meiste"]] == [("SMALL", 0.02), ("BIG", 0.02)]
    assert [e["name"] for e in r["wenigste"]] == ["BIG", "SMALL"]


def test_a_line_without_trips_in_the_service_hours_is_no_record(
    ranked: TestClient, tmp_path, monkeypatch
):
    write_takt(
        tmp_path,
        monkeypatch,
        stops=[("DAY", "2026-10", 100), ("NIGHT", "2026-10", 100)],
        trips=[("DAY", "2026-10", 62)],
    )
    r = records(ranked, art="takt")
    assert r["anzahl"] == 1
    assert [e["name"] for e in r["wenigste"]] == ["DAY"]
