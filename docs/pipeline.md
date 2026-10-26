# Pipeline

## 1 Overview

Turns one monthly source file from `piebro/deutsche-bahn-data` into a compact aggregate (weekday × hour × category × station × month, delay histogram) plus a station table with names, stop counts and coordinates. The API reads only these two outputs; raw data stays local.

## 2 Spec

Commands (PowerShell, from the repo root):

- `uv run python -m pipeline.download YYYY-MM` downloads one monthly file into `data/raw/`.
- `uv run python -m pipeline.coords` runs one SPARQL query against Wikidata and writes `data/coords.parquet`. Needs network access; run it once and again to refresh.
- `uv run python -m pipeline.aggregate <source.parquet> <data/aggregate.parquet>` writes the aggregate and `data/stations.parquet` (next to the aggregate) and prints a coverage report. It reads `coords.parquet` from the aggregate's folder and aborts with a message if the file is missing, so run `pipeline.coords` first.
- `uv run python scripts/check_sample.py <source.parquet>` compares computed arrival delays against raw rows (spot check for AC-4, outside the gate).

Required source columns: `eva`, `station_name`, `train_type`, `time`, `arrival_planned_time`, `arrival_change_time`, `arrival_is_canceled`. A missing column aborts with a message naming it (AC-2).

Aggregate rows: one row per (`weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`) with count `n`. `weekday` 0 = Monday, `hour` from the planned arrival, `gruppe` is `fern` or `regional`, `bucket` is the delay in whole minutes, NULL = cancelled stop.

## 3 Decisions

- **Delay is computed from arrival times** (`arrival_change_time − arrival_planned_time`; no change time = 0 min). Reason: `delay_in_min` in the source is the *departure* delay (arrival delay only at terminal stops), so it is not used.
- **Stops without `arrival_planned_time` are dropped** (first stops, about 1.1 million rows per month). Reason: they have no arrival to measure.
- **Buses and rail replacement are excluded** (`Bus`, `bus`, `Bsv`, `BSv`, `SEV`). Reason: the product covers rail only, the dataset contains them.
- **Month is taken from `time`**, not from the planned arrival. Reason: a monthly file contains stops planned on the last day of the previous or the first day of the next month; `time` lies exactly within the file month.
- **Stations are identified by EVA; names are not unique.** Reason: the dataset has about 5,200 EVAs and some names occur twice (e.g. Hamburg Hbf with two EVAs). The UI shows "name (EVA)"; filters use the EVA only.
- **Cancelled stops are a NULL bucket**, never 0 min. Reason: a cancelled train is not an on-time train (AC-7); the cancellation rate is computed from the NULL bucket.
- **Delay histogram instead of precomputed median/P90.** Reason: percentiles cannot be merged across cells, and filters (period, station) must re-aggregate.
- **Category group by a fixed list**: `ICE, IC, EC, ECE, TGV, RJ, RJX, NJ, EN` are long-distance (`fern`), everything else is `regional`. Reason: the filter is required, the mapping is not specified.
- **Aggregate size** for one nationwide month: about 4.5 million rows, 5 MB Parquet; the unfiltered heatmap query takes about 0.24 s, filtered under 0.1 s.

## 4 Architecture and data keys

- `pipeline/aggregate.py` reads the monthly Parquet lazily with Polars, validates the schema, filters, and groups.
- Output keys: `weekday`, `hour`, `gruppe`, `eva`, `month` (`YYYY-MM`), `bucket` (Int32, nullable), `n`.
- `data/stations.parquet`: `eva`, `name` (most frequent `station_name` per EVA), `n` (all stops of the EVA in the source, cancelled included; used to rank search results and size map dots), `lat`, `lon`, `land` (federal state). `lat`, `lon` and `land` are NULL where Wikidata has no match or no state.
- `data/coords.parquet`: `ibnr`, `lat`, `lon`, `land`, one row per IBNR for the whole of Wikidata (not only Germany). The join strips the leading zero of our EVA (`08000207` to `8000207`) with `core.stations.ibnr_expr`. An EVA without a match takes the coordinates of the one located station with exactly the same name (secondary EVAs such as S-Bahn platforms). Details and the source decision: [adr/0001-station-coordinates.md](adr/0001-station-coordinates.md).
- Coverage report: named stations with coordinates (number and share), the share of stops that belong to them, and the unmatched named stations with the most stops. Source file 2026-09: 5,216 of 5,219 stations (99.9 %), 99.9 % of stops.
- The source also contains `xml_station_name`, `id`, `is_additional_stop` and more; they are not used yet.
- Time zone: Europe/Berlin, as in the source.

## 5 Milestones

- [ ] M0 – Download command and one-month aggregate run through the gate. Re-check: `tests/core` (delay semantics, NULL bucket) and `tests/pipeline` (incl. schema abort) pass.
- [ ] M3 – Multi-month pipeline: incremental download, schema validation across the 2026-05 and 2026-08 changes, cleaning, timetable periods. Re-check: second run downloads nothing (AC-1); changed schema aborts naming the columns (AC-2); `tests/pipeline` covers all of it.

## 6 Platform checks

- Windows 11, PowerShell, `uv`; paths use forward slashes in code and commands.
- The source file for one month has about 14.8 million rows; Polars scans lazily, so memory stays moderate.

## 7 Open decisions

- Handling of the timetable change in mid-December (train numbers restart): separate per period or mark the change (SPEC O6).
- Missing hours in the source (2025-11 to 2026-07) and how to show them.
- Whether a watchlist fallback is needed for aggregate size (SPEC AC-3).

## 8 Known shortcuts

- Delay is clamped to −10…+120 min. Observed raw range is −150 to +1428 min; real cleaning comes with M3.
- Single month only; no incremental download yet.
- No deduplication or plausibility cleaning yet.
- Spot check script runs on demand, not in the gate.
- `pipeline.coords` is not run by tests or the gate (it needs the network); only its parser is tested, on canned JSON.
