# Map, station detail and search

## 1 Overview

The start page of the app: a map of Germany with one dot per station, coloured by the selected metric, a panel for the clicked station, a detail page per station and a global station search. Visual targets are in [design.md](design.md) §2.1 and §2.2 and the clickable [mockup](design/mockup.html); where they differ, the mockup wins. The frame around these pages (sidebar, filter bar, mobile bars) is described in [app-shell.md](app-shell.md), the metrics and the API of the statistics in [patterns.md](patterns.md), the coordinate data in [pipeline.md](pipeline.md) and [adr/0001-station-coordinates.md](adr/0001-station-coordinates.md).

## 2 Spec

**Routes and URL keys**

| Path | Page |
|---|---|
| `/karte` | Map start page; `/` and unknown paths redirect here, query string kept |
| `/bahnhof/{eva}` | Station detail page |

The filter keys `g`, `von`, `bis` and `k` are the ones of the shell (see [app-shell.md](app-shell.md)). On the map, `bhf` is the selected station: it opens the panel, so a link or a reload restores the selection. The detail page takes the station from the path and drops a `bhf` key from the URL once. A station picked from the search goes to `/bahnhof/{eva}` and keeps `g`, `von`, `bis` and `k`. From the detail page, the breadcrumb "Karte" and "Groß ansehen →" (the heatmap) carry the filters plus `bhf={eva}`. Every URL write puts the keys in one canonical order, so a filter change never reloads the page.

**API used**

- `GET /karte` (`gattung`, `von`, `bis`) returns every station with coordinates and its four statistics in one response; the metric switch is client-side. `ohne_koordinaten` counts named stations with stops in the selection that have no coordinates.
- `GET /stationen/{eva}/statistik` (same filters) feeds the detail page: overall statistics, the delay distribution (7 bins plus cancelled) and the statistics per category group.
- `GET /heatmap?eva=` feeds the mini heatmap on the detail page and shares the cache with the heatmap page.
- `GET /stationen?q=&limit=` feeds the search: name-prefix matches first, then by number of stops, so Köln Hbf comes before Köln-Dellbrück.
- `GET /stationen/{eva}` resolves a `bhf` that is not in the map data (a station without coordinates).

**Map page**

- Full-bleed map (MapLibre GL, OpenFreeMap "positron" style), no footer. Labels of the base map appear from zoom 7, so the dots dominate the overview.
- Floating card top left: h1, lead text, metric switch, filter chips. Legend bottom left (collapsed on mobile) with the five classes, the "little data" and size keys and the meta line "period · category · Bahnhöfe auf der Karte: x", followed by " · ohne Koordinaten: y" when stations with data have no coordinates. Zoom buttons and attribution bottom right.
- One circle per station: radius from the square root of its stops, fill from the class of the displayed value. A station below the low-data limit is hollow with a ring in the scale colour; a station whose stops were all cancelled uses the cancellation colour. Worse classes draw on top. The selected station gets an accent ring.
- Hover (on devices that hover) shows "name · value"; a click selects the station. A pick through the chip or a link eases the camera to the station, clear of the panel; a click on the map does not move the camera.
- Station panel: 360 px at the right on desktop, a bottom sheet of at most 62 % height on mobile. It shows name, EVA, a little-data note, one sentence ("x von 10 Ankünften sind pünktlich, 9 von 10 höchstens y min spät"), four tiles, the meta line, "Alle Details" and "Verbindung ab hier" (tagged "bald"). Schließen and Escape close it and hand the focus to the map.
- A `bhf` without map data (unknown or no coordinates) shows the panel with "EVA …" as title and a note, plus the real name when `/stationen/{eva}` knows it.
- States: loading text in the legend, empty card with "Filter zurücksetzen", error banner with "Erneut versuchen" that keeps the filters.

**Station detail page**

- Header: breadcrumb "Karte › name", h1, "EVA … · federal state", "Teilen"; "Verbindung ab hier" and "Umstiege hier" are tagged "bald". Filter bar without the Bahnhof chip.
- A little-data banner, four tiles (Pünktlichkeit, Typische Verspätung, Schlechte Tage (P90), Ausfälle) each with value, sentence and meta line, the delay distribution with a separate hatched "ausgefallen" bar, the mini heatmap with "Groß ansehen →", bars for Regionalverkehr and Fernverkehr, and the cards "Linien an diesem Bahnhof" and "Letzte 12 Monate", both tagged "bald".
- The metric switch above the mini heatmap drives the mini heatmap and the category bars and writes `k`.
- States: skeleton, empty period with "Filter zurücksetzen", error banner, and "Diesen Bahnhof kennen wir nicht" with a search for an unknown or invalid EVA (an invalid EVA does not ask the API).
- Mobile: one column, tiles 2 × 2.

**Search**

- A combobox "Bahnhofssuche" over `/stationen`: in the sidebar under the logo on desktop with the hint "Strg K", inline in the mobile top bar. Ctrl+K and Cmd+K focus the visible field; there is no palette dialog.
- Up to 8 results with name, "federal state · EVA … · n Halte" (missing parts left out). Arrow keys, Enter and click pick; Escape clears. A name that appears more than once in the list gets "2 Einträge mit diesem Namen".
- The station chip of the filter bar uses the same combobox and sets `bhf` instead of navigating.

## 3 Decisions

- **Station coordinates from Wikidata.** Reason: product owner's choice after weighing five sources; 99.9 % of all stops belong to stations with coordinates (see the ADR).
- **MapLibre GL with the OpenFreeMap "positron" style.** Reason: product owner's choice; zoom, pan and draw order over about 5,000 points need WebGL, and OpenFreeMap needs no API key. The no-library alternative is an SVG outline map, which the product owner declined.
- **Base map labels follow the UI language** (`name:de`, else the local `name`); the positron style prefers English names ("Cologne"). `localLabel` in `metrics.ts` rewrites every label that reads a name; road numbers stay. Reason: a German UI with English place names reads wrong, and the English UI later gets English labels from the same code.
- **Coordinates live in the gitignored `data/` folder**, built by `pipeline.coords`, not committed. Reason: they are derived data like the raw files, and the result depends on the current state of Wikidata.
- **The selected station lives in `bhf`.** Reason: the panel survives a reload and the heatmap link carries the station without a second key.
- **The mockup wins over design.md** where they differ: the sheet is fixed at 62 %, there is no `z` map-position key, the footer is hidden on the map and the metric switch scrolls sideways on mobile. Reason: the mockup is the clickable reference.
- **Search per mockup, no palette dialog.** Reason: product owner's choice; Ctrl+K only focuses the field.
- **The field's accessible name is "Bahnhofssuche"**, the filter chip's combobox stays "Bahnhof suchen". Reason: two comboboxes with one name would break tests that find the chip by name, and accessibility labels are not changed to make tests easier. The placeholder reads "Bahnhof suchen …" in both.
- **"bald" sections** (lines, last 12 months, "Verbindung ab hier", "Umstiege hier") are shown as dimmed cards or tags, not hidden. Reason: product owner's choice; the detail page builds what the data supports and says what is missing.
- **No list alternative to the map.** Reason: search and panel reach every station without the map; a station table arrives with the rankings.
- **The duplicate-name hint is computed in the browser** from the shown results, not by the backend. Reason: names are not unique, but a backend field for one hint is not worth the contract.
- **Delay bins are half-open in whole minutes**: < 1 (early arrivals included), [1, 3), [3, 6), [6, 10), [10, 20), [20, 30), ≥ 30. Reason: the source stores whole minutes, and the edge at 6 matches the punctuality rule. Cancelled stops are counted apart and never fall into a bin.
- **The distribution shows shares of all planned stops**, with cancellations as their own bar. Reason: the mockup does it, and the bars then add up to 100 %.
- **"x von 10" is rounded down**, so 96 % reads "9 von 10". Reason: "10 von 10" promises a certainty the number does not support.
- **Low data is judged the way the heatmap does**: arrived stops for the delay metrics, all stops for Ausfälle, "~" below 50. Reason: one rule on the map, in the panel, in the tiles and in the mini heatmap.
- **A metric switch on the detail page.** Reason: the mini heatmap and the category bars would otherwise be fixed to punctuality; it costs one shared component and gives `k` the same meaning as on the other pages.
- **Escape closes the panel and the focus moves to the map.** Reason: keyboard users would otherwise lose their place when the panel disappears.
- **Search hits of an old term are not opened.** Enter is ignored while the answer for a new term loads. Reason: pasting a new name over an old one must not open the old one.
- **Touch targets are 44 px** on the search field, the zoom buttons and the attribution toggle, without changing how they look. Reason: design.md §5.
- **`/karte` is cached per process** by filter combination and file modification times. Reason: the first computation takes about 0.8 s, later calls about 50 ms; the cache follows the files, so new data is never served stale.
- **GZip on all responses.** Reason: the all-stations response is about 900 KB as JSON and about 230 KB compressed.
- **The worker is bundled** (`maplibre-gl-worker.mjs?worker&url`). Reason: MapLibre v6 otherwise looks for it relative to its own module, which breaks once bundled.
- **The MapLibre container sits in a positioned wrapper.** Reason: MapLibre's stylesheet sets its container to `position: relative`, which collapsed a container that was meant to be `absolute`.

## 4 Architecture and data keys

- `frontend/src/MapPage.tsx`: the page, `StationMap` (MapLibre lifecycle, one GeoJSON source with a circle layer and a selection ring, features built from the theme tokens at runtime), `Legend`, `StationPanel`.
- `frontend/src/StationPage.tsx`: the detail page with its tiles, distribution, mini heatmap, category bars and states.
- `frontend/src/StationSearch.tsx`: `StationSearch` (the combobox, variants "global" and "inline", ids from `useId`), `useOpenStation`, `GlobalSearch`, `useSearchShortcut`.
- `frontend/src/ui.tsx`: pieces shared by the pages: metric switch, error banner, empty card, share button, "bald" tag, the low-data rule `show()`, and the class fills.
- `frontend/src/metrics.ts`: also `share`, `binLabel`, `tenths`; `withParam` writes keys in canonical order.
- `backend/main.py`: `/karte`, `/stationen/{eva}/statistik`, the shared filter chain `selection`, the cache `karte_for`.
- `core/stats.py`: `delay_bins`. `core/stations.py`: `ibnr_expr` (EVA to IBNR).
- `pipeline/coords.py` and `pipeline/aggregate.py`: coordinates and the station table, see [pipeline.md](pipeline.md).
- Data keys: `data/stations.parquet` carries `eva`, `name`, `n`, `lat`, `lon`, `land`; `bhf` and `k` as in the URL keys above.
- Tests: `frontend/e2e/map.spec.ts`, `station.spec.ts` and `search.spec.ts` run against fixtures served through `page.route`. The OpenFreeMap style is answered by a minimal local style, never the network; the page's `data-ready` marker is set after the map is idle with the data drawn.

## 5 Milestones

- [x] Station coordinates: source, join and coverage. Re-check: `uv run pytest -q`, `tests/pipeline/test_coords.py` (`test_parse_bindings_dedups_and_keeps_missing_state`), `tests/pipeline/test_aggregate.py` (`test_join_coords_on_normalised_eva`, `test_cli_aborts_without_coords`), `tests/core/test_core.py` (`test_ibnr_strips_leading_zeros`); the coverage figures in the ADR come from `pipeline.aggregate`.
- [x] Map and station statistics API. Re-check: `uv run pytest -q`, `tests/api/test_map_api.py` (`test_karte_lists_only_stations_with_coordinates`, `test_karte_is_cached_per_selection_and_follows_the_files`, `test_statistik_bins_and_cancelled_sum_to_n`, `test_statistik_unknown_or_unnamed_station_is_404`, `test_invalid_input_is_422`, `test_large_responses_are_gzipped`), `tests/api/test_heatmap_api.py` (`test_search_puts_prefix_matches_first_then_busiest`), `tests/core/test_core.py` (`test_delay_bins_edges_negatives_and_cancelled`).
- [x] Map start page with panel. Re-check: `npm.cmd --prefix frontend run test:e2e`, `frontend/e2e/map.spec.ts` (redirect, stations drawn without footer, `?bhf=` panel, Escape, metric switch without refetch, keys in any order load the map once, focus returns to the map, empty and error states, 360 px panel, mobile bottom sheet and 44 px map controls).
- [x] Station search and detail page. Re-check: `frontend/e2e/search.spec.ts` (keyboard pick keeps filters, duplicate hint, stale Enter, Ctrl+K, mobile field) and `frontend/e2e/station.spec.ts` (header, tiles, distribution with a separate cancelled bar, mini heatmap and metric, soon cards, unknown and invalid station, breadcrumb back to the map, mobile).
- [x] The gate passes: `uv run python scripts/gate.py`.

## 6 Platform checks

- [ ] OpenFreeMap tiles and style load on the deployed site, including the attribution of OpenStreetMap, OpenMapTiles and OpenFreeMap that the style carries.
- [ ] WebGL works on the target browsers, desktop and phone. Without WebGL the map does not render; search and detail pages still work.
- [ ] The map's first computation of `/karte` on the Azure Container Apps size chosen later stays acceptable.
- The station popover check stays in [app-shell.md](app-shell.md).

## 7 Open decisions

- Whether to self-host tiles instead of the public OpenFreeMap instance once the site is deployed.
- A map position in the URL (`z`) and a map-position memory; skipped for now.
- A list alternative to the map, with the rankings.
- Whether Ctrl+K should grow into a palette (stations, lines, pages) once lines exist.
- What the "bald" cards show first when multi-month data and lines arrive.
- How to place the three stations that still have no coordinates: Berlin-Karlshorst `08089193`, Bochum-Langendreer `08000358` and Bürstadt (Ried) `08098360`. There are two options:
  - Add their IBNR to the matching Wikidata items, so the next `pipeline.coords` run picks them up. This is CC0 and benefits everyone. Recommended.
  - A small committed override file (EVA, lat, lon, source) taken from Wikidata or OpenStreetMap.

  Google Maps is ruled out: its terms do not allow copying data.
- Whether a secondary EVA should be merged with its main station on the map (one dot with combined stops) instead of two dots on the same spot.

## 8 Known shortcuts

- MapLibre is in the main bundle: the main script is about 1.4 MB (about 400 kB gzip) plus a worker of about 520 kB, against about 100 kB gzip before. Lazy-load the map page if the first load of other pages matters (`ponytail:` in `App.tsx`).
- A metric switch rebuilds and re-sends all points; move to feature state if it stutters (`ponytail:` in `MapPage.tsx`).
- The bottom sheet has a fixed height, without drag or snap levels (`ponytail:` in `MapPage.tsx`).
- The term explanations on the detail page are native `title` tooltips, which are hover-only; use a popover for touch (`ponytail:` in `StationPage.tsx`).
- The search sends one request per keystroke, cached per term; add a debounce if the API gets slow (`ponytail:` in `StationSearch.tsx`).
- `/karte` is cached per process, with at most 16 selections; memory and the first computation grow with the number of months, then vectorise the statistics in Polars (`ponytail:` in `backend/main.py`).
- Stations without coordinates are not on the map (3 of 5,219 named stations; 99.9 % of stops are covered) but remain in search and detail. Secondary EVAs placed by the same-name fallback sit under their main station's dot. The federal state is missing for some stations that have coordinates.
- The duplicate-name hint only knows the eight results shown.
- The mini heatmap is a colour grid with one accessible label; the full heatmap is the accessible table. The category bars are scaled to the larger category for all metrics except punctuality.
- MapLibre's compact attribution starts expanded until the first map move; on mobile it covers a strip above the legend until then.
- The API allows the dev origin `http://localhost:5173` only, so another dev port fails.
