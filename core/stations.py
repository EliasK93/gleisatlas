"""Station identifiers: our EVAs are 8 digits with a leading zero, IBNR (Wikidata P954) is not."""

# pyright: reportUnknownMemberType=false
# (Polars' string-method stubs are partially unknown under strict mode.)
import polars as pl

# The federal states by the Wikidata label in data/stations.parquet: lower-case ISO 3166-2 suffix.
LAND_CODES = {
    "Baden-Württemberg": "bw",
    "Bayern": "by",
    "Berlin": "be",
    "Brandenburg": "bb",
    "Freie Hansestadt Bremen": "hb",
    "Hamburg": "hh",
    "Hessen": "he",
    "Mecklenburg-Vorpommern": "mv",
    "Niedersachsen": "ni",
    "Nordrhein-Westfalen": "nw",
    "Rheinland-Pfalz": "rp",
    "Saarland": "sl",
    "Sachsen": "sn",
    "Sachsen-Anhalt": "st",
    "Schleswig-Holstein": "sh",
    "Thüringen": "th",
}


def ibnr_expr(eva: pl.Expr) -> pl.Expr:
    """'08000207' -> '8000207'."""
    return eva.str.strip_chars_start("0")
