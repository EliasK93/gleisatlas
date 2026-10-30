from dataclasses import dataclass

from core.rankings import higher_is_better, rank
from core.stats import CellStats


@dataclass(frozen=True)
class E:
    name: str
    stats: CellStats


def e(name: str, n: int, value: float | None) -> E:
    rate = (value or 0.0) / 1000  # small, so the cancellation order follows the value
    return E(name, CellStats(n, rate, value, value, value))


def names(entries: list[E]) -> list[str]:
    return [x.name for x in entries]


ENTRIES = [e("a", 100, 1.0), e("b", 100, 3.0), e("c", 100, 2.0)]


def test_lower_is_better_for_delay_metrics():
    for metric in ("median", "p90", "cancellation_rate"):
        worst, best = rank(ENTRIES, metric, min_n=1)
        assert names(worst) == ["b", "c", "a"]
        assert names(best) == ["a", "c", "b"]


def test_higher_is_better_for_punctual_share():
    worst, best = rank(ENTRIES, "punctual_share", min_n=1)
    assert names(worst) == ["a", "c", "b"]
    assert names(best) == ["b", "c", "a"]


def test_min_n_and_none_are_excluded():
    entries = [*ENTRIES, e("small", 99, 0.0), e("none", 500, None)]
    worst, best = rank(entries, "median", min_n=100)
    assert sorted(names(worst)) == sorted(names(best)) == ["a", "b", "c"]


def test_delay_metrics_need_min_n_arrived_stops_but_cancellations_count_all():
    mostly_cancelled = E("mc", CellStats(100, 0.95, 1.0, 1.0, 1.0))  # 100 stops, 5 arrived
    entries = [*ENTRIES, mostly_cancelled]
    for metric in ("punctual_share", "median", "p90"):
        worst, best = rank(entries, metric, min_n=50)
        assert "mc" not in names(worst) and "mc" not in names(best)
    worst, best = rank(entries, "cancellation_rate", min_n=50)
    assert names(worst)[0] == "mc"
    assert rank(entries, "median", min_n=5)[0][-1].name == "mc"  # 5 arrived reach min_n 5


def test_ties_go_to_larger_n_then_name():
    entries = [e("z", 100, 1.0), e("y", 200, 1.0), e("x", 100, 1.0)]
    worst, best = rank(entries, "median", min_n=1)
    assert names(worst) == names(best) == ["y", "x", "z"]


def test_k_cuts_both_lists():
    entries = [e(f"s{i:02}", 100, float(i)) for i in range(25)]
    worst, best = rank(entries, "p90", min_n=1, k=10)
    assert names(worst) == [f"s{i:02}" for i in range(24, 14, -1)]
    assert names(best) == [f"s{i:02}" for i in range(10)]


def test_higher_is_better_only_for_punctuality():
    assert higher_is_better("punctual_share")
    assert not any(higher_is_better(m) for m in ("median", "p90", "cancellation_rate"))
