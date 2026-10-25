# Pattern analysis

## 1 Overview

Shows when and where rail traffic is unreliable: a weekday × hour heatmap of arrival punctuality, filterable by train category, station and month range. Cancellations are reported separately from delays. This is the v0.1 core (SPEC F2).

## 2 Spec

Metrics per heatmap cell (weekday 0 = Monday, hour 0–23):

- median and P90 arrival delay in minutes (non-cancelled stops only)
- share of arrivals under 6 minutes ("pünktlich", DB definition)
- cancellation rate (separate from the delay metrics)
- n, the number of stops including cancellations, and the covered period (`von`, `bis`)

Filters: train category (`alle`, `regional`, `fern`), station by EVA, month range (`YYYY-MM`, inclusive).

Current API:

- `GET /heatmap` – query parameters: `gattung` (`alle` default, `regional`, `fern`), `eva` (station EVA, digits only, optional), `von` and `bis` (month `YYYY-MM`, optional, inclusive). Returns `von`, `bis`, `n`, `cells` (`weekday`, `hour`, `n`, `ausfallquote`, `median`, `p90`, `puenktlich`) and `tage` (the same statistics per weekday over all hours, from the summed histogram). An empty selection returns `n = 0`, no cells and no days.
- `GET /stationen` – query parameters: `q` (case-insensitive substring of the name), `limit` (1–100, default 20). Returns `eva` and `name`, sorted by name.
- `GET /stationen/{eva}` – one station as `eva` and `name`; 404 for an unknown EVA.
- `GET /datenstand` – `monate` (months present in the aggregate) and `bahnhoefe` (number of named stations).
- Invalid input returns 422: `limit` outside 1–100, `von` or `bis` not matching `YYYY-MM`, `eva` not all ASCII digits, `gattung` outside the three values.

The UI on top of this is described in [app-shell.md](app-shell.md).

Planned per roadmap: rankings (M3), time series (M3), map and station detail (M2).

## 3 Decisions

- **Percentiles come from the histogram**: smallest bucket whose cumulative count reaches q × N. Reason: aggregates store delay histograms in whole minutes, so cells can be merged under any filter.
- **Cancelled stops count in n and the cancellation rate, not in the delay distribution.** Reason: a cancellation is not a 0-minute delay (AC-7).
- **Stations are filtered by EVA, never by name.** Reason: names are not unique.
- **Every metric carries n and period.** Reason: AC-8, and uncertainty must be visible.
- **Minimum n for rankings is 30** (assumption; the spec names only n < 15 for connections). Reason: avoid noisy rankings.
- **Weekday totals are computed in the API from the merged histogram**, not as a mean of cell values. Reason: percentiles and medians cannot be averaged.
- **Input is validated at the API.** Reason: a malformed `von` or a negative `limit` silently returned wrong data. `eva` accepts ASCII digits only, so a station name is never a key.

## 4 Architecture and data keys

- `backend/main.py` loads `data/aggregate.parquet` (override: `AGGREGATE_PATH`) and `data/stations.parquet` (override: `STATIONS_PATH`) with Polars on each request.
- Aggregate keys: `weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`, `n` (see [pipeline.md](pipeline.md)).
- OpenAPI schema is exported to `backend/openapi.json` (`uv run python scripts/export_openapi.py`); the TypeScript client is generated from it, and the gate fails when either is stale.
- CORS allows the local dev origin `http://localhost:5173`, GET only.

## 5 Milestones

- [x] M1 – Heatmap view in the app shell on the existing aggregate, with filter bar. Re-check: `uv run pytest -q` passes (`tests/api/test_heatmap_api.py`: `test_period_filter_changes_n`, `test_regional_has_no_fern`, `test_stats_from_histogram`, `test_weekday_totals_from_histogram`, `test_invalid_input_is_422`, `test_station_by_eva`, `test_datenstand`; `tests/core`: statistics from histogram equal direct computation) and `npm.cmd --prefix frontend run test:e2e` passes (`frontend/e2e/heatmap.spec.ts`).
- [ ] M3 – Rankings (lines, stations, minimum n) and time series by month. Re-check: ranking contains no entries below the minimum n; order verified on a mini dataset in `tests/core`.

## 6 Platform checks

- API and UI start locally on Windows 11 (`uv run uvicorn backend.main:app --port 8000`, `npm.cmd --prefix frontend run dev`).
- Heatmap for nationwide, all categories, 3 months loads in under 3 s warm (AC-5), measured later with multi-month data.

## 7 Open decisions

- Final minimum n for rankings (30 now, design proposes a user-set minimum sample).
- Line-level aggregation: lines are null for long-distance trains; define the key.
- Treatment of timetable-period changes in time series (SPEC O6).

## 8 Known shortcuts

- Data covers a single month, so month filters are not yet meaningful.
- Parquet is re-read on every request; fine for one month, to be reconsidered with more data.
- Only the heatmap and station endpoints exist; no rankings, time series or map.
- The `/stationen` list omits the 6 EVAs that have no name in the source.
