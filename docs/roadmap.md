# Roadmap

MVP = **v0.1, local pattern analysis** (SPEC 3.1). Azure (v0.2) and the planner (v1.0) follow.

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

## M6+ Planner (v1.0)
- [ ] Connection-source spike (ADR)
- [ ] Replay engine
- [ ] Planner and transfer UI

## After v1.0
Optional features and backlog per SPEC 3.1 and 3.4.
