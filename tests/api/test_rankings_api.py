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
    for name, file in [
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
