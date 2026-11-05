"""Line sections: the minutes a train gains or loses between two consecutive stops, and the station
order (axis) of a line."""

# pyright: reportUnknownMemberType=false
# (Polars' when/then and list stubs are partially unknown under strict mode.)
import polars as pl

from core.delay import arrival_delay_expr, plausible_expr
from core.lines import destination_expr

_LAST_PART = r"-(\d+)$"


def trip_key_expr() -> pl.Expr:
    """One trip on one day: `id` ("{ride id}-{YYMMDDHHmm}-{stop number}") without its last part."""
    return pl.col("id").str.replace(r"-\d+$", "")


def trip_day_expr() -> pl.Expr:
    """The day a trip started (local time): the date in the middle of `id`
    ("{ride id}-{YYMMDDHHmm}-{stop number}"; the ride id may start with a minus sign). NULL when
    `id` has no such part."""
    return pl.col("id").str.extract(r"-(\d{6})\d{4}-\d+$", 1).str.to_date("%y%m%d", strict=False)


def stop_number_expr() -> pl.Expr:
    """The stop number: the column, else the last part of `id` (raw days have no column)."""
    return pl.coalesce(
        pl.col("train_line_station_num").cast(pl.Int32),
        pl.col("id").str.extract(_LAST_PART, 1).cast(pl.Int32),
    )


def stop_delay_expr() -> pl.Expr:
    """The delay a stop hands to the next section, in whole minutes: its arrival delay, or at a
    first stop (no planned arrival) its departure delay. NULL when that time is cancelled or
    implausible, or when the stop has no planned time at all."""
    arrival_planned, departure_planned = (
        pl.col("arrival_planned_time"),
        pl.col("departure_planned_time"),
    )
    arrival_changed, departure_changed = (
        pl.col("arrival_change_time"),
        pl.col("departure_change_time"),
    )
    arrival = arrival_delay_expr(arrival_planned, arrival_changed, pl.col("arrival_is_canceled"))
    departure = arrival_delay_expr(  # the same rule on the departure columns
        departure_planned, departure_changed, pl.col("departure_is_canceled")
    )
    return (
        pl.when(arrival_planned.is_not_null())
        .then(pl.when(plausible_expr(arrival_planned, arrival_changed)).then(arrival))
        .when(departure_planned.is_not_null())
        .then(pl.when(plausible_expr(departure_planned, departure_changed)).then(departure))
        .cast(pl.Int32)
    )


def section_changes(stops: pl.LazyFrame, *keep: str) -> pl.LazyFrame:
    """(trip, num, eva, delay) per stop -> one row per section between two consecutive stop numbers
    of a trip (difference exactly 1): `from_eva`, `to_eva`, `change` (delay at the end minus delay
    at the start) and the `keep` columns of the end stop. Sections with an end without a delay
    (cancelled or implausible) are left out."""
    delay, previous = pl.col("delay"), pl.col("delay").shift().over("trip")
    return (
        stops.sort("trip", "num")
        .with_columns(
            from_eva=pl.col("eva").shift().over("trip"),
            step=pl.col("num") - pl.col("num").shift().over("trip"),
            before=previous,
        )
        .filter(pl.col("step") == 1, delay.is_not_null(), pl.col("before").is_not_null())
        .select(
            "from_eva",
            pl.col("eva").alias("to_eva"),
            (delay - pl.col("before")).alias("change"),
            *keep,
        )
    )


def line_axis(routes: pl.DataFrame) -> pl.DataFrame:
    """(linie, pattern, trips) -> (linie, pos, eva): per line the stop pattern with the most station
    visits (trips x stops), so a long main route beats many short turns; ties go to the
    lexicographically lower pattern. `pos` counts from 0."""
    pattern = pl.col("pattern")
    best = (
        routes.with_columns(visits=pl.col("trips") * pattern.list.len())
        .sort(["linie", "visits", "pattern"], descending=[False, True, False])
        .unique("linie", keep="first", maintain_order=True)
    )
    return best.select(
        "linie", pos=pl.int_ranges(pattern.list.len(), dtype=pl.Int32), eva=pattern
    ).explode("pos", "eva")


def orient_axis(axis: pl.DataFrame, names: pl.DataFrame, ends: pl.DataFrame) -> pl.DataFrame:
    """(linie, pos, eva), (eva, name), (linie, dest list) -> the axis turned to the label's order:
    reversed when its last station is the line's first end station or its first station is the
    second one, kept when it already starts at the first. The most travelled pattern may run
    either way, the page wants the label's start at the top.
    ponytail: the match is by name (end stations are destination strings, not EVAs, spelling fix
    applied to both); a line whose ends match no station name keeps its axis. Map the destinations
    to EVAs if many lines keep a wrong order."""
    named = (
        axis.join(names, on="eva", how="left")
        .with_columns(name=destination_expr(pl.col("name")))
        .sort("linie", "pos")
        .group_by("linie", maintain_order=True)
        .agg(start=pl.col("name").first(), end=pl.col("name").last())
    )
    dests = pl.col("dest")
    turn = (
        named.join(
            ends.select(
                "linie",
                one=dests.list.get(0, null_on_oob=True),
                two=dests.list.get(1, null_on_oob=True),
            ),
            on="linie",
            how="left",
        )
        .select(
            "linie",
            turn=(pl.col("start") != pl.col("one"))
            & ((pl.col("end") == pl.col("one")) | (pl.col("start") == pl.col("two"))),
        )
        .fill_null(False)
    )
    pos = pl.col("pos")
    return (
        axis.join(turn, on="linie", how="left")
        .select(
            "linie",
            pl.when(pl.col("turn")).then(pos.max().over("linie") - pos).otherwise(pos).alias("pos"),
            "eva",
        )
        .sort("linie", "pos")
    )
