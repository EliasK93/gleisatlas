# Pipeline

## 1 Overview

Turns the monthly source files from `piebro/deutsche-bahn-data` into compact tables: a delay histogram (weekday × hour × category × station × month), a station table with names, stop counts and coordinates, line histograms per month, a line table and a month table with coverage figures. Each month is processed once into its own folder; a combine step then writes the files the API reads. Raw data stays local.

## 2 Spec

Commands (PowerShell, from the repo root):

- `uv run python -m pipeline.coords` runs one SPARQL query against Wikidata and writes `data/coords.parquet`. Needs network access; run it once and again to refresh.
- `uv run python -m pipeline.update` is the one command for the data. It lists the monthly files on HuggingFace, downloads and processes every month whose folder `data/months/YYYY-MM/` is missing or incomplete, and then combines all months. A second run downloads nothing (AC-1). It reads `data/coords.parquet` and aborts before fetching anything if the file is missing, so run `pipeline.coords` first.
- `uv run python -m pipeline.download YYYY-MM` downloads one monthly file into `data/raw/`; `pipeline.update` calls it, you rarely need it directly.
- `uv run python scripts/check_sample.py <source.parquet>` compares computed arrival delays against raw rows (spot check for AC-4, outside the gate).

After a change to the per-month logic (cleaning, line names, coverage rule) the existing month folders are stale: delete `data/months/` and run `pipeline.update` again. The skip check only looks for the folder, not for the version of the code that wrote it.

**Source schema.** The source must carry exactly the 23 known columns (`COLUMNS` in `pipeline/aggregate.py`). A missing or a new column aborts the run with a message that names it (AC-2).

**Month folder** `data/months/YYYY-MM/`, written to a temporary sibling and renamed only when all five files exist, so a crash never leaves a half-complete month:

| File | Keys |
|---|---|
| `aggregate.parquet` | `weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`, `n` |
| `lines.parquet` | `name`, `train_type`, `eva`, `gruppe`, `month`, `bucket`, `n` |
| `networks.parquet` | `name`, `eva`, `net` (the line networks within the month) |
| `stations.parquet` | `eva`, `name`, `n` |
| `meta.parquet` | `month`, `missing_hours`, `stations` |

**Combined files** in `data/`, the only ones the API reads:

| File | Content |
|---|---|
| `aggregate.parquet` | All months of the month aggregates, sorted. One row per (`weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`) with count `n`. `weekday` 0 = Monday, `hour` from the planned arrival, `gruppe` is `fern` or `regional`, `bucket` is the delay in whole minutes, NULL = cancelled stop. |
| `stations.parquet` | `eva`, `name` (from the newest month), `n` (summed), `lat`, `lon`, `land`. |
| `lines.parquet` | `linie`, `eva`, `gruppe`, `month`, `bucket`, `n`: the delay histogram per line and station. |
| `linien.parquet` | `linie`, `name`, `label`, `typ`: one row per line. |
| `monate.parquet` | `month`, `missing_hours`, `stations`: one row per month. The API requires it. |

## 3 Decisions

- **Delay is computed from arrival times** (`arrival_change_time − arrival_planned_time`; no change time = 0 min). Reason: `delay_in_min` in the source is the *departure* delay (arrival delay only at terminal stops), so it is not used.
- **Stops without `arrival_planned_time` are dropped from the delay data** (first stops, about 1.1 million rows per month). Reason: they have no arrival to measure. They still feed the line networks, because a first stop belongs to its trip.
- **Buses and rail replacement are excluded** (`Bus`, `bus`, `Bsv`, `BSv`, `SEV`). Reason: the product covers rail only, the dataset contains them.
- **Month is taken from `time`**, not from the planned arrival. Reason: a monthly file contains stops planned on the last day of the previous or the first day of the next month; `time` lies exactly within the file month.
- **Stations are identified by EVA; names are not unique.** Reason: the dataset has about 5,200 EVAs and some names occur twice (e.g. Hamburg Hbf with two EVAs). The UI shows "name (EVA)"; filters use the EVA only.
- **Cancelled stops are a NULL bucket**, never 0 min. Reason: a cancelled train is not an on-time train (AC-7); the cancellation rate is computed from the NULL bucket.
- **Delay histogram instead of precomputed median/P90.** Reason: percentiles cannot be merged across cells, and filters (period, station) must re-aggregate.
- **Category group by a fixed list**: `ICE, IC, EC, ECE, TGV, RJ, RJX, NJ, EN` are long-distance (`fern`), everything else is `regional`. Reason: the filter is required, the mapping is not specified.
- **Cleaning, per month, in this order:**
  - Delays below −30 min or above +1440 min (24 h, both bounds inclusive) are dropped as implausible. Cancelled stops are kept whatever their times say. A missing change time is plausible. Reason: the observed range is −150 to +1428 min; a delay beyond a day or an arrival half an hour early is a data error, not train behaviour.
  - Duplicates on (`eva`, `train_type`, `train_number`, `arrival_planned_time`) are dropped, keeping the first. Rows without an arrival are never duplicates. Reason: the source repeats stops, and a repeated stop would count twice. This runs after the plausibility rule, so a plausible copy survives an implausible first one.
  - The run prints how many rows each rule dropped per month (3–1,118 duplicates and 158–1,241 implausible rows over the 27 months).
- **No clamp.** The bucket is the exact minute. Reason: clamping hid the long tail from P90 and from the share of delays over an hour; the histogram stays small anyway.
- **A line is its name split into networks.** The name is `line_number`, or `"{train_type} {train_number}"` where that is missing (long-distance trains and a few regional ones, e.g. "ICE 679"). Reason: "S1" alone exists in 15 federal states and splits into 14 networks. Details:
  - Within one name, stations that share a `train_line_ride_id` belong to one network, transitively. A ride id is a trip pattern that repeats daily; 817 ride ids carry more than one name, so (name, ride id) is the unit, not the ride id alone. The networks are connected components, found by min-label propagation in `core/lines.py`.
  - Each month gets its own networks; the combine step joins them across months, with (month, network) standing in for a trip.
  - **Id** `"{name}:{lowest EVA of the network}"`. It stays the same as months are added, unless a network gains a station with a lower EVA or merges with another one; a saved link to a line can then point at nothing.
  - **Label** is the bare name where the name has one network, otherwise "{name} · {busiest station of the network}", e.g. "S1 · Essen-Steele". A name that is only a number gets its train type in front when that is S, RB, RE, IRE or MEX ("S36", "RE7"), in `name` and `label`; the id keeps the source name. **Typ** is the most frequent `train_type` of the line and serves as the badge.
  - A network that only has stops without an arrival (no delay data) is not a line: `linien.parquet` lists only networks with stops, so no row has an empty label or typ. Most lines are single long-distance train numbers. Rankings filter by minimum sample.
- **Missing hours are recorded per month, not repaired.** The usual level of an hour of the day is the lowest, over the seven weekdays, of the median row count of that (weekday, hour) in the month. An hour counts as a gap when it has fewer than `GAP_SHARE` (half) of that level in `pipeline/aggregate.py`; an hour with no rows at all counts too. Reason: the source is quiet at night and on Sunday mornings, so a fixed threshold, or the median over all days, would flag normal hours, while a relative rule also catches a half-empty hour. The hours are counted against the real local month, so the skipped hour of the March clock change is not a gap and the doubled October hour is not one either. The months after the station jump (2025-11) stay flagged for the days before 2025-11-02. Over the 27 months this flags 50 h in 2025-11, 4–12 h in 2024-11 and in six months between 2026-02 and 2026-08 (2026-07: 8 h), 1 h in 2025-06 and 2025-07, and none elsewhere. SPEC §4.1 names 102 h for July 2026; the way it counts is not known, so the figures can differ.
- **Timetable changes are marked, not split.** `core.periods.timetable_changes` returns the Sunday after the second Saturday of December (2024-12-15, 2025-12-14, 2026-12-13). The API lists those inside the data range and trains keep one key across years. Reason: product owner's choice (SPEC O6); splitting statistics per timetable period comes with the planner, where train numbers matter.
- **Full coverage starts where the station count jumps.** `core.periods.full_coverage_start` returns the first month with at least half as many stations as the largest month. The source has about 135 stations per month until 2025-10 and about 5,2xx from 2025-11, so it returns 2025-11. Reason: views default to the period where "nationwide" is true.
- **Output size over 27 months:** `aggregate.parquet` 60.8 MB, `lines.parquet` 10.9 MB, `linien.parquet` 0.2 MB, `stations.parquet` 0.1 MB, `monate.parquet` under 0.1 MB. The 2 GB limit of AC-3 is far away, so no watchlist fallback is needed.

## 4 Architecture and data keys

- `pipeline/aggregate.py`: per-month tables from one source file, read lazily with Polars. `check_schema` validates, `clean` applies the cleaning, and `aggregate`, `lines`, `month_networks`, `stations` and `meta` build the five month tables. `with_coords` and `coverage_report` serve the combine step.
- `pipeline/update.py`: `update` walks the remote months and calls `process` for each incomplete one, then `combine`. The downloader and the list of remote months are passed in, so tests run it with a fake that counts its calls. `combine` writes the five combined files.
- `core/lines.py`, `core/periods.py`, `core/delay.py`: the pure parts (line names and networks, timetable changes and coverage start, the delay and plausibility rules).
- `data/coords.parquet`: `ibnr`, `lat`, `lon`, `land`, one row per IBNR for the whole of Wikidata (not only Germany). The join strips the leading zero of our EVA (`08000207` to `8000207`) with `core.stations.ibnr_expr`. An EVA without a match takes the coordinates of the one located station with exactly the same name (secondary EVAs such as S-Bahn platforms). Details and the source decision: [adr/0001-station-coordinates.md](adr/0001-station-coordinates.md).
- `data/stations.parquet`: `n` is all stops of the EVA in the source, arrival stops with cancelled ones included; it ranks search results and sizes map dots. `lat`, `lon` and `land` are NULL where Wikidata has no match or no state.
- Coverage report, printed by the combine step: named stations with coordinates (number and share), the share of stops that belong to them, and the unmatched named stations with the most stops. Over 27 months: 5,415 of 5,419 named stations (99.9 %). Unmatched: Berlin-Karlshorst, Bochum-Langendreer, Bürstadt (Ried) and Trebitz (b Könnern).
- The source also contains `xml_station_name`, `id`, `is_additional_stop`, the departure columns and more; most are not used yet.
- Time zone: Europe/Berlin, as in the source; times are not converted.

## 5 Milestones

- [ ] M0 – Download command and one-month aggregate run through the gate. Re-check: `tests/core` (delay semantics, NULL bucket) and `tests/pipeline` (incl. schema abort) pass.
- [x] M3 – Multi-month pipeline: incremental download, strict schema, cleaning, line networks, coverage, timetable changes marked. Re-check: `uv run pytest -q` passes, in particular
  - AC-1: `tests/pipeline/test_update.py` (`test_second_run_fetches_nothing_and_still_combines`, `test_month_missing_a_file_is_reprocessed`, `test_leftover_temporary_folder_is_not_complete`, `test_update_aborts_without_coords_before_fetching`)
  - AC-2: `tests/pipeline/test_aggregate.py` (`test_schema_abort`, `test_schema_abort_names_a_new_column`)
  - cleaning and missing hours: `tests/pipeline/test_aggregate.py` (`test_cleaning_drops_duplicates_and_implausible_delays`, `test_a_plausible_copy_survives_an_implausible_first_one`, `test_stops_without_arrival_are_never_duplicates`, `test_meta_counts_thin_hours_as_missing`, `test_meta_compares_an_hour_with_its_usual_level_on_that_weekday`, `test_meta_doubled_october_hour_is_not_missing`, `test_meta_counts_missing_hours_against_the_real_month`), `tests/pipeline/test_update.py` (`test_cleaning_counts_are_printed`, `test_monate`) and `tests/core/test_core.py` (`test_arrival_delay_rules`, `test_plausible_bounds_are_inclusive_and_missing_change_is_plausible`)
  - combine: `tests/pipeline/test_update.py` (`test_combine_stations_newest_name_and_summed_n`, `test_combine_station_keeps_the_newest_name_that_is_not_null`, `test_combine_lines_networks_and_labels`, `test_lines_sum_back_to_the_aggregate`)
  - line networks: `tests/core/test_lines.py` (`test_two_networks_without_shared_station_stay_apart`, `test_cross_month_join_via_month_and_net`, `test_line_ids`, `test_line_table_labels_and_typ`, `test_line_table_leaves_out_networks_without_stops`)
  - timetable changes and coverage: `tests/core/test_periods.py` (`test_timetable_changes`, `test_full_coverage_start`)
  - the real run: `uv run python -m pipeline.update` over all 27 months, then again; the second run skips every month and downloads nothing.

## 6 Platform checks

- Windows 11, PowerShell, `uv`; paths use forward slashes in code and commands.
- The first run over 27 months took 8–14 min with the downloads already local; a second run only combines and took 53 s. Memory stays moderate because Polars scans lazily.
- [ ] The heatmap for nationwide, all categories and the last 3 months loads in under 3 s warm (AC-5). To be measured.

## 7 Open decisions

None.

## 8 Known shortcuts

- The skip check looks only at the month folder: a month file that HuggingFace replaces later is not fetched again, and month folders carry no version. Changing the per-month logic needs `data/months/` deleted by hand (see §2).
- The combine step rewrites every combined file on every run, also when no month is new.
- The raw files stay in `data/raw/` after processing, about 5 GB for 27 months.
- `combine` fails when no month folder is complete; it only happens if the remote list is empty.
- The spot check script runs on demand, not in the gate.
- `pipeline.coords` is not run by tests or the gate (it needs the network); only its parser is tested, on canned JSON.
