from pipeline.coords import parse_bindings


def row(ibnr: str, point: str, state: str | None = None) -> dict:
    out = {"ibnr": {"value": ibnr}, "coord": {"value": point}}
    if state:
        out["stateLabel"] = {"value": state, "xml:lang": "de"}
    return out


def test_parse_bindings_dedups_and_keeps_missing_state():
    response = {
        "results": {
            "bindings": [
                row("8000207", "Point(6.958 50.943)", "Nordrhein-Westfalen"),
                row("8000207", "Point(6.958 50.943)"),  # same station, no state: dropped
                row("8000001", "Point(6.091 50.768)"),  # no state at all
                row("8000207", "Point(6.959 50.944)", "Nordrhein-Westfalen"),  # second coordinate
            ]
        }
    }
    df = parse_bindings(response)
    assert df.columns == ["ibnr", "lat", "lon", "land"]
    assert df["ibnr"].to_list() == ["8000001", "8000207"]
    assert df["lat"].to_list() == [50.768, 50.943]  # lon/lat order is flipped from the WKT point
    assert df["lon"].to_list() == [6.091, 6.958]  # smallest coordinate wins on duplicates
    assert df["land"].to_list() == [None, "Nordrhein-Westfalen"]
