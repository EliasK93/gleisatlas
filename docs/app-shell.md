# App shell

## 1 Overview

The frame around every page: sidebar, filter bar, mobile top bar and tab bar, footer, and the three pattern pages: the weekday × hour heatmap, the rankings and the time series. Visual targets are in [design.md](design.md) and the clickable [mockup](design/mockup.html); where they differ, the mockup wins. The metrics and API behind the pattern pages are described in [patterns.md](patterns.md); the map start page, the station detail page and the search are in [map.md](map.md).

## 2 Spec

**Routes**

| Path | Page |
|---|---|
| `/karte` | Map start page (see [map.md](map.md)) |
| `/bahnhof/{eva}` | Station detail page (see [map.md](map.md)) |
| `/muster/heatmap` | Heatmap "Wann ist es am schlimmsten?" |
| `/muster/rankings` | Rankings of stations or lines |
| `/muster/zeitverlauf` | Time series by month |
| `/muster` | Redirect to `/muster/heatmap`, query string kept |
| `/mehr` | Mobile list of the remaining items, the Darstellung and Sprache switches, data status and the "not a DB service" note |
| `/` and any unknown path | Redirect to `/karte`, query string kept |

**URL keys** (all filter state lives in the URL, so a link restores the view)

| Key | Values | Default when omitted |
|---|---|---|
| `g` | `regional`, `fern` | all categories |
| `bhf` | EVA number | all stations |
| `von`, `bis` | `YYYY-MM` | `von`: first month with full coverage; `bis`: last month |
| `k` | `median`, `p90`, `ausfall` | punctuality |
| `typ` | `linien` (rankings only) | `bahnhoefe` |
| `min` | `100`, `1000`, `5000` (rankings only) | `500` |
| `linie` | a line id (time series only) | no line |

Unknown or invalid values fall back to the default and are removed from the URL once. Keys are always written in one fixed order: `g`, `bhf`, `von`, `bis`, `linie`, `k`, then `typ` and `min`. Sidebar and tab-bar links carry the current query string, so filters persist across pages. A page drops the keys it has no meaning for: `bhf` on the rankings and on the time series when a `linie` is set, `linie` on every page but the time series. What `bhf` means on the map and on the station page is described in [map.md](map.md).

**Sidebar** (from 768 px): logo, the station search field (see [map.md](map.md)), then the groups "Entdecken" (Karte, Wochentag × Uhrzeit, Rankings, Zeitverlauf), "Planen" (Verbindung planen, Umstieg prüfen) and "Bald" (Live-Lage heute, Verspätungsketten, Gespeicherte Fahrten), then "So liest man die Zahlen". Karte, Wochentag × Uhrzeit, Rankings and Zeitverlauf are links. Every other item is dimmed with a "bald" tag and is not a link; it becomes a link when its page ships. Above the footer sit the Darstellung (theme) and Sprache (language) switches, described in [theme-and-language.md](theme-and-language.md). The footer shows "Datenstand: {month} · {n} Bahnhöfe" and "Kein Angebot der Deutschen Bahn." The page footer with the disclaimer, that sentence and the source with the CC BY 4.0 link is hidden on the map, which fills the viewport.

**Filter bar**

- Zeitraum: two native month `<select>`s ("von" and "bis"), filled from `/datenstand` `monate`. They show the URL's `von` and `bis`, or the defaults (full coverage start, last month), and write both to the URL. A pick that crosses the other edge moves that edge to the same month. The chip is highlighted only when `von` or `bis` is set. The time series hides it: that page always shows every month.
- Linie: with a `linie` in the URL (time series only), a highlighted chip "Linie: {label}" with a button "Linie entfernen" that drops the key.
- Gattung: native `<select>` with Alle, Regionalverkehr, Fernverkehr. "Regionalverkehr" is everything that is not long-distance (S-Bahn, RB, RE and regional operators); buses are excluded in the pipeline.
- Bahnhof: a chip that opens a native `popover` with a combobox over `/stationen`. It shows name and "EVA …" and filters by EVA only.
- Zurücksetzen: clears all keys.

**Heatmap page**

- Header with breadcrumb, h1, lead text and "Teilen" (copies the URL, toast "Link kopiert").
- Metric switch: Pünktlichkeit, Typische Verspätung, Schlechte Tage (P90), Ausfälle. Meta line "n = … Halte · period".
- 7 × 24 grid. Cells with fewer than 15 counted stops are hatched and show no value; below 50 the value gets a "~". A cell whose stops were all cancelled shows ✕ on the cancellation colour. The "Ø Tag" column comes from the API's `tage`.
- Five-class legend per metric, tooltip on hover or tap, "Als Tabelle anzeigen", and the card "Auf einen Blick" with the worst and best slot and a count of thin cells.
- States: skeleton grid while loading, empty state with "Filter zurücksetzen", error banner with "Erneut versuchen" that keeps the filters.
- Class limits, unchanged from the mockup: punctuality 90/80/70/60 %; median 1/2/4/7 min; P90 5/8/12/18 min; cancellations 1/2/3.5/5 % on their own scale.

**Rankings page**

- Header as on the heatmap, with a switch Linien · Bahnhöfe (`typ`) next to "Teilen". The filter bar has no Bahnhof chip.
- A card with the metric switch (Pünktlichkeit, Typische Verspätung, Schlechte Tage (P90), Ausfälle, key `k`), the minimum sample as a segmented control (100, 500, 1.000, 5.000, key `min`) and the meta line "{count} Bahnhöfe mit mindestens {min} Halten · period".
- Two cards, "Am unzuverlässigsten" and "Am zuverlässigsten", with the top ten each. From 1280 px they sit side by side, below that they stack, and below 768 px they are tabs. Under each title a header row names the figure columns: the selected metric in bold over the value, and "Ausfälle" in the grey of the cancellation figures over the last column.
- A row shows rank, the train-type badge for a line, the name, "n Halte", a thin bar, the value and the cancellation rate as its own grey "✕" figure. The cancellation figure never wraps ("✕ 10,9 %" stays on one line). The bar is a share of 100 for punctuality and relative to the largest value in view for the other metrics. The value follows the low-data rule of the heatmap.
- Every row is a link: a station row opens `/bahnhof/{eva}` with the filters, a line row opens the time series of that line with the category and the delay view (`k=median` and `k=p90` open Verspätung, the other metrics open Pünktlichkeit).
- States: skeleton, empty card "Keine Einträge mit mindestens {min} Halten" with "Filter zurücksetzen" (the minimum-sample control stays visible above it), error banner with "Erneut versuchen".

**Time series page**

- Header as on the heatmap, "Teilen" included. The filter bar has no Zeitraum chip; with a `linie` it shows the line chip.
- The selection is nationwide, one station (`bhf`) or one line (`linie`); a line wins over a station, and picking a station in the Bahnhof chip drops the line. The title under the chart heading names it ("Deutschland gesamt", the station or the line label), and the meta line reads "n = … Halte · alle Monate (period)".
- A switch with two views, Pünktlichkeit (`k` absent) and Verspätung (`k=median`). `k=p90` reads as `median` and `k=ausfall` as punctuality, and the page rewrites the URL to that. Ausfälle has its own chart instead.
- Chart one is a hand-drawn SVG line over every month: the punctuality share, or the median with a band up to P90. Chart two is a bar chart of the cancellation rate on the same months.
- A month with little data, by the rule of the heatmap (fewer than 15 stops, for the delay view fewer than 15 arrived stops), or with hours missing in the source, is drawn dashed with a hollow point (bars lighter); a month without stops is a hole in the line. A legend line says so. The delay scale includes the medians, which can be below zero.
- Dotted markers above chart one: "Fahrplanwechsel" at each mid-December change from `/datenstand` and "Datenbasis erweitert" at the start of full coverage. The coverage marker is left out when the first month shown already is that month. When it is shown, the note under the chart explains it with the months from `/datenstand` ("Bis Okt 25 nur rund 130 große Bahnhöfe, ab Nov 25 alle.").
- Hover or tap on a month shows a tooltip, for example "Mär 26 · 78 % pünktlich · n = 1.240", with " · 12 h ohne vollständige Daten" for gaps. A month with little data shows no value: "Feb 25 · n = 9 · zu wenig Daten", like the table. The tooltip is the one of the heatmap (shared in `ui.tsx`).
- "Als Tabelle anzeigen" replaces the charts with a table: one row per month with the values, n and the hours without data.
- States: skeleton, empty card when no month has a stop, a card "Diese Linie gibt es in den Daten nicht (mehr)" (or the station one) with "Auswahl entfernen" when the API answers 404, error banner. The page waits for `/datenstand` as well, because gaps and markers come from it.

**Mobile (below 768 px)**

- Sidebar replaced by a top bar with the logo mark and the search field, and a bottom tab bar Karte, Muster, Planen, Mehr. Unbuilt tabs read "bald". The Muster tab links to `/muster`, which redirects to the heatmap, so the tab stays current on all three pattern pages.
- On each pattern page a "Muster" segmented switch Heatmap · Rankings · Zeitverlauf sits above the heading and keeps the query string. Its first label is the short "Heatmap" because the sidebar label does not fit at 375 px.
- Filter chips scroll sideways; the metric switch is one sideways-scrolling row.
- The heatmap is transposed to 24 hour rows × 7 weekday columns, with a "Ø" row for the weekday totals. The page never scrolls sideways.
- From 1024 px the heatmap and "Auf einen Blick" sit side by side.

**API used by the shell**

- `GET /datenstand` returns `monate` and `bahnhoefe` for the sidebar footer and `/mehr`, and `monate` and `vollabdeckung_ab` for the Zeitraum picker.
- `GET /stationen/{eva}` resolves `bhf` to a name after a reload; 404 for an unknown EVA.
- `GET /stationen?q=&limit=` feeds the station combobox and the search field.
- `GET /heatmap` feeds the page (see [patterns.md](patterns.md)).
- `GET /rankings` feeds the rankings page; `GET /zeitverlauf` and `GET /datenstand` (`fehlende_stunden`, `fahrplanwechsel`, `vollabdeckung_ab`) feed the time series.

## 3 Decisions

- **Path routes, not hash routes.** Reason: design.md asks for shareable links, and the mockup's hash routes were only a single-file device.
- **React Router (declarative mode).** Reason: product owner's choice; the app has few routes and no data-router needs.
- **Native HTML and Tailwind, no component library.** Reason: the design is small and specific; `<select>`, `popover` and `<table>` cover the controls and keep accessibility native.
- **Mobile layout in the first shell milestone.** Reason: retrofitting a transposed grid and tab bar later would rework the page.
- **The heatmap is a semantic `<table>`** with a caption, header cells and hidden text in every cell, for example "Montag 7–8 Uhr: 72 % pünktlich, n = 1.240". "Als Tabelle anzeigen" shows those values in the cells. Reason: this is the accessible alternative design.md asks for, without a second component.
- **The Zeitraum is a pair of month selects, not presets or a calendar.** Reason: the data is monthly, so a month is the finest useful unit; native selects need no library and keep the 44 px hit areas.
- **Weekday totals come from the backend** (`tage`, from the summed histogram), not from the browser. Reason: a mean of cell medians is statistically wrong; the mockup averages medians.
- **Colour classes follow the displayed, rounded value** (whole % and minutes, cancellations to one decimal). Reason: colour and printed number always agree. The boundary: 0.894 shows 89 % (class 2), 0.895 shows 90 % (class 1). The mockup classes the raw value, which would put 0.895 in class 2.
- **The low-data rule counts arrived stops for the delay metrics**: `n × (1 − ausfallquote)`, because the median, P90 and punctuality come from arrived stops only. Ausfälle uses `n`. Reason: 20 stops with half cancelled would otherwise show a confident-looking value from 10 arrivals.
- **Cancellations are shown with one decimal** ("2,5 %"), although design.md asks for whole percentages. Reason: the class limit 3.5 % needs it.
- **"Halte" instead of "Ankünfte"** in the meta line. Reason: n includes cancelled stops.
- **Mobile hit areas are at least 44 px without changing the visual size.** A `hit` utility adds an invisible 44 px area behind chips, buttons and the metric switch. Reason: design.md §5; the mockup's 32 px chips would be too small to tap. For the same reason the metric switch is one sideways-scrolling row on mobile: two wrapped rows leave no room for 44 px areas without overlap.
- **Dates and weekdays come from ICU** (`Intl`, de-DE or en-GB by language): "Sept. 2026", "Mo." and "Montag". Reason: English follows without extra code; the mockup's "Sep 2026" is not what ICU produces.
- **The mockup's "Bald" group is included** (Live-Lage heute, Verspätungsketten, Gespeicherte Fahrten). Reason: the mockup wins over the earlier plan.
- **Inter is bundled with Fontsource** (`@fontsource-variable/inter`), no CDN. Reason: no third-party request at runtime. The no-library alternative is copying the woff2 and writing `@font-face` by hand, but the package carries version and licence.
- **No icon library.** The mockup's SVG paths live in one `Icon` component. Reason: about a dozen icons do not justify a dependency.
- **The logo is two static SVGs in `frontend/public/`.** `favicon.svg` is the mark: a white Germany silhouette with a railway track on the gradient badge, used as tab icon and in the mobile top bar. `logo.svg` is the wordmark: the mark plus "Gleisatlas" in Inter 650 as outlines (taken from the bundled font with fontTools and HarfBuzz), used in the sidebar and the README. Its text colours are literal copies of `--text` light and dark, switched by `prefers-color-scheme` inside the SVG, which follows the page's `color-scheme`. Reason: a favicon cannot read CSS tokens, and text as outlines keeps logo and name aligned in every renderer, GitHub included.
- **The page logo is an `<h2>` in the `<header>`.** Reason: one banner landmark on desktop and mobile; the page's `<h1>` follows in the main area.
- **Unbuilt pages are `<span>`s, not links.** Reason: a dead link is worse than an honest "bald".
- **The time series is hand-drawn SVG, with no chart library.** The chart width is measured with a `ResizeObserver`, so the text stays 11 px on a phone instead of scaling down. Reason: two small charts and a sparkline do not justify a dependency, and the existing charts are plain markup too. The cost is hand-written scales, gridline ticks and the band.
- **Cancellations have their own chart on the time series.** Reason: a cancellation is not a delay (AC-7); mixing the rate into the delay chart would suggest a common scale.
- **The time series switch has two views, not the four metrics.** Verspätung draws the median with the P90 band, so P90 needs no view of its own, and Ausfälle is always shown below. Reason: four lines on one chart would repeat what the band already says.
- **`linie` is a filter key, and a line wins over a station.** Reason: with `linie` among the filters every write keeps it, and a line page and a station page never mix. Pages that cannot use a line drop it, like the station page drops `bhf`. When the user picks a station in the Bahnhof chip, the line is dropped instead, because the pick is the newer choice.
- **The time series has no Zeitraum picker.** Reason: the series always covers every month, and it marks where full coverage begins instead of hiding the earlier months.
- **Timetable changes and the coverage start are markers, not splits.** Reason: product owner's choice (SPEC O6); see [patterns.md](patterns.md) §3.
- **Month labels are three letters and the year** ("Mär 26", from ICU's long month name). Reason: 27 columns have to carry labels on a phone, and a fixed three letters keep them the same width.
- **The tooltip lives in `ui.tsx`**, shared by the heatmap, the time series and the station card's sparkline. Reason: three pages need the same hover, tap and scroll behaviour, and one copy keeps them equal.
- **`Segmented` is one component** for the metric switch, the Linien · Bahnhöfe switch, the minimum sample and the tabs of the rankings. Reason: same look and hit areas; `tabs` swaps the pressed buttons for a tab list.
- **The rankings columns become tabs below 768 px.** Reason: ten rows with a bar and two figures do not fit two columns on a phone, and tabs avoid a very long page.
- **Line rows link to the time series, station rows to the station page.** Reason: a line has no page of its own, and the series is the most direct answer to "how has it done".
- **The mobile Muster tab links to `/muster`**, a redirect to the heatmap. Reason: a tab that points at the heatmap would lose its highlight on the other two pattern pages; `/muster` matches all of them by prefix.

## 4 Architecture and data keys

- `frontend/src/App.tsx`: routes, `Shell` (sidebar, mobile top bar, tab bar, footer), `/mehr`, data note.
- `frontend/src/HeatmapPage.tsx`: the page, grid, legend, tooltip, insights and states.
- `frontend/src/RankingsPage.tsx`: the rankings page, its two lists and rows.
- `frontend/src/ZeitverlaufPage.tsx`: the time series page, the SVG `Plot`, `Line`, `Band` and `Markers`, the table mode, and the exported `Sparkline` that the station page uses.
- `frontend/src/Filters.tsx`: filter bar, the station chip and the line chip.
- `frontend/src/ui.tsx`: also `Segmented`, `MusterSwitch`, the shared tooltip (`useTip`, `tipAt`, `TipBox`), `Badge`, `MiniBar` and `Cancelled`.
- `frontend/src/metrics.ts`: pure functions, no React: metric definitions with class limits, `classOf`, number and date formats (`formatMonth`), `readFilters` and `writeFilters` for the URL keys, `readRank` and `writeRank` for `typ` and `min`.
- `frontend/src/Icon.tsx`: the icon set. `frontend/src/api.ts`: typed client over `schema.d.ts`; `must()` turns any non-2xx response into a query error.
- UI text only via the catalogs `frontend/src/i18n/de.ts` and `en.ts` (`t()`, and `tx()` for placeholders filled with React nodes). Colours only via the tokens in `frontend/src/theme.css`; component classes in `index.css` use tokens only. Both rules are stated in [CLAUDE.md](../CLAUDE.md). `frontend/src/prefs.ts` holds the theme and language preferences; see [theme-and-language.md](theme-and-language.md).
- `frontend/src/schema.d.ts` is generated from `backend/openapi.json`: `uv run python scripts/export_openapi.py`, then `npm --prefix frontend run gen`. The gate fails when it is stale (`gen:check`).
- Tests: `frontend/e2e/*.spec.ts` run in Playwright against fixtures served through `page.route` (`frontend/e2e/fixtures.ts`), never a backend. Three projects: desktop Chromium, a Pixel 7 profile (also Chromium), and `csp`, which runs only `csp.spec.ts` against the production build.

## 5 Milestones

- [x] App shell per design: sidebar, routing, filter bar, heatmap view, mobile layout, Inter bundled. Re-check: `npm --prefix frontend run test:e2e` passes, including `frontend/e2e/shell.spec.ts` (redirects, query string kept, Inter loaded, sidebar and "bald" items, mobile tab bar and transposed grid, Mehr) and `frontend/e2e/heatmap.spec.ts` (grid, class boundaries, only-cancelled cells, low-data gate, tooltip, table mode, filters, reset, share, empty and error states, 44 px hit areas).

- [x] Zeitraum picker. Re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/period.spec.ts` (12 months offered with the defaults selected, a pick writes `von` and `bis` and the next request carries both, crossing edges, map and station page, reset, mobile without sideways scroll and with 44 px hit areas).

- [x] Rankings page. Re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/rankings.spec.ts` (two columns of ten with rank, name, value, n and cancellation rate; meta line; the request carries the defaults only; the URL drives the request and the controls; the switches write the URL; invalid values and `bhf` dropped; station and line rows link on with the filters; sidebar and filter bar; empty and error states; Teilen; mobile tabs and 44 px hit areas).
- [x] Time series page. Re-check: `frontend/e2e/zeitverlauf.spec.ts` (nationwide request and title; no period picker; a station and the category in the request; a line wins over a station and its chip is removable, picking a station replaces the line, an unknown line or station has its own state; holes, dashes for low n and gaps; markers and the omitted coverage marker; the median band; tooltip with value, n and missing hours, no value for a month with few arrivals (dashes, hollow points, tooltip), a median below zero stays in the plot; the cancellation bars; table mode; empty and error states; sidebar link; a filter change keeps the page mounted; mobile without sideways scroll and without overlapping marker labels, tap tooltip).
- [x] Muster navigation. Re-check: `frontend/e2e/shell.spec.ts` ("the Muster switch moves between Heatmap, Rankings and Zeitverlauf", "the Muster tab leads to the heatmap and keeps the filters", the sidebar test).

## 6 Platform checks

- [ ] Static Web Apps serves `index.html` for path routes such as `/muster/heatmap` on reload (SPA fallback), with a direct visit and a shared link. Verify on Azure.
- [ ] The station popover sits below its chip in Firefox and Safari. Without anchor positioning it falls back to a centred popover; tick when the product owner has seen both browsers.

## 7 Open decisions

- Whether the Zeitraum picker also gets presets such as "last 3 months" next to the two month selects.
- Which single categories (S, RB, ICE …) become filter values; they need a new aggregate key.

## 8 Known shortcuts

- The Linie chip exists only on the time series. The heatmap, the map and the rankings do not filter by line; they drop a `linie` key.
- The rankings' minimum sample offers four values although the API accepts any value from 15, and the empty state has no one-click "lower the sample" button.
- The time series compares no second series (see [patterns.md](patterns.md) §8).
- The station search has no debounce; see [map.md](map.md) §8.
- Teilen gives no feedback when the browser denies the clipboard.
- An unknown station in `bhf` on the heatmap shows the generic empty state, not "Diesen Bahnhof kennen wir nicht" with a search (design.md §7); the station page has that state (see [map.md](map.md)).
- The sidebar has no collapse to a rail.
- A valid month outside the data range in `von` or `bis` leaves its select blank; the API returns what it has.
- The station popover is positioned with CSS anchor positioning, with the centred default as fallback (see Platform checks).
