# ADR 0001: Station coordinates

Status: accepted

## Context

The monthly source (`piebro/deutsche-bahn-data`) identifies stations by EVA and name only; it has no coordinates, so the map start page cannot place them. Our EVAs are 8-digit strings with a leading zero (`08000207`). Other datasets use the IBNR, which is the same number without the leading zero (`8000207`); the join strips leading zeros on our side.

## Options considered

- **Wikidata** (items with IBNR `P954` and coordinates `P625`; CC0): one SPARQL query, also yields the federal state. Completeness depends on community editing.
- **trainline-eu/stations** (ODbL): share-alike would apply to our derived station file; no federal state.
- **derhuerst/db-stations** (CC BY): a snapshot from 2022, so newer stations are missing.
- **DB StaDa API** (CC BY): authoritative, but needs an API key.
- **OpenStreetMap `uic_ref`** (ODbL): often filled with something other than the IBNR; share-alike as well.

## Decision

Wikidata, chosen by the product owner. `uv run python -m pipeline.coords` runs one SPARQL query (standard library only) and writes `data/coords.parquet` (`ibnr`, `lat`, `lon`, `land`, one row per IBNR). `uv run python -m pipeline.update` joins it onto `data/stations.parquet` via the stripped EVA and prints the coverage report.

## Measured coverage

Source file 2026-09, stations with a name in the source:

- 5,209 of 5,219 stations have coordinates (99.8 %); 4,952 of them also have a federal state.
- 99.5 % of all stops belong to stations with coordinates.
- Only 10 named stations are unmatched by IBNR. Most are secondary EVAs that Wikidata does not list, such as the S-Bahn platforms of Berlin-Charlottenburg (`08089165`, 22,981 stops) next to the main EVA `08010403`.
- Same-name fallback: an unmatched station takes the coordinates of the one located station with exactly the same name. This places 7 of the 10, leaving 5,216 of 5,219 stations (99.9 % of stops).
- Still unmatched: Berlin-Karlshorst (7,785 stops), Bochum-Langendreer (3,587) and Bürstadt (Ried) (2,723). They stay searchable and keep their station page, but are not on the map.

Reproduce: `uv run python -m pipeline.coords`, then `uv run python -m pipeline.update`.

## Consequences

- Stations without coordinates stay off the map but remain in search and the station detail (see [map.md](../map.md)).
- A secondary EVA placed by the same-name fallback is drawn on the same spot as its main station, so one dot covers the other.
- How to place the last three stations is an open decision in [map.md](../map.md) §7.
- The federal state can be missing for stations that do have coordinates.
- Refresh by re-running both commands; the result depends on the current state of Wikidata.
- CC0 needs no attribution; Wikidata is credited anyway.
