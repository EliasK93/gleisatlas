from collections.abc import Sequence
from datetime import date, datetime

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


DAY = date(2026, 10, 14)
OTHER_DAY, LAST_DAY, EMPTY_DAY = date(2026, 10, 13), date(2026, 10, 16), date(2026, 10, 15)


def at(day: date, hhmm: str | None) -> datetime | None:
    if hhmm is None:
        return None
    return datetime.fromisoformat(f"{day.isoformat()}T{hhmm}")


def minutes(time: str, since: pl.Expr) -> pl.Expr:
    return (pl.col(time) - since).dt.total_minutes().cast(pl.Int16)


def write_fahrten(tmp_path, monkeypatch) -> None:
    """A trip table: RE5:1 on DAY (three trips whose ids sort against their departures) and on
    LAST_DAY, another line on OTHER_DAY. A stop is (num, eva, planned and changed arrival, planned
    and changed departure, arrival cancelled)."""
    rows = []

    def trip(linie, day, trip_id, zug, stops):
        for num, eva, ap, ac, dp, dc, canceled in stops:
            rows.append((linie, day, trip_id, zug, num, eva, ap, ac, dp, dc, canceled, False))

    def times(day, *hhmm):
        return [at(day, t) for t in hhmm]

    trip(LINIE, DAY, "z-first", "RE 1", [
        (0, "1", *times(DAY, None, None, "08:00", "08:02"), False),
        (1, BETA, *times(DAY, "08:30", "08:31", "08:31", None), True),  # arrival cancelled
    ])  # fmt: skip
    trip(LINIE, DAY, "a-second", "RE 2", [
        (0, "1", *times(DAY, None, None, "09:00", None), False),
        (1, BETA, *times(DAY, "09:30", "09:35", "09:31", None), False),
    ])  # fmt: skip
    after = date(2026, 10, 15)
    trip(LINIE, DAY, "m-night", "RE 3", [
        (0, "1", *times(DAY, None, None, "23:50", None), False),
        (1, BETA, *times(after, "00:20", "00:25", None, None), False),
    ])  # fmt: skip
    for linie, day, trip_id, zug in [
        (LINIE, LAST_DAY, "later", "RE 4"),
        ("OTHER:1", OTHER_DAY, "o", "RE 9"),
    ]:
        trip(linie, day, trip_id, zug, [(0, "1", None, None, at(day, "07:00"), None, False)])
    pl.DataFrame(
        rows,
        schema={
            "linie": pl.String,
            "day": pl.Date,
            "trip": pl.String,
            "zug": pl.String,
            "num": pl.Int32,
            "eva": pl.String,
            "arrival_planned_time": pl.Datetime,
            "arrival_change_time": pl.Datetime,
            "departure_planned_time": pl.Datetime,
            "departure_change_time": pl.Datetime,
            "arrival_is_canceled": pl.Boolean,
            "departure_is_canceled": pl.Boolean,
        },
        orient="row",
    ).select(  # the stored form: minutes since the trip day and the delays (pipeline.update)
        "linie",
        "day",
        "trip",
        "zug",
        "num",
        "eva",
        an_plan=minutes("arrival_planned_time", pl.col("day").cast(pl.Datetime)),
        an_delay=minutes("arrival_change_time", pl.col("arrival_planned_time")),
        ab_plan=minutes("departure_planned_time", pl.col("day").cast(pl.Datetime)),
        ab_delay=minutes("departure_change_time", pl.col("departure_planned_time")),
        arrival_is_canceled="arrival_is_canceled",
        departure_is_canceled="departure_is_canceled",
    ).write_parquet(tmp_path / "fahrten.parquet")
    monkeypatch.setattr(main, "FAHRTEN_PATH", str(tmp_path / "fahrten.parquet"))


def fahrplan(client: TestClient, tag: date = DAY) -> list[dict]:
    r = client.get("/linie/fahrplan", params={"linie": LINIE, "tag": tag.isoformat()})
    assert r.status_code == 200
    assert r.json()["tag"] == tag.isoformat()
    return r.json()["fahrten"]


def halte(client: TestClient, zug: str) -> list[dict]:
    return next(f for f in fahrplan(client) if f["zug"] == zug)["halte"]


def test_a_trip_has_its_stops_in_order_with_minutes_since_midnight(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)
    assert halte(client, "RE 2") == [
        {
            "eva": "1",
            "an_plan": None, "an_ist": None, "ab_plan": 540, "ab_ist": 540,
            "ausfall_an": False, "ausfall_ab": False,
        },
        {
            "eva": BETA,
            "an_plan": 570, "an_ist": 575, "ab_plan": 571, "ab_ist": 571,
            "ausfall_an": False, "ausfall_ab": False,
        },
    ]  # fmt: skip


def test_the_actual_time_is_the_change_time_else_the_planned_time(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)
    first = halte(client, "RE 1")[0]
    assert (first["ab_plan"], first["ab_ist"]) == (480, 482)  # changed
    second = halte(client, "RE 2")[0]
    assert (second["ab_plan"], second["ab_ist"]) == (540, 540)  # no change: on time


def test_a_cancelled_stop_has_no_actual_time_and_its_flag(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)
    stop = halte(client, "RE 1")[1]
    assert (stop["an_plan"], stop["an_ist"], stop["ausfall_an"]) == (510, None, True)
    assert (stop["ab_ist"], stop["ausfall_ab"]) == (511, False)


def test_a_trip_past_midnight_counts_minutes_beyond_1440(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)
    night = halte(client, "RE 3")
    assert (night[0]["ab_plan"], night[1]["an_plan"], night[1]["an_ist"]) == (1430, 1460, 1465)


def test_trips_come_in_the_order_of_their_first_departure(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)  # the ids sort a-second, m-night, z-first
    assert [f["zug"] for f in fahrplan(client)] == ["RE 1", "RE 2", "RE 3"]


def test_other_lines_and_other_days_are_not_returned(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)
    assert [f["zug"] for f in fahrplan(client, LAST_DAY)] == ["RE 4"]
    assert fahrplan(client, EMPTY_DAY) == []  # nothing ran, inside the line's window


def test_the_line_names_the_window_of_its_own_trips(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)
    body = seite(client)  # the other line's OTHER_DAY does not count
    assert (body["fahrplan_von"], body["fahrplan_bis"]) == ("2026-10-14", "2026-10-16")
    monkeypatch.setattr(main, "FAHRTEN_PATH", str(tmp_path / "missing.parquet"))
    body = seite(client)
    assert (body["fahrplan_von"], body["fahrplan_bis"]) == (None, None)


def test_a_day_outside_the_window_is_a_422_with_the_window(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)
    for tag in (OTHER_DAY.isoformat(), "2026-10-17"):  # OTHER_DAY: only another line ran
        r = client.get("/linie/fahrplan", params={"linie": LINIE, "tag": tag})
        assert r.status_code == 422
        assert "2026-10-14" in r.json()["detail"] and "2026-10-16" in r.json()["detail"]


def test_a_line_without_trips_has_no_window_and_no_day(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)
    others = pl.read_parquet(main.FAHRTEN_PATH).filter(pl.col("linie") != LINIE)
    others.write_parquet(tmp_path / "others.parquet")
    monkeypatch.setattr(main, "FAHRTEN_PATH", str(tmp_path / "others.parquet"))
    body = seite(client)
    assert (body["fahrplan_von"], body["fahrplan_bis"]) == (None, None)
    r = client.get("/linie/fahrplan", params={"linie": LINIE, "tag": OTHER_DAY.isoformat()})
    assert (r.status_code, r.json()["detail"]) == (422, "No trips for that day; available: none")


def test_without_a_trip_table_every_day_is_a_422(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "FAHRTEN_PATH", str(tmp_path / "missing.parquet"))
    r = client.get("/linie/fahrplan", params={"linie": LINIE, "tag": "2026-10-14"})
    assert r.status_code == 422


def test_the_fahrplan_parameters_are_checked(client, tmp_path, monkeypatch):
    write_fahrten(tmp_path, monkeypatch)
    path = "/linie/fahrplan"
    assert client.get(path, params={"linie": LINIE}).status_code == 422  # no tag
    for tag in ("x", "2026-13-01", "2026-02-30"):
        assert client.get(path, params={"linie": LINIE, "tag": tag}).status_code == 422
    assert client.get(path, params={"linie": "x" * 201, "tag": "2026-10-14"}).status_code == 422
    r = client.get(path, params={"linie": "nope", "tag": "2026-10-14"})
    assert (r.status_code, r.json()["detail"]) == (404, "Unknown line")
