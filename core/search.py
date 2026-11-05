"""Finding lines by a typed query: "ic34 dortmund" is the line IC34 and an end station, "dortmund"
is a place and finds no line. Case, spaces and hyphens do not matter."""

# pyright: reportUnknownMemberType=false
# (Polars' string stubs are partially unknown under strict mode.)
import re
from collections.abc import Collection

import polars as pl

_SKIP = r"[\s-]"


def norm(text: str) -> str:
    """Lower case without whitespace and hyphens: "S 6" -> "s6", "Kassel-Wilhelmshöhe" ->
    "kasselwilhelmshöhe". Lower, not casefold, so it agrees with Polars' `to_lowercase`."""
    return re.sub(_SKIP, "", text.lower())


def _key(col: str) -> pl.Expr:
    """`norm` of a column."""
    return pl.col(col).str.to_lowercase().str.replace_all(_SKIP, "")


def split_query(q: str, names: Collection[str]) -> tuple[str, list[str]] | None:
    """(line part, rest words) for a query. `names` are the normalised line names. The line part
    is the longest leading run of words whose joined `norm` is a name exactly, else the longest
    run that is the start of one; it is returned normalised. None when no run is."""
    words = q.split()
    for exact in (True, False):
        for i in range(len(words), 0, -1):
            part = norm("".join(words[:i]))
            if part in names if exact else any(n.startswith(part) for n in names):
                return part, words[i:]
    return None


def line_hits(
    lines: pl.DataFrame, names: Collection[str], q: str, limit: int
) -> tuple[pl.DataFrame, bool]:
    """The lines for a query as (linie, label, typ, zug, richtung, ziel), and whether the query
    starts with a line name exactly ("s6", "ic34 dortmund"). `lines` has (linie, name, label, typ,
    zug, n, first, last); first and last name the axis's end stations (null without an axis);
    `names` are its normalised names. Lines match by name only, exact or by prefix, never by a
    station alone. Rest words keep the ids with one end station or the label that contains all of
    them, and after an exact name only the ids of that name; richtung is 2 when the end is the
    axis's first station (the line page's direction 2 runs toward it), 1 when it is the last, null
    when both, the label only or no rest words; ziel is the name of that end station, set exactly
    with richtung. Order: exact name, lines before single trains, more stops, label."""
    key = _key("name")
    split = split_query(q, names)
    part, rest = split or ("", [])
    exact = split is not None and part in names

    def at(col: str) -> pl.Expr:
        words = [_key(col).str.contains(norm(w), literal=True) for w in rest]
        return pl.all_horizontal(words).fill_null(False) if words else pl.lit(False)

    first, last = at("first"), at("last")
    hits = lines.filter(pl.lit(split is not None) & key.str.starts_with(part))
    if rest:
        hits = hits.filter((first | last | at("label")) & (pl.lit(not exact) | (key == part)))
    toward_first, toward_last = first & ~last, last & ~first
    found = (
        hits.sort([key == part, "zug", "n", "label"], descending=[True, False, True, False])
        .head(limit)
        .select(
            "linie",
            "label",
            "typ",
            "zug",
            richtung=pl.when(toward_first).then(2).when(toward_last).then(1).cast(pl.Int8),
            ziel=pl.when(toward_first).then(pl.col("first")).when(toward_last).then(pl.col("last")),
        )
    )
    return found, exact
