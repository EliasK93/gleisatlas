from datetime import datetime as dt

import polars as pl
import pytest

from core.categories import category_of
from core.delay import arrival_delay_expr
from core.stats import cell_stats, quantile


def test_category_of():
    assert category_of("ICE") == "fern"
    assert category_of("RE") == "regional"


def delays(rows: list[tuple[dt | None, dt | None, bool | None]]) -> list[int | None]:
    df = pl.DataFrame(
        rows, schema={"p": pl.Datetime, "c": pl.Datetime, "x": pl.Boolean}, orient="row"
    )
    out = df.select(arrival_delay_expr(pl.col("p"), pl.col("c"), pl.col("x")).alias("d"))
    return out["d"].to_list()


def test_arrival_delay_rules():
    p = dt(2026, 9, 7, 8, 0)
    assert delays(
        [
            (p, dt(2026, 9, 7, 8, 7), False),  # plain delay
            (p, None, False),  # missing change time -> 0
            (p, None, True),  # cancelled -> NULL, not 0
            (p, dt(2026, 9, 7, 8, 5), None),  # unknown cancel flag -> not cancelled
            (p, dt(2026, 9, 7, 7, 0), False),  # clamped to -10
            (p, dt(2026, 9, 7, 12, 0), False),  # clamped to 120
        ]
    ) == [7, 0, None, 5, -10, 120]


def test_quantile_picks_first_bucket_reaching_share():
    assert quantile([(0, 2), (7, 1)], 0.5) == 0.0
    assert quantile([(0, 2), (7, 1)], 0.9) == 7.0
    with pytest.raises(ValueError):
        quantile([], 0.5)


def test_cell_stats_with_cancellations():
    s = cell_stats([(7, 1), (None, 1), (0, 2)])
    assert (s.n, s.cancellation_rate, s.median, s.p90) == (4, 0.25, 0.0, 7.0)
    assert s.punctual_share == pytest.approx(2 / 3)


def test_cell_stats_all_cancelled():
    s = cell_stats([(None, 3)])
    assert (s.n, s.cancellation_rate) == (3, 1.0)
    assert s.median is None and s.p90 is None and s.punctual_share is None
