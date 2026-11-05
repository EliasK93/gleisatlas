# App shell

## 1 Overview

The frame around every page: sidebar, filter bar, mobile top bar and tab bar, footer, and the three pattern pages: the weekday × hour heatmap, the rankings and the time series. Visual targets are in [design.md](design.md) and the clickable [mockup](design/mockup.html); where they differ, the mockup wins. The metrics and API behind the pattern pages are described in [patterns.md](patterns.md); the map start page, the station detail page and the search are in [map.md](map.md).

## 2 Spec

**Routes**

| Path | Page |
|---|---|
| `/karte` | Map start page (see [map.md](map.md)) |
| `/bahnhof/{eva}` | Station detail page (see [map.md](map.md)) |
| `/lage` | Live-Lage: the map of the 131 large stations for one day, today by default (see [day-history.md](day-history.md)) |
| `/linie/{id}` | Line page: the line's stations and Zeitfresser (see [lines.md](lines.md)); the id is percent-encoded |
| `/muster/heatmap` | Heatmap "Wann ist es am schlimmsten?" |
| `/muster/rankings` | Rankings of stations or lines |
| `/muster/zeitverlauf` | Time series by day (default) and by month |
| `/muster` | Redirect to `/muster/heatmap`, query string kept |
| `/mehr` | Mobile list of the remaining items, the Darstellung and Sprache switches, data status and the "not a DB service" note |
| `/` and any unknown path | Redirect to `/karte`, query string kept |

**URL keys** (all filter state lives in the URL, so a link restores the view)

| Key | Values | Default when omitted |
|---|---|---|
| `g` | `regional`, `fern` | all categories |
| `bhf` | EVA number | all stations |
| `von`, `bis` | `YYYY-MM`, or `YYYY-MM-DD` (read by the Karte, rounded outward to months by the other pages) | `von`: first month with full coverage (on the Karte its first day); `bis`: last month (on the Karte the last complete day) |
| `tag` | `YYYY-MM-DD` (Live-Lage; on the line page the day of its Bildfahrplan) | the newest day (today, else the newest collector day, else the last complete day); a day outside the days served is clamped to the newest one; on the line page the last day of the Bildfahrplan's window, and a day outside it is dropped |
| `land` | a state code such as `nw` (Live-Lage only) | Germany |
| `k` | `median`, `p90`, `ausfall` | punctuality |
| `typ` | `linien` (rankings only) | `bahnhoefe` |
| `min` | `100`, `1000`, `5000` (rankings only) | `500` |
| `art` | `zuege` (rankings of lines only: single trains) | `linien`; dropped for `typ=bahnhoefe` |
| `linie` | a line id (time series only) | no line |
| `z` | `monat` (time series only) | the day view |
| `richtung` | `2` (line page only) | direction 1, along the line's axis ([lines.md](lines.md)); `1` is never written |

Unknown or invalid values fall back to the default and are removed from the URL once. Keys are always written in one fixed order: `g`, `bhf`, `von`, `bis`, `tag`, `land`, `linie`, `z`, `richtung`, `k`, then `typ`, `min` and `art`. Sidebar and tab-bar links carry the current query string, so filters persist across pages. A page drops the keys it has no meaning for: `bhf` on the rankings and on the time series when a `linie` is set, `linie` and `z` on every page but the time series, `tag` on every page but Live-Lage and the line page, `land` on every page but Live-Lage (the Karte included), `richtung` on every page but the line page, `typ`, `min` and `art` on every page but the rankings (`art` on the rankings of stations too), and on the line page `g`, `bhf`, `land`, `linie` and `z` ([lines.md](lines.md) §2). The line page keeps `tag` as the day of its Bildfahrplan: it stays while the line loads, then only a day inside the window the API names and other than its last day stays. Live-Lage is the exception for `g`, `von` and `bis`: it ignores them and leaves them in the URL, so Karte → Live-Lage → Karte restores the Gattung and the period. Its day and chips are described in [day-history.md](day-history.md) §2. What `bhf` means on the map and on the station page is described in [map.md](map.md).

**Sidebar** (from 768 px): logo, the search field for stations and lines (see [map.md](map.md)), then the groups "Entdecken" (Karte, Live-Lage, Wochentag × Uhrzeit, Rankings, Zeitverlauf), "Planen" (Verbindung planen, Umstieg prüfen) and "Bald" (Gespeicherte Fahrten), then "So liest man die Zahlen". Karte, Live-Lage, Wochentag × Uhrzeit, Rankings and Zeitverlauf are links. Every other item is dimmed with a "bald" tag and is not a link; it becomes a link when its page ships. Above the footer sit the Darstellung (theme) and Sprache (language) switches, described in [theme-and-language.md](theme-and-language.md). The footer shows "Datenstand: {month} · {n} Bahnhöfe" and "Kein Angebot der Deutschen Bahn." The page footer with the disclaimer, that sentence and the source with the CC BY 4.0 link is hidden on the map, which fills the viewport.

**Filter bar**

- Zeitraum: two native month `<select>`s ("von" and "bis"), filled from `/datenstand` `monate`. They show the URL's `von` and `bis`, or the defaults (full coverage start, last month), and write both to the URL. A pick that crosses the other edge moves that edge to the same month. The chip is highlighted only when `von` or `bis` is set. The time series hides it: that page always shows every month.
  - A day in the URL (made on the Karte) shows as its month in the select, rounded outward: `von` down to its month, `bis` up to its month, and a month outside the data as the nearest month with data. The pages' requests carry the same months (`useMonthPeriod`); with a period in the URL they wait for `/datenstand`, and go unclamped if it fails. The URL keeps its days until a select is changed, which writes months for both edges.
  - On the Karte the chip holds two native date fields instead, limited to `erster_tag` and `letzter_tag`, described in [map.md](map.md) §2. `DayField` in `Filters.tsx` is the same field Live-Lage uses for `tag`.
- Linie (time series only): without a `linie`, a chip "Linie" with a chevron that opens a native `popover` below it, holding the search in its lines-only scope (`/suche`, the lines group only, no group headings; the field "Linie suchen", the placeholder "Linie suchen …", "Keine Linie gefunden" when nothing matches). A pick sets `linie`, drops `bhf`, and closes the popover. With a `linie`, a highlighted chip "Linie: {label}" and a button "Linie entfernen" that drops the key; the title part of that chip is the picker's button too, so a pick there replaces the line. The rules of the search are in [map.md](map.md).
- Live-Lage: instead of Zeitraum and Gattung, a date field (`<input type="date">`, from the first day of the data to the newest day) and a group "Letzte Tage" of three chips: Heute, Gestern and Vorgestern (the pressed one is the shown day). A chip whose day has no map is disabled and names the reason in its title and in a hidden description for screen readers; every other day goes through the date field. Station and Zurücksetzen as elsewhere. On a phone the whole bar is one sideways-scrolling row like the other bars, so the chips never wrap.
- Gattung: native `<select>` with Alle, Regionalverkehr, Fernverkehr. "Regionalverkehr" is everything that is not long-distance (S-Bahn, RB, RE and regional operators); buses are excluded in the pipeline.
- Bahnhof: a chip that opens a native `popover` with a combobox over `/stationen` (stations only, the same `Picker` as the Linie chip). It shows name and "EVA …" and filters by EVA only.
- Zurücksetzen: clears all keys.

**Heatmap page**

- Header with breadcrumb, h1, lead text and "Teilen" (copies the URL, toast "Link kopiert").
- Metric switch: Pünktlichkeit, Typische Verspätung, Schlechteste 10 %, Ausfälle, with a line under it that explains the selected metric. Meta line "n = … Halte · period".
- 7 × 24 grid. Cells with fewer than 15 counted stops are hatched and show no value; below 50 the value gets a "~". A cell whose stops were all cancelled shows ✕ on the cancellation colour. The "Ø Tag" column comes from the API's `tage`.
- Five-class legend per metric, tooltip on hover or tap, "Als Tabelle anzeigen", and the card "Auf einen Blick" with the worst and best slot and a count of thin cells.
- States: skeleton grid while loading (after 5 s with the hint that the server is starting and the elapsed seconds, as on every page's skeleton; re-check: the "after 5 seconds" test in each page spec), empty state with "Filter zurücksetzen", error banner with "Erneut versuchen" that keeps the filters.
- Class limits, unchanged from the mockup: punctuality 90/80/70/60 %; median 1/2/4/7 min; P90 5/8/12/18 min; cancellations 1/2/3.5/5 % on their own scale.

**Rankings page**

- Header as on the heatmap, with a switch Linien · Bahnhöfe (`typ`) next to "Teilen". With Linien, a second switch Linien · Einzelzüge (`art`, default Linien; only `zuege` is written; the key and the switch are gone for Bahnhöfe, and the request names `art` only for single trains). The filter bar has no Bahnhof chip.
- A card with the metric switch (Pünktlichkeit, Typische Verspätung, Schlechteste 10 %, Ausfälle, key `k`), the minimum sample as a segmented control (100, 500, 1.000, 5.000, key `min`) and the meta line "{count} Bahnhöfe mit mindestens {min} Halten · period" (Linien or Einzelzüge in place of Bahnhöfe).
- Two cards, "Am unzuverlässigsten" and "Am zuverlässigsten", with the top ten each. From 1280 px they sit side by side, below that they stack, and below 768 px they are tabs. Under each title a header row names the figure columns: the selected metric in bold over the value, and "Ausfälle" in the grey of the cancellation figures over the last column.
- A row shows rank, the train-type badge for a line, the name, "n Halte", a thin bar, the value and the cancellation rate as its own grey "✕" figure. The cancellation figure never wraps ("✕ 10,9 %" stays on one line). The bar is a share of 100 for punctuality and relative to the largest value in view for the other metrics. The value follows the low-data rule of the heatmap.
- Every row is a link: a station row opens `/bahnhof/{eva}` with the filters, a line row opens the page of that line (`/linie/{id}`, [lines.md](lines.md)) with the same metric and the period, without the category.
- States: skeleton, empty card "Keine Einträge mit mindestens {min} Halten" with "Filter zurücksetzen" (the minimum-sample control stays visible above it), error banner with "Erneut versuchen".

**Time series page**

- Header as on the heatmap, "Teilen" included. The filter bar has no Zeitraum chip; with a `linie` it shows the line chip.
- The selection is nationwide, one station (`bhf`) or one line (`linie`); a line wins over a station, and picking a station in the Bahnhof chip drops the line. The title under the chart heading names it ("Deutschland gesamt", the station or the line label), and the meta line reads "n = … Halte · alle Tage (period)" in the day view and "n = … Halte · alle Monate (period)" in the month view.
- The shared metric switch with all four metrics, key `k`. Pünktlichkeit (`k` absent) draws the punctuality share. Typische Verspätung (`k=median`) draws the median with a band up to the P90. Schlechteste 10 % (`k=p90`) draws the P90 as the line, with the band reaching down to the median. Ausfälle (`k=ausfall`) makes the cancellation rate the main chart. Punctuality and the delay views keep the cancellation chart below.
- A second switch, "Auflösung", picks Tag or Monat. Days are the default (no key); Monat writes `z=monat`. With a `linie` the switch is hidden and the page stays monthly, because the day data has no line key. The rules and decisions of the day view are in [day-history.md](day-history.md); this page describes the shell around it.
- Day view: chart one draws the daily values as a faint line with the trend as a bold line over it, the selected metric: the punctuality share, the median or the P90, the two delay views with a band from the median trend to the P90 trend. Chart two draws the cancellation rate by day with its trend, or is the only chart when Ausfälle is selected. Days that the low-data rule thins or that have missing hours are dashed, by the same rule as the months. The tooltip names the weekday and date, the value, the trend, n and the missing hours; "Als Tabelle anzeigen" lists a row per day. The message texts are in `zv.*` of the catalogs.
- Month view: chart one is a hand-drawn SVG line over every month: the punctuality share, the median with a band up to the P90, or the P90 with a band down to the median. Chart two is a bar chart of the cancellation rate on the same months, and the only chart when Ausfälle is selected.
- A month with little data, by the rule of the heatmap (fewer than 15 stops, for the delay view fewer than 15 arrived stops), or with hours missing in the source, is drawn dashed with a hollow point (bars lighter); a month without stops is a hole in the line. A legend line says so. The delay scale includes the medians, which can be below zero.
- Dotted markers above chart one: "Fahrplanwechsel" at each mid-December change from `/datenstand` and "Datenbasis erweitert" at the start of full coverage. The coverage marker is left out when the first month shown already is that month. When it is shown, the note under the chart explains it with the months from `/datenstand` ("Bis Okt 25 nur rund 130 große Bahnhöfe, ab Nov 25 alle.").
- Hover or tap on a month shows a tooltip, for example "Mär 26 · 78 % pünktlich · n = 1.240", with " · 12 h ohne vollständige Daten" for gaps. A month with little data shows no value: "Feb 25 · n = 9 · zu wenig Daten", like the table. The tooltip is the one of the heatmap (shared in `ui.tsx`).
- "Als Tabelle anzeigen" replaces the charts with a table: one row per month with the values of the selected metric and the cancellation rate (median and P90 together for the delay views, only Ausfälle for Ausfälle), n and the hours without data.
- States: skeleton, empty card when no month has a stop, a card "Diese Linie gibt es in den Daten nicht (mehr)" (or the station one) with "Auswahl entfernen" when the API answers 404, error banner. The page waits for `/datenstand` as well, because gaps and markers come from it.

**Mobile (below 768 px)**

- Sidebar replaced by a top bar with the logo mark and the search field, and a bottom tab bar Karte · Live-Lage · Muster · Mehr. "Planen" (bald) is an entry of Mehr. The Muster tab links to `/muster`, which redirects to the heatmap, so the tab stays current on all three pattern pages.
- On each pattern page a "Muster" segmented switch Heatmap · Rankings · Zeitverlauf sits above the heading and keeps the query string. Its first label is the short "Heatmap" because the sidebar label does not fit at 375 px.
- Filter chips scroll sideways; the metric switch is one sideways-scrolling row.
- The heatmap is transposed to 24 hour rows × 7 weekday columns, with a "Ø" row for the weekday totals. The page never scrolls sideways.
- From 1024 px the heatmap and "Auf einen Blick" sit side by side.

**API used by the shell**

- `GET /datenstand` returns `monate` and `bahnhoefe` for the sidebar footer and `/mehr`, and `monate` and `vollabdeckung_ab` for the Zeitraum picker, `erster_tag` and `letzter_tag` for the Karte's date fields.
- `GET /stationen/{eva}` resolves `bhf` to a name after a reload; 404 for an unknown EVA.
- `GET /suche?q=&limit=` feeds the search field (stations and lines, [map.md](map.md)); `GET /stationen?q=&limit=` feeds the station combobox of the filter bar.
- `GET /heatmap` feeds the page (see [patterns.md](patterns.md)).
- `GET /rankings` feeds the rankings page; `GET /zeitverlauf` (months), `GET /tagesverlauf` (days) and `GET /datenstand` (`fehlende_stunden`, `fahrplanwechsel`, `vollabdeckung_ab`) feed the time series.

## 3 Decisions

- **Path routes, not hash routes.** Reason: design.md asks for shareable links, and the mockup's hash routes were only a single-file device.
- **React Router (declarative mode).** Reason: product owner's choice; the app has few routes and no data-router needs.
- **Native HTML and Tailwind, no component library.** Reason: the design is small and specific; `<select>`, `popover` and `<table>` cover the controls and keep accessibility native.
- **Mobile layout in the first shell milestone.** Reason: retrofitting a transposed grid and tab bar later would rework the page.
- **The heatmap is a semantic `<table>`** with a caption, header cells and hidden text in every cell, for example "Montag 7–8 Uhr: 72 % pünktlich, n = 1.240". "Als Tabelle anzeigen" shows those values in the cells. Reason: this is the accessible alternative design.md asks for, without a second component.
- **The Zeitraum is a pair of month selects, not presets or a calendar; only the Karte has day fields.** Reason: the heatmap, the rankings and the station page rest on month aggregates, so a month is the finest unit they can answer; native selects need no library and keep the 44 px hit areas. The Karte reads the day table and takes two native date fields ([map.md](map.md) §3).
- **A day in `von` or `bis` rounds outward on the month pages, and the URL keeps it.** Reason: a link from the Karte then opens the other pages with the months that contain the days, and the way back restores the days. Writing months into the URL on arrival would lose them.
- **Weekday totals come from the backend** (`tage`, from the summed histogram), not from the browser. Reason: a mean of cell medians is statistically wrong; the mockup averages medians.
- **Colour classes follow the displayed, rounded value** (whole % and minutes, cancellations to one decimal). Reason: colour and printed number always agree. The boundary: 0.894 shows 89 % (class 2), 0.895 shows 90 % (class 1). The mockup classes the raw value, which would put 0.895 in class 2.
- **The low-data rule counts arrived stops for the delay metrics**: `n × (1 − ausfallquote)`, because the median, P90 and punctuality come from arrived stops only. Ausfälle uses `n`. Reason: 20 stops with half cancelled would otherwise show a confident-looking value from 10 arrivals.
- **Cancellations are shown with one decimal** ("2,5 %"), although design.md asks for whole percentages. Reason: the class limit 3.5 % needs it.
- **"Halte" instead of "Ankünfte"** in the meta line. Reason: n includes cancelled stops.
- **Mobile hit areas are at least 44 px without changing the visual size.** A `hit` utility adds an invisible 44 px area behind chips, buttons and the metric switch. Reason: design.md §5; the mockup's 32 px chips would be too small to tap. For the same reason the metric switch is one sideways-scrolling row on mobile: two wrapped rows leave no room for 44 px areas without overlap.
- **Dates and weekdays come from ICU** (`Intl`, de-DE or en-GB by language): "Sept. 2026", "Mo." and "Montag". Reason: English follows without extra code; the mockup's "Sep 2026" is not what ICU produces.
- **The mockup's "Bald" group is included** (Gespeicherte Fahrten; Verspätungsketten left it when the line page came, [lines.md](lines.md)). Reason: the mockup wins over the earlier plan.
- **Live-Lage is a link under "Entdecken" after Karte, and on a phone it takes the tab bar slot of "Planen", which moves into Mehr.** Reason: the page is built and is a view of the data like the others, so it leaves "Bald"; a phone's tab bar has room for four, and "Planen" has no page yet while Live-Lage is the page to open first on a phone. The product owner chose this.
- **On a phone the Live-Lage filter bar is one sideways-scrolling row, like every other filter bar.** Reason: with the day chips wrapped (measured with seven of them, before they were cut to three) the card was 227 px tall, against 173 px on the Karte. On a 375×700 phone the open legend and the Germany card then covered the filters (86 px overlap on a past day), and the start view put Germany behind the cards. As one row the card ends at the same 173.5 px as the Karte's, the start view keeps the fixed 140 px room, and the Germany card with the legend open stands clear of the filter card (top at 207.7 px). Every chip stays reachable by scrolling. The product owner chose this over wrapping.
- **Inter is bundled with Fontsource** (`@fontsource-variable/inter`), no CDN. Reason: no third-party request at runtime. The no-library alternative is copying the woff2 and writing `@font-face` by hand, but the package carries version and licence.
- **No icon library.** The mockup's SVG paths live in one `Icon` component. Reason: about a dozen icons do not justify a dependency.
- **The logo is two static SVGs in `frontend/public/`.** `favicon.svg` is the mark: a white Germany silhouette with a railway track on the gradient badge, used as tab icon and in the mobile top bar. `logo.svg` is the wordmark: the mark plus "Gleisatlas" in Inter 650 as outlines (taken from the bundled font with fontTools and HarfBuzz), used in the sidebar and the README. Its text colours are literal copies of `--text` light and dark, switched by `prefers-color-scheme` inside the SVG, which follows the page's `color-scheme`. Reason: a favicon cannot read CSS tokens, and text as outlines keeps logo and name aligned in every renderer, GitHub included.
- **The page logo is an `<h2>` in the `<header>`.** Reason: one banner landmark on desktop and mobile; the page's `<h1>` follows in the main area.
- **Unbuilt pages are `<span>`s, not links.** Reason: a dead link is worse than an honest "bald".
- **The time series is hand-drawn SVG, with no chart library.** The chart width is measured with a `ResizeObserver`, so the text stays 11 px on a phone instead of scaling down. Reason: two small charts and a sparkline do not justify a dependency, and the existing charts are plain markup too. The cost is hand-written scales, gridline ticks and the band.
- **Cancellations have their own chart on the time series.** Reason: a cancellation is not a delay (AC-7); mixing the rate into the delay chart would suggest a common scale.
- **Every page offers the same four metrics through the same switch and one key `k`, and links pass `k` on unchanged.** Reason: a choice then survives every page change, which two views on the time series (with `k=p90` folded to the median) did not allow.
- **An explanation line sits under the metric switch** (`metric.<m>.help`, rendered by `MetricSwitch`, the switch's group is described by it through `aria-describedby`). The detail page's tile terms and the map legend reuse it or leave it out. Reason: the four metrics are the product's vocabulary, and "Schlechteste 10 %" and "Typische Verspätung" say little without a definition; one line in one place keeps the wording equal on every page. The line is as wide as the switch, so it wraps there and never widens a card. On phones the floating card of the Karte and Live-Lage hides the line (`helpOnPhone={false}`); the switch is still described by it through `aria-describedby`, and every other page and every desktop shows it. Reason: the card would grow by about 40 px and cover the north of Germany at the start view and, on short phones, the open legend.
- **The P90 is named "Schlechteste 10 %" (en "Worst 10%").** "P90" appears only in the explanation text and as the URL value. Reason: the P90 is the threshold the latest tenth of arrivals reaches, which the plain name says; "schlechte Tage" described days, not arrivals.
- **`linie` is a filter key, and a line wins over a station.** Reason: with `linie` among the filters every write keeps it, and a line page and a station page never mix. Pages that cannot use a line drop it, like the station page drops `bhf`. When the user picks a station in the Bahnhof chip, the line is dropped instead, because the pick is the newer choice; picking a line in the Linie chip drops the station by the same rule.
- **The Linie chip is a picker, and without a line it reads "Linie: Alle", like the Bahnhof chip.** Reason: the product owner's choice after the test round, so both chips read alike; the highlighted chip stays the sign that a line is set. The title of the highlighted chip opens the same picker, so the line can be changed without removing it first. One `Picker` component serves the Bahnhof and the Linie chip (it replaces `StationFilter`): a button with a chevron and a native popover around the search field, anchored by a per-picker CSS anchor name.
- **The Linie chip is a prop of the filter bar (`lines`), passed by the time series only.** It used to show on any page whose URL had a `linie`; every other page drops that key, so nothing visible changed.
- **The time series has no Zeitraum picker.** Reason: the series always covers every month, and it marks where full coverage begins instead of hiding the earlier months.
- **Timetable changes and the coverage start are markers, not splits.** Reason: product owner's choice (SPEC O6); see [patterns.md](patterns.md) §3.
- **Month labels are three letters and the year** ("Mär 26", from ICU's long month name). Reason: a few dozen columns have to carry labels on a phone, and a fixed three letters keep them the same width.
- **The tooltip lives in `ui.tsx`**, shared by the heatmap, the time series and the station card's sparkline. Reason: three pages need the same hover, tap and scroll behaviour, and one copy keeps them equal.
- **`Segmented` is one component** for the metric switch, the Linien · Bahnhöfe switch, the minimum sample and the tabs of the rankings. Reason: same look and hit areas; `tabs` swaps the pressed buttons for a tab list.
- **The rankings columns become tabs below 768 px.** Reason: ten rows with a bar and two figures do not fit two columns on a phone, and tabs avoid a very long page.
- **Line rows link to the line page, station rows to the station page.** Reason: a line has a page of its own ([lines.md](lines.md) §3), and the time series stays one click away from it through the sparkline.
- **The mobile Muster tab links to `/muster`**, a redirect to the heatmap. Reason: a tab that points at the heatmap would lose its highlight on the other two pattern pages; `/muster` matches all of them by prefix.

## 4 Architecture and data keys

- `frontend/src/App.tsx`: routes, `Shell` (sidebar, mobile top bar, tab bar, footer), `/mehr`, data note.
- `frontend/src/HeatmapPage.tsx`: the page, grid, legend, tooltip, insights and states.
- `frontend/src/RankingsPage.tsx`: the rankings page, its two lists and rows.
- `frontend/src/ZeitverlaufPage.tsx`: the time series page (the resolution switch, month and day rows, the table mode) and the exported `Sparkline` that the station page uses.
- `frontend/src/charts.tsx`: the chart pieces shared by both resolutions: `Plot`, `Line`, `TrendLine`, `Band`, `Markers`, `Sized`, `tipOf` and `niceTicks`.
- `frontend/src/Filters.tsx`: filter bar, `Picker` (the popover around a station or line search, used by the Bahnhof chip and the Linie chip; the prop `lines` of `Filters` turns the Linie chip on, `lineTitle` names the set line), and `DayField`, the native date field of the Karte's Zeitraum and Live-Lage's day.
- `frontend/src/ui.tsx`: also `Page` and `PageTitle` (the wrapper and the h1 every pattern page and the station page share), `Pulse` (the loading block with its hidden `state.loading` label), `TableToggle` ("Als Tabelle anzeigen"), `Segmented`, `MusterSwitch`, the shared tooltip (`useTip`, `tipAt`, `TipBox`; `local` for the map's absolutely positioned one), `Badge`, `MiniBar` and `Cancelled`.
- `frontend/src/metrics.ts`: pure functions, no React: metric definitions with class limits, `classOf`, number and date formats (`formatMonth`, `formatRaw` for a raw API value as the metric's text), `lineSearch` (the time series link of a line), `readFilters` and `writeFilters` for the URL keys, `readRank` and `writeRank` for `typ`, `min` and `art`.
- `frontend/src/Icon.tsx`: the icon set. `frontend/src/api.ts`: typed client over `schema.d.ts`; `must()` turns any non-2xx response into a query error; `useStation` is the one lookup of a station by EVA.
- UI text only via the catalogs `frontend/src/i18n/de.ts` and `en.ts` (`t()`, and `tx()` for placeholders filled with React nodes). Colours only via the tokens in `frontend/src/theme.css`; component classes in `index.css` use tokens only. Both rules are stated in [CLAUDE.md](../CLAUDE.md). `frontend/src/prefs.ts` holds the theme and language preferences; see [theme-and-language.md](theme-and-language.md).
- `frontend/src/schema.d.ts` is generated from `backend/openapi.json`: `uv run python scripts/export_openapi.py`, then `npm --prefix frontend run gen`. The gate fails when it is stale (`gen:check`).
- Tests: `frontend/e2e/*.spec.ts` run in Playwright against fixtures served through `page.route` (`frontend/e2e/fixtures.ts`), never a backend. Three projects: desktop Chromium, a Pixel 7 profile (also Chromium), and `csp`, which runs only `csp.spec.ts` against the production build.

## 5 Milestones

- [x] App shell per design: sidebar, routing, filter bar, heatmap view, mobile layout, Inter bundled. Re-check: `npm --prefix frontend run test:e2e` passes, including `frontend/e2e/shell.spec.ts` (redirects, query string kept, Inter loaded, sidebar and "bald" items, mobile tab bar and transposed grid, Mehr) and `frontend/e2e/heatmap.spec.ts` (grid, class boundaries, only-cancelled cells, low-data gate, tooltip, table mode, filters, reset, share, empty and error states, 44 px hit areas).

- [x] Zeitraum picker. Re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/period.spec.ts` (12 months offered with the defaults selected, a pick writes `von` and `bis` and the next request carries both, crossing edges, map and station page, reset, mobile without sideways scroll and with 44 px hit areas; days in the URL round outward to months: "days in the URL round outward to months on the pattern pages, which request months", "a day past the last month asks for the last month, where the select stands", "days in the URL round outward to months on the station page").

- [x] Rankings page. Re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/rankings.spec.ts` (two columns of ten with rank, name, value, n and cancellation rate; meta line; the request carries the defaults only; the URL drives the request and the controls; the switches write the URL; invalid values and `bhf` dropped; station and line rows link on with the filters; sidebar and filter bar; empty and error states; Teilen; mobile tabs and 44 px hit areas).
- [x] Time series page. Re-check: `frontend/e2e/zeitverlauf.spec.ts` (nationwide request and title; no period picker; a station and the category in the request; a line wins over a station and its chip is removable, picking a station replaces the line, an unknown line or station has its own state; holes, dashes for low n and gaps; markers and the omitted coverage marker; the median band; tooltip with value, n and missing hours, no value for a month with few arrivals (dashes, hollow points, tooltip), a median below zero stays in the plot; the cancellation bars; table mode; empty and error states; sidebar link; a filter change keeps the page mounted; mobile without sideways scroll and without overlapping marker labels, tap tooltip). The day view is in the `day view` block of the same file: it is the default and requests `/tagesverlauf`, the switch writes and drops `z=monat`, a line URL has no switch and stays monthly, the station and category reach the request, one bold trend line over thin day segments, the median trend with a band up to the P90 trend, dashes for the day with gaps and the day with little data, the tooltip with date, value, trend, n and missing hours, the cancellation chart, the table by day, the empty, unknown-station and error states, and 375 px without sideways scroll.
- [x] The Linie picker on the time series, passed the product owner's test round. Re-check: `frontend/e2e/zeitverlauf.spec.ts` ("the Linie chip opens a line picker; a pick sets the line, drops the station and asks for its series", "with a line set, its chip opens the picker to change the line", "the line picker says when no line matches"; the existing tests on the line chip, its removal and a station pick replacing the line stay as they were).
- [x] Muster navigation. Re-check: `frontend/e2e/shell.spec.ts` ("the Muster switch moves between Heatmap, Rankings and Zeitverlauf", "the Muster tab leads to the heatmap and keeps the filters", the sidebar test).

## 6 Platform checks

- [x] Static Web Apps serves `index.html` for path routes such as `/muster/heatmap` on reload (SPA fallback), with a direct visit and a shared link. Verify on Azure.
- [ ] The station popover sits below its chip in Firefox and Safari. Without anchor positioning it falls back to a centred popover; tick when the product owner has seen both browsers. Firefox seen; Safari open.

## 7 Open decisions

- Whether the Zeitraum picker also gets presets such as "last 3 months" next to the two month selects.
- Which single categories (S, RB, ICE …) become filter values; they need a new aggregate key.

## 8 Known shortcuts

- The Linie chip exists only on the time series. The heatmap, the map and the rankings do not filter by line; they drop a `linie` key.
- The rankings' minimum sample offers four values although the API accepts any value from 15 (`ponytail:` at `MIN_NS` in `metrics.ts`), and the empty state has no one-click "lower the sample" button.
- The time series compares no second series (see [patterns.md](patterns.md) §8).
- The station search has no debounce; see [map.md](map.md) §8.
- Teilen gives no feedback when the browser denies the clipboard (`ponytail:` in `ShareButton`).
- An unknown station in `bhf` on the heatmap shows the generic empty state, not "Diesen Bahnhof kennen wir nicht" with a search (design.md §7); the station page has that state (see [map.md](map.md)).
- The sidebar has no collapse to a rail.
- The station popover is positioned with CSS anchor positioning, with the centred default as fallback (see Platform checks).
