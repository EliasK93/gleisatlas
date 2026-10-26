"""Station coordinates and federal state from Wikidata (CC0), keyed by IBNR (P954)."""

import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import polars as pl

ENDPOINT = "https://query.wikidata.org/sparql"
USER_AGENT = "Verlaesslich/0.1 (https://github.com/EliasK93)"  # Wikimedia requires one
QUERY = """
SELECT ?ibnr ?coord ?stateLabel WHERE {
  ?item wdt:P954 ?ibnr ; wdt:P625 ?coord .
  OPTIONAL {
    ?item wdt:P131+ ?state .
    ?state wdt:P31 wd:Q1221156 ; rdfs:label ?stateLabel .
    FILTER(LANG(?stateLabel) = "de")
  }
}
"""
OUT = Path("data/coords.parquet")


def parse_bindings(response: dict) -> pl.DataFrame:
    """SPARQL JSON -> one row per IBNR: ibnr, lat, lon, land (nullable)."""
    rows = []
    for b in response["results"]["bindings"]:
        m = re.fullmatch(r"Point\((\S+) (\S+)\)", b["coord"]["value"])
        if m:  # WKT order is lon lat
            lon, lat = float(m[1]), float(m[2])
            rows.append((b["ibnr"]["value"], lat, lon, b.get("stateLabel", {}).get("value")))
    df = pl.DataFrame(
        rows,
        schema={"ibnr": pl.String, "lat": pl.Float64, "lon": pl.Float64, "land": pl.String},
        orient="row",
    )
    # Deterministic pick: a row with a state first, then the smallest coordinate.
    return (
        df.sort("ibnr", "land", "lat", "lon", nulls_last=True)
        .unique("ibnr", keep="first")
        .sort("ibnr")
    )


def fetch() -> dict:
    url = f"{ENDPOINT}?{urllib.parse.urlencode({'query': QUERY, 'format': 'json'})}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.load(resp)


def main(argv: list[str]) -> None:
    if argv:
        sys.exit("usage: python -m pipeline.coords")
    df = parse_bindings(fetch())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(OUT)
    print(f"written: {OUT} ({df.height} stations, {df['land'].is_not_null().sum()} with state)")


if __name__ == "__main__":
    main(sys.argv[1:])
