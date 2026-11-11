"""The one pipeline command: process every remote month not yet done, then the complete raw days
after the last month and the current day so far, then combine."""

import re
import shutil
import sys
import tempfile
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

import polars as pl
from huggingface_hub import list_repo_files

from core.delay import PLAUSIBLE_MAX, PLAUSIBLE_MIN
from core.lines import (
    is_train_number,
    line_ids,
    line_table,
    networks,
    no_live_data,
    top_ends,
)
from core.periods import full_coverage_start, large_stations, local_midnight_utc, local_time
from core.sections import line_axis, orient_axis
from pipeline.aggregate import (
    aggregate,
    coverage_report,
    day_gaps,
    day_hours,
    days,
    dropped,
    ends,
    line_hours,
    line_trips,
    lines,
    meta,
    month_networks,
    routes,
    runs,
    sections,
    stations,
    stop_counts,
    with_coords,
)
from pipeline.coords import OUT as COORDS
from pipeline.coords import main as fetch_coords
from pipeline.live import _write, large_evas
from pipeline.raw import (
    REPO,
    RawSource,
    day_runs,
    day_tables,
    download,
    fchg_pass,
    raw_gaps,
    remote_source,
    stop_rows,
)

MONTH_FILES = (
    "aggregate",
    "lines",
    "ends",
    "networks",
    "stations",
    "meta",
    "days",
    "day_gaps",
    "day_hours",
    "sections",
    "routes",
    "runs",
    "line_hours",
    "line_trips",
    "stops",
)
AGGREGATE_ORDER = ("month", "eva", "weekday", "hour", "gruppe", "bucket")
DAYS_ORDER = ("day", "eva", "gruppe", "bucket")
DAY_HOURS_ORDER = ("day", "hour", "eva", "gruppe", "bucket")
# About one day's rows (24.5 M rows over 822 days), so a one-day filter skips the other row groups.
# ponytail: no test reads the row groups (neither Polars nor an installed library exposes them);
# the evidence is the /tageskarte memory measurement in docs/day-history.md §5; if pyarrow becomes
# a dependency, a test of the row-group metadata is short
DAYS_ROW_GROUP = 50_000


# `day_gaps` is rewritten for every raw day on each update
DAY_FILES = ("days", "hours", "day_hours", "runs")
# `fahrten.parquet` (the trips of the Bildfahrplan) holds this many days, ending on the last day of
# `tage.parquet`.
WINDOW_DAYS = 28
# Rows per row group of `fahrten.parquet`: about the stops of one busy line on one day, so reading
# a line and a day (the file is sorted by both) touches one or two groups of the thousand or so.
FAHRTEN_ROW_GROUP = 10_000
# Files whose first `fchg` request lies this close after the previous file's last one are one run
# (separate runs are at least about 5 minutes apart).
SAME_RUN = timedelta(seconds=60)
# A run with fewer `fchg` requests than this share of the largest run died partway: the stations it
# never asked would count their late stops as on time. Failed requests are rare, so 90 % is safe.
FULL_RUN = 0.9


def _complete(month_dir: Path) -> bool:
    # ponytail: looks only at the folder, so a month HuggingFace replaces later is not fetched again
    # and a change to the per-month logic needs data/months/ deleted by hand; record a version per
    # folder if either happens often.
    return all((month_dir / f"{name}.parquet").exists() for name in MONTH_FILES)


def _day_done(day_dir: Path) -> bool:
    return all((day_dir / f"{name}.parquet").exists() for name in DAY_FILES)


def process(src: Path, month: str, out: Path) -> str:
    """Write the month's tables to `out` via a temporary sibling, renamed only when all are
    written, so a crash never leaves a half-complete month. Returns the cleaning summary."""
    lf = pl.scan_parquet(src)
    dups, bad = dropped(lf)
    tmp = out.with_name(f"{out.name}.tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    nets = month_networks(lf)
    tables = {
        "aggregate": aggregate(lf),
        "lines": lines(lf),
        "ends": ends(lf),
        "networks": nets,
        "stations": stations(lf),
        "meta": meta(lf, month),
        "days": days(lf),
        "day_gaps": day_gaps(lf, month),
        "day_hours": day_hours(lf),
        "sections": sections(lf),
        "routes": routes(lf),
        "runs": runs(lf),
        "line_hours": line_hours(lf, nets),
        "line_trips": line_trips(lf, nets),
        "stops": stop_counts(lf),
    }
    for name, df in tables.items():
        df.write_parquet(tmp / f"{name}.parquet")
    shutil.rmtree(out, ignore_errors=True)  # an incomplete earlier attempt
    tmp.rename(out)
    return f"dropped {dups} duplicates and {bad} implausible rows"


def process_day(day: date, files: list[Path], boundary: datetime, out: Path) -> str:
    """Write a raw day's tables to `out` via a temporary sibling, like `process`; returns a note."""
    rows = stop_rows(files)
    day_days, hours, hour_days = day_tables(rows, day, boundary)
    tmp = out.with_name(f"{out.name}.tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    day_days.write_parquet(tmp / "days.parquet")
    hours.write_parquet(tmp / "hours.parquet")
    hour_days.write_parquet(tmp / "day_hours.parquet")
    day_runs(rows, day, boundary).write_parquet(tmp / "runs.parquet")
    shutil.rmtree(out, ignore_errors=True)
    tmp.rename(out)
    return f"{rows.height} stops, {day_days['n'].sum()} counted"


def _raw_dirs(data_dir: Path) -> list[Path]:
    """The raw day folders `combine` adds: processed, with their gaps, and not superseded by a
    complete monthly folder (the monthly file wins)."""
    months = {d.name for d in (data_dir / "months").glob("????-??") if _complete(d)}
    return sorted(
        d
        for d in (data_dir / "days").glob("????-??-??")
        if _day_done(d) and (d / "day_gaps.parquet").exists() and d.name[:7] not in months
    )


def _write_gaps(days_dir: Path) -> None:
    """Judge the missing hours of every raw day against the raw days of its month so far, so the
    usual level grows with the month and earlier days are re-judged."""
    by_month: dict[str, list[Path]] = {}
    for d in sorted(days_dir.glob("????-??-??")):
        if _day_done(d):
            by_month.setdefault(d.name[:7], []).append(d)
    for dirs in by_month.values():
        day_list = [date.fromisoformat(d.name) for d in dirs]
        gaps = raw_gaps(pl.concat(pl.read_parquet(d / "hours.parquet") for d in dirs), day_list)
        for d, day in zip(dirs, day_list, strict=True):
            gaps.filter(pl.col("day") == day).write_parquet(d / "day_gaps.parquet")


def update_days(data_dir: Path, raw: RawSource) -> None:
    """Process the complete raw days after the last complete monthly folder into `data/days/`. A day
    is complete once a complete `fchg` run from after the next local midnight exists (see
    `day_complete`). It reads the raw files of the UTC folders before it, of its own and after it:
    the runs write the early plan hours of a day (00:00 to 03:00) into the folder before, and the
    late changes into the next. Days already done are skipped.
    ponytail: a day's raw files are downloaded again if its folder is lost or the parse logic
    changes; keeping them would cost about 250 MB per day.
    ponytail: an empty folder after the day (the source lost a whole UTC day) stalls every later
    day until it appears or the monthly file arrives; skipping it needs a rule for the day after."""
    days_dir = data_dir / "days"
    months = sorted(d.name for d in (data_dir / "months").glob("????-??") if _complete(d))
    last = datetime.strptime(months[-1], "%Y-%m") if months else None
    day = date(last.year + last.month // 12, last.month % 12 + 1, 1) if last else None
    stale = [d for d in days_dir.glob("????-??-??*") if d.name[:7] in months]
    if stale and day:
        # The boundary moved: the new first day was processed under the old one. First, so a
        # crash leaves it to be redone.
        shutil.rmtree(days_dir / day.isoformat(), ignore_errors=True)
    for d in days_dir.glob("????-??-??*"):
        if d.name.endswith(".tmp") or d.name[:7] in months:  # a crash, or the monthly file wins
            shutil.rmtree(d, ignore_errors=True)
    if not day:
        return
    boundary, step = datetime.combine(day, time()), timedelta(days=1)
    with tempfile.TemporaryDirectory() as tmp:
        downloaded: dict[str, Path] = {}  # each folder is needed by three days in a row

        def get(key: str) -> Path:
            if key not in downloaded:
                downloaded[key] = raw.fetch(key, Path(tmp))
            return downloaded[key]

        while True:  # until the first day that is not complete yet
            out = days_dir / day.isoformat()
            if not _day_done(out):
                before, own, following = (raw.files(day + n * step) for n in (-1, 0, 1))
                if not day_complete(raw, own + following, day):
                    break
                if not own:
                    print(f"{day}: no raw files in its own folder (the source lost the day)")
                files = [get(k) for k in before + own + following]
                summary = process_day(day, files, boundary, out)
                print(f"{day}: processed from raw, {summary}")
                for key in before:  # the next day starts at its own folder
                    if key in downloaded:
                        downloaded.pop(key).unlink()
            day += step
    _write_gaps(days_dir)


def newest_fchg(raw: RawSource, keys: list[str]) -> tuple[str, datetime] | None:
    """The newest of `keys` (in time order) with a `fchg` snapshot, and that snapshot's time
    (naive UTC). The newest file may hold none (a run whose requests failed): look back."""
    spans = ((k, raw.fchg_span(k)) for k in reversed(keys))
    return next(((k, s[1]) for k, s in spans if s is not None), None)


def day_complete(raw: RawSource, keys: list[str], day: date) -> bool:
    """Whether a complete `fchg` run started after the local midnight that ends `day`: by then the
    late changes of its stops are in (a run before it gives a day that is too good, by 1 to 2
    %-points). `keys` are the files of the UTC folders of `day` and the day after, in time order.
    Files within SAME_RUN of each other are one run, as a run can be split over two files at UTC
    midnight; the last run, when it ends within SAME_RUN before a UTC midnight, may still be
    missing its other half and does not count until a later file exists. A run that died partway
    has fewer requests than FULL_RUN of the largest run of the files and does not count either.
    ponytail: assumes a run splits only at a UTC midnight (one case seen); a split elsewhere needs
    the answered stations compared. Reads two columns of every file of two folders per pending day
    (about 12 small remote reads); cache the spans if updates run often."""
    spans = sorted(s for k in keys if (s := raw.fchg_span(k)))
    runs: list[tuple[datetime, datetime, int]] = []  # start, end, number of requests
    for first, last, count in spans:
        if runs and first - runs[-1][1] <= SAME_RUN:
            start, _, total = runs.pop()
            runs.append((start, last, total + count))
        else:
            runs.append((first, last, count))
    if (
        runs
        and datetime.combine(runs[-1][1].date() + timedelta(1), time()) - runs[-1][1] <= SAME_RUN
    ):
        runs.pop()
    midnight = local_midnight_utc(day + timedelta(days=1))
    biggest = max((count for *_, count in runs), default=0)
    return any(start >= midnight and count >= FULL_RUN * biggest for start, _, count in runs)


def update_rest(data_dir: Path, raw: RawSource, now: datetime, large: list[str]) -> None:
    """Write `heute_rest.parquet`: the local day of `now` so far, from the raw files of the UTC
    folders before it and of its own. `day_hours` of the stops planned on the day at the large
    stations (`large`) that answered in the newest `fchg` pass, only the hours before the local
    hour the pass started, plus that start as `stand` (UTC); like the live collector's run start,
    the stops of the hour the pass started in are not settled. No pass of the day yet gives no
    rows, so an earlier file never stays.
    ponytail: every update downloads both UTC folders again (about 2 x 160 MB); keep them in a
    local cache if updates run often."""
    day = local_time(now).date()
    keys = raw.files(day - timedelta(days=1)) + raw.files(day)
    newest = newest_fchg(raw, keys)
    stand, cut, answered = None, 0, set[str]()
    with tempfile.TemporaryDirectory() as tmp:
        files: dict[str, Path] = {}
        if newest and local_time(newest[1].replace(tzinfo=UTC)).date() == day:
            files[newest[0]] = raw.fetch(newest[0], Path(tmp))
            start, answered = fchg_pass(files[newest[0]])
            stand = start.replace(tzinfo=UTC) if start else None
            seen = local_time(stand) if stand else None
            cut = seen.hour if seen and seen.date() == day else 0
        paths = [files.get(k) or raw.fetch(k, Path(tmp)) for k in keys] if cut else []
        rows = stop_rows(paths)
    today = rows.sort("time", "id").lazy().filter(pl.col("arrival_planned_time").dt.date() == day)
    keep = pl.col("eva").is_in(sorted(answered & set(large)))
    rest = day_hours(today).filter(pl.col("hour") < cut, keep)
    _write(
        rest.with_columns(stand=pl.lit(stand, pl.Datetime("us", "UTC"))),
        data_dir / "heute_rest.parquet",
    )
    print(f"{day} so far: {rest['n'].sum()} stops before {cut:02d}:00 from raw, stand {stand}")


def _read(dirs: list[Path], name: str) -> pl.DataFrame:
    """One table over all months, with `month` from the folder name where the table has none."""
    frames = [pl.read_parquet(d / f"{name}.parquet") for d in dirs]
    return pl.concat(
        df if "month" in df.columns else df.with_columns(month=pl.lit(d.name))
        for d, df in zip(dirs, frames, strict=True)
    )


def write_large(data_dir: Path) -> list[str]:
    """Write `large.parquet` (one column `eva`, sorted) from the `days.parquet` and
    `monate.parquet` just written: the large stations by the one core rule, so the collector job
    and the API need not read the big `days.parquet`. Empty without a month before full coverage.
    Returns the EVAs."""
    monate = pl.read_parquet(data_dir / "monate.parquet")
    start = full_coverage_start(dict(zip(monate["month"], monate["stations"], strict=True)))
    days = pl.scan_parquet(data_dir / "days.parquet")
    evas = large_stations(days, start).collect()["eva"].to_list() if start else []
    pl.DataFrame({"eva": evas}, schema={"eva": pl.String}).write_parquet(data_dir / "large.parquet")
    return evas


def combine(data_dir: Path) -> None:
    """Write the files the API reads from all complete month folders; the day tables (`days`,
    `day_hours`, `tage`) also take the raw days after the last month.
    ponytail: rewrites every file on every run, also when nothing is new; skip unchanged inputs if
    the run time starts to matter."""
    dirs = sorted(d for d in (data_dir / "months").glob("????-??") if _complete(d))
    raw_dirs = _raw_dirs(data_dir)
    aggregates = [d / "aggregate.parquet" for d in dirs]
    pl.scan_parquet(aggregates).sort(*AGGREGATE_ORDER, nulls_last=True).sink_parquet(
        data_dir / "aggregate.parquet"
    )

    # An edge day can sit in two month files, or in the last month and the first raw day: sum it
    # per key.
    (
        pl.scan_parquet([d / "days.parquet" for d in [*dirs, *raw_dirs]])
        .group_by(DAYS_ORDER)
        .agg(pl.col("n").sum())
        .select("day", "gruppe", "eva", "bucket", "n")
        .sort(DAYS_ORDER, nulls_last=True)
        .sink_parquet(data_dir / "days.parquet", row_group_size=DAYS_ROW_GROUP)
    )
    # The hour table covers only the large stations (the day map's today needs no others); month
    # and day folders keep theirs whole. They are found in the two files just written.
    _read(dirs, "meta").sort("month").write_parquet(data_dir / "monate.parquet")
    _read(dirs, "stops").group_by("eva", "gruppe", "month").agg(pl.col("n").sum()).sort(
        "eva", "month", "gruppe"
    ).write_parquet(data_dir / "halte.parquet")
    large = write_large(data_dir)
    (
        pl.scan_parquet([d / "day_hours.parquet" for d in [*dirs, *raw_dirs]])
        .filter(pl.col("eva").is_in(large))
        .group_by(DAY_HOURS_ORDER)
        .agg(pl.col("n").sum())
        .select("day", "hour", "gruppe", "eva", "bucket", "n")
        .sort(DAY_HOURS_ORDER, nulls_last=True)
        .sink_parquet(data_dir / "day_hours.parquet", row_group_size=DAYS_ROW_GROUP)
    )
    pl.concat(pl.read_parquet(d / "day_gaps.parquet") for d in [*dirs, *raw_dirs]).sort(
        "day"
    ).write_parquet(data_dir / "tage.parquet")

    per_month = _read(dirs, "stations")
    names = (
        per_month.sort("month")  # group_by keeps the row order inside a group
        .group_by("eva")
        .agg(name=pl.col("name").drop_nulls().last(), n=pl.col("n").sum())
    )
    st = with_coords(names.sort("eva"), pl.read_parquet(data_dir / "coords.parquet"))
    st.write_parquet(data_dir / "stations.parquet")
    print(coverage_report(st))

    month_nets = _read(dirs, "networks")
    nets = networks(
        month_nets.select("name", group=pl.concat_str("month", pl.lit("|"), "net"), eva="eva")
    )
    by_name = _read(dirs, "lines")
    stops = by_name.group_by("name", "eva", "train_type").agg(pl.col("n").sum())
    all_ends = _read(dirs, "ends").group_by("name", "eva", "dest").agg(pl.col("n").sum())
    keys = ["linie", "eva", "gruppe", "month", "bucket"]
    line_of = line_ids(nets).select("name", "eva", "linie")
    cells = (
        by_name.join(line_of, on=["name", "eva"])
        .group_by(keys)
        .agg(pl.col("n").sum())
        .sort(keys, nulls_last=True)
    )
    cells.write_parquet(data_dir / "lines.parquet")
    n, bucket = pl.col("n"), pl.col("bucket")
    counts = cells.group_by("linie").agg(
        n=n.sum(),
        zero=n.filter(bucket == 0).sum(),
        cancelled=n.filter(bucket.is_null()).sum(),
    )
    flags = counts.select(
        "linie", ohne_echtzeit=no_live_data(pl.col("n"), pl.col("zero"), pl.col("cancelled"))
    )
    (
        line_table(nets, stops, all_ends)
        .join(flags, on="linie", how="left")
        .with_columns(zug=is_train_number(pl.col("name")))
        .select("linie", "name", "label", "typ", "zug", "ohne_echtzeit")
        .write_parquet(data_dir / "linien.parquet")
    )
    write_line_sections(data_dir, dirs, line_of, top_ends(all_ends, line_of))
    write_line_profiles(data_dir, dirs, line_of)
    write_trips(data_dir, [*dirs, *raw_dirs], line_of)


def write_line_profiles(data_dir: Path, dirs: list[Path], line_of: pl.DataFrame) -> None:
    """Write `linien_stunden.parquet` (the delay histogram per line, weekday, hour and month) and
    `takt.parquet` (the trips per line, group and month), only for the lines of `linien.parquet`
    and sorted by line and month. A month table holds the month's network `net`, its lowest EVA:
    that is an EVA of the network, so `line_of` (name, eva, linie) maps it to the line."""
    known = pl.read_parquet(data_dir / "linien.parquet").select("linie")

    def of_line(name: str, keys: list[str], total: str) -> pl.DataFrame:
        return (
            _read(dirs, name)
            .join(line_of, left_on=["name", "net"], right_on=["name", "eva"])
            .join(known, on="linie", how="semi")
            .group_by(keys)
            .agg(pl.col(total).sum())
            .sort(keys, nulls_last=True)
        )

    of_line("line_hours", ["linie", "month", "gruppe", "weekday", "hour", "bucket"], "n").select(
        "linie", "gruppe", "weekday", "hour", "month", "bucket", "n"
    ).write_parquet(data_dir / "linien_stunden.parquet")
    of_line("line_trips", ["linie", "month", "gruppe"], "trips").select(
        "linie", "gruppe", "month", "trips"
    ).write_parquet(data_dir / "takt.parquet")


def write_trips(data_dir: Path, folders: list[Path], line_of: pl.DataFrame) -> None:
    """Write `fahrten.parquet`: the stops of the trips of the last WINDOW_DAYS days (ending on the
    last day of `tage.parquet`), for the lines of `linien.parquet`, sorted by line, day, trip and
    stop number. `folders` are the month folders, then the raw day folders; only those that reach
    into the window are read, and of a stop in two places the first copy stays. A trip finds its
    line by line name and the station of its first stop, like the sections. `line_of` is
    (name, eva, linie)."""
    last = pl.read_parquet(data_dir / "tage.parquet").select(pl.col("day").max()).item()
    first = last - timedelta(days=WINDOW_DAYS - 1)
    reached = [f / "runs.parquet" for f in folders if f.name[:7] >= f"{first:%Y-%m}"]
    known = pl.read_parquet(data_dir / "linien.parquet").select("linie")
    # The window is read first (the day filter is pushed into the scan), the rest runs on it: a
    # lazy plan over an empty window panics in Polars 2.0.0.
    window = pl.scan_parquet(reached).filter(pl.col("day").is_between(first, last)).collect()
    window = window.unique(["trip", "num"], keep="first", maintain_order=True).with_columns(
        zug=pl.coalesce("zug", "name")  # a stop without a train type or number has no "{type} {nr}"
    )
    lines = (  # one row per trip: the line of its first stop
        window.group_by("trip")
        .agg(pl.col("name", "eva").sort_by("num").first())
        .join(line_of, on=["name", "eva"])
        .join(known, on="linie", how="semi")
        .select("trip", "linie")
    )
    out = window.drop("name").join(lines, on="trip")
    del window  # one full-size frame less during the sort

    def minutes(time: str, since: pl.Expr) -> pl.Expr:
        return (pl.col(time) - since).dt.total_minutes().cast(pl.Int16)

    def delay(change: str, planned: str) -> pl.Expr:  # outside the plausible range = no change
        d = (pl.col(change) - pl.col(planned)).dt.total_minutes()
        return pl.when(d.is_between(PLAUSIBLE_MIN, PLAUSIBLE_MAX)).then(d).cast(pl.Int16)

    # Minutes instead of datetimes: a quarter of the size. Times count from the trip day's midnight
    # (past 1440 for a night trip); a delay is null without a change time (on time).
    midnight = pl.col("day").cast(pl.Datetime("us"))
    out = out.select(
        "linie",
        "day",
        "trip",
        "zug",
        "num",
        "eva",
        minutes("arrival_planned_time", midnight).alias("an_plan"),
        delay("arrival_change_time", "arrival_planned_time").alias("an_delay"),
        minutes("departure_planned_time", midnight).alias("ab_plan"),
        delay("departure_change_time", "departure_planned_time").alias("ab_delay"),
        "arrival_is_canceled",
        "departure_is_canceled",
    ).sort("linie", "day", "trip", "num")
    path = data_dir / "fahrten.parquet"
    out.write_parquet(path, row_group_size=FAHRTEN_ROW_GROUP)
    print(f"fahrten.parquet: {out.height} rows, {path.stat().st_size / 1e6:.1f} MB")


def write_line_sections(
    data_dir: Path, dirs: list[Path], line_of: pl.DataFrame, line_ends: pl.DataFrame
) -> None:
    """Write `abschnitte.parquet` (the sections per line and month) and `linienweg.parquet` (the
    station order of each line, turned to the label's order), both only for the lines of
    `linien.parquet`. `line_of` is (name, eva, linie); a section finds its line by its first
    station, a pattern as well. `line_ends` is (linie, dest list), the label's end stations.
    ponytail: the axis comes from the newest month in which the line has routes; revisit if a
    route changes inside a period."""
    known = pl.read_parquet(data_dir / "linien.parquet").select("linie")

    def of_line(df: pl.DataFrame, first: str) -> pl.DataFrame:
        return df.join(line_of, left_on=["name", first], right_on=["name", "eva"]).join(
            known, on="linie", how="semi"
        )

    (
        of_line(_read(dirs, "sections"), "from_eva")
        .select("linie", "from_eva", "to_eva", "month", "n", "minutes")
        .sort("linie", "month", "from_eva", "to_eva")
        .write_parquet(data_dir / "abschnitte.parquet")
    )
    patterns = of_line(
        _read(dirs, "routes").with_columns(first=pl.col("pattern").list.first()), "first"
    )
    newest = patterns.filter(pl.col("month") == pl.col("month").max().over("linie"))
    names = pl.read_parquet(data_dir / "stations.parquet").select("eva", "name")
    orient_axis(line_axis(newest), names, line_ends).write_parquet(data_dir / "linienweg.parquet")


def update(
    data_dir: Path,
    remote_months: Callable[[], list[str]],
    fetch: Callable[[str], Path],
    raw: RawSource | None = None,
    now: Callable[[], datetime] | None = None,
) -> None:
    """`now` (aware) enables the partial current day from `raw`, written last: its downloads
    failing never keeps the complete days from being combined."""
    coords = data_dir / "coords.parquet"
    if not coords.exists():
        sys.exit(f"Missing {coords}: run `uv run python -m pipeline.coords` first")
    for month in remote_months():
        out = data_dir / "months" / month
        if _complete(out):
            print(f"{month}: skipped, already complete")
            continue
        print(f"{month}: processed, {process(fetch(month), month, out)}")
    if raw:
        update_days(data_dir, raw)
    combine(data_dir)
    if raw and now:
        update_rest(data_dir, raw, now(), large_evas(data_dir))


def remote_months() -> list[str]:
    pattern = r"monthly_processed_data/data-(\d{4}-\d{2})\.parquet"
    files = list_repo_files(REPO, repo_type="dataset")
    return sorted(m[1] for f in files if (m := re.fullmatch(pattern, f)))


def main(argv: list[str]) -> None:
    if argv:
        sys.exit("usage: python -m pipeline.update")
    if not COORDS.exists():
        fetch_coords([])
    update(
        Path("data"),
        remote_months,
        lambda month: Path(download(month)),
        remote_source(),
        lambda: datetime.now(UTC),
    )


if __name__ == "__main__":
    main(sys.argv[1:])
