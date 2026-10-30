from datetime import date

from core.holidays import nationwide_holidays


def test_easter_2025_and_its_neighbours():
    days = nationwide_holidays(2025)
    assert date(2025, 4, 18) in days  # Karfreitag
    assert date(2025, 4, 21) in days  # Ostermontag
    assert date(2025, 4, 20) not in days  # Easter Sunday itself is no extra day here


def test_easter_2026_moves_the_other_holidays():
    days = nationwide_holidays(2026)
    assert date(2026, 4, 3) in days  # Karfreitag
    assert date(2026, 4, 6) in days  # Ostermontag
    assert date(2026, 5, 14) in days  # Christi Himmelfahrt
    assert date(2026, 5, 25) in days  # Pfingstmontag


def test_nine_fixed_and_movable_days():
    days = nationwide_holidays(2026)
    assert len(days) == 9
    assert {(d.month, d.day) for d in days} >= {(1, 1), (5, 1), (10, 3), (12, 25), (12, 26)}
