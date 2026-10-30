"""Nationwide German public holidays; regional ones (Epiphany, Corpus Christi, ...) are left out."""

from datetime import date, timedelta


def _easter(year: int) -> date:
    """Easter Sunday by the anonymous Gregorian algorithm."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    m = (a + 11 * h) // 319
    r = (2 * e + 2 * i - k - h + m + 32) % 7
    month, day = divmod(h - m + r + 114, 31)
    return date(year, month, day + 1)


def nationwide_holidays(year: int) -> frozenset[date]:
    easter = _easter(year)
    return frozenset(
        {
            date(year, 1, 1),
            easter - timedelta(days=2),  # Karfreitag
            easter + timedelta(days=1),  # Ostermontag
            date(year, 5, 1),
            easter + timedelta(days=39),  # Christi Himmelfahrt
            easter + timedelta(days=50),  # Pfingstmontag
            date(year, 10, 3),
            date(year, 12, 25),
            date(year, 12, 26),
        }
    )
