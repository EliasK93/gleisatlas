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
Details in [day-history.md](day-history.md). Built on a per-day delay histogram (about 36 MB, estimated on 2025-06 and 2026-09).
- [x] Daily time series with a 28-day trend as the default; the monthly view stays as a switch (re-check: `uv run pytest -q`, `tests/api/test_tagesverlauf_api.py`, `tests/core/test_holidays.py`; `npm --prefix frontend run test:e2e`, the "day view" tests in `frontend/e2e/zeitverlauf.spec.ts`)
- [x] Day map: the map coloured by one past day against each station's normal for that weekday (noise-aware classes), with a card for Germany showing its step and deviation (re-check: `uv run pytest -q`, `tests/core/test_normal.py`, `tests/api/test_tageskarte_api.py`; `npm --prefix frontend run test:e2e`, `frontend/e2e/lage.spec.ts`; the map is the page Live-Lage since the section below)

## M7 Fresh days (v0.3)
Details in [pipeline.md](pipeline.md) (raw days) and [day-history.md](day-history.md) (coverage); the live source is decided in [adr/0002-live-source.md](adr/0002-live-source.md).
- [x] Fresh days from raw data: the day map and the daily series reach the last complete day, usually yesterday; the month views stay on whole months (re-check: `uv run pytest -q`, `tests/pipeline/test_raw.py`, `tests/pipeline/test_update.py`, `test_complete_raw_days_after_the_last_month_reach_the_day_tables`, `test_combine_sums_a_raw_day_with_the_same_day_from_a_monthly_file`; on the real data `/datenstand` names the last complete day)
- [x] Data refresh of the deployed site: `scripts/azure.py data` uploads the data files to Blob (re-check: `uv run pytest -q`, `tests/scripts/test_azure.py`; the first refresh of the live site is a platform check in [day-history.md](day-history.md) §6)
- [x] Live source for "today": where the live state comes from, how it is collected and where it runs (re-check: [adr/0002-live-source.md](adr/0002-live-source.md) is accepted)
- [x] Day × hour histogram over all days, all four metrics, so any past day can be cut at any hour (re-check: `uv run pytest -q`, `test_day_hours_sum_over_the_hour_to_days`, `test_day_hours_sum_an_edge_day_and_add_up_to_days_of_the_large_stations`, `test_day_hours_take_the_raw_days_too`)
- [x] Collector for the large stations: `fchg` every 15 minutes and each `plan` slice once, writing `heute.parquet`; tested against a fake API with the raw days' XML, the run with the real key is a platform check (re-check: `uv run pytest -q`, `tests/pipeline/test_live.py`; [day-history.md](day-history.md) §6)
- [x] The source's partial raw day as a fallback for the large stations the collector has not completed yet, written by `pipeline.update` as `heute_rest.parquet` (re-check: `uv run pytest -q`, `tests/pipeline/test_rest.py`)
- [x] "Heute" in the day view: today so far against the same hours of the reference days, two freshness levels, the time of the data, a fallback to the last complete day (re-check: `uv run pytest -q`, `tests/api/test_heute_api.py`; `npm --prefix frontend run test:e2e`, the "today" tests in `frontend/e2e/lage.spec.ts`; details in [day-history.md](day-history.md))

## Move to a VPS
- [ ] The stable run on one VPS: the API image, the static frontend with the CSP and TLS, the data on disk, the collector's cron and key. Azure stays for tests and temporary deploys. Until then the collector runs as a job on the Azure deployment (Live-Lage below).

## Live-Lage
Details in [day-history.md](day-history.md).
- [x] Live-Lage as its own page `/lage` for the 131 large stations: today by default, a Rückblick to any day through the date field and three chips (Heute, Gestern, Vorgestern), the Germany card with Fern and Regional, the Karte without a Tag switch and the Karte's Gattung and period kept across the page (re-check: `uv run pytest -q`, `tests/api/test_tageskarte_api.py`, `tests/api/test_heute_api.py`, `tests/core/test_periods.py`; `npm --prefix frontend run test:e2e`, `frontend/e2e/lage.spec.ts`)
- [x] Bundesländer level of Live-Lage: a card per state with its step colour and deviation, state areas from a Natural Earth file with a wash outside Germany and a hover tint, the same step and deviation on the Germany card, a click zooming to the state and its card (re-check: `uv run pytest -q`, `tests/core/test_core.py` (`test_land_codes_cover_the_16_states`), `tests/api/test_tageskarte_api.py` (`test_a_state_class_is_1_on_the_best_day_and_5_on_the_worst`), `tests/api/test_heute_api.py` (`test_today_a_state_counts_only_the_stations_that_report`); `npm --prefix frontend run test:e2e`, the block "the states" in `frontend/e2e/lage.spec.ts`)
- [x] A day-level Zeitraum on the Karte, up to the last complete day: two date fields, the default from the full-coverage month to the last complete day, `/karte` reading `days.parquet`; the other pages keep month selects and round days from the URL outward (re-check: `uv run pytest -q tests/api/test_map_api.py`, `test_karte_takes_a_day_range`, `test_karte_month_edges_mean_whole_months`, `test_karte_default_reaches_the_last_day`; `npm --prefix frontend run test:e2e`, `frontend/e2e/period.spec.ts`; details in [map.md](map.md))
- [x] Collector days: Live-Lage shows the days the collector has kept after the last complete day (`live_tage.parquet`), the API serves them, lists them in `/datenstand` and refreshes the live files while it runs (re-check: `uv run pytest -q`, `tests/pipeline/test_live.py`, `tests/api/test_heute_api.py`, `tests/api/test_deploy_api.py`; `npm --prefix frontend run test:e2e`, `frontend/e2e/lage.spec.ts`; details in [day-history.md](day-history.md) §2)
- [x] An earlier complete day: a raw day counts as complete at the first complete `fchg` run after local midnight, so yesterday is usually there in the early morning (re-check: `uv run pytest -q`, `tests/pipeline/test_update.py`, the `day_complete` tests; the measurement is in [pipeline.md](pipeline.md) §3)
- [ ] The collector as a scheduled job on Azure that keeps today and the collector days in the blob container, so the deployed Live-Lage stays complete without the local machine; with it the API's 10-minute cooldown and a warm-up of every page after a wake. Built and tested locally (re-check: `uv run pytest -q`, `tests/pipeline/test_live.py`, `tests/scripts/test_azure.py`, `tests/api/test_warmup.py`; `az bicep build --file infra/main.bicep --stdout`); ticked after the platform checks in [deployment.md](deployment.md) §6 ("Heute" and the previous day on the deployed Live-Lage)
- [x] Every page offers the four metrics (Pünktlichkeit, Typische Verspätung, Schlechteste 10 %, Ausfälle) through the same switch with an explanation line under it, and `k` survives every page change (re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/metric-help.spec.ts`, and in `zeitverlauf.spec.ts` the tests "the P90 view draws the P90 as the line, with the band reaching down to the median" and "the cancellation view has the cancellation rate as its only chart")

## M8 Line detail page (v0.3)
Details in [lines.md](lines.md).
- [x] Line detail page `/linie/<id>` with the line's stations along its route and their statistics; line rows in the Rankings and in the station's line table open it (re-check: `uv run pytest -q`, `tests/api/test_line_api.py`, `tests/core/test_sections.py`, `tests/pipeline/test_update.py` (`test_combine_writes_the_sections_and_the_axis_of_a_line`, `test_combine_turns_the_axis_to_the_label_order`); `npm --prefix frontend run test:e2e`, `frontend/e2e/line.spec.ts` and the line-row tests in `rankings.spec.ts` and `station.spec.ts`)
- [x] Zeitfresser: the sections between stations coloured by where trains lose or make up time, on a map and as a strip, with the mean minutes per section (re-check: `tests/core/test_sections.py`, `tests/pipeline/test_aggregate.py` (`test_sections_count_and_sum_the_changes_per_line_and_month`), `frontend/e2e/line.spec.ts` (the strip, the direction toggle, the step colours); the colour limits are confirmed in the product owner's test round)
- [x] Whole-line tiles on the line page, lines marked without live data and left out of the Rankings, a Rankings switch Linien · Einzelzüge (re-check: `tests/core/test_lines.py`, `tests/api/test_rankings_api.py`, `tests/api/test_line_api.py`, `frontend/e2e/line.spec.ts` and `frontend/e2e/rankings.spec.ts`; the list is in [lines.md](lines.md) §5)
- [x] Bildfahrplan: the graphic timetable of the line for one day of the last 28 days, planned against actual (re-check: the Bildfahrplan milestone in [lines.md](lines.md) §5). A table `combine` writes (`fahrten.parquet`, 56 MB) is downloaded at start on Azure like the other files; a trip belongs to its start day and the chart runs past 24:00 for night trips; replacement buses are also dropped by line name

## Finding lines
Lines are hard to reach: only through a station's line table or the best and worst Rankings. Details: the search in [map.md](map.md), the line page in [lines.md](lines.md).
- [x] The global search finds stations and lines: a place lists stations, a line name lists the line's ids, "ic34 dortmund" opens IC34 toward Dortmund, spaces and case do not matter (re-check: `uv run pytest -q tests/core/test_search.py tests/api/test_search_api.py`; `frontend/e2e/search.spec.ts` ("a place query shows the stations and no line group when the API sends no lines", "the API's order decides which group comes first", "a line name lists the exact line first, then the prefix hits, with no station group", "a line option shows its type badge, its label and the matched direction", "the arrow keys run across both groups in their shown order", "a line pick opens the line page with metric and period kept and the direction", "a line toward its last station opens without a direction key", mobile "a tap on a line opens its page; the options are 44 px high"); the grouped field and its rules are in [map.md](map.md))
- [x] A line picker in the Zeitverlauf: a "Linie" chip opens the search in its lines-only scope and sets `linie`; the chip of a set line opens it too, to change the line (re-check: `frontend/e2e/zeitverlauf.spec.ts`, "the Linie chip opens a line picker; a pick sets the line, drops the station and asks for its series", "with a line set, its chip opens the picker to change the line", "the line picker says when no line matches"; details in [app-shell.md](app-shell.md))
- [x] The line page's route and Zeitfresser strip become one route card with the map beside it, and jump chips under the header (re-check: `frontend/e2e/line.spec.ts`, the milestone in [lines.md](lines.md) §5 names the tests)

## Gate fast path
- [x] A docs-only change runs only the secret scan, and in manual mode the clean-tree check: when every file changed since the last green gate run is a Markdown file (not `THIRD_PARTY_LICENSES.md`) or under `docs/images/`, in manual and hook mode. Anything else, a missing or unknown green tree and `--ci` run every check. A green fast run writes the marker like a full run (re-check: `uv run pytest -q tests/scripts/test_gate.py`, `test_a_docs_only_change_runs_only_the_secret_scan_in_manual_mode`, `test_a_docs_only_change_runs_only_the_secret_scan_in_hook_mode`, `test_a_fast_run_saves_the_fingerprint`, `test_a_change_that_is_not_docs_runs_every_check`, `test_a_change_under_docs_images_counts_as_docs`, `test_ci_runs_every_check_for_a_docs_only_change`, `test_a_marker_naming_an_unknown_tree_runs_every_check`, `test_a_code_file_renamed_to_markdown_runs_every_check`)
- [x] Seen for real: after a green gate, one edit to a `.md` file and `uv run python scripts/gate.py` prints "docs-only change since the last green gate: secret scan, clean tree" and only the secret scan and the clean tree run, then the edit is reverted

## Lines from the map and deep links
Details in [map.md](map.md) (the station panel) and [lines.md](lines.md) (the section link and the anchors).
- [x] The Karte's station panel lists the station's five busiest lines, each opening its line page, and "Alle {count} Linien" opens the station page at its table of lines (re-check: the milestone in [map.md](map.md) §5 names the tests in `frontend/e2e/map.spec.ts`, `lage.spec.ts` and `station.spec.ts`)
- [x] A section of the line page has its own URL key `abschnitt`, set in the route card or on the map, and `#strecke`, `#bildfahrplan` and `#linien` scroll to their target once the data has arrived (re-check: the milestone in [lines.md](lines.md) §5 names the tests in `frontend/e2e/line.spec.ts` and `heatmap.spec.ts`)

## Show more in the Rankings
Details in [patterns.md](patterns.md) §2 and §3.
- [x] Every Rankings list starts with 10 rows and grows by 100 per click of "Mehr anzeigen" until all are shown, each list on its own, with a count line under it; the `limit` parameter of the three Rankings routes (re-check: the milestone in [patterns.md](patterns.md) §5 names the tests in `tests/api/test_rankings_api.py` and `frontend/e2e/rankings.spec.ts`)

## Next, in order
Each step gets its own plan and its own section here once it starts.
1. [x] A docs-only fast path in the gate (section "Gate fast path")
2. [x] Lines from the map and deep links (section "Lines from the map and deep links")
3. [x] Rankings and the heatmap, one data rebuild for all of them:
   - a Rankings tab "Abschnitte": the network-wide worst and best Zeitfresser sections, per station pair and direction, pooled over all lines, with a minimum of trips; each row links to its lines
   - a Rankings tab with records independent of delays: stations with the most and fewest stops, lines with the most and fewest trains per hour, without the minimum-sample chips (a fixed floor instead)
   - a line filter for the Wochentag × Uhrzeit heatmap, from a per-line weekday × hour table (a larger file to download)
   - Re-check, pipeline and API: `uv run pytest -q tests/pipeline tests/api`, in particular the record-table milestone in [pipeline.md](pipeline.md) §5, `tests/api/test_rankings_api.py` (`test_sections_pool_over_the_lines_and_keep_each_direction`, `test_stops_per_day_count_every_stop_over_the_days_of_the_period`, `test_trips_per_hour_of_service_come_from_the_takt_table`) and `tests/api/test_heatmap_api.py` (`test_a_line_has_its_own_heatmap_and_a_title`); the full list is the milestone in [patterns.md](patterns.md) §5
   - Re-check, UI: `npm --prefix frontend run test:e2e`, `frontend/e2e/rankings.spec.ts` and `frontend/e2e/heatmap.spec.ts`; the rules and decisions are in [patterns.md](patterns.md) §2 and §3, the data files in [pipeline.md](pipeline.md) §2 and the download list in [deployment.md](deployment.md) §4
4. [x] Show more in the Rankings (section "Show more in the Rankings")
5. [ ] The image registry on GitHub Container Registry instead of Azure Container Registry, checked with one test deploy together with the larger data
6. [ ] The planner, M9+ below
7. [ ] Talk about the move to a VPS (section above) once the planner's connection source is decided, since the source sets what the server needs

## M9+ Planner (v1.0)
- [ ] Connection-source spike (ADR)
- [ ] Replay engine
- [ ] Planner and transfer UI

## Ideas, unsorted
Not planned yet; further ideas and details in SPEC 3.1 and 3.4.
- Restructuring the main navigation, for example pages per entity (station, line) instead of per chart.
- An advanced search page: stations by conditions, and the lines that stop at a station.
- Live-Lage with a larger station set than the 131 (decide first how the days before full coverage are handled and the selection rule, for example at least 3 per state).
- Line data on Live-Lage: the collector keeps the line, so Live-Lage can show the worst lines today nationwide and per state (pooled over the 131 stations) and a station's lines as plain counts; with `fahrten.parquet` that reaches 28 days back. Measured on 28 days: by noon about 110 lines a day reach 50 stops pooled, a station has a median of 4 lines with 15 stops (7 for the whole day), long-distance trains are single-train lines and need grouping. If taken up, it goes before the image-registry deploy, so one deploy checks the changed collector.
- Maybe: an hour curve of the shown day in the Germany or state card of Live-Lage, against the normal's same hours. Only if it adds something the Zeitverlauf and the heatmap do not already show; otherwise drop it.
- On the daily series: a calendar view, marked holidays and strikes, the 10 worst and best days.
- Weather correlation on the daily series (DWD Open Data or Meteostat).
- A comparison with the official DB punctuality figures.
- A passenger-rights calculator: how often a station, line or connection reaches 60 or 120 minutes.
- Lines that cross the border marked as "section in Germany".
- Maybe: how much later a rail replacement bus (SEV) arrives than the train it replaces. Measure first whether the buses stop at the train's station and how much later they are (about 90 % of replacement rows name the replaced train); shown only if the data really shows it.
