from datetime import date, timedelta

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from tests.conftest import BETA

# The `client` fixture covers the calendar days of 2026-09 and 2026-10 (61 days). All stops of
# the mini source are planned on 2026-09-07: station 1 has 5 there, one of them cancelled, and
# Beta has 1 (the row filed under 2026-10 carries the same planned day).


def verlauf(client: TestClient, **params) -> dict:
    r = client.get("/tagesverlauf", params=params)
    assert r.status_code == 200
    return r.json()


def counts(body: dict) -> dict[str, int]:
    return {t["tag"]: t["n"] for t in body["tage"] if t["n"]}


def test_day_sums_match_the_histogram_and_cancelled_stops_stay_cancelled(client: TestClient):
    assert counts(verlauf(client)) == {"2026-09-07": 6}
    body = verlauf(client, eva="1")
    assert body["titel"] == "Alpha"
    assert counts(body) == {"2026-09-07": 5}
    heat = client.get("/stationen/1/statistik", params={"von": "2026-09"}).json()["gesamt"]
    day = next(t for t in body["tage"] if t["tag"] == "2026-09-07")
    assert {k: day[k] for k in heat} == heat
    assert day["ausfallquote"] == pytest.approx(1 / 5)  # the cancelled stop is not a 0 minute stop


def test_every_calendar_day_is_present_and_empty_days_have_no_statistics(client: TestClient):
    body = verlauf(client)
    days = [t["tag"] for t in body["tage"]]
    first = date(2026, 9, 1)
    assert days == [(first + timedelta(d)).isoformat() for d in range(61)]
    empty = next(t for t in body["tage"] if t["tag"] == "2026-09-08")
    assert empty["n"] == 0
    assert (empty["ausfallquote"], empty["median"], empty["p90"], empty["puenktlich"]) == (
        None,
        None,
        None,
        None,
    )
    assert isinstance(empty["fehlende_stunden"], int)
    assert set(empty["trend"]) == {"puenktlich", "ausfallquote", "median", "p90"}


def test_gattung_filters(client: TestClient):
    assert counts(verlauf(client, gattung="fern")) == {"2026-09-07": 1}
    assert counts(verlauf(client, eva="1", gattung="regional")) == {"2026-09-07": 4}
    assert counts(verlauf(client, eva=BETA, gattung="fern")) == {}


def test_unknown_station_is_404_and_a_bad_eva_or_gattung_is_422(client: TestClient):
    assert client.get("/tagesverlauf", params={"eva": "999"}).status_code == 404
    assert client.get("/tagesverlauf", params={"eva": "x"}).status_code == 422
    assert client.get("/tagesverlauf", params={"gattung": "bahn"}).status_code == 422


def forty_days_of(client: TestClient, tmp_path, monkeypatch, stops) -> TestClient:
    """From 2026-01-01: on day i, `stops(i)` gives (on time, cancelled); no stops on days 0 and 1,
    and gaps in the data on days 20 and 39."""

    def day(i: int) -> date:
        return date(2026, 1, 1) + timedelta(i)

    rows = []
    for i in range(2, 40):
        on_time, cancelled = stops(i)
        rows.append((day(i), "regional", "1", 0, on_time))
        rows.append((day(i), "regional", "1", None, cancelled))
    pl.DataFrame(
        rows,
        schema={
            "day": pl.Date,
            "gruppe": pl.String,
            "eva": pl.String,
            "bucket": pl.Int32,
            "n": pl.UInt32,
        },
        orient="row",
    ).write_parquet(tmp_path / "d.parquet")
    pl.DataFrame(
        {
            "day": [day(i) for i in range(40)],
            "missing_hours": [2 if i in (20, 39) else 0 for i in range(40)],
        },
        schema={"day": pl.Date, "missing_hours": pl.Int32},
    ).write_parquet(tmp_path / "t.parquet")
    monkeypatch.setattr(main, "DAYS_PATH", str(tmp_path / "d.parquet"))
    monkeypatch.setattr(main, "TAGE_PATH", str(tmp_path / "t.parquet"))
    return client


@pytest.fixture
def forty_days(client: TestClient, tmp_path, monkeypatch) -> TestClient:
    """On day i, i cancelled stops and 100 - i on time (cancellation rate i/100)."""
    return forty_days_of(client, tmp_path, monkeypatch, lambda i: (100 - i, i))


def trend_of(client: TestClient, i: int, metric: str = "ausfallquote") -> float | None:
    return verlauf(client)["tage"][i]["trend"][metric]


def test_trend_is_the_centred_28_day_median(forty_days: TestClient):
    # day 10: window days -3..24 holds the values 2..19 and 21..24 (day 20 is a gap): median 12.5
    assert trend_of(forty_days, 10) == pytest.approx(0.125)
    assert trend_of(forty_days, 10, "median") == 0  # all non-cancelled stops are on time
    assert trend_of(forty_days, 10, "puenktlich") == 1


def test_days_with_missing_hours_do_not_feed_the_trend(forty_days: TestClient):
    # day 21: window days 8..35 minus the gap day 20; with it the median would be 0.215
    assert trend_of(forty_days, 21) == pytest.approx(0.22)
    gap = verlauf(forty_days)["tage"][20]
    assert gap["fehlende_stunden"] == 2
    assert gap["n"] == 100  # the gap day itself still shows its own values
    assert gap["ausfallquote"] == pytest.approx(0.2)
    assert gap["trend"]["ausfallquote"] is not None  # and gets a trend from its neighbours


def test_trend_needs_14_values_in_the_window(forty_days: TestClient):
    # day 0: window days 0..14 hold 13 values (days 0 and 1 have no stops); day 1 holds 14
    assert trend_of(forty_days, 0) is None
    assert trend_of(forty_days, 1) is not None
    # day 39: window days 26..39 hold 13 values (day 39 is a gap); day 38 holds 14
    assert trend_of(forty_days, 39) is None
    assert trend_of(forty_days, 38) is not None


def test_days_with_fewer_than_15_stops_do_not_feed_the_trend(client, tmp_path, monkeypatch):
    forty_days_of(client, tmp_path, monkeypatch, lambda i: (12, 2))  # n = 14 every day
    days = verlauf(client)["tage"]
    assert days[10]["n"] == 14
    assert all(v is None for t in days for v in t["trend"].values())


def test_days_with_fewer_than_15_arrived_stops_feed_only_the_cancellation_trend(
    client, tmp_path, monkeypatch
):
    forty_days_of(client, tmp_path, monkeypatch, lambda i: (14, 6))  # n = 20, 14 arrived
    assert trend_of(client, 10) == pytest.approx(0.3)
    for metric in ("puenktlich", "median", "p90"):
        assert trend_of(client, 10, metric) is None


def test_days_with_15_arrived_stops_feed_every_trend(client, tmp_path, monkeypatch):
    forty_days_of(client, tmp_path, monkeypatch, lambda i: (15, 5))
    assert trend_of(client, 10, "puenktlich") == 1
    assert trend_of(client, 10, "median") == 0
