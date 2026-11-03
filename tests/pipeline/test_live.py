import subprocess
import sys
import urllib.error
import urllib.request
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl
import pytest

from core.normal import WEEKS
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
        self.day = DAY  # the day the plan slices belong to
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
        stops = self.plans.get((eva, int(hh)), []) if yymmdd == self.day.strftime("%y%m%d") else []
        return 200, xml(*stops)

    def plan_calls(self) -> list[str]:
        return [c for c in self.calls if "/plan/" in c]


def write_stations(data_dir: Path, evas: list[str]) -> None:
    """The large stations, as `pipeline.update` writes them."""
    pl.DataFrame({"eva": sorted(evas)}, schema={"eva": pl.String}).write_parquet(
        data_dir / "large.parquet"
    )


def test_the_collector_reads_the_large_stations_from_large_parquet(data_dir):
    assert live.large_evas(data_dir) == [A, B]


@pytest.mark.parametrize("evas", [None, []])
def test_without_large_stations_the_run_exits_naming_the_update(tmp_path, server, clock, evas):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    if evas is not None:
        write_stations(data_dir, evas)
    with pytest.raises(SystemExit, match="pipeline.update"):
        live.run(data_dir, server.get, clock.now, clock.sleep)
    assert server.calls == []


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
        "runs.parquet",
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


def test_the_collector_imports_without_the_download_library():
    """The API image leaves the `pipeline` dependency group (huggingface-hub) out."""
    code = "import sys; sys.modules['huggingface_hub'] = None; import pipeline.live"
    root = Path(__file__).resolve().parents[2]
    done = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def test_arguments_are_refused():
    with pytest.raises(SystemExit, match="usage: python -m pipeline.live"):
        live.main(["--now"])


# Collector days: the stops planned on a day D are finalized by the first run at or after 01:00
# local on D + 1 into data/live_tage.parquet. D is a Tuesday in winter time (local = UTC + 1).
D = date(2026, 11, 3)
AT_0_30 = datetime(2026, 11, 2, 23, 30, tzinfo=UTC)  # 00:30 local on D
AT_12_30 = datetime(2026, 11, 3, 11, 30, tzinfo=UTC)  # 12:30 local on D
AT_23_30 = datetime(2026, 11, 3, 22, 30, tzinfo=UTC)  # 23:30 local on D: all 24 slices of D
AT_0_10 = datetime(2026, 11, 3, 23, 10, tzinfo=UTC)  # 00:10 local on D + 1: too early to finalize
AT_1_05 = datetime(2026, 11, 4, 0, 5, tzinfo=UTC)  # 01:05 local on D + 1: finalizes D
AT_1_20 = datetime(2026, 11, 4, 0, 20, tzinfo=UTC)
KEPT_SCHEMA = pl.Schema(
    {
        "day": pl.Date,
        "hour": pl.Int8,
        "gruppe": pl.String,
        "eva": pl.String,
        "bucket": pl.Int32,
        "n": pl.UInt32,
    }
)


def run_at(data_dir: Path, server: Server, t: datetime) -> str:
    clock = Clock(t)
    return live.run(data_dir, server.get, clock.now, clock.sleep)


def the_day(data_dir: Path, server: Server) -> None:
    """The runs that cover D: from its local midnight on, never more than 12 hours between them."""
    for t in (AT_0_30, AT_12_30, AT_23_30):
        run_at(data_dir, server, t)


def kept(data_dir: Path) -> pl.DataFrame:
    return pl.read_parquet(data_dir / "live_tage.parquet")


def rows_of(df: pl.DataFrame, day: date = D) -> list[tuple]:
    return df.filter(pl.col("day") == day).sort("eva", "hour", "bucket").drop("day").rows()


def a_day(server: Server) -> None:
    """Two stops of D at station A: 08:00 and 23:50, and one of B."""
    server.day = D
    server.plans[(A, 8)] = [plan_stop("a-1-1", "2611030800")]
    server.plans[(A, 23)] = [plan_stop("a-1-2", "2611032350")]
    server.plans[(B, 8)] = [plan_stop("b-1-1", "2611030800")]


def test_the_first_run_from_1am_keeps_yesterday_with_the_changes_of_the_night(data_dir, server):
    a_day(server)
    the_day(data_dir, server)
    server.changes[A] = [fchg_stop("a-1-2", '<ar ct="2611040005"/>')]  # 15 min late, after 00:00
    run_at(data_dir, server, AT_0_10)
    assert not (data_dir / "live_tage.parquet").exists()  # not before 01:00
    server.changes[A] = []  # the API has forgotten the change by now: the run before holds it
    summary = run_at(data_dir, server, AT_1_05)
    out = kept(data_dir)
    assert out.schema == KEPT_SCHEMA
    assert rows_of(out) == [
        (8, "fern", A, 0, 1),
        (23, "fern", A, 15, 1),
        (8, "fern", B, 0, 1),
    ]
    assert "kept 2026-11-03: 2 stations" in summary
    assert not list(data_dir.glob("*.tmp"))


def test_a_kept_day_is_not_written_again(data_dir, server):
    a_day(server)
    the_day(data_dir, server)
    run_at(data_dir, server, AT_1_05)
    before = rows_of(kept(data_dir))
    server.changes[A] = [fchg_stop("a-1-1", '<ar ct="2611030830"/>')]
    summary = run_at(data_dir, server, AT_1_20)
    assert rows_of(kept(data_dir)) == before
    assert "kept" not in summary


def test_a_station_without_all_24_slices_of_the_day_is_left_out(data_dir, server):
    a_day(server)
    server.status[f"/plan/{B}/261103/05"] = 500
    the_day(data_dir, server)
    run_at(data_dir, server, AT_1_05)
    assert sorted(kept(data_dir)["eva"].unique()) == [A]


def test_a_station_whose_changes_failed_in_the_finalizing_run_is_left_out(data_dir, server):
    a_day(server)
    the_day(data_dir, server)
    server.status[f"/fchg/{B}"] = 500
    run_at(data_dir, server, AT_1_05)
    assert sorted(kept(data_dir)["eva"].unique()) == [A]


def at_utc(hour: int, minute: int = 0, second: int = 0) -> datetime:
    return datetime(2026, 11, 3, hour, minute, second, tzinfo=UTC)


@pytest.mark.parametrize(
    "earlier, is_kept",
    [
        ([at_utc(7)], False),  # 15.5 h to the evening run
        ([at_utc(10, 30)], True),  # 12 h exactly is still fine
        ([at_utc(10, 29, 59)], False),
        ([at_utc(7), at_utc(15)], True),
        ([at_utc(19)], False),  # the first run of D at 20:00 local: the night was never seen
        ([], False),  # the first run at 23:30 local
    ],
)
def test_runs_more_than_12_hours_apart_keep_no_day(data_dir, server, earlier, is_kept):
    a_day(server)
    for t in earlier:
        run_at(data_dir, server, t)
    run_at(data_dir, server, AT_23_30)
    summary = run_at(data_dir, server, AT_1_05)
    assert (data_dir / "live_tage.parquet").exists() is is_kept
    assert ("runs more than 12 hours apart" in summary) is not is_kept
    assert (data_dir / "live" / "2026-11-03" / "final").exists()  # kept or not, not tried again


def test_a_day_with_no_runs_is_not_kept(data_dir, server):
    # a fresh start after midnight: there is no state of D
    summary = run_at(data_dir, server, AT_1_05)
    assert not (data_dir / "live_tage.parquet").exists()
    assert "kept" not in summary


def test_a_day_whose_runs_all_failed_is_dropped_with_the_note_no_runs(data_dir, server):
    a_day(server)
    server.down = True  # D has a state folder but not one answered run
    run_at(data_dir, server, AT_23_30)
    server.down = False
    summary = run_at(data_dir, server, AT_1_05)
    assert "dropped 2026-11-03: no runs" in summary
    assert not (data_dir / "live_tage.parquet").exists()


def test_the_runs_just_after_midnight_count_in_the_gap_check_of_the_day_before(data_dir, server):
    a_day(server)
    run_at(data_dir, server, AT_0_30)
    run_at(data_dir, server, AT_12_30)  # then nothing for 11 h 45 ...
    run_at(data_dir, server, datetime(2026, 11, 3, 23, 15, tzinfo=UTC))  # 00:15 local on D + 1
    summary = run_at(data_dir, server, AT_1_05)  # ... and 50 min: 12 h 35 min without the 00:15 run
    assert "kept 2026-11-03" in summary


def test_yesterdays_state_is_read_only_while_it_is_open(data_dir, server, monkeypatch):
    a_day(server)
    the_day(data_dir, server)
    run_at(data_dir, server, AT_1_05)  # finalizes D
    read: list[Path] = []
    real = live._stops
    monkeypatch.setattr(live, "_stops", lambda path: (read.append(path), real(path))[1])
    run_at(data_dir, server, AT_1_20)
    assert read
    assert {p.parent.name for p in read} == {"2026-11-04"}


def test_a_skipped_day_is_not_tried_again(data_dir, server):
    a_day(server)
    run_at(data_dir, server, at_utc(7))
    run_at(data_dir, server, AT_23_30)
    run_at(data_dir, server, AT_1_05)
    run_at(data_dir, server, AT_1_20)
    assert not (data_dir / "live_tage.parquet").exists()


def test_runs_are_recorded_in_the_state_folder_of_their_day(data_dir, server):
    run_at(data_dir, server, AT_23_30)
    run_at(data_dir, server, AT_0_10)
    server.down = True  # a run that gets no changes covers nothing
    run_at(data_dir, server, datetime(2026, 11, 4, 0, 40, tzinfo=UTC))

    def runs(day: str) -> pl.DataFrame:
        return pl.read_parquet(data_dir / "live" / day / "runs.parquet")

    assert runs("2026-11-03").schema == pl.Schema({"t0": pl.Datetime("us")})  # naive UTC
    # the run just after midnight also counts for the day before
    assert runs("2026-11-03")["t0"].to_list() == [
        t.replace(tzinfo=None) for t in (AT_23_30, AT_0_10)
    ]
    assert runs("2026-11-04")["t0"].to_list() == [AT_0_10.replace(tzinfo=None)]


@pytest.mark.parametrize("failure", ["down", "throttled"])
def test_a_finalizing_run_without_all_the_changes_waits_for_the_next_one(data_dir, server, failure):
    a_day(server)
    the_day(data_dir, server)
    if failure == "down":
        server.down = True
    else:
        server.too_many_from = len(server.calls) + 2  # A answers, B is throttled
    run_at(data_dir, server, AT_1_05)
    assert not (data_dir / "live_tage.parquet").exists()
    assert not (data_dir / "live" / "2026-11-03" / "final").exists()
    server.down, server.too_many_from = False, None
    summary = run_at(data_dir, server, AT_1_20)
    assert sorted(kept(data_dir)["eva"].unique()) == [A, B]
    assert "kept 2026-11-03: 2 stations" in summary


def test_the_file_keeps_the_reference_weeks_before_the_new_day_and_replaces_the_day_itself(
    data_dir, server
):
    assert live.KEEP_DAYS == 7 * WEEKS  # every reference day of the same weekday stays
    keep = timedelta(days=live.KEEP_DAYS)
    a_day(server)
    old = [
        (D - keep - timedelta(days=1), 8, "fern", A, 0, 7),
        (D - keep, 8, "fern", A, 0, 7),
        (D - timedelta(days=1), 8, "fern", A, 0, 7),
        (D, 9, "fern", A, 0, 99),  # an earlier version of D itself
    ]
    pl.DataFrame(old, schema=KEPT_SCHEMA, orient="row").write_parquet(
        data_dir / "live_tage.parquet"
    )
    the_day(data_dir, server)
    run_at(data_dir, server, AT_1_05)
    out = kept(data_dir)
    assert sorted(out["day"].unique()) == [D - keep, D - timedelta(days=1), D]
    assert (9, "fern", A, 0, 99) not in rows_of(out)
    assert (8, "fern", A, 0, 1) in rows_of(out)


def test_the_night_the_clocks_go_back_is_one_25_hour_day(data_dir, server):
    day = date(2026, 10, 25)  # CEST ends at 03:00 local: 02:30 happens twice
    server.day = day
    server.plans[(A, 2)] = [plan_stop("a-1-1", "2610250230")]
    server.plans[(A, 23)] = [plan_stop("a-1-2", "2610252350")]
    for hour, minute in ((0, 30), (1, 30), (11, 0), (22, 30)):  # 02:30 CEST, 02:30 CET, ... 23:30
        run_at(data_dir, server, datetime(2026, 10, 25, hour, minute, tzinfo=UTC))
    assert not (data_dir / "live_tage.parquet").exists()
    summary = run_at(data_dir, server, datetime(2026, 10, 26, 0, 5, tzinfo=UTC))  # 01:05 CET
    assert "kept 2026-10-25" in summary
    assert rows_of(kept(data_dir), day) == [(2, "fern", A, 0, 1), (23, "fern", A, 0, 1)]
