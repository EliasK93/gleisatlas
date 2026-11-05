from datetime import date, timedelta
from datetime import datetime as dt

import polars as pl

from core.sections import (
    line_axis,
    orient_axis,
    section_changes,
    stop_delay_expr,
    stop_number_expr,
    trip_day_expr,
    trip_key_expr,
)

T0 = dt(2026, 9, 7, 8, 0)
SCHEMA = {
    "id": pl.String,
    "train_line_station_num": pl.Int32,
    "eva": pl.String,
    "arrival_planned_time": pl.Datetime("us"),
    "arrival_change_time": pl.Datetime("us"),
    "arrival_is_canceled": pl.Boolean,
    "departure_planned_time": pl.Datetime("us"),
    "departure_change_time": pl.Datetime("us"),
    "departure_is_canceled": pl.Boolean,
}


def stop(
    num: int,
    eva: str,
    arrival: int | None = None,
    departure: int | None = None,
    *,
    cancelled: bool = False,
    column: bool = True,
    ride: str = "r1",
) -> dict:
    """A source row of the trip `ride`; `arrival` and `departure` are the delays in minutes, the
    planned times follow the stop number. A stop without an arrival is a first stop."""
    planned = T0 + timedelta(minutes=10 * num)

    def at(delay: int | None) -> dt | None:
        return None if delay is None else planned + timedelta(minutes=delay)

    return {
        "id": f"{ride}-2609070800-{num}",
        "train_line_station_num": num if column else None,
        "eva": eva,
        "arrival_planned_time": None if arrival is None else planned,
        "arrival_change_time": at(arrival),
        "arrival_is_canceled": cancelled and arrival is not None,
        "departure_planned_time": None if departure is None else planned,
        "departure_change_time": at(departure),
        "departure_is_canceled": cancelled and arrival is None,
    }


def changes(*stops: dict) -> list[tuple[str, str, int]]:
    """(from, to, change) of the sections the stops give, in stop order."""
    df = pl.DataFrame(stops, schema=SCHEMA).select(
        trip=trip_key_expr(), num=stop_number_expr(), eva="eva", delay=stop_delay_expr()
    )
    out = section_changes(df.lazy()).collect()
    return out.sort("from_eva").select("from_eva", "to_eva", "change").rows()


def test_changes_along_a_trip_sum_to_the_last_arrival_minus_the_first_departure():
    got = changes(
        stop(1, "A", departure=2),
        stop(2, "B", arrival=5, departure=5),
        stop(3, "C", arrival=3, departure=4),
        stop(4, "D", arrival=9),
    )
    assert got == [("A", "B", 3), ("B", "C", -2), ("C", "D", 6)]
    assert sum(c for *_, c in got) == 9 - 2


def test_a_stop_without_a_change_time_counts_as_on_time():
    # B has a planned arrival but no change: 0 minutes; A has a departure only, delayed by 4
    row = stop(2, "B", arrival=0)
    row["arrival_change_time"] = None
    assert changes(stop(1, "A", departure=4), row) == [("A", "B", -4)]


def test_a_cancelled_end_drops_only_its_sections():
    assert changes(
        stop(1, "A", departure=1),
        stop(2, "B", arrival=2),
        stop(3, "C", arrival=3),
        stop(4, "D", arrival=9, cancelled=True),
    ) == [("A", "B", 1), ("B", "C", 1)]
    # a cancelled first stop leaves no section from it, the rest stays
    assert changes(
        stop(1, "A", departure=1, cancelled=True), stop(2, "B", arrival=2), stop(3, "C", arrival=5)
    ) == [("B", "C", 3)]


def test_an_implausible_delay_at_either_end_drops_the_section():
    assert changes(
        stop(1, "A", departure=2000), stop(2, "B", arrival=5), stop(3, "C", arrival=6)
    ) == [("B", "C", 1)]
    assert (
        changes(stop(1, "A", departure=0), stop(2, "B", arrival=-45), stop(3, "C", arrival=1)) == []
    )


def test_a_stop_number_gap_makes_no_section():
    got = changes(
        stop(1, "A", departure=0),
        stop(2, "B", arrival=1),
        stop(4, "D", arrival=3),
        stop(5, "E", arrival=7),
    )
    assert got == [("A", "B", 1), ("D", "E", 4)]


def test_trips_do_not_mix():
    got = changes(
        stop(1, "A", departure=0, ride="x"),
        stop(1, "B", departure=0, ride="y"),
        stop(2, "C", arrival=5, ride="x"),
        stop(2, "D", arrival=1, ride="y"),
    )
    assert got == [("A", "C", 5), ("B", "D", 1)]


def test_the_stop_number_falls_back_to_the_last_part_of_the_id():
    df = pl.DataFrame(
        {
            "id": ["-123-2609302323-5", "456-2609302323-12", "789-2609302323-7"],
            "train_line_station_num": pl.Series([None, None, 3], dtype=pl.Int32),
        }
    ).select(trip=trip_key_expr(), num=stop_number_expr())
    assert df.rows() == [("-123-2609302323", 5), ("456-2609302323", 12), ("789-2609302323", 3)]


def test_the_trip_day_is_the_date_in_the_middle_of_the_id():
    ids = [
        "123-2609302323-5",  # the local start of the trip, also when later stops are after midnight
        "-8123456789012345678-2610010005-12",  # a ride id may start with a minus sign
        "-2610010005-3",  # a short ride id
        "no-id-here",
        None,
    ]
    out = pl.DataFrame({"id": ids}, schema={"id": pl.String}).select(day=trip_day_expr())
    assert out.schema == pl.Schema({"day": pl.Date})
    assert out["day"].to_list() == [
        date(2026, 9, 30),
        date(2026, 10, 1),
        date(2026, 10, 1),
        None,
        None,
    ]


def test_the_axis_is_the_pattern_with_the_most_station_visits():
    routes = pl.DataFrame(
        {
            "linie": ["L", "L", "L", "M"],
            "pattern": [list("ABCDE"), list("AB"), list("BC"), list("XY")],
            "trips": [3, 6, 2, 1],  # visits: 15, 12, 4; the many short turns lose
        }
    )
    assert line_axis(routes).sort("linie", "pos").rows() == [
        ("L", 0, "A"),
        ("L", 1, "B"),
        ("L", 2, "C"),
        ("L", 3, "D"),
        ("L", 4, "E"),
        ("M", 0, "X"),
        ("M", 1, "Y"),
    ]
    # more visits for the short turn: it wins
    routes = routes.with_columns(trips=pl.Series([3, 8, 2, 1]))
    assert line_axis(routes).filter(pl.col("linie") == "L")["eva"].to_list() == ["A", "B"]


def test_a_tie_goes_to_the_lexicographically_lower_pattern():
    for patterns in ([list("AC"), list("AB")], [list("AB"), list("AC")]):
        routes = pl.DataFrame({"linie": ["L", "L"], "pattern": patterns, "trips": [2, 2]})
        assert line_axis(routes).sort("pos")["eva"].to_list() == ["A", "B"]


def oriented(patterns: dict[str, list[str]], ends: dict[str, list[str]]) -> dict[str, list[str]]:
    """`orient_axis` over lines given as station-name lists (the EVA is the name's lower case)."""
    axis = pl.DataFrame(
        [
            (line, i, name.lower())
            for line, names in patterns.items()
            for i, name in enumerate(names)
        ],
        schema={"linie": pl.String, "pos": pl.Int32, "eva": pl.String},
        orient="row",
    )
    names = pl.DataFrame(
        {
            "eva": [n.lower() for ns in patterns.values() for n in ns],
            "name": sum(patterns.values(), []),
        }
    ).unique()
    dests = pl.DataFrame({"linie": list(ends), "dest": list(ends.values())})
    got = orient_axis(axis, names, dests)
    assert got.columns == ["linie", "pos", "eva"] and got.schema["pos"] == pl.Int32
    return {k: v["eva"].to_list() for (k,), v in got.sort("linie", "pos").group_by("linie")}


def test_the_axis_is_turned_so_it_starts_at_the_first_end_of_the_label():
    got = oriented(
        {
            "last": list("ABC"),  # ends at the label's first end: turned
            "second": list("ABC"),  # starts at the label's second end: turned
            "kept": list("CBA"),  # already starts at the first end
            "neither": list("ABC"),  # no name matches an end: left alone
            "none": list("ABC"),  # no end stations at all: left alone
        },
        {"last": ["C", "X"], "second": ["X", "A"], "kept": ["C", "A"], "neither": ["X", "Y"]},
    )
    assert got == {
        "last": ["c", "b", "a"],
        "second": ["c", "b", "a"],
        "kept": ["c", "b", "a"],
        "neither": ["a", "b", "c"],
        "none": ["a", "b", "c"],
    }


def test_a_ring_that_starts_at_the_first_end_is_not_turned():
    ring = ["Ring", "B", "C", "Ring"]  # it starts and ends at the first end
    assert oriented({"R": ring}, {"R": ["Ring"]}) == {"R": ["ring", "b", "c", "ring"]}


def test_the_names_match_after_the_spelling_fix_of_the_destinations():
    got = oriented({"L": ["Hamm", "Schwerte(Ruhr)"]}, {"L": ["Schwerte (Ruhr)", "Hamm"]})
    assert got == {"L": ["schwerte(ruhr)", "hamm"]}
