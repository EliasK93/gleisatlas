import urllib.error
import urllib.request
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl
import pytest

from pipeline import live
from tests.pipeline.test_raw import API, EVA, fchg_stop, plan_stop, xml

A, B, OLD = EVA, "08000002", "08000003"
DAY = date(2026, 11, 4)  # a Wednesday in winter time: local = UTC + 1
AT_14_37 = datetime(2026, 11, 4, 13, 37, tzinfo=UTC)
HEUTE_SCHEMA = pl.Schema(
    {
        "day": pl.Date,
        "hour": pl.Int8,
        "gruppe": pl.String,
        "eva": pl.String,
        "bucket": pl.Int32,
        "n": pl.UInt32,
        "stand": pl.Datetime("us", "UTC"),
    }
)


class Clock:
    """A clock that only moves when the collector sleeps."""

    def __init__(self, t: datetime):
        self.t = t
        self.slept = 0.0

    def now(self) -> datetime:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += timedelta(seconds=seconds)
        self.slept += seconds


class Server:
    """The Timetables API over dicts: plan stops per (eva, hour) of DAY, changes per eva."""

    def __init__(self):
        self.plans: dict[tuple[str, int], list[str]] = {}
        self.changes: dict[str, list[str]] = {}
        self.status: dict[str, int] = {}  # path -> status without a body
        self.bodies: dict[str, str] = {}  # path -> body with status 200
        self.too_many_from: int | None = None  # 429 from this call on (1-based)
        self.down = False  # every request fails without a status (network, DNS, timeout)
        self.slow: tuple[Clock, float] | None = None  # each request takes this long
        self.calls: list[str] = []

    def get(self, url: str) -> tuple[int, str]:
        self.calls.append(url)
        if self.slow:
            self.slow[0].t += timedelta(seconds=self.slow[1])
        if self.too_many_from and len(self.calls) >= self.too_many_from:
            return 429, ""
        if self.down:
            return 0, ""
        path = url.removeprefix(API)
        if path in self.status:
            return self.status[path], ""
        if path in self.bodies:
            return 200, self.bodies[path]
        parts = path.strip("/").split("/")
        if parts[0] == "fchg":
            return 200, xml(*self.changes.get(parts[1], []))
        _, eva, yymmdd, hh = parts
        stops = self.plans.get((eva, int(hh)), []) if yymmdd == DAY.strftime("%y%m%d") else []
        return 200, xml(*stops)

    def plan_calls(self) -> list[str]:
        return [c for c in self.calls if "/plan/" in c]


def write_stations(data_dir: Path, evas: list[str]) -> None:
    """Coverage starts in 2025-11, so the large stations are those of 2025-10."""
    monate = pl.DataFrame(
        {
            "month": ["2025-09", "2025-10", "2025-11"],
            "missing_hours": [0, 0, 0],
            "stations": [len(evas), len(evas), 10 * len(evas)],
        },
        schema={"month": pl.String, "missing_hours": pl.Int32, "stations": pl.UInt32},
    )
    monate.write_parquet(data_dir / "monate.parquet")
    for month, month_evas in {"2025-09": [OLD], "2025-10": evas, "2025-11": [*evas, OLD]}.items():
        folder = data_dir / "months" / month
        folder.mkdir(parents=True)
        pl.DataFrame(
            {"eva": month_evas, "name": month_evas, "n": [1] * len(month_evas)},
            schema={"eva": pl.String, "name": pl.String, "n": pl.UInt32},
        ).write_parquet(folder / "stations.parquet")


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    d = tmp_path / "data"
    d.mkdir()
    write_stations(d, [A, B])
    return d


@pytest.fixture
def server() -> Server:
    return Server()


@pytest.fixture
def clock() -> Clock:
    return Clock(AT_14_37)


def collect(data_dir: Path, server: Server, clock: Clock) -> pl.DataFrame:
    live.run(data_dir, server.get, clock.now, clock.sleep)
    return pl.read_parquet(data_dir / "heute.parquet")


def counts(heute: pl.DataFrame) -> list[tuple]:
    return heute.sort("eva", "hour", "bucket").select("eva", "hour", "bucket", "n").rows()


def test_a_planned_stop_without_change_counts_on_time(data_dir, server, clock):
    server.plans[(A, 8)] = [plan_stop("a-1-1", "2611040800")]
    heute = collect(data_dir, server, clock)
    assert heute.schema == HEUTE_SCHEMA
    assert heute.select("day", "hour", "gruppe", "eva", "bucket", "n").rows() == [
        (DAY, 8, "fern", A, 0, 1)
    ]
    assert stands(heute) == [AT_14_37]  # the start of the run, when the changes were fetched
    assert not list(data_dir.glob("*.tmp"))


def stands(heute: pl.DataFrame) -> list[datetime]:
    naive = heute.select(pl.col("stand").dt.replace_time_zone(None)).to_series().unique()
    return [t.replace(tzinfo=UTC) for t in naive.to_list()]


def evas(heute: pl.DataFrame) -> list[str]:
    return sorted(heute["eva"].unique())


def test_a_run_that_crosses_an_hour_keeps_its_start_hour_and_time(data_dir, server, clock):
    clock.t = datetime(2026, 11, 4, 13, 59, 30, tzinfo=UTC)  # 14:59:30 local
    server.plans[(A, 13)] = [plan_stop("a-1-1", "2611041350")]
    server.plans[(A, 14)] = [plan_stop("a-2-1", "2611041410")]
    heute = collect(data_dir, server, clock)
    assert clock.t > datetime(2026, 11, 4, 14, 0, tzinfo=UTC)  # the run ended after 15:00
    assert counts(heute) == [(A, 13, 0, 1)]
    assert stands(heute) == [datetime(2026, 11, 4, 13, 59, 30, tzinfo=UTC)]


def test_a_changed_arrival_gives_the_delay(data_dir, server, clock):
    server.plans[(A, 8)] = [plan_stop("a-1-1", "2611040800")]
    server.changes[A] = [fchg_stop("a-1-1", '<ar ct="2611040807"/>')]
    assert counts(collect(data_dir, server, clock)) == [(A, 8, 7, 1)]


def test_a_cancelled_stop_is_never_0_minutes(data_dir, server, clock):
    server.plans[(A, 8)] = [plan_stop("a-1-1", "2611040800")]
    server.changes[A] = [fchg_stop("a-1-1", '<ar cs="c" clt="2611040700"/>')]
    assert counts(collect(data_dir, server, clock)) == [(A, 8, None, 1)]


def test_only_arrivals_before_the_last_full_hour_of_today_count(data_dir, server, clock):
    server.plans[(A, 13)] = [plan_stop("a-1-1", "2611041350")]
    server.plans[(A, 14)] = [plan_stop("a-2-1", "2611041410")]  # 14:10, the hour still running
    server.changes[A] = [  # a stop of yesterday, still in the changes
        fchg_stop("y-1-1", '<ar ps="a" ct="2611032210" pt="2611032200"/>', extra='<tl c="ICE"/>')
    ]
    assert counts(collect(data_dir, server, clock)) == [(A, 13, 0, 1)]


def test_a_station_missing_a_plan_slice_before_the_cut_is_left_out(data_dir, server, clock):
    for eva in (A, B):
        server.plans[(eva, 8)] = [plan_stop(f"{eva}-1-1", "2611040800")]
    server.status[f"/plan/{B}/261104/05"] = 500
    assert [r[0] for r in counts(collect(data_dir, server, clock))] == [A]


def test_changes_first_then_the_past_slices_station_by_station_then_the_hours_ahead(
    data_dir, server, clock
):
    collect(data_dir, server, clock)
    assert server.calls[:2] == [f"{API}/fchg/{A}", f"{API}/fchg/{B}"]  # not OLD: not a large one
    past = [f"{e}/261104/{h:02d}" for e in (A, B) for h in range(14)]
    ahead = [f"{e}/261104/{h:02d}" for h in range(14, 18) for e in (A, B)]  # up to now + 3 h
    assert [c.removeprefix(f"{API}/plan/") for c in server.plan_calls()] == past + ahead
    assert clock.slept == len(server.calls) - 1  # one request per second


def large(tmp_path: Path, count: int) -> tuple[Path, list[str]]:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    stations = [f"0800{i:04d}" for i in range(count)]
    write_stations(data_dir, stations)
    return data_dir, stations


def test_no_request_starts_12_minutes_after_the_start(tmp_path, server, clock):
    data_dir, _ = large(tmp_path, 60)  # 60 + 60 * 18 = 1,140 requests wanted
    heute = collect(data_dir, server, clock)
    assert len(server.calls) == 12 * 60  # one a second, the last one at 11:59
    assert heute.schema == HEUTE_SCHEMA
    slices = pl.read_parquet(data_dir / "live" / DAY.isoformat() / "slices.parquet")
    assert slices.height == 12 * 60 - 60
    clock.t += timedelta(minutes=3)
    collect(data_dir, server, clock)
    assert len(set(server.plan_calls())) == len(server.plan_calls())  # no slice twice
    assert len(server.plan_calls()) == 60 * 18


def test_a_first_run_cut_short_counts_the_stations_it_finished(tmp_path, server, clock):
    data_dir, stations = large(tmp_path, 40)
    for eva in stations:
        server.plans[(eva, 8)] = [plan_stop(f"{eva}-1-1", "2611040800")]
    server.slow = (clock, 1.0)  # two seconds a request: 360 requests, 320 of them slices
    heute = collect(data_dir, server, clock)
    assert len(server.calls) == 360
    assert evas(heute) == stations[: 320 // 14]  # 14 slices before the cut each


def test_429_stops_the_run_and_still_writes_state_and_output(data_dir, server, clock):
    server.too_many_from = 4  # two changes and one slice get through
    heute = collect(data_dir, server, clock)
    assert len(server.calls) == 4
    assert heute.height == 0
    assert heute.schema == HEUTE_SCHEMA
    state = data_dir / "live" / DAY.isoformat()
    assert sorted(p.name for p in state.iterdir()) == [
        "fchg.parquet",
        "plan.parquet",
        "slices.parquet",
    ]
    assert pl.read_parquet(state / "slices.parquet").height == 1


def test_a_second_run_merges_onto_the_first_and_a_later_change_wins(data_dir, server, clock):
    server.plans[(A, 8)] = [plan_stop("a-1-1", "2611040800")]
    server.changes[A] = [fchg_stop("a-1-1", '<ar ct="2611040805"/>')]
    collect(data_dir, server, clock)
    server.plans.clear()  # the plan comes from the first run's state
    server.changes[A] = [fchg_stop("a-1-1", '<ar ct="2611040812"/>')]
    clock.t += timedelta(minutes=15)
    assert counts(collect(data_dir, server, clock)) == [(A, 8, 12, 1)]
    assert len(set(server.plan_calls())) == len(server.plan_calls())


def test_a_change_without_change_data_does_not_replace_the_one_before(data_dir, server, clock):
    server.plans[(A, 8)] = [plan_stop("a-1-1", "2611040800")]
    server.changes[A] = [fchg_stop("a-1-1", '<ar ct="2611040805"/>')]
    collect(data_dir, server, clock)
    server.changes[A] = [fchg_stop("a-1-1", '<ar pt="2611040800"/>')]
    clock.t += timedelta(minutes=15)
    assert counts(collect(data_dir, server, clock)) == [(A, 8, 5, 1)]


def test_folders_older_than_yesterday_are_deleted(data_dir, server, clock):
    for day in ("2026-11-02", "2026-11-03"):
        (data_dir / "live" / day).mkdir(parents=True)
    collect(data_dir, server, clock)
    assert sorted(p.name for p in (data_dir / "live").iterdir()) == ["2026-11-03", "2026-11-04"]


def test_before_1am_there_is_no_today_yet(data_dir, server, clock):
    clock.t = datetime(2026, 11, 3, 23, 30, tzinfo=UTC)  # 00:30 on the 4th, local
    server.plans[(A, 0)] = [plan_stop("a-1-1", "2611040010")]
    heute = collect(data_dir, server, clock)
    assert heute.height == 0
    assert heute.schema == HEUTE_SCHEMA
    assert (data_dir / "live" / "2026-11-04" / "plan.parquet").exists()


def test_a_station_whose_changes_failed_in_this_run_is_left_out(data_dir, server, clock):
    for eva in (A, B):
        server.plans[(eva, 8)] = [plan_stop(f"{eva}-1-1", "2611040800")]
    assert evas(collect(data_dir, server, clock)) == [A, B]
    server.status[f"/fchg/{B}"] = 500
    clock.t += timedelta(minutes=15)
    assert evas(collect(data_dir, server, clock)) == [A]
    server.down = True  # without changes, the planned stops would all look on time
    clock.t += timedelta(minutes=15)
    assert collect(data_dir, server, clock).height == 0


def test_bad_bodies_are_skipped_and_asked_for_again(data_dir, server, clock):
    for eva in (A, B):
        server.plans[(eva, 8)] = [plan_stop(f"{eva}-1-1", "2611040800")]
    server.bodies[f"/fchg/{B}"] = "<timetable"  # cut off
    server.bodies[f"/plan/{A}/261104/05"] = " "
    assert collect(data_dir, server, clock).height == 0
    server.bodies.clear()
    clock.t += timedelta(minutes=15)
    assert evas(collect(data_dir, server, clock)) == [A, B]
    assert server.calls.count(f"{API}/plan/{A}/261104/05") == 2


def test_credentials_are_stripped_and_the_key_never_shows(monkeypatch, capsys):
    monkeypatch.setenv("DB_CLIENT_ID", "client\n")
    monkeypatch.setenv("DB_API_KEY", "secret-key\r\n")  # as read from a file
    sent: list[dict[str, str]] = []

    def offline(req: urllib.request.Request, timeout: float):
        sent.append(dict(req.header_items()))
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(urllib.request, "urlopen", offline)
    monkeypatch.setattr(live, "run", lambda data_dir, get, now, sleep: str(get(f"{API}/fchg/{A}")))
    live.main([])
    assert (sent[0]["Db-client-id"], sent[0]["Db-api-key"]) == ("client", "secret-key")
    assert "secret" not in capsys.readouterr().out


def test_missing_credentials_exit_naming_both(monkeypatch):
    monkeypatch.delenv("DB_CLIENT_ID", raising=False)
    monkeypatch.setenv("DB_API_KEY", "x")
    with pytest.raises(SystemExit, match="DB_CLIENT_ID and DB_API_KEY"):
        live.main([])


def test_arguments_are_refused():
    with pytest.raises(SystemExit, match="usage: python -m pipeline.live"):
        live.main(["--now"])
