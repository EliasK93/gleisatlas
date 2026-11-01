from datetime import date, timedelta

import pytest

from core.normal import FLOORS, MIN_DAYS, deviation_class, normal, reference_days, spread

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
    [(80.9, 3), (81.0, 2), (81.9, 2), (82.0, 1), (100.0, 1)],
)
def test_deviation_class_cuts_at_1_and_2_floors(value, better):
    assert deviation_class(value, FLAT, True, 1.0) == better
    mirrored = 160.0 - value  # the same distance below the normal
    assert deviation_class(mirrored, FLAT, True, 1.0) == {3: 3, 2: 4, 1: 5}[better]
    assert deviation_class(mirrored, FLAT, False, 1.0) == better  # lower is better: swapped


@pytest.mark.parametrize("metric", ["median", "p90"])
def test_a_minute_off_a_stable_minute_metric_is_as_usual(metric):
    flat = [4.0] * 10  # whole minutes: one rounding step must not change the class
    floor = FLOORS[metric]
    assert deviation_class(5.0, flat, False, floor) == 3
    assert deviation_class(3.0, flat, False, floor) == 3
    assert deviation_class(6.0, flat, False, floor) == 4  # 2 min later: a bit worse
    assert deviation_class(2.0, flat, False, floor) == 2
    assert deviation_class(7.0, flat, False, floor) == 5  # 3 min later: much worse
    assert deviation_class(1.0, flat, False, floor) == 1


def test_deviation_class_uses_the_spread_when_it_exceeds_the_floor():
    noisy = [float(v) for v in range(760, 841, 8)]  # normal 800, spread 35.6
    assert deviation_class(830.0, noisy, True, 1.0) == 3  # 0.8 spreads: as usual
    assert deviation_class(840.0, noisy, True, 1.0) == 2  # 1.1
    assert deviation_class(860.0, noisy, True, 1.0) == 2  # 1.7
    assert deviation_class(880.0, noisy, True, 1.0) == 1  # 2.2


def test_deviation_class_needs_a_value_and_a_normal():
    assert deviation_class(None, FLAT, True, 1.0) is None
    assert deviation_class(80.0, FLAT[:7], True, 1.0) is None
    assert deviation_class(80.0, [None] * 10, True, 1.0) is None


def test_every_metric_has_a_floor_in_metric_units():
    assert FLOORS == {
        "punctual_share": 0.01,
        "cancellation_rate": 0.005,
        "median": 1.5,  # the stored medians are whole minutes: a one-minute step is no signal
        "p90": 1.5,
    }
