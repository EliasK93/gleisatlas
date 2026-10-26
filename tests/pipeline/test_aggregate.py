import polars as pl
import pytest

from pipeline.aggregate import aggregate, main, stations, stop_counts, with_coords


def test_delay_and_cancel(mini: pl.DataFrame):
    reg = mini.filter((pl.col("gruppe") == "regional") & (pl.col("eva") == "1"))
    assert reg["n"].sum() == 4
    assert reg.filter(pl.col("bucket").is_null())["n"].item() == 1  # cancelled
    ok = reg.filter(pl.col("bucket").is_not_null())
    assert sorted(ok.select(pl.col("bucket").repeat_by("n").explode())["bucket"]) == [0, 0, 7]


def test_month_from_time_not_planned(mini: pl.DataFrame):
    assert sorted(mini["month"].unique()) == ["2026-09", "2026-10"]


def test_stations(source: pl.DataFrame):
    s = stations(source.lazy())
    assert dict(s.iter_rows()) == {"1": "Alpha", "2": "Beta"}


def test_station_name_tie_is_deterministic(source: pl.DataFrame):
    for names in (["Zulu", "Alpha"], ["Alpha", "Zulu"]):
        two = source.filter((pl.col("train_type") == "RE") & (pl.col("eva") == "1")).head(2)
        tied = two.with_columns(station_name=pl.Series(names))  # one row each: a real tie
        assert stations(tied.lazy())["name"].to_list() == ["Alpha"]


def test_schema_abort(source: pl.DataFrame):
    with pytest.raises(SystemExit, match="arrival_is_canceled"):
        aggregate(source.drop("arrival_is_canceled").lazy())


def test_station_stop_counts(source: pl.DataFrame):
    # all categories and months, cancelled included; bus and no-arrival rows excluded
    assert dict(stop_counts(source.lazy()).iter_rows()) == {"1": 5, "2": 1}


def test_join_coords_on_normalised_eva(source: pl.DataFrame, coords: pl.DataFrame):
    s = stations(source.lazy()).join(stop_counts(source.lazy()), on="eva")
    s = s.with_columns(eva=pl.col("eva").str.pad_start(8, "0"))
    out = with_coords(s, coords).sort("eva")
    assert out.columns == ["eva", "name", "n", "lat", "lon", "land"]
    assert out["lat"].to_list() == [50.0, None]
    assert out["land"].to_list() == ["Nordrhein-Westfalen", None]


def test_unlocated_station_takes_coords_of_its_only_namesake():
    # A secondary EVA (S-Bahn platforms) shares the name of the located main station.
    st = pl.DataFrame(
        {
            "eva": ["08000001", "08089001", "08000002", "08000003", "08000004", "08089003"],
            "name": ["Alpha", "Alpha", "Beta", "Gamma", "Gamma", "Gamma"],
            "n": [10, 5, 3, 2, 2, 1],
        }
    )
    coords = pl.DataFrame(
        {
            "ibnr": ["8000001", "8000003", "8000004"],
            "lat": [50.0, 51.0, 52.0],
            "lon": [7.0, 8.0, 9.0],
            "land": ["Hessen", None, None],
        }
    )
    out = with_coords(st, coords).sort("eva")
    lat = dict(zip(out["eva"], out["lat"], strict=True))
    assert lat["08089001"] == 50.0  # its only located namesake
    assert out.filter(pl.col("eva") == "08089001")["land"].item() == "Hessen"
    assert lat["08000002"] is None  # no located namesake
    assert lat["08089003"] is None  # two located namesakes: ambiguous
    assert out.columns == ["eva", "name", "n", "lat", "lon", "land"]


def test_cli_writes_aggregate_and_stations(source: pl.DataFrame, coords: pl.DataFrame, tmp_path):
    src, dst = tmp_path / "src.parquet", tmp_path / "out" / "aggregate.parquet"
    source.write_parquet(src)
    dst.parent.mkdir()
    coords.write_parquet(dst.with_name("coords.parquet"))
    main([str(src), str(dst)])
    assert pl.read_parquet(dst)["n"].sum() == 6
    out = pl.read_parquet(dst.with_name("stations.parquet"))
    assert out.height == 2
    assert out.columns == ["eva", "name", "n", "lat", "lon", "land"]


def test_cli_aborts_without_coords(source: pl.DataFrame, tmp_path):
    src, dst = tmp_path / "src.parquet", tmp_path / "out" / "aggregate.parquet"
    source.write_parquet(src)
    with pytest.raises(SystemExit, match="pipeline.coords"):
        main([str(src), str(dst)])
