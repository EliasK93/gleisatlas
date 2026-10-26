"""Line keys: a line is its name split into networks, the stations joined by its trips."""

# pyright: reportUnknownMemberType=false
# (Polars' string and aggregation stubs are partially unknown under strict mode.)
import polars as pl

NUMBER_TYPES = ["S", "RB", "RE", "IRE", "MEX"]


def line_name_expr() -> pl.Expr:
    """`line_number`, or "{train_type} {train_number}" where it is missing (e.g. "ICE 679")."""
    return pl.coalesce(
        pl.col("line_number"),
        pl.concat_str(pl.col("train_type"), pl.lit(" "), pl.col("train_number")),
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
    """Add `linie` = "{name}:{net}", stable as months are added."""
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


def line_table(
    nets: pl.DataFrame, stops: pl.DataFrame, station_names: pl.DataFrame
) -> pl.DataFrame:
    """One row per line: linie, name, label, typ. A name of only digits is shown with its train type
    in front when that is S, RB, RE, IRE or MEX ("S36"); `linie` keeps the source name. The label
    is the bare name when the name has one network, else "{name} · {busiest station}"; typ is the
    train_type with the most stops. Networks without any stop (only first stops in the source)
    are left out."""
    lines = line_ids(nets)
    stops = stops.join(lines, on=["name", "eva"])
    lines = lines.join(stops.select("linie").unique(), on="linie", how="semi")
    count = pl.col("net").n_unique().over("name")
    # A bare number gets its regional train type in front ("S36"); operator codes stay out.
    shown = (
        pl.when(pl.col("name").str.contains(r"^\d+$") & pl.col("train_type").is_in(NUMBER_TYPES))
        .then(pl.concat_str("train_type", "name"))
        .otherwise(pl.col("name"))
    )
    return (
        lines.select("linie", "name", "net")
        .unique()
        .join(_top(stops, "eva"), on="linie", how="left")
        .join(station_names.rename({"name": "station"}), on="eva", how="left")
        .join(_top(stops, "train_type"), on="linie", how="left")
        .select(
            "linie",
            name=shown,
            label=pl.when(count == 1)
            .then(shown)
            .otherwise(pl.concat_str(shown, pl.lit(" · "), pl.coalesce("station", "eva"))),
            typ="train_type",
        )
        .sort("linie")
    )
