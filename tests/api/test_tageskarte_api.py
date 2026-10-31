from datetime import date, timedelta
from statistics import median

import polars as pl
import pytest
from fastapi.testclient import TestClient

from backend import main
from tests.conftest import BETA, write_monate

# The fixture has stops every day from 2026-02-05 to 2026-05-31 at station "1" (coordinates) and
# at "08000002" (none). The day under test is Thursday 2026-05-21; its twelve reference Thursdays
# run back to 2026-02-26. Christi Himmelfahrt (2026-05-14) is a holiday, so 11 remain.

FIRST, LAST = date(2026, 2, 5), date(2026, 5, 31)
DAY = date(2026, 5, 21)
HOLIDAY = date(2026, 5, 14)
GAP = date(2026, 3, 12)  # a Thursday inside the reference weeks
NO_NORMAL = {"puenktlich": None, "ausfallquote": None, "median": None, "p90": None}


def thursdays(n: int) -> list[date]:
    return [DAY - timedelta(weeks=k) for k in range(1, n + 1)]


def tageskarte(client: TestClient, tag: date = DAY, **params) -> dict:
    r = client.get("/tageskarte", params={"tag": tag.isoformat(), **params})
    assert r.status_code == 200
    return r.json()


def write_days(
    client: TestClient,
    tmp_path,
    monkeypatch,
    stops,
    gaps: tuple[date, ...] = (),
    evas=("1", BETA),
    fern=None,
) -> TestClient:
    """`stops(day, eva)` gives the regional stops of a day: (on time, 20 min late, cancelled);
    `fern` the same for the fern stops, none by default. Full coverage starts in March: the large
    stations are those with stops in February (all of `evas`, unless `stops` gives none then)."""
    rows = []
    d = FIRST
    while d <= LAST:
        for eva in evas:
            for gruppe, count in (("regional", stops), ("fern", fern)):
                on_time, late, cancelled = count(d, eva) if count else (0, 0, 0)
                rows += [
                    (d, gruppe, eva, 0, on_time),
                    (d, gruppe, eva, 20, late),
                    (d, gruppe, eva, None, cancelled),
                ]
        d += timedelta(1)
    pl.DataFrame(
        [r for r in rows if r[4]],
        schema={
            "day": pl.Date,
            "gruppe": pl.String,
            "eva": pl.String,
            "bucket": pl.Int32,
            "n": pl.UInt32,
        },
        orient="row",
    ).write_parquet(tmp_path / "d.parquet")
    all_days = [FIRST + timedelta(i) for i in range((LAST - FIRST).days + 1)]
    pl.DataFrame(
        {"day": all_days, "missing_hours": [3 if x in gaps else 0 for x in all_days]},
        schema={"day": pl.Date, "missing_hours": pl.Int32},
    ).write_parquet(tmp_path / "t.parquet")
    monkeypatch.setattr(main, "DAYS_PATH", str(tmp_path / "d.parquet"))
    monkeypatch.setattr(main, "TAGE_PATH", str(tmp_path / "t.parquet"))
    rows = [("2026-02", 0, 1), ("2026-03", 0, 10), ("2026-04", 0, 10), ("2026-05", 0, 10)]
    write_monate(tmp_path / "monate.parquet", monkeypatch, rows)
    return client


def write_stations(tmp_path, monkeypatch, evas: tuple[str, ...]) -> None:
    """A station table with coordinates for each of `evas`."""
    pl.DataFrame(
        {
            "eva": list(evas),
            "name": [f"Station {e}" for e in evas],
            "n": 1,
            "land": None,
            "lat": 50.0,
            "lon": 7.0,
        }
    ).write_parquet(tmp_path / "more.parquet")
    monkeypatch.setattr(main, "STATIONS_PATH", str(tmp_path / "more.parquet"))


def varying(d: date, eva: str) -> tuple[int, int, int]:
    """Every day has 100 regional stops and 5 cancelled; the share on time varies by week."""
    on_time = 80 + (d - FIRST).days // 7 % 5
    return on_time, 100 - on_time, 5


def test_reference_days_skip_a_holiday_and_a_gap_day(client: TestClient, tmp_path, monkeypatch):
    write_days(client, tmp_path, monkeypatch, varying, gaps=(GAP,))
    body = tageskarte(client)
    assert body["referenztage"] == [d.isoformat() for d in thursdays(12) if d not in (HOLIDAY, GAP)]
    assert len(body["referenztage"]) == 10


def test_a_station_with_fewer_than_8_counting_days_has_no_normal(
    client: TestClient, tmp_path, monkeypatch
):
    def thin_on(count: int):
        thin = thursdays(12)[1:][:count]  # skip the holiday, which is left out anyway

        def stops(d: date, eva: str) -> tuple[int, int, int]:
            return (3, 2, 1) if eva == "1" and d in thin else varying(d, eva)

        return stops

    # 11 reference days: with 3 thin days 8 count, with 4 only 7
    write_days(client, tmp_path, monkeypatch, thin_on(3))
    (s,) = tageskarte(client)["stationen"]
    counting = [
        varying(d, "1")[0] / 100
        for d in thursdays(12)
        if d != HOLIDAY and d not in thursdays(12)[1:4]
    ]
    assert len(counting) == 8
    assert s["normal"]["puenktlich"] == pytest.approx(median(counting), abs=1e-12)
    assert s["normal"]["ausfallquote"] is not None
    main.tageskarte_for.cache_clear()
    write_days(client, tmp_path, monkeypatch, thin_on(4))
    (s,) = tageskarte(client)["stationen"]
    assert s["normal"] == NO_NORMAL
    assert s["klasse"] == NO_NORMAL  # no normal, no class
    assert s["n"] == 105  # the day's own statistics stay


@pytest.mark.parametrize(
    "target, expected",
    [
        ((100, 0, 0), {"puenktlich": 1, "ausfallquote": 1, "median": 3, "p90": 1}),
        ((0, 100, 20), {"puenktlich": 5, "ausfallquote": 5, "median": 5, "p90": 3}),
    ],
)
def test_germany_weather_is_1_on_the_best_day_and_5_on_the_worst(
    client: TestClient, tmp_path, monkeypatch, target, expected
):
    def stops(d: date, eva: str) -> tuple[int, int, int]:
        return target if d == DAY else varying(d, eva)

    write_days(client, tmp_path, monkeypatch, stops)
    de = tageskarte(client)["deutschland"]
    assert de["wetter"] == expected
    assert de["normal"]["median"] == 0
    assert de["normal"]["p90"] == 20
    assert de["normal"]["ausfallquote"] == pytest.approx(5 / 105)


def test_stats_equal_tagesverlauf_and_unlocated_stations_are_counted(
    client: TestClient, tmp_path, monkeypatch
):
    write_days(client, tmp_path, monkeypatch, varying)
    body = tageskarte(client)
    assert (body["tag"], body["n"], body["ohne_koordinaten"]) == (DAY.isoformat(), 210, 1)
    (s,) = body["stationen"]
    assert (s["eva"], s["name"], s["lat"], s["lon"]) == ("1", "Alpha", 50.0, 7.0)
    keys = ("n", "ausfallquote", "median", "p90", "puenktlich")

    def own(day: dict) -> dict:
        return {k: day[k] for k in keys}

    for eva, got in ((None, body["deutschland"]), ("1", s)):
        params = {"eva": eva} if eva else {}
        days = client.get("/tagesverlauf", params=params).json()["tage"]
        assert own(got) == own(next(t for t in days if t["tag"] == DAY.isoformat()))


def test_a_gap_day_is_marked_and_a_day_without_stops_has_no_germany(
    client: TestClient, tmp_path, monkeypatch
):
    def stops(d: date, eva: str) -> tuple[int, int, int]:
        return (0, 0, 0) if d == DAY else varying(d, eva)

    write_days(client, tmp_path, monkeypatch, stops, gaps=(DAY,))
    body = tageskarte(client)
    assert body["fehlende_stunden"] == 3
    assert (body["n"], body["deutschland"], body["stationen"], body["ohne_koordinaten"]) == (
        0,
        None,
        [],
        0,
    )
    assert len(body["referenztage"]) == 11


def test_gattung_is_ignored(client: TestClient, tmp_path, monkeypatch):
    write_days(client, tmp_path, monkeypatch, varying)
    body = tageskarte(client)
    assert body["n"] == 210
    for gattung in ("fern", "regional", "x"):
        assert tageskarte(client, gattung=gattung) == body


def test_a_station_outside_the_large_set_never_appears(client: TestClient, tmp_path, monkeypatch):
    """Station 3 has stops from March on, none in February: it is not a large station."""

    def stops(d: date, eva: str) -> tuple[int, int, int]:
        return (0, 0, 0) if eva == "3" and d.month == 2 else varying(d, eva)

    write_days(client, tmp_path, monkeypatch, stops, evas=("1", BETA, "3"))
    write_stations(tmp_path, monkeypatch, ("1", BETA, "3"))
    body = tageskarte(client)
    assert [s["eva"] for s in body["stationen"]] == [BETA, "1"]
    assert body["n"] == 210  # the 105 stops of station 3 are not in the day either
    assert main.large() == [BETA, "1"]


def test_germany_adds_up_from_fern_and_regional_and_each_has_a_normal(
    client: TestClient, tmp_path, monkeypatch
):
    def fern(d: date, eva: str) -> tuple[int, int, int]:
        return (20, 0, 0) if eva == "1" else (0, 0, 0)

    write_days(client, tmp_path, monkeypatch, varying, fern=fern)
    body = tageskarte(client)
    de, ferne, regional = (
        body[k] for k in ("deutschland", "deutschland_fern", "deutschland_regional")
    )
    assert (de["n"], ferne["n"], regional["n"]) == (230, 20, 210)
    assert body["n"] == 230
    assert (ferne["puenktlich"], ferne["normal"]["puenktlich"]) == (1, 1)
    on_time = [varying(d, "1")[0] / 100 for d in thursdays(12) if d != HOLIDAY]
    assert regional["normal"]["puenktlich"] == pytest.approx(median(on_time), abs=1e-12)
    assert regional["normal"]["ausfallquote"] == pytest.approx(5 / 105)
    assert ferne["normal"]["ausfallquote"] == 0
    assert all(v is not None for v in (*ferne["wetter"].values(), *regional["wetter"].values()))
    # a station keeps all its trains: 105 regional and 20 fern stops
    assert next(s for s in body["stationen"] if s["eva"] == "1")["n"] == 125


def test_a_category_without_stops_that_day_has_no_germany(
    client: TestClient, tmp_path, monkeypatch
):
    write_days(client, tmp_path, monkeypatch, varying)
    body = tageskarte(client)
    assert body["deutschland_fern"] is None
    assert body["deutschland_regional"] == body["deutschland"]


@pytest.mark.parametrize(
    "tag, status",
    [
        ("2026-5-21", 422),
        ("abc", 422),
        ("2026-13-45", 422),
        ("2026-02-04", 404),  # before the first day
        ("2026-06-01", 404),  # after the last day
        ("2026-05-21", 200),
    ],
)
def test_malformed_tag_is_422_and_a_day_out_of_range_404(
    client: TestClient, tmp_path, monkeypatch, tag: str, status: int
):
    write_days(client, tmp_path, monkeypatch, varying)
    assert client.get("/tageskarte", params={"tag": tag}).status_code == status
    assert client.get("/tageskarte").status_code == 422


def test_large_responses_are_gzipped(client: TestClient, tmp_path, monkeypatch):
    evas = tuple(str(i) for i in range(1, 61))
    write_days(client, tmp_path, monkeypatch, varying, evas=evas)
    stations = tmp_path / "many.parquet"
    pl.DataFrame(
        {
            "eva": list(evas),
            "name": [f"Station number {e}" for e in evas],
            "n": 1,
            "land": None,
            "lat": 50.0,
            "lon": 7.0,
        }
    ).write_parquet(stations)
    monkeypatch.setattr(main, "STATIONS_PATH", str(stations))
    r = client.get(
        "/tageskarte", params={"tag": DAY.isoformat()}, headers={"accept-encoding": "gzip"}
    )
    assert r.headers["content-encoding"] == "gzip"
    assert len(r.json()["stationen"]) == 60


def test_germany_has_no_weather_on_a_gap_day_but_its_stations_keep_a_class(
    client: TestClient, tmp_path, monkeypatch
):
    def stops(d: date, eva: str) -> tuple[int, int, int]:
        return (100, 0, 0) if d == DAY else varying(d, eva)

    write_days(client, tmp_path, monkeypatch, stops, gaps=(DAY,))
    body = tageskarte(client)
    assert body["fehlende_stunden"] == 3
    assert body["deutschland"]["wetter"] == NO_NORMAL
    assert body["deutschland"]["normal"]["puenktlich"] is not None
    assert body["stationen"][0]["klasse"]["puenktlich"] == 1


def test_reference_days_reach_back_before_full_coverage(client: TestClient, tmp_path, monkeypatch):
    """The large stations are covered over the whole history, so full coverage (March here) does
    not cut the reference days."""
    write_days(client, tmp_path, monkeypatch, varying)
    body = tageskarte(client, date(2026, 3, 5))
    assert body["referenztage"] == ["2026-02-26", "2026-02-19", "2026-02-12", "2026-02-05"]


def klasse_with(client: TestClient, tmp_path, monkeypatch, refs, target) -> dict:
    """The station's class when every reference day is `refs` and the day itself `target`; both
    are (on time, cancelled)."""

    def stops(d: date, eva: str) -> tuple[int, int, int]:
        on_time, cancelled = target if d == DAY else refs(d)
        return on_time, 1000 - on_time, cancelled

    write_days(client, tmp_path, monkeypatch, stops)
    return tageskarte(client)["stationen"][0]["klasse"]


@pytest.mark.parametrize(
    "on_time, expected",
    [
        (819, 3),  # 1.9 floors (1 pp) above the normal of 80 %
        (821, 2),
        (839, 2),
        (841, 1),
        (781, 3),
        (779, 4),
        (761, 4),
        (759, 5),
    ],
)
def test_punctuality_class_cuts_at_2_and_4_floors_when_the_references_agree(
    client: TestClient, tmp_path, monkeypatch, on_time, expected
):
    klasse = klasse_with(client, tmp_path, monkeypatch, lambda d: (800, 5), (on_time, 5))
    assert klasse["puenktlich"] == expected


def test_the_spread_of_the_references_decides_when_it_exceeds_the_floor(
    client: TestClient, tmp_path, monkeypatch
):
    ladder = {d: 760 + 8 * i for i, d in enumerate(d for d in thursdays(12) if d != HOLIDAY)}
    # normal 80 %, spread 3.6 pp; with only the floor 88 % would be 8 floors away
    for on_time, expected in ((860, 3), (880, 2), (940, 2), (950, 1)):
        main.tageskarte_for.cache_clear()
        klasse = klasse_with(
            client, tmp_path, monkeypatch, lambda d: (ladder.get(d, 800), 5), (on_time, 5)
        )
        assert klasse["puenktlich"] == expected


@pytest.mark.parametrize(
    "refs, target, expected",
    [
        # 95 % on time in the references: median and P90 are 0; a day with nobody on time is
        # worse in all four, a cancellation share of 5 % against 0.5 % included
        ((950, 5), (0, 50), {"puenktlich": 5, "ausfallquote": 5, "median": 5, "p90": 5}),
        # 0 % on time and 5 % cancelled in the references: the other way round
        ((0, 50), (1000, 0), {"puenktlich": 1, "ausfallquote": 1, "median": 1, "p90": 1}),
        # the same as usual
        ((900, 5), (900, 5), {"puenktlich": 3, "ausfallquote": 3, "median": 3, "p90": 3}),
    ],
)
def test_better_and_worse_days_get_the_class_of_every_metric(
    client: TestClient, tmp_path, monkeypatch, refs, target, expected
):
    assert klasse_with(client, tmp_path, monkeypatch, lambda d: refs, target) == expected


def test_a_station_day_without_a_shown_value_has_no_class(
    client: TestClient, tmp_path, monkeypatch
):
    def stops(d: date, eva: str) -> tuple[int, int, int]:
        return (3, 2, 1) if d == DAY else varying(d, eva)

    write_days(client, tmp_path, monkeypatch, stops)
    (s,) = tageskarte(client)["stationen"]
    assert s["normal"]["puenktlich"] is not None
    assert s["klasse"] == NO_NORMAL
