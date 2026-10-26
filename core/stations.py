"""Station identifiers: our EVAs are 8 digits with a leading zero, IBNR (Wikidata P954) is not."""

# pyright: reportUnknownMemberType=false
# (Polars' string-method stubs are partially unknown under strict mode.)
import polars as pl


def ibnr_expr(eva: pl.Expr) -> pl.Expr:
    """'08000207' -> '8000207'."""
    return eva.str.strip_chars_start("0")
