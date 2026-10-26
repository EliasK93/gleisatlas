"""Arrival-delay rule: cancelled stops have no delay, a missing change time counts as on time."""

# pyright: reportUnknownMemberType=false
# (Polars' when/then/otherwise stubs are partially unknown under strict mode.)
import polars as pl

# Delays outside this range (minutes) are data errors, not train behaviour.
PLAUSIBLE_MIN, PLAUSIBLE_MAX = -30, 1440


def _minutes(planned: pl.Expr, changed: pl.Expr) -> pl.Expr:
    return (changed - planned).dt.total_minutes()


def arrival_delay_expr(planned: pl.Expr, changed: pl.Expr, cancelled: pl.Expr) -> pl.Expr:
    """Exact delay in whole minutes as Int32; NULL for cancelled stops."""
    return (
        pl.when(cancelled.fill_null(False))
        .then(None)
        .otherwise(_minutes(planned, changed).fill_null(0))
        .cast(pl.Int32)
    )


def plausible_expr(planned: pl.Expr, changed: pl.Expr) -> pl.Expr:
    """True when the delay lies within [PLAUSIBLE_MIN, PLAUSIBLE_MAX] or the change time is
    missing. It ignores the cancel flag: callers keep cancelled stops regardless."""
    return _minutes(planned, changed).is_between(PLAUSIBLE_MIN, PLAUSIBLE_MAX).fill_null(True)
