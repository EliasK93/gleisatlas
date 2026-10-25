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


def category_of(train_type: str) -> str:
    return FERN if train_type in LONG_DISTANCE else REGIONAL


def category_expr(train_type: pl.Expr) -> pl.Expr:
    return train_type.is_in(LONG_DISTANCE).replace_strict({True: FERN, False: REGIONAL})


def is_excluded_expr(train_type: pl.Expr) -> pl.Expr:
    return train_type.is_in(EXCLUDED)
