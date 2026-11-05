import polars as pl

from core.lines import (
    MIN_STOPS,
    destination_expr,
    is_train_number,
    line_ids,
    line_name_expr,
    line_table,
    networks,
    no_live_data,
)


def members(rows: list[tuple[str, str, str]]) -> pl.DataFrame:
    return pl.DataFrame(rows, schema=["name", "group", "eva"], orient="row")


def nets_of(df: pl.DataFrame) -> list[tuple[str, str, str]]:
    return [(n, e, net) for n, e, net in df.select("name", "eva", "net").iter_rows()]


def test_line_name_puts_the_train_type_before_a_bare_number():
    df = pl.DataFrame(
        {
            "line_number": ["57", "RE57", "RE 3", "35", "57", "S1", None],
            "train_type": ["RE", "RE", "RE", "FLX", None, "S", "ICE"],
            "train_number": ["1", "2", "3", "4", "5", "31", "679"],
        }
    )
    assert df.select(line_name_expr().alias("n"))["n"].to_list() == [
        "RE57",
        "RE57",
        "RE3",
        "FLX35",
        "57",
        "S1",
        "ICE 679",
    ]


def test_a_blank_line_number_counts_as_missing():
    df = pl.DataFrame(
        {"line_number": ["", " "], "train_type": ["ICE", "RB"], "train_number": ["679", "12"]}
    )
    assert df.select(n=line_name_expr())["n"].to_list() == ["ICE 679", "RB 12"]


def test_a_train_number_name_is_letters_a_space_and_digits():
    df = pl.DataFrame(
        {
            "line_number": [None, "RE57", "S1", "RE 3", None],
            "train_type": ["ICE", "RE", "S", "RE", "ICE"],
            "train_number": ["2591", "1", "2", "3", "7"],
        }
    )
    # "RE 3" loses its space in the line name, so only the lines without a number are trains
    names = df.select(name=line_name_expr())["name"].to_list()
    assert names == ["ICE 2591", "RE57", "S1", "RE3", "ICE 7"]
    # a source line number with a space before its digits survives and reads as a train
    flags = pl.DataFrame({"name": [*names, "S-Bahn 1", "S 1 x", "X  12", "ICE  5"]})
    assert flags.select(zug=is_train_number(pl.col("name")))["zug"].to_list() == [
        *[True, False, False, False, True],
        *[True, False, False, False],
    ]


def no_live(n: int, zero: int, cancelled: int = 0) -> bool:
    df = pl.DataFrame({"n": [n], "zero": [zero], "cancelled": [cancelled]})
    return df.select(r=no_live_data(pl.col("n"), pl.col("zero"), pl.col("cancelled")))["r"].item()


def test_a_line_without_live_data_has_enough_stops_nearly_all_exactly_on_time():
    assert MIN_STOPS == 500
    assert no_live(500, 500)
    assert not no_live(499, 499)  # too few stops
    assert no_live(1000, 990)  # 99 %
    assert not no_live(1000, 989)  # 98.9 %


def test_cancelled_stops_are_not_arrived_and_never_count_as_zero_minutes():
    assert no_live(600, 495, 100)  # 495 of the 500 arrived stops: 99 %
    assert not no_live(600, 494, 100)  # 98.8 % of the arrived stops, though 82 % of all
    assert not no_live(600, 0, 600)  # only cancellations: nothing arrived at 0


def test_destination_spelling_is_unified():
    df = pl.DataFrame(
        {
            "d": [
                "Schwerte(Ruhr)",
                "Offenbach (Main)Hbf",
                "Langenhagen - Kaltenweide",
                "Dortmund   Hbf ",
                "Kassel-Wilhelmshöhe",
                None,
            ]
        }
    )
    assert df.select(destination_expr(pl.col("d")).alias("d"))["d"].to_list() == [
        "Schwerte (Ruhr)",
        "Offenbach (Main) Hbf",
        "Langenhagen-Kaltenweide",
        "Dortmund Hbf",
        "Kassel-Wilhelmshöhe",
        None,
    ]


def test_two_networks_without_shared_station_stay_apart():
    df = members([("S1", "r1", "A"), ("S1", "r1", "B"), ("S1", "r2", "X"), ("S1", "r2", "Y")])
    assert nets_of(networks(df)) == [
        ("S1", "A", "A"),
        ("S1", "B", "A"),
        ("S1", "X", "X"),
        ("S1", "Y", "X"),
    ]


def test_chain_joins_into_one_network_with_lowest_eva():
    df = members(
        [
            ("S1", "r2", "D"),
            ("S1", "r2", "C"),
            ("S1", "r1", "B"),
            ("S1", "r1", "C"),
            ("S1", "r3", "D"),
        ]
    )
    df = pl.concat([df, members([("S1", "r4", "A"), ("S1", "r4", "D")])])
    assert nets_of(networks(df)) == [
        ("S1", "A", "A"),
        ("S1", "B", "A"),
        ("S1", "C", "A"),
        ("S1", "D", "A"),
    ]


def test_other_name_sharing_stations_is_not_joined():
    df = members([("S1", "r1", "A"), ("S1", "r1", "B"), ("S2", "r2", "B"), ("S2", "r2", "C")])
    assert nets_of(networks(df)) == [
        ("S1", "A", "A"),
        ("S1", "B", "A"),
        ("S2", "B", "B"),
        ("S2", "C", "B"),
    ]


def test_cross_month_join_via_month_and_net():
    sep = pl.DataFrame({"name": ["S1"] * 2, "eva": ["B", "C"], "net": ["B", "B"]})
    oct_ = pl.DataFrame({"name": ["S1"] * 2, "eva": ["A", "B"], "net": ["A", "A"]})
    monthly = pl.concat(
        [sep.with_columns(month=pl.lit("2026-09")), oct_.with_columns(month=pl.lit("2026-10"))]
    )
    df = monthly.select("name", group=pl.concat_str("month", pl.lit("|"), "net"), eva="eva")
    assert nets_of(networks(df)) == [("S1", "A", "A"), ("S1", "B", "A"), ("S1", "C", "A")]


def test_networks_are_deterministic():
    rows = [("S1", "r1", "B"), ("S1", "r1", "A"), ("RE1", "r9", "Z"), ("S1", "r1", "A")]
    a, b = networks(members(rows)), networks(members(rows[::-1]))
    assert a.equals(b)
    assert nets_of(a) == [("RE1", "Z", "Z"), ("S1", "A", "A"), ("S1", "B", "A")]


def test_line_ids():
    nets = pl.DataFrame({"name": ["S1"], "eva": ["B"], "net": ["A"]})
    assert line_ids(nets)["linie"].to_list() == ["S1:A"]


def stops_of(rows: list[tuple[str, str, str, int]]) -> pl.DataFrame:
    return pl.DataFrame(rows, schema=["name", "eva", "train_type", "n"], orient="row")


def ends_of(rows: list[tuple[str, str, str, int]]) -> pl.DataFrame:
    return pl.DataFrame(rows, schema=["name", "eva", "dest", "n"], orient="row")


def test_line_table_labels_name_the_two_most_frequent_ends():
    nets = pl.DataFrame(
        {
            "name": ["S1", "S1", "S1", "S1", "S2", "S2", "S3"],
            "eva": ["A", "B", "X", "Y", "A", "B", "A"],
            "net": ["A", "A", "X", "X", "A", "A", "A"],
        }
    )
    stops = stops_of(
        [
            ("S1", "A", "S", 10),
            ("S1", "B", "S", 30),
            ("S1", "B", "RB", 1),
            ("S1", "X", "S", 5),
            ("S2", "A", "S", 4),
            ("S3", "A", "S", 2),
        ]
    )
    ends = ends_of(
        [
            ("S1", "A", "Aheim", 5),
            ("S1", "B", "Aheim", 1),  # summed per line: Aheim 6
            ("S1", "B", "Bstadt", 4),
            ("S1", "B", "Cdorf", 2),  # third end: not shown
            ("S1", "X", "Zeta", 3),  # the other S1 network has its own ends
            ("S1", "Y", "Yberg", 3),  # tie at 3: the lower name goes first
            ("S2", "A", "Aheim", 4),  # one end
        ]
    )
    out = line_table(nets, stops, ends)
    assert out.columns == ["linie", "name", "label", "typ"]
    assert out.rows() == [
        ("S1:A", "S1", "S1 Aheim – Bstadt", "S"),
        ("S1:X", "S1", "S1 Yberg – Zeta", "S"),
        ("S2:A", "S2", "S2 Aheim", "S"),
        ("S3:A", "S3", "S3", "S"),  # no end known
    ]


def test_line_table_train_number_names_show_an_arrow_to_the_top_end():
    nets = pl.DataFrame({"name": ["ICE 679"] * 2, "eva": ["A", "B"], "net": ["A", "A"]})
    stops = stops_of([("ICE 679", "A", "ICE", 2), ("ICE 679", "B", "ICE", 2)])
    ends = ends_of([("ICE 679", "A", "Kassel", 1), ("ICE 679", "B", "Fulda", 3)])
    assert line_table(nets, stops, ends)["label"].to_list() == ["ICE 679 → Fulda"]
    assert line_table(nets, stops, ends.clear())["label"].to_list() == ["ICE 679"]


def test_line_table_leaves_out_networks_without_stops():
    # X-Y and the whole name RE9 only have stops without an arrival (no row in `stops`).
    nets = pl.DataFrame(
        {
            "name": ["S1", "S1", "S1", "RE9"],
            "eva": ["A", "X", "Y", "A"],
            "net": ["A", "X", "X", "A"],
        }
    )
    stops = stops_of([("S1", "A", "S", 4)])
    ends = ends_of([("S1", "A", "Aheim", 4)])
    assert line_table(nets, stops, ends).rows() == [("S1:A", "S1", "S1 Aheim", "S")]
