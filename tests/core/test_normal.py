from datetime import date, timedelta

import pytest

from core.normal import FLOORS, MIN_DAYS, deviation_class, normal, reference_days, spread, weather

FIRST, LAST = date(2025, 1, 1), date(2026, 12, 31)


def test_reference_days_are_the_same_weekday_of_the_previous_12_weeks():
    day = date(2026, 9, 15)
    refs = reference_days(day, FIRST, LAST, set())
    assert refs == [day - timedelta(weeks=k) for k in range(1, 13)]
    assert {d.weekday() for d in refs} == {day.weekday()}


def test_a_holiday_and_a_gap_day_are_left_out():
    refs = reference_days(date(2026, 6, 1), FIRST, LAST, {date(2026, 4, 20)})
    assert date(2026, 5, 25) not in refs  # Pfingstmontag
    assert date(2026, 4, 6) not in refs  # Ostermontag
    assert date(2026, 4, 20) not in refs  # gap day
    assert date(2026, 4, 27) in refs
    assert len(refs) == 9


def test_the_range_start_cuts_the_list():
    day = date(2026, 9, 15)
    first = day - timedelta(weeks=5)
    assert reference_days(day, first, LAST, set()) == [
        day - timedelta(weeks=k) for k in range(1, 6)
    ]


def test_a_normal_needs_8_valid_days():
    seven = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
    assert MIN_DAYS == 8
    assert normal(seven) is None
    assert normal([*seven, 8.0]) == 4.5
    assert normal([*seven, 8.0, None, None]) == 4.5  # missing values do not count


REFS = [float(v) for v in range(1, 11)]  # 10 reference days with the values 1..10


def test_best_and_worst_day_give_1_and_5():
    assert weather(11.0, REFS, higher_is_better=True) == 1
    assert weather(0.0, REFS, higher_is_better=True) == 5
    assert weather(0.0, REFS, higher_is_better=False) == 1  # a lower delay is better
    assert weather(11.0, REFS, higher_is_better=False) == 5


def test_ties_count_half_and_the_fifths_are_cut_evenly():
    assert weather(5.5, REFS, higher_is_better=True) == 3  # beats 5 of 10: share 0.5
    assert weather(5.0, REFS, higher_is_better=True) == 3  # beats 4, ties 1: share 0.45
    assert weather(1.0, [1.0] * 10, higher_is_better=True) == 3  # all ties: share 0.5
    assert weather(3.0, REFS, higher_is_better=True) == 4  # beats 2, ties 1: 0.25
    assert weather(9.0, REFS, higher_is_better=True) == 1  # beats 8, ties 1: 0.85


def test_weather_needs_8_references_and_a_value():
    assert weather(5.0, REFS[:7], higher_is_better=True) is None
    assert weather(5.0, [*REFS[:7], None], higher_is_better=True) is None
    assert weather(None, REFS, higher_is_better=True) is None


def test_weather_is_symmetric_on_an_exact_fifth_boundary():
    assert weather(8.5, REFS, higher_is_better=True) == 2  # beats exactly 8: share 0.8
    assert weather(2.5, REFS, higher_is_better=True) == 4  # loses to exactly 8: share 0.2
    assert weather(8.5, REFS, higher_is_better=False) == 4
    assert weather(2.5, REFS, higher_is_better=False) == 2


def test_spread_is_the_scaled_median_absolute_deviation_with_a_floor():
    values = [float(v) for v in range(760, 841, 8)]  # 11 values, median 800, MAD 24
    assert spread(values, floor=1.0) == pytest.approx(1.4826 * 24)
    assert spread([5.0] * 10, floor=0.5) == 0.5  # no spread at all: the floor
    assert spread([*values, None], floor=1.0) == pytest.approx(1.4826 * 24)  # None is skipped
    assert spread(values[:7], floor=1.0) is None  # fewer than MIN_DAYS


# 10 equal references: the spread is the floor, so z is the distance in floors
FLAT = [80.0] * 10


@pytest.mark.parametrize(
    "value, better",
    [(81.9, 3), (82.0, 2), (83.9, 2), (84.0, 1), (100.0, 1)],
)
def test_deviation_class_cuts_at_2_and_4_floors(value, better):
    assert deviation_class(value, FLAT, True, 1.0) == better
    mirrored = 160.0 - value  # the same distance below the normal
    assert deviation_class(mirrored, FLAT, True, 1.0) == {3: 3, 2: 4, 1: 5}[better]
    assert deviation_class(mirrored, FLAT, False, 1.0) == better  # lower is better: swapped


def test_deviation_class_uses_the_spread_when_it_exceeds_the_floor():
    noisy = [float(v) for v in range(760, 841, 8)]  # normal 800, spread 35.6
    assert deviation_class(860.0, noisy, True, 1.0) == 3  # 1.7 spreads: as usual
    assert deviation_class(880.0, noisy, True, 1.0) == 2
    assert deviation_class(940.0, noisy, True, 1.0) == 2  # 3.9
    assert deviation_class(950.0, noisy, True, 1.0) == 1  # 4.2


def test_deviation_class_needs_a_value_and_a_normal():
    assert deviation_class(None, FLAT, True, 1.0) is None
    assert deviation_class(80.0, FLAT[:7], True, 1.0) is None
    assert deviation_class(80.0, [None] * 10, True, 1.0) is None


def test_every_metric_has_a_floor_in_metric_units():
    assert FLOORS == {
        "punctual_share": 0.01,
        "cancellation_rate": 0.005,
        "median": 1.0,  # the stored medians are whole minutes: a one-minute step is no signal
        "p90": 1.0,
    }
