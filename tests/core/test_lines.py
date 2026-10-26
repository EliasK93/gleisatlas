import polars as pl

from core.lines import line_ids, line_name_expr, line_table, networks


def members(rows: list[tuple[str, str, str]]) -> pl.DataFrame:
    return pl.DataFrame(rows, schema=["name", "group", "eva"], orient="row")


def nets_of(df: pl.DataFrame) -> list[tuple[str, str, str]]:
    return [(n, e, net) for n, e, net in df.select("name", "eva", "net").iter_rows()]


def test_line_name_falls_back_to_type_and_number():
    df = pl.DataFrame(
        {"line_number": ["S1", None], "train_type": ["S", "ICE"], "train_number": ["31", "679"]}
    )
    assert df.select(line_name_expr().alias("n"))["n"].to_list() == ["S1", "ICE 679"]


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


def test_line_table_labels_and_typ():
    nets = pl.DataFrame(
        {
            "name": ["S1", "S1", "S1", "S1", "RE5"],
            "eva": ["A", "B", "X", "Y", "A"],
            "net": ["A", "A", "X", "X", "A"],
        }
    )
    stops = pl.DataFrame(
        {
            "name": ["S1", "S1", "S1", "S1", "S1", "RE5", "RE5"],
            "eva": ["A", "B", "X", "Y", "Y", "A", "A"],
            "train_type": ["S", "S", "S", "S", "RB", "RE", "RB"],
            "n": [10, 30, 5, 5, 1, 4, 3],
        }
    )
    names = pl.DataFrame(
        {"eva": ["A", "B", "X", "Y"], "name": ["Aheim", "Bstadt", "Xdorf", "Yberg"]}
    )
    out = line_table(nets, stops, names)
    assert out.columns == ["linie", "name", "label", "typ"]
    assert out.rows() == [
        ("RE5:A", "RE5", "RE5", "RE"),
        ("S1:A", "S1", "S1 · Bstadt", "S"),
        # X and Y tie at 5 S stops; Y has 6 stops in total, so Y is the busiest station
        ("S1:X", "S1", "S1 · Yberg", "S"),
    ]


def test_line_table_digit_names_get_the_train_type_in_front():
    # "36" is only a number in the source; id stays, "S36" is shown. Operator codes and
    # other types keep the bare number; names with letters are untouched.
    nets = pl.DataFrame(
        {
            "name": ["36", "36", "7", "7", "RB60"],
            "eva": ["A", "X", "A", "X", "A"],
            "net": ["A", "X", "A", "A", "A"],
        }
    )
    stops = pl.DataFrame(
        {
            "name": ["36", "36", "7", "RB60"],
            "eva": ["A", "X", "A", "A"],
            "train_type": ["S", "S", "SWE", "RB"],
            "n": [3, 2, 4, 1],
        }
    )
    names = pl.DataFrame({"eva": ["A", "X"], "name": ["Aheim", "Xdorf"]})
    assert line_table(nets, stops, names).select("linie", "name", "label").rows() == [
        ("36:A", "S36", "S36 · Aheim"),
        ("36:X", "S36", "S36 · Xdorf"),
        ("7:A", "7", "7"),
        ("RB60:A", "RB60", "RB60"),
    ]


def test_line_table_leaves_out_networks_without_stops():
    # X-Y and the whole name RE9 only have stops without an arrival (no row in `stops`).
    nets = pl.DataFrame(
        {
            "name": ["S1", "S1", "S1", "RE9"],
            "eva": ["A", "X", "Y", "A"],
            "net": ["A", "X", "X", "A"],
        }
    )
    stops = pl.DataFrame({"name": ["S1"], "eva": ["A"], "train_type": ["S"], "n": [4]})
    names = pl.DataFrame({"eva": ["A", "X", "Y"], "name": ["Aheim", "Xdorf", "Yberg"]})
    assert line_table(nets, stops, names).rows() == [("S1:A", "S1", "S1", "S")]


def test_line_table_busiest_station_tie_goes_to_lowest_eva():
    nets = pl.DataFrame({"name": ["S1"] * 3, "eva": ["A", "X", "Y"], "net": ["A", "X", "X"]})
    stops = pl.DataFrame(
        {"name": ["S1"] * 3, "eva": ["A", "X", "Y"], "train_type": ["S"] * 3, "n": [1, 5, 5]}
    )
    names = pl.DataFrame({"eva": ["A", "X", "Y"], "name": ["Aheim", "Xdorf", "Yberg"]})
    assert line_table(nets, stops, names)["label"].to_list() == ["S1 · Aheim", "S1 · Xdorf"]
