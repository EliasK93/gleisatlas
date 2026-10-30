import random
from datetime import datetime as dt
from datetime import timedelta

import polars as pl
import pytest

from core.categories import category_expr
from core.delay import arrival_delay_expr, plausible_expr
from core.stations import ibnr_expr
from core.stats import cell_stats, cell_stats_frame, delay_bins, quantile


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
            (p, dt(2026, 9, 7, 7, 20), False),  # early: exact, no clamp
            (p, dt(2026, 9, 7, 13, 0), False),  # late: exact, no clamp
        ]
    ) == [7, 0, None, 5, -40, 300]


def test_plausible_bounds_are_inclusive_and_missing_change_is_plausible():
    p = dt(2026, 9, 7, 8, 0)
    m = timedelta(minutes=1)
    df = pl.DataFrame(
        [(p, p - 30 * m), (p, p - 31 * m), (p, p + 1440 * m), (p, p + 1441 * m), (p, None)],
        schema={"p": pl.Datetime, "c": pl.Datetime},
        orient="row",
    )
    out = df.select(plausible_expr(pl.col("p"), pl.col("c")).alias("ok"))["ok"].to_list()
    assert out == [True, False, True, False, True]


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


def random_cells() -> dict[tuple[int, int], list[tuple[int | None, int]]]:
    """A few hundred (day, station) cells of (bucket, n) pairs, buckets unique within a cell:
    negative and large buckets, single-bucket and cancelled-only cells, cumulative sums exactly
    on 0.5 and 0.9 of the arrived total."""
    rng = random.Random(15)
    cells: dict[tuple[int, int], list[tuple[int | None, int]]] = {
        (0, 0): [(None, 4)],  # cancelled only
        (0, 1): [(-3, 7)],  # single bucket
        (0, 2): [(0, 5), (3, 5)],  # median exactly on the cumulative sum
        (0, 3): [(0, 9), (5, 1), (None, 2)],  # p90 exactly on the cumulative sum
        (0, 4): [(5, 1), (6, 1), (None, 1)],  # the punctual edge
    }
    for i in range(400):
        buckets = rng.sample([*range(-20, 15), 200, 1440], rng.randint(1, 8))
        cell: list[tuple[int | None, int]] = [(b, rng.randint(1, 60)) for b in buckets]
        if rng.random() < 0.3:
            cell.append((None, rng.randint(1, 60)))
        if rng.random() < 0.3:  # a total whose halves and tenths are whole
            cell = [(b, 10 * (n // 10 + 1)) for b, n in cell]
        rng.shuffle(cell)
        cells[(1, i)] = cell
    return cells


def test_cell_stats_frame_equals_cell_stats():
    cells = random_cells()
    rows = [(d, e, b, n) for (d, e), pairs in cells.items() for b, n in pairs]
    frame = pl.LazyFrame(rows, schema=["day", "eva", "bucket", "n"], orient="row")
    got = {
        (r["day"], r["eva"]): r
        for r in cell_stats_frame(frame, ["day", "eva"]).collect().to_dicts()
    }
    assert got.keys() == cells.keys()
    for key, pairs in cells.items():
        want, r = cell_stats(pairs), got[key]
        # the same float64 operations in the same order, so equality is exact
        assert (r["n"], r["cancellation_rate"], r["median"], r["p90"], r["punctual_share"]) == (
            want.n,
            want.cancellation_rate,
            want.median,
            want.p90,
            want.punctual_share,
        ), key


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
