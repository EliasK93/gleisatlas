import os
from datetime import UTC, date, datetime, timedelta

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from core.normal import reference_days
from tests.api.test_tageskarte_api import (
    DAY,
    FIRST,
    LAST,
    NO_NORMAL,
    tageskarte,
    varying,
    write_days,
    write_stations,
)
from tests.conftest import BETA

# "Today" is Tuesday 2026-06-02, the day after the last complete day. The collector ran at 12:37
# local time (CEST, 10:37 UTC), so the cut is hour 12. The twelve reference Tuesdays run back to
# 2026-03-17. Station "1" is a large station, BETA has no coordinates, "2" has coordinates but no
# data today.

TODAY = LAST + timedelta(days=2)
STAND = datetime(2026, 6, 2, 10, 37, tzinfo=UTC)
REST_STAND = datetime(2026, 6, 2, 7, 37, tzinfo=UTC)  # 09:37 local: cut 9
DAY_HOURS_SCHEMA = {
    "day": pl.Date,
    "hour": pl.Int8,
    "gruppe": pl.String,
    "eva": pl.String,
    "bucket": pl.Int32,
    "n": pl.UInt32,
}
HEUTE_SCHEMA = {**DAY_HOURS_SCHEMA, "stand": pl.Datetime("us", "UTC")}


@pytest.fixture(autouse=True)
def fresh_caches():
    main._frame.cache_clear()
    main.tageskarte_for.cache_clear()
    yield
    main._frame.cache_clear()
    main.tageskarte_for.cache_clear()


def reference_rows():
    """Station 1: 90 on time and 10 late before the cut, 1000 cancelled after it. BETA: 100 late
    before the cut. Every reference Tuesday looks the same."""
    rows = []
    d = date(2026, 2, 10)
    while d <= LAST:
        if d.weekday() == 1:
            rows += [
                (d, 5, "regional", "1", 0, 90),
                (d, 5, "regional", "1", 20, 10),
                (d, 20, "regional", "1", None, 1000),
                (d, 5, "regional", BETA, 20, 100),
                (d, 5, "regional", "2", 0, 80),
                (d, 5, "regional", "2", 20, 20),
                (d, 10, "regional", "2", None, 1000),
            ]
        d += timedelta(7)
    return rows


def today_rows():
    return [
        (TODAY, 5, "regional", "1", 0, 30),
        (TODAY, 5, "regional", "1", 20, 10),
        (TODAY, 9, "regional", "1", 0, 20),
        (TODAY, 9, "regional", "1", 20, 40),
    ]


def rest_rows():
    """The other stations from piebro's raw data, up to 09:37 local (cut 9): station 2 is small,
    station 1 is also here but is live, so its live values win."""
    return [
        (TODAY, 5, "regional", "1", 0, 5),
        (TODAY, 5, "regional", "2", 0, 30),
        (TODAY, 5, "regional", "2", 20, 10),
        (TODAY, 8, "regional", "2", 0, 20),
        (TODAY, 8, "regional", "2", 20, 40),
    ]


def write_heute(tmp_path, monkeypatch, rows, stand=STAND, now=STAND + timedelta(minutes=10)):
    pl.DataFrame([(*r, stand) for r in rows], schema=HEUTE_SCHEMA, orient="row").write_parquet(
        tmp_path / "heute.parquet"
    )
    monkeypatch.setattr(main, "HEUTE_PATH", str(tmp_path / "heute.parquet"))
    monkeypatch.setattr(main, "now", lambda: now)


def write_rest(tmp_path, monkeypatch, rows, stand=REST_STAND):
    pl.DataFrame([(*r, stand) for r in rows], schema=HEUTE_SCHEMA, orient="row").write_parquet(
        tmp_path / "heute_rest.parquet"
    )
    monkeypatch.setattr(main, "HEUTE_REST_PATH", str(tmp_path / "heute_rest.parquet"))


@pytest.fixture
def base(client: TestClient, tmp_path, monkeypatch) -> TestClient:
    """Reference days, stations and the clock; no live or rest file yet. Stations 1, 2 and BETA are
    large; station 2 has stops in February only, so no past day lists it."""

    def stops(d: date, eva: str) -> tuple[int, int, int]:
        return (0, 0, 0) if eva == "2" and d.month != 2 else varying(d, eva)

    write_days(client, tmp_path, monkeypatch, stops, evas=("1", "2", BETA))
    pl.DataFrame(reference_rows(), schema=DAY_HOURS_SCHEMA, orient="row").write_parquet(
        tmp_path / "day_hours.parquet"
    )
    monkeypatch.setattr(main, "DAY_HOURS_PATH", str(tmp_path / "day_hours.parquet"))
    pl.DataFrame(
        {
            "eva": ["1", "2", BETA],
            "name": ["Alpha", "Gamma", "Beta"],
            "n": 1,
            "land": None,
            "lat": [50.0, 51.0, None],
            "lon": [7.0, 8.0, None],
        },
        schema_overrides={"lat": pl.Float64, "lon": pl.Float64, "land": pl.String},
    ).write_parquet(tmp_path / "stations2.parquet")
    monkeypatch.setattr(main, "STATIONS_PATH", str(tmp_path / "stations2.parquet"))
    monkeypatch.setattr(main, "now", lambda: STAND + timedelta(minutes=10))
    return client


@pytest.fixture
def live(base: TestClient, tmp_path, monkeypatch) -> TestClient:
    write_heute(tmp_path, monkeypatch, today_rows())
    return base


def no_today(client: TestClient):
    body = client.get("/datenstand").json()
    assert (body["heute"], body["heute_stand"], body["heute_stand_rest"]) == (None, None, None)
    assert body["letzter_tag"] == LAST.isoformat()
    assert client.get("/tageskarte", params={"tag": TODAY.isoformat()}).status_code == 404


def test_without_a_heute_file_there_is_no_today(client: TestClient, tmp_path, monkeypatch):
    write_days(client, tmp_path, monkeypatch, varying)
    no_today(client)


def test_a_heute_file_without_rows_is_no_today(live: TestClient, tmp_path, monkeypatch):
    write_heute(tmp_path, monkeypatch, [])
    no_today(live)


def test_a_stale_heute_file_is_no_today(live: TestClient, tmp_path, monkeypatch):
    write_heute(tmp_path, monkeypatch, today_rows(), now=STAND + timedelta(hours=3))
    no_today(live)


def test_after_local_midnight_yesterdays_file_is_no_today(live: TestClient, tmp_path, monkeypatch):
    stand = datetime(2026, 6, 2, 21, 50, tzinfo=UTC)  # 23:50 local, the file's day is 2026-06-02
    write_heute(tmp_path, monkeypatch, today_rows(), stand=stand, now=stand + timedelta(minutes=15))
    no_today(live)  # 00:05 local on 2026-06-03: fresh by age, but the day is over


def test_without_day_hours_there_is_no_today(live: TestClient, tmp_path, monkeypatch):
    # Azure downloads no day_hours.parquet and has no collector: a stray heute file is no today
    monkeypatch.setattr(main, "DAY_HOURS_PATH", str(tmp_path / "missing-day-hours.parquet"))
    no_today(live)


def test_a_rewritten_heute_file_is_served_without_clearing_any_cache(
    live: TestClient, tmp_path, monkeypatch
):
    body = live.get("/datenstand").json()
    assert datetime.fromisoformat(body["heute_stand"]) == STAND
    assert tageskarte(live, TODAY)["n"] == 100
    later = STAND + timedelta(minutes=15)
    write_heute(
        tmp_path,
        monkeypatch,
        [(TODAY, 5, "regional", "1", 0, 200)],
        stand=later,
        now=later + timedelta(minutes=5),
    )
    path = tmp_path / "heute.parquet"
    stamp = path.stat().st_mtime_ns + 1_000_000_000
    os.utime(path, ns=(stamp, stamp))  # a different mtime for sure, whatever the clock resolution
    body = live.get("/datenstand").json()
    assert datetime.fromisoformat(body["heute_stand"]) == later
    now_body = tageskarte(live, TODAY)
    assert datetime.fromisoformat(now_body["stand"]) == later
    assert (now_body["n"], now_body["deutschland"]["puenktlich"]) == (200, 1.0)


def test_a_heute_day_that_is_not_after_the_last_complete_day_is_no_today(
    live: TestClient, tmp_path, monkeypatch
):
    write_heute(tmp_path, monkeypatch, [(LAST, *r[1:]) for r in today_rows()])
    body = live.get("/datenstand").json()
    assert (body["heute"], body["heute_stand"]) == (None, None)
    past = tageskarte(live, LAST)  # served as the past day it is
    assert (past["stand"], past["bis_stunde"]) == (None, None)


def test_datenstand_names_today_and_the_collector_run(live: TestClient):
    body = live.get("/datenstand").json()
    assert body["heute"] == TODAY.isoformat()
    assert datetime.fromisoformat(body["heute_stand"]) == STAND
    assert body["letzter_tag"] == LAST.isoformat()


def test_today_takes_its_values_from_heute_and_the_references_cut_at_the_hour(live: TestClient):
    body = tageskarte(live, TODAY)
    assert datetime.fromisoformat(body["stand"]) == STAND
    assert body["bis_stunde"] == 12
    assert body["fehlende_stunden"] == 0
    assert len(body["referenztage"]) == 12
    assert body["referenztage"][0] == "2026-05-26"
    assert (body["n"], body["ohne_koordinaten"]) == (100, 0)
    alpha = next(s for s in body["stationen"] if s["eva"] == "1")
    assert (alpha["n"], alpha["puenktlich"], alpha["ausfallquote"]) == (100, 0.5, 0)
    # the 1000 cancelled stops of hour 20 do not count against the references
    assert alpha["normal"]["puenktlich"] == pytest.approx(0.9)
    assert alpha["normal"]["ausfallquote"] == 0
    assert alpha["klasse"]["puenktlich"] == 5


def test_the_germany_card_compares_the_same_stations_only(live: TestClient):
    de = tageskarte(live, TODAY)["deutschland"]
    # BETA, late on every reference day but absent today, would pull the normal to 0.45
    assert de["normal"]["puenktlich"] == pytest.approx(0.9)
    assert de["normal"]["ausfallquote"] == 0
    assert de["puenktlich"] == 0.5
    assert de["klasse"]["puenktlich"] == 5


def test_a_located_station_without_data_today_is_listed_with_nothing_shown(live: TestClient):
    body = tageskarte(live, TODAY)
    assert [s["eva"] for s in body["stationen"]] == ["1", "2"]  # BETA has no coordinates
    gamma = body["stationen"][1]
    assert (gamma["name"], gamma["n"], gamma["median"], gamma["puenktlich"]) == (
        "Gamma",
        0,
        None,
        None,
    )
    assert gamma["normal"] == NO_NORMAL
    assert gamma["klasse"] == NO_NORMAL


def test_every_stand_is_sent_in_whole_seconds(base: TestClient, tmp_path, monkeypatch):
    # fractional seconds beyond three digits are engine-specific in JavaScript's Date parsing
    write_heute(tmp_path, monkeypatch, today_rows(), stand=STAND.replace(microsecond=123456))
    write_rest(tmp_path, monkeypatch, rest_rows(), stand=REST_STAND.replace(microsecond=654321))
    ds = base.get("/datenstand").json()
    body = tageskarte(base, TODAY)
    assert (ds["heute_stand"], ds["heute_stand_rest"], body["stand"], body["stand_rest"]) == (
        "2026-06-02T10:37:00+00:00",
        "2026-06-02T07:37:00+00:00",
        "2026-06-02T10:37:00+00:00",
        "2026-06-02T07:37:00+00:00",
    )


def test_a_past_day_has_no_stand_and_no_cut(live: TestClient):
    body = tageskarte(live, DAY)
    assert (body["stand"], body["bis_stunde"]) == (None, None)


def station(body: dict, eva: str) -> dict:
    return next(s for s in body["stationen"] if s["eva"] == eva)


def test_only_rest_data_is_a_today_with_the_rest_stand_and_cut(
    base: TestClient, tmp_path, monkeypatch
):
    write_rest(tmp_path, monkeypatch, rest_rows())
    ds = base.get("/datenstand").json()
    assert (ds["heute"], ds["heute_stand"]) == (TODAY.isoformat(), None)
    assert datetime.fromisoformat(ds["heute_stand_rest"]) == REST_STAND
    body = tageskarte(base, TODAY)
    assert (body["stand"], body["bis_stunde"]) == (None, None)
    assert datetime.fromisoformat(body["stand_rest"]) == REST_STAND
    assert body["bis_stunde_rest"] == 9
    assert [(s["eva"], s["live"]) for s in body["stationen"]] == [("1", False), ("2", False)]
    two = station(body, "2")
    assert two["n"] == 100
    # the reference days are cut at 9: station 2's 1000 cancelled stops of hour 10 stay out
    assert two["normal"]["puenktlich"] == pytest.approx(0.8)
    assert two["normal"]["ausfallquote"] == 0
    de = body["deutschland"]
    assert (de["n"], body["deutschland_live"]) == (105, False)  # all rest stations, no BETA
    assert de["normal"]["puenktlich"] == pytest.approx(0.85)


def test_with_both_sources_each_station_uses_its_own_values_and_cut(
    base: TestClient, tmp_path, monkeypatch
):
    write_heute(tmp_path, monkeypatch, today_rows())
    write_rest(tmp_path, monkeypatch, rest_rows())
    ds = base.get("/datenstand").json()
    assert datetime.fromisoformat(ds["heute_stand"]) == STAND
    assert datetime.fromisoformat(ds["heute_stand_rest"]) == REST_STAND
    body = tageskarte(base, TODAY)
    assert datetime.fromisoformat(body["stand"]) == STAND
    assert (body["bis_stunde"], body["bis_stunde_rest"]) == (12, 9)
    one, two = station(body, "1"), station(body, "2")
    assert (one["live"], one["n"]) == (True, 100)  # the live values, not the rest file's 5 stops
    assert one["normal"]["puenktlich"] == pytest.approx(0.9)
    assert (two["live"], two["n"], two["puenktlich"]) == (False, 100, 0.5)
    # station 2 is cut at the rest hour 9, not at the live hour 12: hour 10 stays out
    assert two["normal"]["puenktlich"] == pytest.approx(0.8)
    assert two["normal"]["ausfallquote"] == 0
    de = body["deutschland"]
    assert body["deutschland_live"] is True
    assert (de["n"], de["normal"]["puenktlich"]) == (100, pytest.approx(0.9))  # live stations only


def test_a_rest_file_that_feeds_no_station_sends_no_rest_stand(
    base: TestClient, tmp_path, monkeypatch
):
    # the collector covers station 1, the only one in the rest file: the legend has no other line
    write_heute(tmp_path, monkeypatch, today_rows())
    write_rest(tmp_path, monkeypatch, [(TODAY, 5, "regional", "1", 0, 5)])
    body = tageskarte(base, TODAY)
    assert datetime.fromisoformat(body["stand"]) == STAND
    assert (body["stand_rest"], body["bis_stunde_rest"]) == (None, None)


def test_a_rest_file_from_yesterday_or_without_rows_is_no_today(
    base: TestClient, tmp_path, monkeypatch
):
    write_rest(tmp_path, monkeypatch, [(TODAY - timedelta(days=1), *r[1:]) for r in rest_rows()])
    no_today(base)
    write_rest(tmp_path, monkeypatch, [])
    no_today(base)


def test_past_days_say_nothing_of_today(base: TestClient, tmp_path, monkeypatch):
    write_heute(tmp_path, monkeypatch, today_rows())
    write_rest(tmp_path, monkeypatch, rest_rows())
    body = tageskarte(base, DAY)
    assert (body["stand"], body["bis_stunde"], body["stand_rest"], body["bis_stunde_rest"]) == (
        None,
        None,
        None,
        None,
    )
    assert body["deutschland_live"] is None
    assert [s["live"] for s in body["stationen"]] == [False]


def test_germany_per_category_follows_the_stations_decided_on_all_trains(
    base: TestClient, tmp_path, monkeypatch
):
    """The live file has regional stops only; the rest file has 7 fern stops at station 2. Live
    stations report today, so the fern line has no stops: the rest stations do not fill it."""
    write_heute(tmp_path, monkeypatch, today_rows())
    write_rest(tmp_path, monkeypatch, [*rest_rows(), (TODAY, 6, "fern", "2", 0, 7)])
    body = tageskarte(base, TODAY)
    assert body["deutschland_live"] is True
    assert body["deutschland_fern"] is None
    assert body["deutschland_regional"] == body["deutschland"]
    assert station(body, "2")["n"] == 107  # the station itself shows all its trains


def test_a_station_outside_the_large_set_never_appears_today(
    base: TestClient, tmp_path, monkeypatch
):
    """Station 3 has coordinates and stops in both files but is no large station."""
    write_stations(tmp_path, monkeypatch, ("1", "2", "3"))
    big = [(TODAY, 5, "regional", "3", 0, 999)]
    write_heute(tmp_path, monkeypatch, [*today_rows(), *big])
    write_rest(tmp_path, monkeypatch, [*rest_rows(), *big])
    body = tageskarte(base, TODAY)
    assert [s["eva"] for s in body["stationen"]] == ["1", "2"]
    assert (body["n"], body["deutschland"]["n"]) == (100, 100)  # the live stations only


def test_the_rest_fallback_covers_only_large_stations(base: TestClient, tmp_path, monkeypatch):
    write_stations(tmp_path, monkeypatch, ("1", "2", "3"))
    write_rest(tmp_path, monkeypatch, [*rest_rows(), (TODAY, 5, "regional", "3", 0, 999)])
    body = tageskarte(base, TODAY)
    assert body["deutschland_live"] is False
    assert [s["eva"] for s in body["stationen"]] == ["1", "2"]
    assert (body["n"], body["deutschland"]["n"]) == (105, 105)  # stations 1 and 2, not 3


def test_today_has_a_fern_and_a_regional_line_that_add_up(base: TestClient, tmp_path, monkeypatch):
    write_rest(tmp_path, monkeypatch, [*rest_rows(), (TODAY, 6, "fern", "2", 0, 7)])
    body = tageskarte(base, TODAY)
    assert (station(body, "2")["n"], body["deutschland"]["n"]) == (107, 112)
    fern, regional = body["deutschland_fern"], body["deutschland_regional"]
    assert (fern["n"], regional["n"]) == (7, 105)
    assert fern["puenktlich"] == 1
    assert fern["normal"] == NO_NORMAL  # the reference days have no fern stops
    assert regional["normal"]["puenktlich"] == pytest.approx(0.85)


def with_states(tmp_path, monkeypatch) -> None:
    """Alpha and Beta are in Berlin, Gamma in Bayern."""
    pl.DataFrame(
        {
            "eva": ["1", "2", BETA],
            "name": ["Alpha", "Gamma", "Beta"],
            "n": 1,
            "land": ["Berlin", "Bayern", "Berlin"],
            "lat": [50.0, 51.0, None],
            "lon": [7.0, 8.0, None],
        },
        schema_overrides={"lat": pl.Float64, "lon": pl.Float64},
    ).write_parquet(tmp_path / "stations3.parquet")
    monkeypatch.setattr(main, "STATIONS_PATH", str(tmp_path / "stations3.parquet"))


def test_today_a_state_counts_only_the_stations_that_report(
    live: TestClient, tmp_path, monkeypatch
):
    with_states(tmp_path, monkeypatch)
    body = tageskarte(live, TODAY)
    (berlin,) = body["laender"]  # Gamma and Beta do not report: no Bayern, no second station
    assert (berlin["land"], berlin["bahnhoefe"]) == ("be", 1)
    assert berlin["alle"]["n"] == body["deutschland"]["n"] == 100
    assert berlin["alle"]["normal"]["puenktlich"] == pytest.approx(0.9)  # Beta's days stay out


def test_today_the_states_add_up_to_germany_when_the_rest_stations_feed_it(
    base: TestClient, tmp_path, monkeypatch
):
    write_rest(tmp_path, monkeypatch, rest_rows())
    with_states(tmp_path, monkeypatch)
    body = tageskarte(base, TODAY)
    assert body["deutschland_live"] is False
    assert [(land["land"], land["bahnhoefe"], land["alle"]["n"]) for land in body["laender"]] == [
        ("be", 1, 5),
        ("by", 1, 100),
    ]
    assert sum(land["alle"]["n"] for land in body["laender"]) == body["deutschland"]["n"] == 105


# Collector days. The `base` fixture above has days up to LAST = 2026-05-31 (a Sunday), day hours
# for the Tuesdays, stations 1, 2 and BETA large, and the clock at noon on 2026-06-02. The
# collector kept Monday 2026-06-01, which no uploaded day covers yet.

C1 = LAST + timedelta(days=1)  # a Monday
C2 = date(2026, 6, 8)  # the Monday after
TUESDAY = date(2026, 6, 2)


def collector_rows(day: date) -> list[tuple]:
    """Station 1: 100 stops in two hours, 90 on time. BETA has no coordinates. Station 9 is no
    large station."""
    return [
        (day, 8, "regional", "1", 0, 90),
        (day, 9, "regional", "1", 20, 10),
        (day, 8, "regional", BETA, 0, 50),
        (day, 8, "regional", "9", 0, 999),
    ]


def write_live_tage(tmp_path, monkeypatch, rows: list[tuple]) -> None:
    pl.DataFrame(rows, schema=DAY_HOURS_SCHEMA, orient="row").write_parquet(
        tmp_path / "live_tage.parquet"
    )
    monkeypatch.setattr(main, "LIVE_TAGE_PATH", str(tmp_path / "live_tage.parquet"))


def bump_mtime(path) -> None:
    stamp = path.stat().st_mtime_ns + 1_000_000_000  # a different mtime for sure
    os.utime(path, ns=(stamp, stamp))


def test_without_the_file_there_are_no_collector_days(base: TestClient):
    assert base.get("/datenstand").json()["live_tage"] == []
    assert base.get("/tageskarte", params={"tag": C1.isoformat()}).status_code == 404


def test_datenstand_lists_the_days_between_the_last_complete_day_and_today(
    base: TestClient, tmp_path, monkeypatch
):
    monkeypatch.setattr(main, "now", lambda: datetime(2026, 6, 10, 10, 0, tzinfo=UTC))
    days = (date(2026, 6, 10), C2, LAST, C1)  # unsorted; today and the complete day are no extras
    write_live_tage(tmp_path, monkeypatch, [r for d in days for r in collector_rows(d)])
    assert base.get("/datenstand").json()["live_tage"] == ["2026-06-01", "2026-06-08"]


def test_a_collector_day_is_served_from_the_hours_summed_at_the_large_stations(
    base: TestClient, tmp_path, monkeypatch
):
    write_live_tage(tmp_path, monkeypatch, collector_rows(C1))
    body = tageskarte(base, C1)
    assert body["tag"] == C1.isoformat()
    assert (body["n"], body["ohne_koordinaten"], body["fehlende_stunden"]) == (150, 1, 0)
    assert (body["stand"], body["bis_stunde"], body["deutschland_live"]) == (None, None, None)
    # the reference Mondays come from days.parquet, like for any complete day
    expected = reference_days(C1, FIRST, LAST, set())
    assert body["referenztage"] == [d.isoformat() for d in expected]
    one = station(body, "1")
    assert (one["n"], one["puenktlich"], one["live"]) == (100, 0.9, False)
    assert one["normal"]["puenktlich"] is not None
    assert [s["eva"] for s in body["stationen"]] == [
        "1"
    ]  # BETA has no coordinates, 9 is no large one
    assert body["deutschland"]["n"] == 150


def test_germany_and_the_states_count_only_the_stations_the_collector_kept_that_day(
    base: TestClient, tmp_path, monkeypatch
):
    """Beta is bad on every reference Monday and the collector did not keep it on C1: Germany and
    Berlin are Alpha's day against Alpha's Mondays, not against Alpha's and Beta's together."""

    def stops(d: date, eva: str) -> tuple[int, int, int]:
        return (50, 50, 5) if eva == BETA else varying(d, eva)

    write_days(base, tmp_path, monkeypatch, stops, evas=("1", "2", BETA))
    with_states(tmp_path, monkeypatch)
    write_live_tage(tmp_path, monkeypatch, [r for r in collector_rows(C1) if r[3] == "1"])
    body = tageskarte(base, C1)
    alpha = station(body, "1")["normal"]["puenktlich"]
    (berlin,) = body["laender"]
    assert body["deutschland"]["n"] == berlin["alle"]["n"] == 100
    assert body["deutschland"]["normal"]["puenktlich"] == pytest.approx(alpha)
    assert berlin["alle"]["normal"]["puenktlich"] == pytest.approx(alpha)


def test_a_day_the_file_does_not_hold_is_still_not_found(base: TestClient, tmp_path, monkeypatch):
    write_live_tage(tmp_path, monkeypatch, collector_rows(C1))
    assert base.get("/tageskarte", params={"tag": TUESDAY.isoformat()}).status_code == 404


def test_the_reference_days_of_a_collector_day_include_the_collector_days_before_it(
    base: TestClient, tmp_path, monkeypatch
):
    monkeypatch.setattr(main, "now", lambda: datetime(2026, 6, 10, 10, 0, tzinfo=UTC))
    bad = [(C1, 8, "regional", "1", 20, 100)]  # station 1 was late on every stop on C1
    write_live_tage(tmp_path, monkeypatch, [*bad, *collector_rows(C2)])
    with_c1 = tageskarte(base, C2)
    assert with_c1["referenztage"] == [d.isoformat() for d in reference_days(C2, FIRST, C2, set())]
    assert with_c1["referenztage"][0] == C1.isoformat()
    write_live_tage(tmp_path, monkeypatch, collector_rows(C2))
    main.tageskarte_for.cache_clear()
    main._frame.cache_clear()
    without_c1 = tageskarte(base, C2)
    assert C1.isoformat() not in without_c1["referenztage"]
    # one late reference day moves the median of the others
    assert (
        station(with_c1, "1")["normal"]["puenktlich"]
        != station(without_c1, "1")["normal"]["puenktlich"]
    )


def test_a_complete_day_wins_over_the_collectors_copy_of_it(
    base: TestClient, tmp_path, monkeypatch
):
    before = tageskarte(base, LAST)
    write_live_tage(tmp_path, monkeypatch, [(LAST, 8, "regional", "1", 20, 9999)])
    main.tageskarte_for.cache_clear()
    assert tageskarte(base, LAST) == before
    assert base.get("/datenstand").json()["live_tage"] == []


def test_a_rewritten_collector_file_is_served_without_clearing_any_cache(
    base: TestClient, tmp_path, monkeypatch
):
    write_live_tage(tmp_path, monkeypatch, collector_rows(C1))
    assert tageskarte(base, C1)["n"] == 150
    write_live_tage(tmp_path, monkeypatch, [(C1, 8, "regional", "1", 0, 7)])
    bump_mtime(tmp_path / "live_tage.parquet")
    assert tageskarte(base, C1)["n"] == 7
    assert base.get("/datenstand").json()["live_tage"] == [C1.isoformat()]


def test_past_days_stay_cached_while_the_collector_file_changes(
    base: TestClient, tmp_path, monkeypatch
):
    write_live_tage(tmp_path, monkeypatch, collector_rows(C1))
    tageskarte(base, LAST)
    hits = main.tageskarte_for.cache_info().hits
    write_live_tage(tmp_path, monkeypatch, [(C1, 8, "regional", "1", 0, 7)])
    bump_mtime(tmp_path / "live_tage.parquet")
    tageskarte(base, LAST)
    assert main.tageskarte_for.cache_info().hits == hits + 1  # the file does not key past days


def test_the_reference_days_of_today_include_the_collector_days(
    base: TestClient, tmp_path, monkeypatch
):
    """Today is Tuesday 2026-06-09, 12:37 local. Tuesday 2026-06-02 is a collector day: its hours
    before the cut count, the cancelled stops of hour 20 do not."""
    stand = datetime(2026, 6, 9, 10, 37, tzinfo=UTC)
    today = date(2026, 6, 9)
    write_heute(
        tmp_path,
        monkeypatch,
        [(today, 5, "regional", "1", 0, 30), (today, 5, "regional", "1", 20, 10)],
        stand=stand,
        now=stand + timedelta(minutes=10),
    )
    write_live_tage(
        tmp_path,
        monkeypatch,
        [(TUESDAY, 5, "regional", "1", 20, 100), (TUESDAY, 20, "regional", "1", None, 1000)],
    )
    body = tageskarte(base, today)
    assert body["referenztage"] == [
        d.isoformat() for d in reference_days(today, FIRST, TUESDAY, set())
    ]
    assert body["referenztage"][0] == TUESDAY.isoformat()
    assert station(body, "1")["normal"]["ausfallquote"] == 0


def test_large_reads_large_parquet_and_follows_a_new_file(base: TestClient, tmp_path, monkeypatch):
    assert main.large() == sorted(["1", "2", BETA])  # the fixture's large.parquet
    pl.DataFrame({"eva": ["1"]}, schema={"eva": pl.String}).write_parquet(
        tmp_path / "large.parquet"
    )
    monkeypatch.setattr(main, "LARGE_PATH", str(tmp_path / "large.parquet"))
    assert main.large() == ["1"]
    pl.DataFrame({"eva": ["1", "2"]}, schema={"eva": pl.String}).write_parquet(
        tmp_path / "large.parquet"
    )
    bump_mtime(tmp_path / "large.parquet")
    assert main.large() == ["1", "2"]
