"""Top and bottom k of lines or stations by one statistic."""

from collections.abc import Iterable
from typing import Literal, Protocol

from core.stats import CellStats

Metric = Literal["punctual_share", "median", "p90", "cancellation_rate"]


class Ranked(Protocol):
    @property
    def name(self) -> str: ...
    @property
    def stats(self) -> CellStats: ...


def rank[T: Ranked](
    entries: Iterable[T], metric: Metric, min_n: int, k: int = 10
) -> tuple[list[T], list[T]]:
    """(worst, best): worst-first and best-first, at most k each. Entries below min_n or without
    a value are left out; ties go to the larger n, then the name."""
    sign = 1 if metric == "punctual_share" else -1  # higher is better only for punctuality
    scored: list[tuple[float, T]] = []
    for e in entries:
        value: float | None = getattr(e.stats, metric)
        if e.stats.n >= min_n and value is not None:
            scored.append((sign * value, e))
    worst = sorted(scored, key=lambda s: (s[0], -s[1].stats.n, s[1].name))
    best = sorted(scored, key=lambda s: (-s[0], -s[1].stats.n, s[1].name))
    return [e for _, e in worst[:k]], [e for _, e in best[:k]]
