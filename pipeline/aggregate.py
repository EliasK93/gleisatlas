"""One monthly source file -> cleaned per-month tables (delay histogram, lines, networks, ...)."""

import sys
from datetime import datetime

import polars as pl

from core.categories import bus_line_expr, category_expr, is_excluded_expr
from core.delay import arrival_delay_expr, plausible_expr
from core.lines import destination_expr, line_name_expr, networks
from core.sections import (
    section_changes,
    stop_delay_expr,
    stop_number_expr,
    trip_day_expr,
    trip_key_expr,
)
from core.stations import ibnr_expr

COLUMNS = frozenset(
    {
        "station_name",
        "xml_station_name",
        "eva",
        "train_number",
        "line_number",
        "final_destination_station",
        "delay_in_min",
        "time",
        "arrival_is_canceled",
        "departure_is_canceled",
        "train_type",
        "is_additional_stop",
        "is_replacement_train",
        "replaced_train_type",
        "replaced_train_number",
        "has_plan_record",
        "train_line_ride_id",
        "train_line_station_num",
        "arrival_planned_time",
        "arrival_change_time",
        "departure_planned_time",
        "departure_change_time",
        "id",
    }
)
GAP_SHARE = 0.5  # source gaps are partial: an hour under half its usual rows is incomplete
DUPLICATE_KEY = ("eva", "train_type", "train_number", "arrival_planned_time")

_planned = pl.col("arrival_planned_time")
_arrival = _planned.is_not_null()
# Rows without an arrival (first stops) are never duplicates: they only feed the networks.
_first = ~_arrival | pl.struct(*DUPLICATE_KEY).is_first_distinct()
_plausible = pl.col("arrival_is_canceled").fill_null(False) | plausible_expr(
    _planned, pl.col("arrival_change_time")
)


def check_schema(lf: pl.LazyFrame) -> None:
    names = set(lf.collect_schema().names())
    missing, new = sorted(COLUMNS - names), sorted(names - COLUMNS)
    if missing or new:
        sys.exit(f"Schema error: missing columns {missing}, new columns {new}")


def _rail(lf: pl.LazyFrame) -> pl.LazyFrame:
    """Rail only: no bus types, and no replacement buses booked under another type (by name)."""
    check_schema(lf)
    return lf.filter(~is_excluded_expr(pl.col("train_type")), ~bus_line_expr(line_name_expr()))


def clean(lf: pl.LazyFrame) -> pl.LazyFrame:
    """Rail stops without implausible delays and without duplicates (cancelled stops stay).
    Implausible rows go first, so a plausible copy of a duplicate survives."""
    return _rail(lf).filter(_plausible).filter(_first)


def dropped(lf: pl.LazyFrame) -> tuple[int, int]:
    """(duplicates, implausible rows) that `clean` drops."""
    rail = _rail(lf)
    bad = rail.select((~_plausible).sum()).collect().item()
    dup = rail.filter(_plausible).select((~_first).sum()).collect().item()
    return dup, bad


def _arrivals(lf: pl.LazyFrame) -> pl.LazyFrame:
    return clean(lf).filter(_arrival)


_month = pl.col("time").dt.strftime("%Y-%m")  # `time` lies within the file month, unlike planned
_bucket = arrival_delay_expr(_planned, pl.col("arrival_change_time"), pl.col("arrival_is_canceled"))
_gruppe = category_expr(pl.col("train_type"))
_weekday = _planned.dt.weekday() - 1  # 0 = Monday
_hour = _planned.dt.hour()


def aggregate(lf: pl.LazyFrame) -> pl.DataFrame:
    """One row per (weekday, hour, gruppe, eva, month, bucket); bucket NULL = cancelled."""
    return (
        _arrivals(lf)
        .select(
            weekday=_weekday,
            hour=_hour,
            gruppe=_gruppe,
            eva=pl.col("eva"),
            month=_month,
            bucket=_bucket,
        )
        .group_by("weekday", "hour", "gruppe", "eva", "month", "bucket")
        .agg(n=pl.len())
        .sort("month", "eva", "weekday", "hour", "gruppe", "bucket", nulls_last=True)
        .collect()
    )


def lines(lf: pl.LazyFrame) -> pl.DataFrame:
    """Delay histogram per line name: (name, train_type, eva, gruppe, month, bucket, n)."""
    keys = ["name", "train_type", "eva", "gruppe", "month", "bucket"]
    return (
        _arrivals(lf)
        .select(
            name=line_name_expr(),
            train_type="train_type",
            eva="eva",
            gruppe=_gruppe,
            month=_month,
            bucket=_bucket,
        )
        .group_by(keys)
        .agg(n=pl.len())
        .sort(keys, nulls_last=True)
        .collect()
    )


def stop_counts(lf: pl.LazyFrame) -> pl.DataFrame:
    """Every stop with a planned arrival or departure per (eva, gruppe, month), cancelled ones
    included: unlike `aggregate`, the stops where a train starts count too."""
    keys = ["eva", "gruppe", "month"]
    return (
        clean(lf)
        .filter(_arrival | pl.col("departure_planned_time").is_not_null())
        .select(eva="eva", gruppe=_gruppe, month=_month)
        .group_by(keys)
        .agg(n=pl.len())
        .sort(keys)
        .collect()
    )


def line_hours(lf: pl.LazyFrame, nets: pl.DataFrame) -> pl.DataFrame:
    """`lines` per weekday and hour with the stations summed away: (name, net, gruppe, weekday,
    hour, month, bucket, n), `net` the line's month network from `nets` (`month_networks`)."""
    keys = ["name", "net", "gruppe", "weekday", "hour", "month", "bucket"]
    return (
        _arrivals(lf)
        .select(
            name=line_name_expr(),
            eva="eva",
            weekday=_weekday,
            hour=_hour,
            gruppe=_gruppe,
            month=_month,
            bucket=_bucket,
        )
        .join(nets.lazy(), on=["name", "eva"])
        .group_by(keys)
        .agg(n=pl.len())
        .sort(keys, nulls_last=True)
        .collect()
    )


def line_trips(lf: pl.LazyFrame, nets: pl.DataFrame) -> pl.DataFrame:
    """Trips per line name and network: (name, net, gruppe, month, trips). A trip counts once per
    day when its first stop's planned departure is between 06:00 and 21:59; name, network, group
    and month are those of the first stop (`nets` is `month_networks`)."""
    keys = ["name", "net", "gruppe", "month"]
    return (
        _trip_stops(lf, gruppe=_gruppe, month=_month, departure=pl.col("departure_planned_time"))
        .group_by("trip")
        .agg(pl.all().sort_by("num").first())
        .filter(pl.col("departure").dt.hour().is_between(6, 21))
        .join(nets.lazy(), on=["name", "eva"])
        .group_by(keys)
        .agg(trips=pl.len())
        .sort(keys)
        .collect()
    )


def ends(lf: pl.LazyFrame) -> pl.DataFrame:
    """End stations per line name: (name, eva, dest, n); null or blank destinations are left out."""
    keys = ["name", "eva", "dest"]
    return (
        _arrivals(lf)
        .select(
            name=line_name_expr(),
            eva="eva",
            dest=destination_expr(pl.col("final_destination_station")),
        )
        .filter(pl.col("dest") != "")  # also drops nulls
        .group_by(keys)
        .agg(n=pl.len())
        .sort(keys)
        .collect()
    )


def _trip_stops(lf: pl.LazyFrame, **extra: pl.Expr) -> pl.LazyFrame:
    """Every stop (first stops included) with its trip and stop number; stops without either are
    left out."""
    return (
        clean(lf)
        .select(
            name=line_name_expr(),
            trip=trip_key_expr(),
            num=stop_number_expr(),
            eva="eva",
            **extra,
        )
        .filter(pl.col("trip").is_not_null(), pl.col("num").is_not_null())
    )


def sections(lf: pl.LazyFrame) -> pl.DataFrame:
    """Sections between consecutive stops of a trip per line name and month of the end stop:
    (name, from_eva, to_eva, month, n, minutes), `minutes` the sum of the delay changes."""
    keys = ["name", "from_eva", "to_eva", "month"]
    return (
        section_changes(_trip_stops(lf, month=_month, delay=stop_delay_expr()), "name", "month")
        .group_by(keys)
        .agg(n=pl.len(), minutes=pl.col("change").sum().cast(pl.Int64))
        .sort(keys)
        .collect()
    )


def routes(lf: pl.LazyFrame) -> pl.DataFrame:
    """The stop patterns of a line name: (name, pattern, trips), `pattern` the EVAs in stop order;
    a trip with one stop has no route."""
    return (
        _trip_stops(lf)
        .sort("trip", "num")
        .group_by("trip")
        .agg(pl.col("name").first(), pattern=pl.col("eva"))
        .filter(pl.col("pattern").list.len() >= 2)
        .group_by("name", "pattern")
        .agg(trips=pl.len())
        .sort("name", "pattern")
        .collect()
    )


def runs(lf: pl.LazyFrame) -> pl.DataFrame:
    """One row per stop of every trip, for the Bildfahrplan: the line name, the train
    ("{type} {number}"), the trip, the stop number, the day the trip started, the station and the
    planned and changed times with the cancel flags, sorted by trip and stop number. The same
    cleaning as the other tables (cancelled stops stay).
    shortcut: every month keeps all its trips (about 200 MB), although `combine` reads only the last
    28 days; revisit if the disk matters."""
    flag = ("arrival_is_canceled", "departure_is_canceled")
    times = (
        "arrival_planned_time",
        "arrival_change_time",
        "departure_planned_time",
        "departure_change_time",
    )
    return (
        _trip_stops(
            lf,
            zug=pl.concat_str("train_type", pl.lit(" "), "train_number"),
            day=trip_day_expr(),
            **{c: pl.col(c).cast(pl.Datetime("us")) for c in times},  # one unit, month or raw day
            **{c: pl.col(c).fill_null(False) for c in flag},
        )
        .select("name", "zug", "trip", "num", "day", "eva", *times, *flag)
        .sort("trip", "num", maintain_order=True)
        .collect()
    )


def month_networks(lf: pl.LazyFrame) -> pl.DataFrame:
    """(name, eva, net): stations joined by a line's trips, stops without arrival included."""
    members = clean(lf).select(name=line_name_expr(), group="train_line_ride_id", eva="eva")
    return networks(members.unique().collect())


def stations(lf: pl.LazyFrame) -> pl.DataFrame:
    """(eva, name, n): most frequent name per EVA (display only) and its stops, cancelled ones
    included; filtering always uses the EVA."""
    return (
        _arrivals(lf)
        .group_by("eva")
        .agg(name=pl.col("station_name").mode().sort().first(), n=pl.len())  # sorted: ties
        .sort("eva")
        .collect()
    )


def _per_day(lf: pl.LazyFrame, **extra: pl.Expr) -> pl.DataFrame:
    keys = ["day", *extra, "eva", "gruppe", "bucket"]
    return (
        _arrivals(lf)
        .select(day=_planned.dt.date(), **extra, gruppe=_gruppe, eva=pl.col("eva"), bucket=_bucket)
        .group_by(keys)
        .agg(n=pl.len())
        .select("day", *extra, "gruppe", "eva", "bucket", "n")
        .sort(keys, nulls_last=True)
        .collect()
    )


def days(lf: pl.LazyFrame) -> pl.DataFrame:
    """Delay histogram per planned arrival day: (day, gruppe, eva, bucket, n); bucket NULL =
    cancelled. A file holds stops planned on the neighbouring month's edge day, so days of two
    files can overlap and are summed when the months are combined."""
    return _per_day(lf)


def day_hours(lf: pl.LazyFrame) -> pl.DataFrame:
    """`days` per planned arrival hour as well: (day, hour, gruppe, eva, bucket, n), so a day can
    be cut at an hour. Summed over the hour it is `days`."""
    return _per_day(lf, hour=_planned.dt.hour())


def hour_table(per_hour: pl.DataFrame, start: datetime, end: datetime) -> pl.DataFrame:
    """One row per local hour from `start` to `end` (naive `hour`, `end` excluded) with its `rows`
    (`per_hour` is (hour, rows); absent hours count 0), the usual level of its hour of day and
    `thin`, whether it is missing. The one implementation of the GAP_SHARE rule: months and raw
    days differ only in the range and the rows they hand in."""
    hours = pl.datetime_range(start, end, "1h", closed="left", time_zone="Europe/Berlin")
    every_hour = pl.select(hour=hours.dt.replace_time_zone(None).unique()).with_columns(
        pl.col("hour").cast(per_hour.schema["hour"])
    )
    return (
        every_hour.join(per_hour, on="hour", how="left")
        .with_columns(pl.col("rows").fill_null(0))
        .with_columns(weekday=pl.col("hour").dt.weekday(), hour_of_day=pl.col("hour").dt.hour())
        .with_columns(usual=pl.col("rows").median().over("weekday", "hour_of_day"))
        .with_columns(usual=pl.col("usual").min().over("hour_of_day"))
        .with_columns(thin=pl.col("rows") < GAP_SHARE * pl.col("usual"))
    )


def missing_per_day(table: pl.DataFrame) -> pl.DataFrame:
    """(day, missing_hours) of a `hour_table`, one row per calendar day."""
    return (
        table.group_by(day=pl.col("hour").dt.date())
        .agg(missing_hours=pl.col("thin").sum().cast(pl.Int32))
        .sort("day")
    )


def _hour_counts(month_rows: pl.LazyFrame, month: str) -> pl.DataFrame:
    """`hour_table` over the real month, from the rows' `time`."""
    start = datetime.strptime(month, "%Y-%m")
    end = datetime(start.year + start.month // 12, start.month % 12 + 1, 1)
    per_hour = (
        month_rows.group_by(hour=pl.col("time").dt.truncate("1h")).agg(rows=pl.len()).collect()
    )
    return hour_table(per_hour, start, end)


def day_gaps(lf: pl.LazyFrame, month: str) -> pl.DataFrame:
    """(day, missing_hours): `meta`'s missing hours counted per calendar day of the month, days
    without a gap included."""
    return missing_per_day(_hour_counts(clean(lf).filter(_month == month), month))


def meta(lf: pl.LazyFrame, month: str) -> pl.DataFrame:
    """(month, missing_hours, stations). The usual level of an hour of day is the lowest, over the
    seven weekdays, of the median row count of that (weekday, hour) in the month; so quiet Sunday
    mornings are normal. An hour is missing when its row count is below GAP_SHARE of that level
    (no rows at all counts). Hours count against the real month in local time: the skipped hour
    of the March clock change is not missing, the doubled October hour (both hours land in one)
    is not either."""
    month_rows = clean(lf).filter(_month == month)
    thin = _hour_counts(month_rows, month)["thin"].sum()
    stations = month_rows.select(pl.col("eva").filter(_arrival).n_unique()).collect().item()
    return pl.DataFrame(
        {"month": [month], "missing_hours": [thin], "stations": [stations]},
        schema={"month": pl.String, "missing_hours": pl.Int32, "stations": pl.UInt32},
    )


def with_coords(st: pl.DataFrame, coords: pl.DataFrame) -> pl.DataFrame:
    """Add lat, lon, land; coords are keyed by IBNR, our EVAs carry a leading zero.

    A secondary EVA (e.g. the S-Bahn platforms of a station) is often missing in Wikidata; it
    takes the coordinates of the one located station with exactly the same name.
    """
    keyed = st.with_columns(ibnr=ibnr_expr(pl.col("eva")))
    out = keyed.join(coords, on="ibnr", how="left").drop("ibnr")
    geo = ["lat", "lon", "land"]
    namesake = (
        out.drop_nulls(["name", "lat"])
        .filter(pl.len().over("name") == 1)
        .select("name", *(pl.col(c).alias(f"{c}_same") for c in geo))
    )
    missing = pl.col("lat").is_null()
    return (
        out.join(namesake, on="name", how="left", maintain_order="left")
        .with_columns(
            pl.when(missing).then(pl.col(f"{c}_same")).otherwise(pl.col(c)).alias(c) for c in geo
        )
        .drop(f"{c}_same" for c in geo)
    )


def coverage_report(st: pl.DataFrame) -> str:
    named = st.drop_nulls("name")
    hit = named.filter(pl.col("lat").is_not_null())
    stops, hit_stops = int(named["n"].sum()), int(hit["n"].sum())
    lines = [
        f"named stations with coordinates: {hit.height} of {named.height}"
        f" ({100 * hit.height / named.height:.1f} %)",
        f"share of stops with coordinates: {100 * hit_stops / stops:.1f} %",
        "20 unmatched named stations with the most stops (eva, name, n):",
    ]
    miss = named.filter(pl.col("lat").is_null()).sort("n", descending=True).head(20)
    lines += [f"  {eva}  {name}  {n}" for eva, name, n, *_ in miss.iter_rows()]
    return "\n".join(lines)
