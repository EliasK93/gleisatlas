# Pattern analysis

## 1 Overview

Shows when and where rail traffic is unreliable: a weekday × hour heatmap of arrival punctuality, filterable by train category, station and month range. Cancellations are reported separately from delays. This is the v0.1 core (SPEC F2).

## 2 Spec

Metrics per heatmap cell (weekday 0 = Monday, hour 0–23):

- median and P90 arrival delay in minutes (non-cancelled stops only)
- share of arrivals under 6 minutes ("pünktlich", DB definition)
- cancellation rate (separate from the delay metrics)
- n, the number of stops including cancellations, and the covered period (`von`, `bis`)

Filters: train category (`alle`, `regional`, `fern`), station by EVA, month range (`YYYY-MM`, inclusive). Where `von` is omitted, the heatmap, the map and the station statistics start at `vollabdeckung_ab`, the first month with full station coverage (see §3); `bis` defaults to the last month. A `bis` before `vollabdeckung_ab` switches that default off: the selection then starts at the first month.

Current API:

- `GET /heatmap` – query parameters: `gattung` (`alle` default, `regional`, `fern`), `eva` (station EVA, digits only, optional), `von` and `bis` (month `YYYY-MM`, optional, inclusive). Returns `von`, `bis`, `n`, `cells` (`weekday`, `hour`, `n`, `ausfallquote`, `median`, `p90`, `puenktlich`) and `tage` (the same statistics per weekday over all hours, from the summed histogram). An empty selection returns `n = 0`, no cells and no days.
- `GET /karte` – query parameters: `gattung`, `von`, `bis` as for the heatmap. Returns `von`, `bis`, `n` (all stops in the selection), `ohne_koordinaten` (named stations with stops in the selection but no coordinates) and `stationen` (`eva`, `name`, `lat`, `lon` and the four statistics of the heatmap cell). Only stations with coordinates are listed. The response is gzip-compressed and cached per process.
- `GET /stationen` – query parameters: `q` (case-insensitive substring of the name), `limit` (1–100, default 20). Returns `eva`, `name`, `land` (federal state, nullable) and `n` (stops over the data set). Name-prefix matches come first, then the busiest station, then the name.
- `GET /stationen/{eva}` – one station as `Station` (`eva`, `name`, `land`, `n`); 404 for an unknown EVA.
- `GET /stationen/{eva}/statistik` – query parameters: `gattung`, `von`, `bis`. Returns the `station`, `von`, `bis`, `n`, `gesamt` (the four statistics), `verteilung` (non-cancelled stops in 7 delay bins, edges in whole minutes: < 1, [1, 3), [3, 6), [6, 10), [10, 20), [20, 30), ≥ 30), `ausgefallen` (cancelled stops; `verteilung` plus `ausgefallen` sums to `n`) and `gruppen` (the statistics per `regional` and `fern`, only groups with stops). An empty selection returns `n = 0`, `gesamt` null and no bins; 404 for an unknown EVA.
- `GET /datenstand` – `monate` (months in `data/monate.parquet`), `bahnhoefe` (number of named stations), `vollabdeckung_ab` (`YYYY-MM`, the first month with at least half as many stations as the largest month; empty if there are no months), `fehlende_stunden` (month → hours missing in the source, only months with gaps) and `fahrplanwechsel` (ISO dates of the timetable changes inside the data range). `monate`, `vollabdeckung_ab`, `fehlende_stunden` and `fahrplanwechsel` all come from `data/monate.parquet` (override: `MONATE_PATH`).
- `GET /rankings` – query parameters: `typ` (required: `linien` or `bahnhoefe`), `metrik` (`puenktlich` default, `median`, `p90`, `ausfallquote`), `min_n` (integer from 15, default 500), `gattung`, `von`, `bis` (as for the heatmap). Returns `typ`, `metrik`, `min_n`, `von`, `bis`, `anzahl` (entries that reach `min_n`, counted in arrived stops for the delay metrics and in all stops for `ausfallquote`, and have a value for the metric), `schlechteste` (worst first, at most 10) and `beste` (best first, at most 10). An entry is `id` (the EVA of a station, the `linie` key of a line), `name` (station name or line label), `typ` (train type of a line, null for a station) and the four statistics. Higher is better for `puenktlich`, lower for the other three; ties go to the larger n, then the name. An empty selection returns `von` and `bis` as empty strings, `anzahl = 0` and two empty lists.
- `GET /stationen/{eva}/linien` – query parameters: `gattung`, `von`, `bis`. Returns every line that stops at the station in the selection, as `linie`, `name` (label), `typ` and the four statistics, worst punctuality first, then the larger n, then the name. Lines with too little data (the UI's rule: fewer than 15 stops or fewer than 15 arrived stops) come after all others, and lines without a value come last within each part. No minimum n. 404 for an unknown EVA.
- `GET /zeitverlauf` – query parameters: `eva` (digits only) or `linie` (a line key), at most one of them, and `gattung`. Without `eva` and `linie` the series is nationwide. There is no `von` or `bis`: the series always covers every month of `/datenstand`. Returns `titel` (station name or line label, null nationwide) and `monate`, one row per month in ascending order: `monat` (`YYYY-MM`), `n` and the four statistics. A month without stops in the selection has `n = 0` and all statistics null. 404 for an unknown `eva` or `linie`; 422 when both are given.
- Invalid input returns 422: `limit` outside 1–100, `von` or `bis` not matching `YYYY-MM`, `eva` not all ASCII digits, `gattung` outside the three values, `typ` or `metrik` outside their values, `min_n` below 15, `eva` together with `linie`.
- Responses are gzip-compressed (`GZipMiddleware`).

The UI on top of this is described in [app-shell.md](app-shell.md) and [map.md](map.md).

## 3 Decisions

- **Percentiles come from the histogram**: smallest bucket whose cumulative count reaches q × N. Reason: aggregates store delay histograms in whole minutes, so cells can be merged under any filter.
- **Cancelled stops count in n and the cancellation rate, not in the delay distribution.** Reason: a cancellation is not a 0-minute delay (AC-7).
- **Stations are filtered by EVA, never by name.** Reason: names are not unique.
- **Every metric carries n and period.** Reason: AC-8, and uncertainty must be visible.
- **The default period starts at full coverage.** Without `von`, views start at `vollabdeckung_ab` (2025-11 on the real data), not at the first month. Reason: until 2025-10 the source covers only about 135 stations, so "nationwide" would silently mean the big hubs and every station panel would mix two different populations. The picker can still reach back to 2024-07.
- **Minimum n for rankings is user-set: 100, 500, 1,000 or 5,000 stops, default 500** (design.md §2.4). Reason: a line or station needs far more than 30 stops for a stable P90 over a period of months, and the right bar depends on the question; this replaces the earlier assumption of 30. The cell rule of the heatmap (hatched below 15 stops) is separate. The UI offers the four values; the API accepts any `min_n` from 15, the same floor as the heatmap's hatching.
- **Stations and lines are ranked by the same function** (`core/rankings.py`, `rank`), and the station statistics come from one cached function shared with `/karte`. Reason: one ordering rule, and the first rankings request after a map request needs no second pass over the aggregate.
- **`min_n` counts arrived stops for the delay metrics (`puenktlich`, `median`, `p90`) and all stops for `ausfallquote`.** Reason: a median from a handful of arrived stops is as unstable as one from a handful of stops, and the UI shows "–" for it; a station with many stops but few arrivals would otherwise lead a ranking with a value the table hides. `anzahl` counts the entries that pass the same rule.
- **The line statistics are computed for every line, once per selection.** Reason: `rank()` already drops entries below `min_n`, so the line cache key has no `min_n` and dragging the threshold costs nothing after the first call (0.57 s cold for the default period).
- **`/zeitverlauf` always returns every month and marks empty months as holes.** A month without stops in the selection has `n = 0` and null statistics instead of being left out. Reason: the chart keeps one slot per month, so a gap shows as a gap and not as a shortened axis; the period picker does not apply to a series.
- **`Monat.ausfallquote` is nullable, unlike `Stats.ausfallquote`.** Reason: a month with `n = 0` has no cancellation rate, and 0 would claim that nothing was cancelled. For that reason `Monat` is its own model and does not inherit `Stats`; the JSON is `Stats` plus `monat`.
- **Line statistics on the station page and in the rankings have no minimum n in the API.** The station endpoint lists every line and the page shows the little-data rule per row; only `/rankings` applies a threshold. Reason: a station's line table is a lookup, a ranking is a claim.
- **Timetable changes are marked, not split.** The API names the mid-December dates and trains keep one key across years. Reason: product owner's choice (SPEC O6); a split per period comes with the planner. See [pipeline.md](pipeline.md) §3.
- **A line is its name split into networks** (id `"{name}:{lowest EVA}"`). Reason: "S1" exists in many federal states. See [pipeline.md](pipeline.md) §3.
- **Weekday totals are computed in the API from the merged histogram**, not as a mean of cell values. Reason: percentiles and medians cannot be averaged.
- **Input is validated at the API.** Reason: a malformed `von` or a negative `limit` silently returned wrong data. `eva` accepts ASCII digits only, so a station name is never a key.

## 4 Architecture and data keys

- `backend/main.py` loads `data/aggregate.parquet` (override: `AGGREGATE_PATH`), `data/stations.parquet` (override: `STATIONS_PATH`), `data/monate.parquet` (override: `MONATE_PATH`), `data/lines.parquet` (override: `LINES_PATH`) and `data/linien.parquet` (override: `LINIEN_PATH`) with Polars on each request. `monate.parquet` is required: without it every request without `von`, and `/datenstand`, fails. `lines.parquet` and `linien.parquet` are required by `/rankings?typ=linien`, `/stationen/{eva}/linien` and `/zeitverlauf?linie=`. `pipeline.update` writes all of them; `/karte` and the rankings keep their results per process (see Known shortcuts).
- Aggregate keys: `weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`, `n` (see [pipeline.md](pipeline.md)). Line keys: `lines.parquet` has `linie`, `eva`, `gruppe`, `month`, `bucket`, `n` (no weekday or hour), `linien.parquet` has `linie`, `name`, `label`, `typ`. The line statistics are therefore per month and category, not per cell, and the selection chain (`gattung`, `eva`, `von`, `bis`) is the one of the heatmap.
- `station_stats_for` (statistics per EVA for a selection) feeds `/karte` and `/rankings?typ=bahnhoefe`; `line_stats_for` feeds `/rankings?typ=linien`; `line_entries` also feeds `/stationen/{eva}/linien`. `/zeitverlauf` groups once by month and bucket and runs the statistics per month.
- OpenAPI schema is exported to `backend/openapi.json` (`uv run python scripts/export_openapi.py`); the TypeScript client is generated from it, and the gate fails when either is stale.
- CORS allows the local dev origin `http://localhost:5173`, GET only.

## 5 Milestones

- [x] M1 – Heatmap view in the app shell on the existing aggregate, with filter bar. Re-check: `uv run pytest -q` passes (`tests/api/test_heatmap_api.py`: `test_period_filter_changes_n`, `test_regional_has_no_fern`, `test_stats_from_histogram`, `test_weekday_totals_from_histogram`, `test_invalid_input_is_422`, `test_station_by_eva`, `test_datenstand`; `tests/core`: statistics from histogram equal direct computation) and `npm.cmd --prefix frontend run test:e2e` passes (`frontend/e2e/heatmap.spec.ts`).
- [x] M3 – Data status and default period. Re-check: `uv run pytest -q`, `tests/api/test_datenstand_api.py` (`test_datenstand_carries_coverage_gaps_and_timetable_changes`, `test_timetable_change_inside_the_data_range`, `test_default_period_starts_at_full_coverage`, `test_default_period_applies_to_station_statistics`, `test_default_period_applies_to_the_map`).
- [x] M3 – Rankings of lines and stations with a minimum n. Re-check: `uv run pytest -q`, `tests/api/test_rankings_api.py` (`test_min_n_leaves_entries_out`, `test_order_follows_the_metric_direction`, `test_entries_without_a_value_are_left_out`, `test_at_most_ten_entries`, `test_lines_carry_their_label_and_train_type`, `test_lines_follow_gattung_and_period`, `test_default_period_is_the_heatmaps`, `test_empty_selection`, `test_invalid_input_is_422`, `test_pipeline_built_mini_lines`); the order itself in `tests/core/test_rankings.py` (`test_lower_is_better_for_delay_metrics`, `test_higher_is_better_for_punctual_share`, `test_min_n_and_none_are_excluded`, `test_ties_go_to_larger_n_then_name`, `test_k_cuts_both_lists`).
- [x] M3 – Lines at a station. Re-check: `tests/api/test_rankings_api.py` (`test_station_lines_worst_first`, `test_station_lines_follow_gattung_and_period`, `test_station_lines_without_a_value_come_last`, `test_station_lines_unknown_station_is_404`).
- [x] M3 – Time series by month. Re-check: `tests/api/test_zeitverlauf_api.py` (`test_nationwide_sums_match_the_heatmap_per_month`, `test_a_month_carries_the_statistics`, `test_station_names_the_station_and_keeps_months_without_stops`, `test_line_names_the_line_label`, `test_gattung_filters`, `test_unknown_station_or_line_is_404`, `test_station_and_line_together_is_422`, `test_invalid_input_is_422`).

## 6 Platform checks

- API and UI start locally on Windows 11 (`uv run uvicorn backend.main:app --port 8000`, `npm.cmd --prefix frontend run dev`).
- [ ] Heatmap for nationwide, all categories, 3 months loads in under 3 s warm (AC-5). To be measured.
- Measured on the 27 months of real data (in-process test client; cold is the first call, warm the second):

  | Call | Cold | Warm |
  |---|---|---|
  | `/rankings?typ=bahnhoefe` (5,402 stations) | 1.06 s | 0.02 s |
  | `/rankings?typ=linien` (min_n 500, 2,445 lines) | 0.57 s | 0.01 s |
  | `/stationen/08000207/linien` (Köln Hbf, 1,242 lines; not cached) | 0.08 s | 0.08 s |
  | `/zeitverlauf` nationwide | 0.34 s | 0.29 s |

  The cold station ranking includes the statistics `/karte` shares, so after a map request it is faster. To be repeated on the Azure container size chosen later.

## 7 Open decisions

None. The line key is decided in [pipeline.md](pipeline.md) §3, and the timetable change (SPEC O6) is marked only.

## 8 Known shortcuts

- Parquet is re-read on every request; to be reconsidered now that the aggregate covers 27 months.
- The lines at a station are not cached: the biggest station takes about 0.1 s. Add an `lru_cache` like the rankings have if the page calls it often.
- The time series follows one selection (nationwide, one station or one line). Comparing up to three series in one chart is not built.
- A line id is `{name}:{lowest EVA of its network}`. When a network gains a station with a lower EVA in a later month, its id changes, and a saved link to the old id returns 404. Accepted while the data only grows by whole months and a link is cheap to recreate from the rankings.
- The `/stationen` list omits the 6 EVAs that have no name in the source.
- `/karte`, the station statistics behind it and the station rankings, and the line statistics of the line rankings are each cached per process by selection and file modification time, at most 16 entries. The first `/karte` computation took about 2 s on 11 months (5k Pydantic models). Vectorise the statistics in Polars when more months make that slow.
