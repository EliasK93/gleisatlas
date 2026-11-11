"""Line keys: a line is its name split into networks, the stations joined by its trips; its label
names the end stations."""

# pyright: reportUnknownMemberType=false
# (Polars' string and aggregation stubs are partially unknown under strict mode.)
import polars as pl


def line_name_expr() -> pl.Expr:
    """The line name: the train type goes in front of a bare number ("57" with RE -> "RE57", as the
    source writes it from December 2025), letters and digits lose their space ("RE 3" -> "RE3"),
    and a missing or blank `line_number` becomes "{train_type} {train_number}" (e.g. "ICE 679")."""
    raw, kind = pl.col("line_number"), pl.col("train_type")
    number = pl.when(raw.str.strip_chars() != "").then(raw)
    return (
        pl.when(number.str.contains(r"^\d+$") & kind.is_not_null())
        .then(pl.concat_str(kind, number))
        .otherwise(
            pl.coalesce(
                number.str.replace(r"^([A-Za-z]+)\s+(\d+)$", "${1}${2}"),
                pl.concat_str(kind, pl.lit(" "), pl.col("train_number")),
            )
        )
    )


MIN_STOPS = 500  # a line needs this many stops before "no live data" can be told from chance
NO_LIVE_PERCENT = 99  # share of its arrived stops that report exactly 0 minutes, in integers


def is_train_number(name: pl.Expr) -> pl.Expr:
    """True for a train-number name ("ICE 679"): no space, a space, digits.
    shortcut: a regex on the name, so a source line number with a space before its digits matches
    too (2 names in the real data); flag train-number names in `line_name_expr` if more show up."""
    return name.str.contains(r"^\S+ \d+$")


def no_live_data(n: pl.Expr, zero: pl.Expr, cancelled: pl.Expr) -> pl.Expr:
    """True for a line that most likely has no live data: at least MIN_STOPS stops, and at least
    NO_LIVE_PERCENT of the stops that arrived (not cancelled) at exactly 0 minutes. The arguments
    are a line's counts: all stops, stops at 0 minutes, cancelled stops."""
    arrived = n.cast(pl.Int64) - cancelled.cast(pl.Int64)
    return (
        (n >= MIN_STOPS) & (arrived > 0) & (zero.cast(pl.Int64) * 100 >= NO_LIVE_PERCENT * arrived)
    )


def destination_expr(col: pl.Expr) -> pl.Expr:
    """Spelling fix for an end station: "Schwerte(Ruhr)" -> "Schwerte (Ruhr)", "(Main)Hbf" ->
    "(Main) Hbf", "Langenhagen - Kaltenweide" -> "Langenhagen-Kaltenweide", one space, stripped."""
    # shortcut: a regex spelling fix; variants like "Bahnhof, Arnsberg" stay separate. Map the
    # destinations to station EVAs if such variants show in the labels.
    return (
        col.str.replace_all(r"\s+", " ")
        .str.replace_all(r"\s*-\s*", "-")
        .str.replace_all(r"(\S)\(", "${1} (")
        .str.replace_all(r"\)(\w)", ") ${1}")
        .str.strip_chars()
    )


def networks(members: pl.DataFrame) -> pl.DataFrame:
    """(name, group, eva) -> (name, eva, net). Within one name, EVAs that share a group belong to
    one network (transitively); net is its lowest EVA. Min-label propagation to a fixpoint."""
    edges = members.select("name", "group", "eva").unique()
    labels = (
        edges.select("name", "eva").unique().with_columns(net=pl.col("eva")).sort("name", "eva")
    )
    while True:
        per_group = (
            edges.join(labels, on=["name", "eva"])
            .group_by("name", "group")
            .agg(pl.col("net").min())
        )
        new = (
            edges.join(per_group, on=["name", "group"])
            .group_by("name", "eva")
            .agg(pl.col("net").min())
            .sort("name", "eva")
        )
        if new["net"].equals(labels["net"]):
            return new
        labels = new


def line_ids(nets: pl.DataFrame) -> pl.DataFrame:
    """Add `linie` = "{name}:{net}", stable as months are added.
    shortcut: when a network gains a station with a lower EVA in a later month its id changes and a
    saved link to the old id gives 404; fine while a link is cheap to recreate from the rankings,
    keep a map of old ids if saved links start to matter."""
    return nets.with_columns(linie=pl.concat_str("name", pl.lit(":"), "net"))


def _top(df: pl.DataFrame, col: str) -> pl.DataFrame:
    """Per linie, the `col` value with the most stops; ties go to the lowest value."""
    return (
        df.group_by("linie", col)
        .agg(pl.col("n").sum())
        .sort(["linie", "n", col], descending=[False, True, False])
        .unique("linie", keep="first", maintain_order=True)
        .drop("n")
    )


def top_ends(ends: pl.DataFrame, lines: pl.DataFrame) -> pl.DataFrame:
    """(linie, dest): per line its two most frequent end stations, most frequent first, ties by
    name. `ends` is (name, eva, dest, n), `lines` has (name, eva, linie)."""
    return (
        ends.join(lines, on=["name", "eva"])
        .group_by("linie", "dest")
        .agg(pl.col("n").sum())
        .sort(["linie", "n", "dest"], descending=[False, True, False])
        .group_by("linie", maintain_order=True)
        .agg(pl.col("dest").head(2))
    )


def line_table(nets: pl.DataFrame, stops: pl.DataFrame, ends: pl.DataFrame) -> pl.DataFrame:
    """One row per line: linie, name, label, typ. `ends` is (name, eva, dest, n). The label names
    the line's two most frequent end stations: "{name} {first} – {second}", "{name} {first}" with
    one, the bare name with none; a train-number name ("ICE 679") reads "{name} → {top end}".
    typ is the train_type with the most stops. Networks without any stop (only first stops in the
    source) are left out."""
    lines = line_ids(nets)
    stops = stops.join(lines, on=["name", "eva"])
    lines = lines.join(stops.select("linie").unique(), on="linie", how="semi")
    top = top_ends(ends, lines)
    name, dests = pl.col("name"), pl.col("dest")
    first, second = dests.list.get(0, null_on_oob=True), dests.list.get(1, null_on_oob=True)
    return (
        lines.select("linie", "name")
        .unique()
        .join(top, on="linie", how="left")
        .join(_top(stops, "train_type"), on="linie", how="left")
        .select(
            "linie",
            "name",
            label=pl.when(first.is_null())
            .then(name)
            .when(is_train_number(name))
            .then(pl.concat_str(name, pl.lit(" → "), first))
            .when(second.is_null())
            .then(pl.concat_str(name, pl.lit(" "), first))
            .otherwise(pl.concat_str(name, pl.lit(" "), first, pl.lit(" – "), second)),
            typ="train_type",
        )
        .sort("linie")
    )
