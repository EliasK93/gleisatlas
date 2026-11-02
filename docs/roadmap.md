# Roadmap

MVP = **v0.1, local pattern analysis** (SPEC 3.1). Azure (v0.2), day-level history (v0.3) and the planner (v1.0) follow.

## M0 Foundation
- [x] Repo rules, gate and hooks (re-check: `uv run python scripts/gate.py`)
- [x] Clean code base (core / pipeline / backend) (re-check: `uv run pytest -q`)
- [x] App shell with design tokens, i18n and smoke test (re-check: `npm --prefix frontend run test:e2e`)

## M1 App shell per design
- [x] Sidebar, routing, filter bar (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/shell.spec.ts`; details in [app-shell.md](app-shell.md))
- [x] Heatmap view on the existing aggregate (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/heatmap.spec.ts`; `uv run pytest -q`, `test_weekday_totals_from_histogram`)
- [x] Inter font bundled (re-check: `npm --prefix frontend run test:e2e`, test "Inter is loaded")
- [x] API input validation (`limit`, `von`, `bis`, `eva`) (re-check: `uv run pytest -q`, `test_invalid_input_is_422`)
- [x] Single category rule (re-check: `uv run pytest -q`, `test_category_expr`)

## M2 Map start page
Details in [map.md](map.md).
- [x] Decide the station-coordinate source (ADR) (re-check: [adr/0001-station-coordinates.md](adr/0001-station-coordinates.md); `uv run pytest -q`, `test_join_coords_on_normalised_eva`, `test_update_aborts_without_coords_before_fetching`)
- [x] Map start page with station panel (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/map.spec.ts`; `uv run pytest -q`, `tests/api/test_map_api.py`)
- [x] Station detail page (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/station.spec.ts`; `uv run pytest -q`, `test_statistik_bins_and_cancelled_sum_to_n`, `test_delay_bins_edges_negatives_and_cancelled`)
- [x] Station search with Ctrl+K (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/search.spec.ts`; `uv run pytest -q`, `test_search_puts_prefix_matches_first_then_busiest`)

## M3 More data
- [x] Multi-month pipeline: incremental download, schema validation, cleaning, timetable changes marked (re-check: `uv run pytest -q`, `test_second_run_fetches_nothing_and_still_combines`, `test_schema_abort_names_a_new_column`, `test_cleaning_drops_duplicates_and_implausible_delays`, `test_timetable_changes`; details in [pipeline.md](pipeline.md))
- [x] Default period at full coverage and the Zeitraum picker (re-check: `uv run pytest -q`, `test_default_period_starts_at_full_coverage`; `npm --prefix frontend run test:e2e`, `frontend/e2e/period.spec.ts`)
- [x] Rankings of stations and lines, and the lines at a station (re-check: `uv run pytest -q`, `tests/api/test_rankings_api.py`, `tests/core/test_rankings.py`; `npm --prefix frontend run test:e2e`, `frontend/e2e/rankings.spec.ts` and the lines tests in `frontend/e2e/station.spec.ts`; details in [patterns.md](patterns.md), [app-shell.md](app-shell.md) and [map.md](map.md))
- [x] Time series by month, with the station sparkline (re-check: `uv run pytest -q`, `tests/api/test_zeitverlauf_api.py`; `npm --prefix frontend run test:e2e`, `frontend/e2e/zeitverlauf.spec.ts` and the sparkline tests in `frontend/e2e/station.spec.ts`)

## M4 Dark mode and English UI
Details in [theme-and-language.md](theme-and-language.md).
- [x] Dark theme on the existing tokens (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/theme.spec.ts`)
- [x] English message catalog and language switch (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/i18n.spec.ts`; `npm --prefix frontend run typecheck` for matching catalog keys)
- [x] Polars query cap: at most four queries run at once (re-check: `uv run pytest -q`, `tests/api/test_concurrency.py`; details in [patterns.md](patterns.md))

## Line names
- [x] One line per train type and network, named by its end stations. The source switched from bare numbers ("57") to prefixed names ("RE57") in December 2025, which split one line in two and merged S, RE and IRE lines with the same number (re-check: `uv run pytest -q`, `test_bare_number_and_prefixed_name_become_one_line`, `test_bare_numbers_of_different_train_types_stay_apart`, `test_line_table_labels_name_the_two_most_frequent_ends`; details in [pipeline.md](pipeline.md))

## M5 Azure deployment (v0.2)
Details and the runbook in [deployment.md](deployment.md).
- [x] API ready for Container Apps: CORS from the environment, request log, data download at start, image (re-check: `uv run pytest -q`, `tests/api/test_deploy_api.py`)
- [x] Bicep infrastructure (re-check: `az bicep build --file infra/main.bicep --stdout`, the gate line `bicep`)
- [x] Budget alert: a monthly budget on the resource group (amount is a deploy parameter) with alerts at 50 %, 90 % and forecast 100 % (re-check: the `budget` resource in `infra/main.bicep`; the alert e-mail is a platform check in [deployment.md](deployment.md) §6)
- [x] Impressum and privacy policy (server logs, map tiles loaded from OpenFreeMap) (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/legal.spec.ts`)
- [x] Content-Security-Policy and the other headers of the deployed site (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/csp.spec.ts`)
- [ ] The product owner runs the deployment commands (re-check: the platform checks in [deployment.md](deployment.md) §6). First deploy done; the budget alert e-mail, the first day's costs and the unfinished-requests query are left.
- [x] Local request log: with `LOG_FILE` set, the API also writes its request lines, timestamped, to a plain-text file, so they outlive the terminal window (re-check: `uv run pytest -q`, `test_the_log_file_gets_timestamped_lines_and_is_detached_again`)

## M6 Daily history and the day map (v0.3)
Details in [day-history.md](day-history.md). Built on a per-day delay histogram (about 36 MB over 27 months, measured on 2025-06 and 2026-09).
- [x] Daily time series with a 28-day trend as the default; the monthly view stays as a switch (re-check: `uv run pytest -q`, `tests/api/test_tagesverlauf_api.py`, `tests/core/test_holidays.py`; `npm --prefix frontend run test:e2e`, the "day view" tests in `frontend/e2e/zeitverlauf.spec.ts`)
- [x] Day map: the map coloured by one past day against each station's normal for that weekday (noise-aware classes), with a card for Germany showing its step and deviation (re-check: `uv run pytest -q`, `tests/core/test_normal.py`, `tests/api/test_tageskarte_api.py`; `npm --prefix frontend run test:e2e`, `frontend/e2e/lage.spec.ts`; the map is the page Live-Lage since the section below)

## M7 Fresh days (v0.3)
Details in [pipeline.md](pipeline.md) (raw days) and [day-history.md](day-history.md) (coverage); the live source is decided in [adr/0002-live-source.md](adr/0002-live-source.md).
- [x] Fresh days from raw data: the day map and the daily series reach the last complete day, about one to two days back; the month views stay on whole months (re-check: `uv run pytest -q`, `tests/pipeline/test_raw.py`, `tests/pipeline/test_update.py`, `test_complete_raw_days_after_the_last_month_reach_the_day_tables`, `test_combine_sums_a_raw_day_with_the_same_day_from_a_monthly_file`; on the real data `/datenstand` names the last complete day)
- [x] Data refresh of the deployed site: `scripts/azure.py data` uploads the data files to Blob (re-check: `uv run pytest -q`, `tests/scripts/test_azure.py`; the first refresh of the live site is a platform check in [day-history.md](day-history.md) §6)
- [x] Live source for "today": where the live state comes from, how it is collected and where it runs (re-check: [adr/0002-live-source.md](adr/0002-live-source.md) is accepted)
- [x] Day × hour histogram over all days, all four metrics, so any past day can be cut at any hour (re-check: `uv run pytest -q`, `test_day_hours_sum_over_the_hour_to_days`, `test_day_hours_sum_an_edge_day_and_add_up_to_days_of_the_large_stations`, `test_day_hours_take_the_raw_days_too`)
- [x] Collector for the large stations: `fchg` every 15 minutes and each `plan` slice once, writing `heute.parquet`; tested against a fake API with the raw days' XML, the run with the real key is a platform check (re-check: `uv run pytest -q`, `tests/pipeline/test_live.py`; [day-history.md](day-history.md) §6)
- [x] The other stations from the source's partial raw day, written by `pipeline.update` as `heute_rest.parquet` (re-check: `uv run pytest -q`, `tests/pipeline/test_rest.py`)
- [x] "Heute" in the day view: today so far against the same hours of the reference days, two freshness levels, the time of the data, a fallback to the last complete day (re-check: `uv run pytest -q`, `tests/api/test_heute_api.py`; `npm --prefix frontend run test:e2e`, the "today" tests in `frontend/e2e/lage.spec.ts`; details in [day-history.md](day-history.md))

## Move to a VPS
- [ ] The stable run on one VPS: the API image, the static frontend with the CSP and TLS, the data on disk, the collector's cron and key. Azure stays for tests and temporary deploys. "Today" on the deployed site waits for this.

## Live-Lage
Details in [day-history.md](day-history.md).
- [x] Live-Lage as its own page `/lage` for the 131 large stations: today by default, a Rückblick to any day through the date field and three chips (Heute, Gestern, Vorgestern), the Germany card with Fern and Regional, the Karte without a Tag switch and the Karte's Gattung and period kept across the page (re-check: `uv run pytest -q`, `tests/api/test_tageskarte_api.py`, `tests/api/test_heute_api.py`, `tests/core/test_periods.py`; `npm --prefix frontend run test:e2e`, `frontend/e2e/lage.spec.ts`)
- [x] Bundesländer level of Live-Lage: a card per state with its step colour and deviation, state areas from a Natural Earth file with a wash outside Germany and a hover tint, the same step and deviation on the Germany card, a click zooming to the state and its card (re-check: `uv run pytest -q`, `tests/core/test_core.py` (`test_land_codes_cover_the_16_states`), `tests/api/test_tageskarte_api.py` (`test_a_state_class_is_1_on_the_best_day_and_5_on_the_worst`), `tests/api/test_heute_api.py` (`test_today_a_state_counts_only_the_stations_that_report`); `npm --prefix frontend run test:e2e`, the block "the states" in `frontend/e2e/lage.spec.ts`)
- [x] A day-level Zeitraum on the Karte, up to the last complete day: two date fields, the default from the full-coverage month to the last complete day, `/karte` reading `days.parquet`; the other pages keep month selects and round days from the URL outward (re-check: `uv run pytest -q tests/api/test_map_api.py`, `test_karte_takes_a_day_range`, `test_karte_month_edges_mean_whole_months`, `test_karte_default_reaches_the_last_day`; `npm --prefix frontend run test:e2e`, `frontend/e2e/period.spec.ts`; details in [map.md](map.md))
- [ ] An hour slider for the Rückblick
- [ ] A larger station set than the 131 (decide first how the days before full coverage are handled and the selection rule, for example at least 3 per state)
- [x] Every page offers the four metrics (Pünktlichkeit, Typische Verspätung, Schlechteste 10 %, Ausfälle) through the same switch with an explanation line under it, and `k` survives every page change (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/metric-help.spec.ts`, and in `zeitverlauf.spec.ts` the tests "the P90 view draws the P90 as the line, with the band reaching down to the median" and "the cancellation view has the cancellation rate as its only chart")

## M8 Line detail page (v0.3)
- [ ] Line detail page with the line's stations and statistics
- [ ] Zeitfresser: the sections between stations coloured by where trains lose or make up time
- [ ] Bildfahrplan: the graphic timetable of the line for one day, planned against actual. Needs data per run (about 82 MB per month with all stations, compact): decide where it lives first

## M9+ Planner (v1.0)
- [ ] Connection-source spike (ADR)
- [ ] Replay engine
- [ ] Planner and transfer UI

## After v1.0
Optional features and backlog per SPEC 3.1 and 3.4.
