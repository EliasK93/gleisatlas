# Map, station detail and search

## 1 Overview

The start page of the app: a map of Germany with one dot per station, coloured by the selected metric, a panel for the clicked station, a detail page per station and a global station search. Visual targets are in [design.md](design.md) §2.1 and §2.2 and the clickable [mockup](design/mockup.html); where they differ, the mockup wins. The frame around these pages (sidebar, filter bar, mobile bars) is described in [app-shell.md](app-shell.md), the metrics and the API of the statistics in [patterns.md](patterns.md), the coordinate data in [pipeline.md](pipeline.md) and [adr/0001-station-coordinates.md](adr/0001-station-coordinates.md).

## 2 Spec

**Routes and URL keys**

| Path | Page |
|---|---|
| `/karte` | Map start page; `/` and unknown paths redirect here, query string kept |
| `/bahnhof/{eva}` | Station detail page |
| `/lage` | Live-Lage, the map for one day (see [day-history.md](day-history.md)) |

The filter keys `g`, `von`, `bis` and `k` are the ones of the shell (see [app-shell.md](app-shell.md)). On the map, `von` and `bis` may be months or days (the Karte is the one page with a day-level Zeitraum); the station page, like the other month pages, rounds days outward to months. On the map, `bhf` is the selected station: it opens the panel, so a link or a reload restores the selection. The detail page takes the station from the path and drops a `bhf` or `linie` key from the URL once; the map drops `linie` too. A station picked from the search goes to `/bahnhof/{eva}` and keeps `g`, `von`, `bis` and `k`. From the detail page, the breadcrumb "Karte" and "Groß ansehen →" (the heatmap) carry the filters plus `bhf={eva}`. Every URL write puts the keys in one canonical order, so a filter change never reloads the page.

**API used**

- `GET /karte` (`gattung`, `von`, `bis`) returns every station with coordinates and its four statistics in one response; the metric switch is client-side. `von` and `bis` are each a month (`YYYY-MM`: as `von` its first day, as `bis` its last day) or a day (`YYYY-MM-DD`). Without `von` the range starts on the first day of `vollabdeckung_ab` (unless `bis` ends before it), without `bis` it runs to the last day in the data. It reads the day table, so the response's `von` and `bis` are the first and last day with data in the selection. `ohne_koordinaten` counts named stations with stops in the selection that have no coordinates.
- `GET /stationen/{eva}/statistik` (same filters) feeds the detail page: overall statistics, the delay distribution (7 bins plus cancelled) and the statistics per category group.
- `GET /heatmap?eva=` feeds the mini heatmap on the detail page and shares the cache with the heatmap page.
- `GET /stationen?q=&limit=` feeds the search: name-prefix matches first, then by number of stops, so Köln Hbf comes before Köln-Dellbrück.
- `GET /stationen/{eva}` resolves a `bhf` that is not in the map data (a station without coordinates).
- `GET /stationen/{eva}/linien` (same filters) feeds the table of lines; `GET /zeitverlauf?eva=` (category only) feeds the sparkline, together with `/datenstand` for the gap hours.

**Map page**

- Full-bleed map (MapLibre GL, OpenFreeMap "positron" style in the light theme and "dark" in the dark one, see [theme-and-language.md](theme-and-language.md)), no footer. Labels of the base map appear from zoom 7, so the dots dominate the overview.
- Floating card top left: h1, lead text, metric switch, filter chips. The Zeitraum chip holds two native date fields, "Zeitraum von" and "Zeitraum bis", limited to `erster_tag` to `letzter_tag` of `/datenstand`; without `von` and `bis` in the URL they show the first day of the full-coverage month and the last complete day. A day outside the data, or a month beyond it, shows the nearest day inside. A pick that would cross the other edge moves that edge to the same day; typing a day key by key into a field passes through such days, so a day that would cross is held while the field has the focus and applied when the field is left. A field writes only a complete day inside the data. Legend bottom left (collapsed on mobile) with the metric's name (its explanation stands under the metric switch), the five classes, the "sehr wenig Daten (n < 15)" (very pale ring), "wenig Daten (n < 50)" (pale dot) and size keys and the meta line "period · category · Bahnhöfe auf der Karte: x" (the period as days, for example "1.–29. Okt. 2026"), followed by " · ohne Koordinaten: y" when stations with data have no coordinates. Zoom buttons bottom right, the attribution below them; from 768 px it wraps before it reaches the legend.
- On desktop the start view fits Germany below the filter card (its measured bottom edge plus 12 px, fitted again while the card's height settles and until the camera is moved or a station is picked); with the station panel open the card stops 12 px before it and its rows wrap.
- One circle per station: radius from the square root of its stops, fill from the class of the displayed value. A station below the low-data limit is hollow with a ring in the scale colour, at 30 % opacity; a station with a "~" value (15 to 49 counted stops) is filled at 50 % opacity; a station whose stops were all cancelled uses the cancellation colour. Dots with enough data draw above the faint ones, and within each group worse classes draw on top. The selected station gets an accent ring.
- Hover (on devices that hover) shows "name · value"; a click selects the station. A pick through the chip or a link eases the camera to the station, clear of the panel; a click on the map does not move the camera.
- Station panel: 360 px at the right on desktop, a bottom sheet of at most 62 % height on mobile. It shows name, EVA, a little-data note, one sentence ("x von 10 Ankünften sind pünktlich, 9 von 10 höchstens y min spät"), four tiles, the meta line, "Alle Details" and "Verbindung ab hier" (tagged "bald"). Schließen and Escape close it and hand the focus to the map.
- A `bhf` without map data (unknown or no coordinates) shows the panel with "EVA …" as title and a note, plus the real name when `/stationen/{eva}` knows it.
- States: loading text in the legend, empty card with "Filter zurücksetzen", error banner with "Erneut versuchen" that keeps the filters.

**One day**

- The Karte shows a period of days (`von`, `bis`), not one day: it has no Tag switch and ignores a `tag` key. Live-Lage in turn ignores the Karte's `g`, `von` and `bis` and leaves them in the URL, so the way back restores them. The map of one day against its normal is the separate page Live-Lage (`/lage`), which shares this page's map code; its rules, the steps and the data are in [day-history.md](day-history.md) §2 and §4.

**Station detail page**

- Header: breadcrumb "Karte › name", h1, "EVA … · federal state", "Teilen"; "Verbindung ab hier" and "Umstiege hier" are tagged "bald". Filter bar without the Bahnhof chip.
- A little-data banner, four tiles (Pünktlichkeit, Typische Verspätung, Schlechteste 10 %, Ausfälle) each with value, sentence and meta line, the delay distribution with a separate hatched "ausgefallen" bar, the mini heatmap with "Groß ansehen →", bars for Regionalverkehr and Fernverkehr, the table "Linien an diesem Bahnhof" and the card "Letzte 12 Monate".
- "Linien an diesem Bahnhof" lists the lines that stop here, worst punctuality first by default, with a segmented toggle "Schlechteste zuerst" · "Beste zuerst" (client-side: only the lines with enough data are reversed, the ones with too little data stay last in both orders), with the train-type badge, the name, a thin bar with the punctuality value, n and the cancellation rate as its own grey "✕" figure. It shows the first ten and "Alle {count} Linien anzeigen" expands the rest in place and the same button then reads "Weniger anzeigen" and collapses back to ten. A line with too little data is hatched and shows no value, by the rule of the heatmap. Every row links to the time series of that line, with the category and the selected metric. After "Alle {count} Linien anzeigen" the focus moves to the first newly shown row; after "Weniger anzeigen" it stays on the button. On mobile each row becomes a bordered card with the bar below the name. It has its own loading, error and empty state ("Mit diesen Filtern gibt es hier keine Linien."), so the rest of the page stays.
- "Letzte 12 Monate" is a sparkline of the punctuality of the station's last 12 months with the latest value and its n ("pünktlich im {month} · n = …", the latest month with enough data, or "–" when no month has) and the link "Zeitverlauf →" to the station's time series. It follows the category filter but not `von` and `bis`, which the series does not use. Months with little data (the rule of the heatmap) or gaps are dashed, with a hollow point, and a tap or hover shows the month's tooltip. It has its own loading, error and empty state.
- The metric switch above the mini heatmap drives the mini heatmap and the category bars and writes `k`.
- States: skeleton, empty period with "Filter zurücksetzen", error banner, and "Diesen Bahnhof kennen wir nicht" with a search for an unknown or invalid EVA (an invalid EVA does not ask the API).
- Mobile: one column, tiles 2 × 2.

**Search**

- A combobox "Bahnhofssuche" over `/stationen`: in the sidebar under the logo on desktop with the hint "Strg K", inline in the mobile top bar. Ctrl+K and Cmd+K focus the visible field; there is no palette dialog.
- Up to 8 results with name, "federal state · EVA … · n Halte" (missing parts left out). Arrow keys, Enter and click pick; Escape clears. A name that appears more than once in the list gets "2 Einträge mit diesem Namen".
- The station chip of the filter bar uses the same combobox and sets `bhf` instead of navigating.

## 3 Decisions

- **Station coordinates from Wikidata.** Reason: product owner's choice after weighing five sources; 99.9 % of all stops belong to stations with coordinates (see the ADR).
- **MapLibre GL with the OpenFreeMap "positron" style (light) and "dark" (dark theme, [theme-and-language.md](theme-and-language.md)).** Reason: product owner's choice; zoom, pan and draw order over about 5,000 points need WebGL, and OpenFreeMap needs no API key. The no-library alternative is an SVG outline map, which the product owner declined.
- **Base map labels follow the UI language** (`name:de`, else the local `name`); the OpenFreeMap styles prefer English names ("Cologne"). `localLabel` in `metrics.ts` rewrites every label that reads a name; road numbers stay. Reason: a German UI with English place names reads wrong, and the English UI gets English labels from the same code.
- **Coordinates live in the gitignored `data/` folder**, built by `pipeline.coords`, not committed. Reason: they are derived data like the raw files, and the result depends on the current state of Wikidata.
- **The selected station lives in `bhf`.** Reason: the panel survives a reload and the heatmap link carries the station without a second key.
- **The mockup wins over design.md** where they differ: the sheet is fixed at 62 %, there is no `z` map-position key, the footer is hidden on the map and the metric switch scrolls sideways on mobile. Reason: the mockup is the clickable reference.
- **Search per mockup, no palette dialog.** Reason: product owner's choice; Ctrl+K only focuses the field.
- **The field's accessible name is "Bahnhofssuche"**, the filter chip's combobox stays "Bahnhof suchen". Reason: two comboboxes with one name would break tests that find the chip by name, and accessibility labels are not changed to make tests easier. The placeholder reads "Bahnhof suchen …" in both.
- **Unbuilt actions** ("Verbindung ab hier", "Umstiege hier") are shown with a "bald" tag, not hidden. Reason: product owner's choice; the detail page builds what the data supports and says what is missing.
- **"Linien an diesem Bahnhof" shows punctuality only, worst first, and does not follow the metric switch.** The first ten rows show, the rest expands in place. Reason: the API orders lines by punctuality, and a table that re-sorted with the metric would need a second ordering rule; sorting by column is not built (see Known shortcuts).
- **A line row opens the time series, not a line page.** Reason: a line has no page of its own, and the series answers the next question directly.
- **"Letzte 12 Monate" is punctuality over the last 12 months of the data, not a calendar year.** The series is the time series endpoint's, so the sparkline and the full page show the same numbers. Reason: one source for both, and the period picker stays out of it like on the full series.
- **No list alternative to the map.** Reason: search and panel reach every station without the map. The rankings show only the ten worst and ten best, so they are no full station list either.
- **The duplicate-name hint is computed in the browser** from the shown results, not by the backend. Reason: names are not unique, but a backend field for one hint is not worth the contract.
- **Delay bins are half-open in whole minutes**: < 1 (early arrivals included), [1, 3), [3, 6), [6, 10), [10, 20), [20, 30), ≥ 30. Reason: the source stores whole minutes, and the edge at 6 matches the punctuality rule. Cancelled stops are counted apart and never fall into a bin.
- **The distribution shows shares of all planned stops**, with cancellations as their own bar. Reason: the mockup does it, and the bars then add up to 100 %.
- **"x von 10" is rounded down**, so 96 % reads "9 von 10". Reason: "10 von 10" promises a certainty the number does not support.
- **Low data is judged the way the heatmap does**: arrived stops for the delay metrics, all stops for Ausfälle, "~" below 50. Reason: one rule on the map, in the panel, in the tiles and in the mini heatmap.
- **Stations with few stops are drawn pale, and beneath the others**: 50 % opacity for the "~" tier, 30 % for the hollow ring, `PALE` and `VERY_PALE` in `MapPage.tsx`. Reason: the same cut-off as the "~" everywhere (`show()`); the class from a few stops is noisy and should not draw the eye, and a pale dot must never cover a solid one. Both tiers stay visible on the light and the dark base map.
- **A metric switch on the detail page.** Reason: the mini heatmap and the category bars would otherwise be fixed to punctuality; it costs one shared component and gives `k` the same meaning as on the other pages.
- **Escape closes the panel and the focus moves to the map.** Reason: keyboard users would otherwise lose their place when the panel disappears.
- **Search hits of an old term are not opened.** Enter is ignored while the answer for a new term loads. Reason: pasting a new name over an old one must not open the old one.
- **Touch targets are 44 px** on the search field, the zoom buttons and the attribution toggle, without changing how they look. Reason: design.md §5.
- **The Karte's Zeitraum is day-level and runs to the last complete day; the other pages keep months.** Reason (product owner, 2026-11-01): the map lagged up to a month behind, and `days.parquet` already holds every station per day. The Heatmap needs the hour of the stop, which the day table lacks, and the lines have no day table; per-day tables for them would be much larger and not fit the deploy.
- **Two native date fields, not presets or a calendar.** Reason: `<input type="date">` needs no library, keeps the 44 px hit areas and takes a typed day; `min` and `max` are the first and last day of the data.
- **The default range is the first day of the full-coverage month up to the last complete day.** Reason: the same start as the month pages (a nationwide map must not mix two station populations, [patterns.md](patterns.md) §3), and the map shows the newest complete data without a pick.
- **Month pages round days from the URL outward to months, clamped to the months with data, and leave the URL alone.** Their selects and their requests agree (`useMonthPeriod`); picking in one of their selects writes months for both edges. Reason: a link made on the Karte with days opens the other pages with the months that contain those days, and the way back to the Karte restores the days.
- **`/karte` reads `days.parquet`, the station rankings and statistics stay on `aggregate.parquet`.** Reason: the map needs days, the rankings and the station page months, and the aggregate carries the hour and weekday that the heatmap needs; one table cannot serve both without a bigger file.
- **`/karte` is cached per process** by filter combination and file modification times. Reason: the first computation takes seconds (on one Polars thread, measured on the real data: October 2026 0.57 s, the default range 2.7 s), later calls about 50 ms; the cache follows the files, so new data is never served stale.
- **GZip on all responses.** Reason: the all-stations response is about 900 KB as JSON and about 230 KB compressed.
- **The worker is bundled** (`maplibre-gl-worker.mjs?worker&url`). Reason: MapLibre v6 otherwise looks for it relative to its own module, which breaks once bundled.
- **The MapLibre container sits in a positioned wrapper.** Reason: MapLibre's stylesheet sets its container to `position: relative`, which collapsed a container that was meant to be `absolute`.

## 4 Architecture and data keys

- `frontend/src/MapPage.tsx`: the page (also Live-Lage, through its `day` prop), `StationMap` (MapLibre lifecycle, one GeoJSON source with a circle layer and a selection ring, features built from the theme tokens at runtime), `Legend`, `StationPanel`.
- `frontend/src/StationPage.tsx`: the detail page with its tiles, distribution, mini heatmap, category bars, the `Lines` table and states. The `Sparkline` card is `ZeitverlaufPage.tsx`'s export (see [app-shell.md](app-shell.md)).
- `frontend/src/StationSearch.tsx`: `StationSearch` (the combobox, variants "global" and "inline", ids from `useId`), `useOpenStation`, `GlobalSearch`, `useSearchShortcut`.
- `frontend/src/ui.tsx`: pieces shared by the pages: metric switch, error banner, empty card, share button, "bald" tag, the low-data rule `show()`, the class fills, and `Badge`, `MiniBar` and `Cancelled` for the lines table and the category bars.
- `frontend/src/metrics.ts`: also `share`, `binLabel`, `tenths`; `withParam` writes keys in canonical order.
- `backend/main.py`: `/karte`, `/stationen/{eva}/statistik`, the shared filter chain `selection`, the cache `karte_for`, the query type `Period` (a month or a real day; only `/karte` takes it, a calendar-impossible day such as `2026-02-30` is a 422).
- `frontend/src/Filters.tsx`: the Zeitraum chip with `DayField` (the date field shared with Live-Lage). `frontend/src/metrics.ts`: `monthOf`, `monthsOf`, `firstDay`, `lastDay`, `withPeriod`, `formatDays`. `frontend/src/api.ts`: `useMonthPeriod`.
- `core/stats.py`: `delay_bins`. `core/stations.py`: `ibnr_expr` (EVA to IBNR).
- `pipeline/coords.py` and `pipeline/aggregate.py`: coordinates and the station table, see [pipeline.md](pipeline.md).
- Data keys: `data/stations.parquet` carries `eva`, `name`, `n`, `lat`, `lon`, `land`; `/karte` reads `data/days.parquet` (`day`, `gruppe`, `eva`, `bucket`, `n`; see [pipeline.md](pipeline.md)), filtered by `day` so that Polars can skip row groups; `bhf` and `k` as in the URL keys above.
- Tests: `frontend/e2e/map.spec.ts`, `station.spec.ts` and `search.spec.ts` run against fixtures served through `page.route`. The OpenFreeMap style is answered by a minimal local style, never the network; the page's `data-ready` marker is set after the map is idle with the data drawn.

## 5 Milestones

- [x] Station coordinates: source, join and coverage. Re-check: `uv run pytest -q`, `tests/pipeline/test_coords.py` (`test_parse_bindings_dedups_and_keeps_missing_state`), `tests/pipeline/test_aggregate.py` (`test_join_coords_on_normalised_eva`, `test_unlocated_station_takes_coords_of_its_only_namesake`), `tests/pipeline/test_update.py` (`test_update_aborts_without_coords_before_fetching`), `tests/core/test_core.py` (`test_ibnr_strips_leading_zeros`); the coverage figures in the ADR come from the combine step of `pipeline.update`.
- [x] Map and station statistics API. Re-check: `uv run pytest -q`, `tests/api/test_map_api.py` (`test_karte_lists_only_stations_with_coordinates`, `test_karte_is_cached_per_selection_and_follows_the_files`, `test_statistik_bins_and_cancelled_sum_to_n`, `test_statistik_unknown_or_unnamed_station_is_404`, `test_invalid_input_is_422`, `test_large_responses_are_gzipped`), `tests/api/test_heatmap_api.py` (`test_search_puts_prefix_matches_first_then_busiest`), `tests/core/test_core.py` (`test_delay_bins_edges_negatives_and_cancelled`).
- [x] Map start page with panel. Re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/map.spec.ts` (redirect, stations drawn without footer, `?bhf=` panel, Escape, metric switch without refetch, keys in any order load the map once, focus returns to the map, empty and error states, 360 px panel, mobile bottom sheet and 44 px map controls).
- [x] Station search and detail page. Re-check: `frontend/e2e/search.spec.ts` (keyboard pick keeps filters, duplicate hint, stale Enter, Ctrl+K, mobile field) and `frontend/e2e/station.spec.ts` (header, tiles, distribution with a separate cancelled bar, mini heatmap and metric, unknown and invalid station, breadcrumb back to the map, mobile).
- [x] Lines and the last 12 months on the station page. Re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/station.spec.ts` ("the lines table shows the first ten, worst first, and expands in place", "a line row links to the time series of that line, keeping category and delay view", "a line with too little data is hatched and shows no value", "a station without lines says so", "the lines card shows its own error and the rest of the page stays", "the sparkline shows the last 12 months, the latest value and a link to the series", "a month with little data in the sparkline is dashed", "the sparkline headline is the latest month with enough data, with its n", "the sparkline headline is a dash when no month has enough data", "a line row passes every metric on to the time series unchanged", "expanding the lines with the keyboard moves focus to the first new row", "the sparkline card has its own error and the rest of the page stays", mobile "the lines become row cards: the bar sits below the name"); `uv run pytest -q`, `test_station_lines_worst_first`, `test_zeitverlauf_api.py`.
- [x] Day-level Zeitraum on the Karte. Re-check: `uv run pytest -q tests/api/test_map_api.py` (`test_karte_takes_a_day_range`, `test_karte_month_edges_mean_whole_months`, `test_karte_month_end_is_its_last_day`, `test_karte_default_reaches_the_last_day`, `test_invalid_input_is_422`); `npm --prefix frontend run test:e2e`, `frontend/e2e/period.spec.ts` (the map's two date fields and their defaults, picking days writes them to the URL and the request carries them, crossing edges, a month in the URL shows its first and last day, days in the URL round outward to months on the pattern pages and the station page, a typed day does not move the other edge on the way, mobile fit and 44 px hit areas).
- [x] Pale dots for little data. Re-check: `frontend/e2e/theme.spec.ts` ("stations with little data are drawn paler, in both themes"), `frontend/e2e/map.spec.ts` (the legend keys, German and English).

## 6 Platform checks

- [x] OpenFreeMap tiles and style load on the deployed site, including the attribution of OpenStreetMap, OpenMapTiles and OpenFreeMap that the style carries.
- [ ] WebGL works on the target browsers, desktop and phone. Without WebGL the map does not render; search and detail pages still work. Desktop seen in Chrome, Edge and Firefox; phone open.
- [x] The map's first computation of `/karte` on the Azure Container Apps size (0.5 vCPU / 1 GiB) stays acceptable; measured with the cold and warm `/karte` check in [deployment.md](deployment.md) §6.
- [ ] The cold `/karte` on the deployed site, now reading `days.parquet`, stays acceptable (measured locally with one thread: October 2026 0.57 s, the default range 2.7 s).
- The station popover check stays in [app-shell.md](app-shell.md).

## 7 Open decisions

- Whether to self-host tiles instead of the public OpenFreeMap instance once the site is deployed.
- A map position in the URL (`z`) and a map-position memory; skipped for now.
- A full station list as an alternative to the map; the rankings cover only the top and bottom ten.
- Whether Ctrl+K should grow into a palette (stations, lines, pages) now that lines exist.
- Whether the table of lines should sort by column (punctuality, n, cancellations) instead of worst first only.
- Whether a secondary EVA should be merged with its main station on the map (one dot with combined stops) instead of two dots on the same spot.

## 8 Known shortcuts

- MapLibre is in the main bundle: the main script is about 1.4 MB (about 400 kB gzip) plus a worker of about 520 kB. Lazy-load the map page if the first load of other pages matters (`ponytail:` in `App.tsx`).
- A metric switch rebuilds and re-sends all points; move to feature state if it stutters (`ponytail:` in `MapPage.tsx`).
- The bottom sheet has a fixed height, without drag or snap levels (`ponytail:` in `MapPage.tsx`).
- The term explanations on the detail page are native `title` tooltips, which are hover-only; use a popover for touch (`ponytail:` in `StationPage.tsx`).
- The search sends one request per keystroke, cached per term; add a debounce if the API gets slow (`ponytail:` in `StationSearch.tsx`).
- `/karte` is cached per process, with at most 16 selections; memory and the first computation grow with the number of days in the range, then vectorise the statistics in Polars (`ponytail:` in `backend/main.py`).
- `/karte` with only an early `bis` (no `von`) labels its range from the first day in the file (2024-06-30), a day before `erster_tag`, because the full-coverage default is switched off for it. Only hand-made URLs reach it; the date fields never write one.
- Stations without coordinates are not on the map but remain in search and detail. On 27 months that is only Trebitz (b Könnern), with one stop and no Wikidata item; a missing station gets its IBNR added to its Wikidata item, so the next `pipeline.coords` run places it. Secondary EVAs placed by the same-name fallback sit under their main station's dot. The federal state is missing for some stations that have coordinates.
- The table of lines is not sortable by column. Lines with too little data (the hatched ones) come after all others, so the list shows them but never leads with them. The list is not cached (about 0.1 s for Köln Hbf, see [patterns.md](patterns.md)).
- The duplicate-name hint only knows the eight results shown.
- The mini heatmap is a colour grid with one accessible label; the full heatmap is the accessible table. The category bars are scaled to the larger category for all metrics except punctuality.
- MapLibre's compact attribution starts expanded until the first map move; on mobile it covers a strip above the legend until then.
- Vite starts on its port strictly and fails if the port is taken, instead of moving to a port CORS would block (the CORS rule is in [patterns.md](patterns.md) §4).
