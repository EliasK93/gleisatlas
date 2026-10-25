"""Arrival-delay rule: cancelled stops have no delay, a missing change time counts as on time."""

# pyright: reportUnknownMemberType=false
# (Polars' when/then/otherwise stubs are partially unknown under strict mode.)
import polars as pl

# ponytail: delay is clamped; outlier cleaning arrives with the multi-month pipeline.
CLAMP_MIN, CLAMP_MAX = -10, 120


def arrival_delay_expr(
    planned: pl.Expr, changed: pl.Expr, cancelled: pl.Expr, lo: int = CLAMP_MIN, hi: int = CLAMP_MAX
) -> pl.Expr:
    """Delay in whole minutes as Int32; NULL for cancelled stops."""
    delay = (changed - planned).dt.total_minutes()
    return (
        pl.when(cancelled.fill_null(False))
        .then(None)
        .otherwise(delay.fill_null(0).clip(lo, hi))
        .cast(pl.Int32)
    )
