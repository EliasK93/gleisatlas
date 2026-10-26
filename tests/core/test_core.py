from datetime import datetime as dt

import polars as pl
import pytest

from core.categories import category_expr
from core.delay import arrival_delay_expr
from core.stations import ibnr_expr
from core.stats import cell_stats, delay_bins, quantile


def test_ibnr_strips_leading_zeros():
    df = pl.DataFrame({"eva": ["08000207", "8000207", "00000001"]})
    assert df.select(ibnr_expr(pl.col("eva")))["eva"].to_list() == ["8000207", "8000207", "1"]


def test_category_expr():
    df = pl.DataFrame({"t": ["ICE", "RE"]})
    assert df.select(category_expr(pl.col("t")))["t"].to_list() == ["fern", "regional"]


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


def test_delay_bins_edges_negatives_and_cancelled():
    rows = [
        (-10, 1),  # early: first bin
        (0, 2),
        (1, 3),  # lower edge of the second bin
        (2, 4),
        (3, 5),
        (5, 6),
        (6, 7),
        (9, 8),
        (10, 9),
        (19, 10),
        (20, 11),
        (29, 12),
        (30, 13),
        (120, 14),
        (None, 15),  # cancelled: never in a delay bin
    ]
    b = delay_bins(rows)
    assert b.bins == (1 + 2, 3 + 4, 5 + 6, 7 + 8, 9 + 10, 11 + 12, 13 + 14)
    assert b.cancelled == 15


def test_delay_bins_empty_and_repeated_buckets():
    assert delay_bins([]).bins == (0,) * 7
    assert delay_bins([(5, 1), (5, 2), (None, 1), (None, 2)]).bins[2] == 3
