import polars as pl
import pytest

from pipeline.aggregate import aggregate, main, stations


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


def test_cli_writes_aggregate_and_stations(source: pl.DataFrame, tmp_path):
    src, dst = tmp_path / "src.parquet", tmp_path / "out" / "aggregate.parquet"
    source.write_parquet(src)
    main([str(src), str(dst)])
    assert pl.read_parquet(dst)["n"].sum() == 6
    assert pl.read_parquet(dst.with_name("stations.parquet")).height == 2
