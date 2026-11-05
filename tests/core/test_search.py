import polars as pl

from core.search import line_hits, norm, split_query

# (linie, name, label, typ, zug, n, first, last): first and last name the axis's end stations
ROWS = [
    ("S6:1", "S6", "S6 Köln – Essen", "S", False, 100, "Köln Hbf", "Essen Hbf"),
    ("S6:2", "S6", "S6 Haan – Dortmund", "S", False, 50, "Haan", "Dortmund Hbf"),
    ("S60:1", "S60", "S60 Ulm", "S", False, 900, "Ulm Hbf", "Aalen"),
    ("IC34:1", "IC34", "IC34 Dortmund – Emden", "IC", False, 300, "Dortmund Hbf", "Emden Hbf"),
    ("IC34:2", "IC34", "IC34 Berlin – Dortmund", "IC", False, 200, "Berlin Hbf", "Dortmund Hbf"),
    ("IC34:3", "IC34", "IC34 Hamburg – Berlin", "IC", False, 400, "Hamburg Hbf", "Berlin Hbf"),
    ("RE50:1", "RE50", "RE50 Bremen", "RE", False, 80, "Bremen Hbf", "Vechta"),
    ("RE5:1", "RE5", "RE5 Koblenz – Wesel", "RE", False, 20, "Koblenz Hbf", "Wesel"),
    ("RE 501:1", "RE 501", "RE 501 → Fulda", "RE", True, 5000, "Bebra", "Fulda"),
    ("ICE 679:1", "ICE 679", "ICE 679 → Kassel", "ICE", True, 10, "Berlin Hbf", "Kassel-Wilh."),
    ("S1:1", "S1", "S1 Ring", "S", False, 70, "Ring Hbf", "Ring Hbf"),
    ("X1:1", "X1", "X1", "X", False, 1, None, None),
    # the label names Hamm, the axis runs Düsseldorf to Aachen
    ("RE1:1", "RE1", "RE1 Hamm – Aachen", "RE", False, 600, "Düsseldorf Hbf", "Aachen Hbf"),
    ("RE13:1", "RE13", "RE13 Hamm – Venlo", "RE", False, 700, "Hamm (Westf)", "Venlo"),
]  # fmt: skip
LINES = pl.DataFrame(
    ROWS,
    schema=["linie", "name", "label", "typ", "zug", "n", "first", "last"],
    orient="row",
)
NAMES = {norm(n) for n in LINES["name"]}


def hits_for(q: str, limit: int = 20) -> pl.DataFrame:
    return line_hits(LINES, NAMES, q, limit)[0]


def ids(q: str, limit: int = 20) -> list[str]:
    return hits_for(q, limit)["linie"].to_list()


def test_norm_drops_case_spaces_and_hyphens():
    assert [norm(t) for t in ("S 6", "IC-34", "Ice 679", " s6 ")] == ["s6", "ic34", "ice679", "s6"]


def test_the_line_part_is_the_longest_run_of_words_that_is_a_name():
    assert split_query("S 6 essen", NAMES) == ("s6", ["essen"])
    assert split_query("ice 679", NAMES) == ("ice679", [])
    assert split_query("ic34 dortmund", NAMES) == ("ic34", ["dortmund"])
    assert split_query("s6", {"s6", "s60"}) == ("s6", [])  # exact, not the prefix of s60
    assert split_query("s1 2", {"s1", "s12"}) == ("s12", [])  # the longer run wins


def test_without_an_exact_name_the_longest_prefix_run_is_the_line_part():
    assert split_query("re", NAMES) == ("re", [])
    assert split_query("ic3 dortmund", NAMES) == ("ic3", ["dortmund"])
    assert split_query("s 6 0", NAMES) == ("s60", [])
    assert split_query("re5 0 vechta", NAMES) == ("re50", ["vechta"])


def test_a_place_has_no_line_part():
    assert split_query("dortmund", NAMES) is None
    assert split_query("dortmund hbf", NAMES) is None
    assert split_query("   ", NAMES) is None


def test_a_place_finds_no_line_even_when_lines_end_there():
    assert ids("dortmund") == []


def test_a_line_and_an_end_station_gives_that_direction():
    hits = hits_for("ic34 dortmund", 20)
    # IC34:3 has no end at Dortmund and drops out; the busier id leads
    assert hits["linie"].to_list() == ["IC34:1", "IC34:2"]
    assert hits["richtung"].to_list() == [2, 1]  # first station of the axis: toward it is 2
    assert hits["ziel"].to_list() == ["Dortmund Hbf", "Dortmund Hbf"]  # the end that was meant
    towards = hits_for("ic34 emden", 20)
    assert (towards["richtung"].to_list(), towards["ziel"].to_list()) == ([1], ["Emden Hbf"])


def test_a_rest_word_that_matches_neither_end_drops_the_id():
    assert ids("ic34 kiel") == []
    assert ids("s6 essen") == ["S6:1"]


def test_every_rest_word_has_to_match_the_same_end_or_the_label():
    assert ids("ic34 dortmund hbf") == ["IC34:1", "IC34:2"]
    assert ids("ic34 hbf dortmund") == ids("ic34 dortmund hbf")
    # one word per end: no end has both, the label of IC34:1 has both
    hits = hits_for("ic34 dortmund emden")
    assert (hits["linie"].to_list(), hits["richtung"].to_list()) == (["IC34:1"], [None])
    assert ids("ic34 berlin emden") == []  # neither one end nor one label


def test_a_rest_word_may_match_the_label_and_then_gives_no_direction():
    # RE1's label names Hamm, but its axis runs Düsseldorf to Aachen
    hits = hits_for("re1 hamm")
    assert hits["linie"].to_list() == ["RE1:1"]  # RE13 names Hamm too, but RE1 is the exact name
    assert (hits["richtung"].to_list(), hits["ziel"].to_list()) == ([None], [None])
    # the direction still comes from the axis's ends
    aachen = hits_for("re1 aachen")
    assert (aachen["richtung"].to_list(), aachen["ziel"].to_list()) == ([1], ["Aachen Hbf"])


def test_rest_words_keep_the_prefix_hits_after_a_prefix_line_part():
    assert ids("re hamm") == ["RE13:1", "RE1:1"]  # no exact name: both, more stops first


def test_an_id_with_the_word_at_both_ends_has_no_direction():
    hits = hits_for("s6 hbf", 20)
    # S6 is exact, so the prefix match S60 (Ulm Hbf) stays out
    assert hits["linie"].to_list() == ["S6:1", "S6:2"]
    # Köln Hbf and Essen Hbf, then Dortmund Hbf (last)
    assert hits["richtung"].to_list() == [None, 1]
    assert hits["ziel"].to_list() == [None, "Dortmund Hbf"]  # set exactly with richtung
    s = hits_for("s hbf", 20)  # a prefix: S60's Ulm Hbf is its first station
    assert (s["linie"][0], s["richtung"][0], s["ziel"][0]) == ("S60:1", 2, "Ulm Hbf")


def test_spaces_hyphens_and_case_do_not_matter():
    assert ids("S 6") == ids("s6") == ids("S6") == ["S6:1", "S6:2", "S60:1"]
    assert ids("ice 679") == ["ICE 679:1"]
    assert ids("IC-34 dortmund") == ids("ic34 dortmund")
    assert ids("ice 679 kassel") == ["ICE 679:1"]  # an end station, spelled with its hyphen


def test_one_name_in_several_networks_gives_one_hit_per_id():
    assert ids("s6")[:2] == ["S6:1", "S6:2"]  # most stops first, before the prefix match S60


def test_a_prefix_ranks_the_exact_name_first_and_lines_before_trains():
    # RE5 is exact, RE50 a line prefix, "RE 501" a single train with more stops than both
    assert ids("re5") == ["RE5:1", "RE50:1", "RE 501:1"]


def test_then_more_stops_and_then_the_label():
    assert ids("s") == ["S60:1", "S6:1", "S1:1", "S6:2"]
    tied = LINES.filter(pl.col("linie").is_in(["S6:1", "S6:2"])).with_columns(n=pl.lit(5))
    assert line_hits(tied, NAMES, "s6", 20)[0]["label"].to_list() == [
        "S6 Haan – Dortmund",
        "S6 Köln – Essen",
    ]


def test_a_ring_and_a_line_without_an_axis_have_no_direction():
    assert hits_for("s1 ring", 20)["richtung"].to_list() == [None]
    assert hits_for("x1", 20)["richtung"].to_list() == [None]
    assert hits_for("s1 ring", 20)["ziel"].to_list() == [None]
    assert hits_for("x1", 20)["ziel"].to_list() == [None]
    assert ids("x1 ulm") == []  # no end station to match


def test_the_limit_cuts_the_list():
    assert ids("s6", limit=1) == ["S6:1"]


def test_a_hit_carries_what_the_picker_shows():
    hit = hits_for("ice 679", 20).row(0, named=True)
    assert hit == {
        "linie": "ICE 679:1",
        "label": "ICE 679 → Kassel",
        "typ": "ICE",
        "zug": True,
        "richtung": None,
        "ziel": None,
    }


def test_the_query_starts_with_an_exact_name_or_not():
    def exact(q: str) -> bool:
        return line_hits(LINES, NAMES, q, 20)[1]

    assert exact("ic34 dortmund")
    assert exact("S 6")
    assert exact("ice 679")
    assert not exact("dortmund")
    assert not exact("re")  # only a prefix
    assert not exact("")
