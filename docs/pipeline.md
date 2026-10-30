# Pipeline

## 1 Overview

Turns the monthly source files from `piebro/deutsche-bahn-data` into compact tables: a delay histogram (weekday × hour × category × station × month), a station table with names, stop counts and coordinates, line histograms per month, a delay histogram per day, a line table, a month table with coverage figures and a day table with the hours missing per day. Each month is processed once into its own folder; a combine step then writes the files the API reads. Raw data stays local.

## 2 Spec

Commands (from the repo root):

- `uv run python -m pipeline.coords` runs one SPARQL query against Wikidata and writes `data/coords.parquet`. Needs network access; run it once and again to refresh.
- `uv run python -m pipeline.update` is the one command for the data. It lists the monthly files on HuggingFace, downloads and processes every month whose folder `data/months/YYYY-MM/` is missing or incomplete, and then combines all months. A second run downloads nothing (AC-1). It reads `data/coords.parquet` and aborts before fetching anything if the file is missing, so run `pipeline.coords` first.
- `uv run python -m pipeline.download YYYY-MM` downloads one monthly file into `data/raw/`; `pipeline.update` calls it, you rarely need it directly.
- `uv run python scripts/check_sample.py <source.parquet>` compares computed arrival delays against raw rows (spot check for AC-4, outside the gate).

After a change to the per-month logic (cleaning, line names, coverage rule) the existing month folders are stale: delete `data/months/` and run `pipeline.update` again. The skip check only looks for the folder, not for the version of the code that wrote it.

**Source schema.** The source must carry exactly the 23 known columns (`COLUMNS` in `pipeline/aggregate.py`). A missing or a new column aborts the run with a message that names it (AC-2).

**Month folder** `data/months/YYYY-MM/`, written to a temporary sibling and renamed only when all eight files exist, so a crash never leaves a half-complete month (a folder from before the day tables lacks two of them and is processed again by the next run):

| File | Keys |
|---|---|
| `aggregate.parquet` | `weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`, `n` |
| `lines.parquet` | `name`, `train_type`, `eva`, `gruppe`, `month`, `bucket`, `n` |
| `ends.parquet` | `name`, `eva`, `dest`, `n` (arrival stops per line name, station and end station) |
| `networks.parquet` | `name`, `eva`, `net` (the line networks within the month) |
| `stations.parquet` | `eva`, `name`, `n` |
| `meta.parquet` | `month`, `missing_hours`, `stations` |
| `days.parquet` | `day`, `gruppe`, `eva`, `bucket`, `n` (the delay histogram per planned arrival day) |
| `day_gaps.parquet` | `day`, `missing_hours`: one row per calendar day of the month, days without a gap included |

**Combined files** in `data/`, the only ones the API reads:

| File | Content |
|---|---|
| `aggregate.parquet` | All months of the month aggregates, sorted. One row per (`weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`) with count `n`. `weekday` 0 = Monday, `hour` from the planned arrival, `gruppe` is `fern` or `regional`, `bucket` is the delay in whole minutes, NULL = cancelled stop. |
| `stations.parquet` | `eva`, `name` (from the newest month), `n` (summed), `lat`, `lon`, `land`. |
| `lines.parquet` | `linie`, `eva`, `gruppe`, `month`, `bucket`, `n`: the delay histogram per line and station. |
| `linien.parquet` | `linie`, `name`, `label`, `typ`: one row per line. |
| `monate.parquet` | `month`, `missing_hours`, `stations`: one row per month. The API requires it. |
| `days.parquet` | `day`, `gruppe`, `eva`, `bucket`, `n`: the month files summed per key (an edge day can sit in two of them), sorted by day, EVA, group and bucket, in row groups of `DAYS_ROW_GROUP` = 50,000 rows (about one day), so the API's one-day filter skips the others ([day-history.md](day-history.md) §3). |
| `tage.parquet` | `day`, `missing_hours`: every calendar day from the first to the last month, sorted. |

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
  - **The train type goes in front of a bare number, for every train type** ("57" with RE becomes "RE57", "35" with FLX becomes "FLX35"), and letters and digits lose a space between them ("RE 3" becomes "RE3"). Reason: until the December 2025 timetable change the source gives regional lines as bare numbers and from then on prefixed. Without the rule one line splits in two (`57` and `RE57`), and S1, RE1 and IRE1 sharing a station merge into one line with mixed statistics.
  - Within one name, stations that share a `train_line_ride_id` belong to one network, transitively. A ride id is a trip pattern that repeats daily; 817 ride ids carry more than one name, so (name, ride id) is the unit, not the ride id alone. The networks are connected components, found by min-label propagation in `core/lines.py`.
  - Each month gets its own networks; the combine step joins them across months, with (month, network) standing in for a trip.
  - **Id** `"{name}:{lowest EVA of the network}"`, with the name as built above. It stays the same as months are added, unless a network gains a station with a lower EVA or merges with another one; a saved link to a line can then point at nothing.
  - **Label** names the line's two most frequent end stations by stops, e.g. "RE57 Dortmund Hbf – Warburg (Westf)"; ties go to the lower name. A train-number line ("ICE 679", one direction) reads "ICE 679 → Kassel-Wilhelmshöhe". With one end station the label is the name and that end, with none the name alone. Reason: the name alone does not say where a line runs, and the same name in two networks (S1) must be told apart. **Typ** is the most frequent `train_type` of the line and serves as the badge.
  - **End stations** come from `final_destination_station`; `destination_expr` fixes the spelling ("Schwerte(Ruhr)" becomes "Schwerte (Ruhr)", "Langenhagen - Kaltenweide" becomes "Langenhagen-Kaltenweide"). Null or blank destinations are left out. Reason: the column has 4,647 spellings, and the fix leaves only 32 duplicate groups.
  - A network that only has stops without an arrival (no delay data) is not a line: `linien.parquet` lists only networks with stops, so no row has an empty label or typ. Most lines are single long-distance train numbers. Rankings filter by minimum sample.
- **Missing hours are recorded per month, not repaired.** The usual level of an hour of the day is the lowest, over the seven weekdays, of the median row count of that (weekday, hour) in the month. An hour counts as a gap when it has fewer than `GAP_SHARE` (half) of that level in `pipeline/aggregate.py`; an hour with no rows at all counts too. Reason: the source is quiet at night and on Sunday mornings, so a fixed threshold, or the median over all days, would flag normal hours, while a relative rule also catches a half-empty hour. The hours are counted against the real local month, so the skipped hour of the March clock change is not a gap and the doubled October hour is not one either. The months after the station jump (2025-11) stay flagged for the days before 2025-11-02. Over the 27 months this flags 50 h in 2025-11, 4–12 h in 2024-11 and in six months between 2026-02 and 2026-08 (2026-07: 8 h), 1 h in 2025-06 and 2025-07, and none elsewhere. SPEC §4.1 names 102 h for July 2026; the way it counts is not known, so the figures can differ.
- **Missing hours are also counted per day** (`day_gaps`), with the same rule and the same hour counts (`_hour_counts`) as the month figure, so the days of a month add up to its `missing_hours`. Reason: the daily series and the day map must know which days are incomplete. The day is the calendar day of the poll time, while the delay histogram's day is the planned arrival (see [day-history.md](day-history.md) §3).
- **Timetable changes are marked, not split.** `core.periods.timetable_changes` returns the Sunday after the second Saturday of December (2024-12-15, 2025-12-14, 2026-12-13). The API lists those inside the data range and trains keep one key across years. Reason: product owner's choice (SPEC O6); splitting statistics per timetable period comes with the planner, where train numbers matter.
- **Full coverage starts where the station count jumps.** `core.periods.full_coverage_start` returns the first month with at least half as many stations as the largest month. The source has about 135 stations per month until 2025-10 and about 5,2xx from 2025-11, so it returns 2025-11. Reason: views default to the period where "nationwide" is true.
- **Output size over 27 months:** `aggregate.parquet` 60.8 MB, `lines.parquet` 10.9 MB, `linien.parquet` 0.2 MB, `stations.parquet` 0.1 MB, `monate.parquet` under 0.1 MB. The per-day histogram adds about 36 MB over 27 months (measured on 2025-06 and 2026-09); the real file is 36.7 MB, 0.3 % more with the row groups ([day-history.md](day-history.md) §5). The 2 GB limit of AC-3 is far away, so no watchlist fallback is needed.

## 4 Architecture and data keys

- `pipeline/aggregate.py`: per-month tables from one source file, read lazily with Polars. `check_schema` validates, `clean` applies the cleaning, and `aggregate`, `lines`, `ends`, `month_networks`, `stations`, `meta`, `days` and `day_gaps` build the eight month tables. `with_coords` and `coverage_report` serve the combine step.
- `pipeline/update.py`: `update` walks the remote months and calls `process` for each incomplete one, then `combine`. The downloader and the list of remote months are passed in, so tests run it with a fake that counts its calls. `combine` writes the seven combined files; `MONTH_FILES` lists the month tables, so a month folder without one of them counts as incomplete.
- `core/lines.py`, `core/periods.py`, `core/delay.py`, `core/holidays.py`: the pure parts (line names, end-station spelling and networks, timetable changes and coverage start, the delay and plausibility rules, the nationwide public holidays: fixed dates plus the Easter-based ones, no library; regional holidays are not included).
- `data/coords.parquet`: `ibnr`, `lat`, `lon`, `land`, one row per IBNR for the whole of Wikidata (not only Germany). The join strips the leading zero of our EVA (`08000207` to `8000207`) with `core.stations.ibnr_expr`. An EVA without a match takes the coordinates of the one located station with exactly the same name (secondary EVAs such as S-Bahn platforms). Details and the source decision: [adr/0001-station-coordinates.md](adr/0001-station-coordinates.md).
- `data/stations.parquet`: `n` is all stops of the EVA in the source, arrival stops with cancelled ones included; it ranks search results and sizes map dots. `lat`, `lon` and `land` are NULL where Wikidata has no match or no state.
- Coverage report, printed by the combine step: named stations with coordinates (number and share), the share of stops that belong to them, and the unmatched named stations with the most stops. Over 27 months: 5,418 of 5,419 named stations (100.0 %, as the report rounds it). Unmatched: Trebitz (b Könnern), one stop, no Wikidata item.
- The source also contains `xml_station_name`, `id`, `is_additional_stop`, the departure columns and more; most are not used yet.
- Time zone: Europe/Berlin, as in the source; times are not converted.

## 5 Milestones

- [x] M0 – Download command and one-month aggregate run through the gate. Re-check: `tests/core` (delay semantics, NULL bucket) and `tests/pipeline` (incl. schema abort) pass.
- [x] M3 – Multi-month pipeline: incremental download, strict schema, cleaning, line networks, coverage, timetable changes marked. Re-check: `uv run pytest -q` passes, in particular
  - AC-1: `tests/pipeline/test_update.py` (`test_second_run_fetches_nothing_and_still_combines`, `test_month_missing_a_file_is_reprocessed`, `test_leftover_temporary_folder_is_not_complete`, `test_update_aborts_without_coords_before_fetching`)
  - AC-2: `tests/pipeline/test_aggregate.py` (`test_schema_abort`, `test_schema_abort_names_a_new_column`)
  - cleaning and missing hours: `tests/pipeline/test_aggregate.py` (`test_cleaning_drops_duplicates_and_implausible_delays`, `test_a_plausible_copy_survives_an_implausible_first_one`, `test_stops_without_arrival_are_never_duplicates`, `test_meta_counts_thin_hours_as_missing`, `test_meta_compares_an_hour_with_its_usual_level_on_that_weekday`, `test_meta_doubled_october_hour_is_not_missing`, `test_meta_counts_missing_hours_against_the_real_month`), `tests/pipeline/test_update.py` (`test_cleaning_counts_are_printed`, `test_monate`) and `tests/core/test_core.py` (`test_arrival_delay_rules`, `test_plausible_bounds_are_inclusive_and_missing_change_is_plausible`)
  - combine: `tests/pipeline/test_update.py` (`test_combine_stations_newest_name_and_summed_n`, `test_combine_station_keeps_the_newest_name_that_is_not_null`, `test_combine_lines_networks_and_labels`, `test_lines_sum_back_to_the_aggregate`)
  - line networks: `tests/core/test_lines.py` (`test_two_networks_without_shared_station_stay_apart`, `test_cross_month_join_via_month_and_net`, `test_line_ids`, `test_line_table_leaves_out_networks_without_stops`)
  - timetable changes and coverage: `tests/core/test_periods.py` (`test_timetable_changes`, `test_full_coverage_start`)
  - the real run: `uv run python -m pipeline.update` over all 27 months, then again; the second run skips every month and downloads nothing.
- [x] Line names – one line per train type and network, labelled by its end stations. Re-check: `uv run pytest -q`, in particular
  - `tests/core/test_lines.py` (`test_line_name_puts_the_train_type_before_a_bare_number`, `test_destination_spelling_is_unified`, `test_line_table_labels_name_the_two_most_frequent_ends`, `test_line_table_train_number_names_show_an_arrow_to_the_top_end`)
  - `tests/pipeline/test_update.py` (`test_bare_number_and_prefixed_name_become_one_line` for "57" in one month and "RE57" in the next, `test_bare_numbers_of_different_train_types_stay_apart` for S1 and RE1 at a shared station, `test_blank_destination_is_not_an_end`, `test_combine_lines_networks_and_labels`)
  - the real run over all 27 months, before and after: stations showing a line name more than once 4,118 of 5,430 and 0; regional stops on bare-number names 27.7 % and 0; Winterberg (Westf) lists RE57 twice and once; lines 19,379 and 18,971.

- [x] Day tables – a delay histogram and the missing hours per day. Re-check: `uv run pytest -q`, in particular
  - `tests/core/test_holidays.py` (`test_easter_2025_and_its_neighbours`, `test_easter_2026_moves_the_other_holidays`, `test_nine_fixed_and_movable_days`)
  - `tests/pipeline/test_aggregate.py` (`test_days_sum_back_to_the_aggregate`, `test_days_take_the_planned_arrival_and_keep_cancelled_null`, `test_days_are_sorted_with_nulls_last`, `test_day_gaps_has_one_row_per_day_and_adds_up_to_meta`, `test_day_gaps_follow_the_real_clock_changes`)
  - `tests/pipeline/test_update.py` (`test_month_without_the_day_tables_is_reprocessed`, `test_days_sum_back_to_the_aggregate_and_tage_to_monate`, `test_an_edge_day_split_over_two_months_is_summed`)
  - the real run: `uv run python -m pipeline.update` over all 27 months writes `data/days.parquet` and `data/tage.parquet`.

## 6 Platform checks

- `uv`; paths use forward slashes in code and commands, so the commands run the same on Windows, macOS and Linux.
- The first run over 27 months took 8–14 min with the downloads already local; a second run only combines and took 53 s. Memory stays moderate because Polars scans lazily.
- **AC-4 spot check.** Six stops drawn at random from six different months (delays of 1, 1, 4, 9 and 13 min, and one cancelled stop), each on a unique key. For each, the delay was computed by hand from the raw timestamps (change minus plan in whole minutes, truncated toward zero; cancelled is no delay) and compared with `arrival_delay_expr`. Then the stop's cell (weekday, hour, group, EVA, month, bucket) was looked up in `data/months/YYYY-MM/aggregate.parquet` and recounted from the whole raw month with the cleaning rules written out again in plain Python. All six agree, in the delay and in the cell count:

  | Train | Station (EVA) | Planned arrival | Raw change | Raw delay | Computed delay | Cell count raw / file |
  |---|---|---|---|---|---|---|
  | S 1554 | Berlin-Friedenau (08089058) | 2025-12-22 09:04 | 09:05 | 1 min | 1 min | 41 / 41 |
  | S 8903 | München Ost (08000262) | 2025-09-26 20:04 | 20:13 | 9 min | 9 min | 8 / 8 |
  | S 41085 | Hamburg-Altona (08098553) | 2025-02-20 09:50 | 09:54 | 4 min | 4 min | 19 / 19 |
  | NWB 83437 | Schierbrok (08005343) | 2026-03-02 23:37 | 23:50 | 13 min | 13 min | 1 / 1 |
  | S 7088 | Berlin-Lichtenberg (08089182) | 2025-06-09 12:06 | 12:07 | 1 min | 1 min | 43 / 43 |
  | RE 10207 | Dülmen (08000083) | 2026-08-02 08:19 | 09:19 | cancelled | NULL bucket | 1 / 1 |

  The cell is the finest granularity the file has, so a count match shows the stop sits in the right bucket and nothing was dropped or doubled. The throwaway script is not in the repo; `scripts/check_sample.py` is the repeatable version of the delay comparison.

## 7 Open decisions

None.

## 8 Known shortcuts

- The skip check looks only at the month folder: a month file that HuggingFace replaces later is not fetched again, and month folders carry no version. Changing the per-month logic needs `data/months/` deleted by hand (see §2).
- Downloads use no pinned dataset `revision`. If the upstream dataset re-uploads a month, a newly fetched month and the older processed ones can come from different upstream states without notice. Revisit when upstream corrections matter: record the dataset commit in `meta` and reprocess the months whose commit differs.
- The combine step rewrites every combined file on every run, also when no month is new.
- The raw files stay in `data/raw/` after processing, about 5 GB for 27 months.
- `combine` fails when no month folder is complete; it only happens if the remote list is empty.
- The spot check script runs on demand, not in the gate.
- `pipeline.coords` is not run by tests or the gate (it needs the network); only its parser is tested, on canned JSON.
- The end-station spelling fix is a regex. Variants such as "Bahnhof, Arnsberg" stay separate; map destinations to station EVAs if they show in labels.
- The train type comes from `train_type` before December 2025 and from `line_number` after. A line the source typed differently before the change (RB68 then, RE68 now; IRE1 then, ARV1 now) stays a separate line that ends in 2025-11. Over 27 months that is 77 lines and 0.045 % of stops; revisit if one shows up in the rankings.
- A line is shown as a train-number line (label with "→") when its name matches `^\S+ \d+$`. A source line number with a space before the digits would match too; 2 such labels exist in the real data.
