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
- Invalid input returns 422: `limit` outside 1–100, `von` or `bis` not matching `YYYY-MM`, `eva` not all ASCII digits, `gattung` outside the three values.
- Responses are gzip-compressed (`GZipMiddleware`).

The UI on top of this is described in [app-shell.md](app-shell.md) and [map.md](map.md).

Planned per roadmap: rankings and time series (M3).

## 3 Decisions

- **Percentiles come from the histogram**: smallest bucket whose cumulative count reaches q × N. Reason: aggregates store delay histograms in whole minutes, so cells can be merged under any filter.
- **Cancelled stops count in n and the cancellation rate, not in the delay distribution.** Reason: a cancellation is not a 0-minute delay (AC-7).
- **Stations are filtered by EVA, never by name.** Reason: names are not unique.
- **Every metric carries n and period.** Reason: AC-8, and uncertainty must be visible.
- **The default period starts at full coverage.** Without `von`, views start at `vollabdeckung_ab` (2025-11 on the real data), not at the first month. Reason: until 2025-10 the source covers only about 135 stations, so "nationwide" would silently mean the big hubs and every station panel would mix two different populations. The picker can still reach back to 2024-07.
- **Minimum n for rankings is user-set: 100, 500, 1,000 or 5,000 stops, default 500** (design.md §2.4). Reason: a line or station needs far more than 30 stops for a stable P90 over a period of months, and the right bar depends on the question; this replaces the earlier assumption of 30. The cell rule of the heatmap (hatched below 15 stops) is separate.
- **Timetable changes are marked, not split.** The API names the mid-December dates and trains keep one key across years. Reason: product owner's choice (SPEC O6); a split per period comes with the planner. See [pipeline.md](pipeline.md) §3.
- **A line is its name split into networks** (id `"{name}:{lowest EVA}"`). Reason: "S1" exists in many federal states. See [pipeline.md](pipeline.md) §3.
- **Weekday totals are computed in the API from the merged histogram**, not as a mean of cell values. Reason: percentiles and medians cannot be averaged.
- **Input is validated at the API.** Reason: a malformed `von` or a negative `limit` silently returned wrong data. `eva` accepts ASCII digits only, so a station name is never a key.

## 4 Architecture and data keys

- `backend/main.py` loads `data/aggregate.parquet` (override: `AGGREGATE_PATH`), `data/stations.parquet` (override: `STATIONS_PATH`) and `data/monate.parquet` (override: `MONATE_PATH`) with Polars on each request. `monate.parquet` is required: without it every request without `von`, and `/datenstand`, fails. `pipeline.update` writes it; `/karte` keeps its result per process (see Known shortcuts).
- Aggregate keys: `weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`, `n` (see [pipeline.md](pipeline.md)).
- OpenAPI schema is exported to `backend/openapi.json` (`uv run python scripts/export_openapi.py`); the TypeScript client is generated from it, and the gate fails when either is stale.
- CORS allows the local dev origin `http://localhost:5173`, GET only.

## 5 Milestones

- [x] M1 – Heatmap view in the app shell on the existing aggregate, with filter bar. Re-check: `uv run pytest -q` passes (`tests/api/test_heatmap_api.py`: `test_period_filter_changes_n`, `test_regional_has_no_fern`, `test_stats_from_histogram`, `test_weekday_totals_from_histogram`, `test_invalid_input_is_422`, `test_station_by_eva`, `test_datenstand`; `tests/core`: statistics from histogram equal direct computation) and `npm.cmd --prefix frontend run test:e2e` passes (`frontend/e2e/heatmap.spec.ts`).
- [x] M3 – Data status and default period. Re-check: `uv run pytest -q`, `tests/api/test_datenstand_api.py` (`test_datenstand_carries_coverage_gaps_and_timetable_changes`, `test_timetable_change_inside_the_data_range`, `test_default_period_starts_at_full_coverage`, `test_default_period_applies_to_station_statistics`, `test_default_period_applies_to_the_map`).
- [ ] M3 – Rankings (lines, stations, minimum n) and time series by month. Re-check: ranking contains no entries below the minimum n; order verified on a mini dataset in `tests/core`.

## 6 Platform checks

- API and UI start locally on Windows 11 (`uv run uvicorn backend.main:app --port 8000`, `npm.cmd --prefix frontend run dev`).
- [ ] Heatmap for nationwide, all categories, 3 months loads in under 3 s warm (AC-5). To be measured.

## 7 Open decisions

None. The line key is decided in [pipeline.md](pipeline.md) §3, and the timetable change (SPEC O6) is marked only.

## 8 Known shortcuts

- Parquet is re-read on every request; to be reconsidered now that the aggregate covers 27 months.
- Only the heatmap, map and station endpoints exist; no rankings or time series.
- The `/stationen` list omits the 6 EVAs that have no name in the source.
- `/karte` is cached per process by selection and file modification time, at most 16 entries; the first computation takes about 2 s on 11 months (5k Pydantic models); cached per selection. Vectorise the statistics in Polars when more months make that slow.
