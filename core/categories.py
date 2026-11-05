"""Train-category mapping: long-distance versus regional, and excluded bus types."""

# pyright: reportUnknownMemberType=false
# (Polars' when/then/otherwise stubs are partially unknown under strict mode.)
import polars as pl

LONG_DISTANCE = ["ICE", "IC", "EC", "ECE", "TGV", "RJ", "RJX", "NJ", "EN"]
# The product covers rail only; the dataset also contains buses and rail replacement.
EXCLUDED = ["Bus", "bus", "Bsv", "BSv", "SEV"]

# Category values are data keys shared with the aggregate and the API.
FERN = "fern"
REGIONAL = "regional"


def category_expr(train_type: pl.Expr) -> pl.Expr:
    return train_type.is_in(LONG_DISTANCE).replace_strict({True: FERN, False: REGIONAL})


def is_excluded_expr(train_type: pl.Expr) -> pl.Expr:
    """True for the bus types; a stop without a type stays."""
    return train_type.is_in(EXCLUDED).fill_null(False)


def bus_line_expr(name: pl.Expr) -> pl.Expr:
    """True for a replacement-bus line name: SEV or Bus as a whole word, digits allowed right after
    it ("SEV BUS", "SEV S4", "RE6 BUS", "SEV7"). The train type alone misses buses booked under
    other types (SBB, Bvs, BUS, ...). A missing name stays."""
    return name.str.contains(r"(?i)\b(?:SEV|Bus)\d*\b").fill_null(False)
