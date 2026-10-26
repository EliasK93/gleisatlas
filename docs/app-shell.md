# App shell

## 1 Overview

The frame around every page: sidebar, filter bar, mobile top bar and tab bar, footer and the weekday × hour heatmap. Visual targets are in [design.md](design.md) and the clickable [mockup](design/mockup.html); where they differ, the mockup wins. The heatmap metrics and API are described in [patterns.md](patterns.md); the map start page, the station detail page and the search are in [map.md](map.md).

## 2 Spec

**Routes**

| Path | Page |
|---|---|
| `/karte` | Map start page (see [map.md](map.md)) |
| `/bahnhof/{eva}` | Station detail page (see [map.md](map.md)) |
| `/muster/heatmap` | Heatmap "Wann ist es am schlimmsten?" |
| `/mehr` | Mobile list of the remaining items, data status and licence |
| `/` and any unknown path | Redirect to `/karte`, query string kept |

**URL keys** (all filter state lives in the URL, so a link restores the view)

| Key | Values | Default when omitted |
|---|---|---|
| `g` | `regional`, `fern` | all categories |
| `bhf` | EVA number | all stations |
| `von`, `bis` | `YYYY-MM` | whole data range |
| `k` | `median`, `p90`, `ausfall` | punctuality |

Unknown or invalid values fall back to the default and are removed from the URL once. Sidebar and tab-bar links carry the current query string, so filters persist across pages. What `bhf` means on the map and on the station page is described in [map.md](map.md).

**Sidebar** (from 768 px): logo, the station search field (see [map.md](map.md)), then the groups "Entdecken" (Karte, Wochentag × Uhrzeit, Rankings, Zeitverlauf), "Planen" (Verbindung planen, Umstieg prüfen) and "Bald" (Live-Lage heute, Verspätungsketten, Gespeicherte Fahrten), then "So lesen Sie die Zahlen". Karte and Wochentag × Uhrzeit are links. Every other item is dimmed with a "bald" tag and is not a link; it becomes a link when its page ships. The footer shows "Datenstand: {month} · {n} Bahnhöfe" and the CC BY 4.0 link. The page footer with the disclaimer is hidden on the map, which fills the viewport.

**Filter bar**

- Zeitraum: read-only, shows the period of the current response.
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

**Mobile (below 768 px)**

- Sidebar replaced by a top bar with the logo mark and the search field, and a bottom tab bar Karte, Muster, Planen, Mehr. Unbuilt tabs read "bald".
- Filter chips scroll sideways; the metric switch is one sideways-scrolling row.
- The heatmap is transposed to 24 hour rows × 7 weekday columns, with a "Ø" row for the weekday totals. The page never scrolls sideways.
- From 1024 px the heatmap and "Auf einen Blick" sit side by side.

**API used by the shell**

- `GET /datenstand` returns `monate` and `bahnhoefe` for the sidebar footer and `/mehr`.
- `GET /stationen/{eva}` resolves `bhf` to a name after a reload; 404 for an unknown EVA.
- `GET /stationen?q=&limit=` feeds the station combobox and the search field.
- `GET /heatmap` feeds the page (see [patterns.md](patterns.md)).

## 3 Decisions

- **Path routes, not hash routes.** Reason: design.md asks for shareable links, and the mockup's hash routes were only a single-file device.
- **React Router (declarative mode).** Reason: product owner's choice; the app has few routes and no data-router needs.
- **Native HTML and Tailwind, no component library.** Reason: the design is small and specific; `<select>`, `popover` and `<table>` cover the controls and keep accessibility native.
- **Mobile layout in the first shell milestone.** Reason: retrofitting a transposed grid and tab bar later would rework the page.
- **The heatmap is a semantic `<table>`** with a caption, header cells and hidden text in every cell, for example "Montag 7–8 Uhr: 72 % pünktlich, n = 1.240". "Als Tabelle anzeigen" shows those values in the cells. Reason: this is the accessible alternative design.md asks for, without a second component.
- **Weekday totals come from the backend** (`tage`, from the summed histogram), not from the browser. Reason: a mean of cell medians is statistically wrong; the mockup averages medians.
- **Colour classes follow the displayed, rounded value** (whole % and minutes, cancellations to one decimal). Reason: colour and printed number always agree. The boundary: 0.894 shows 89 % (class 2), 0.895 shows 90 % (class 1). The mockup classes the raw value, which would put 0.895 in class 2.
- **The low-data rule counts arrived stops for the delay metrics**: `n × (1 − ausfallquote)`, because the median, P90 and punctuality come from arrived stops only. Ausfälle uses `n`. Reason: 20 stops with half cancelled would otherwise show a confident-looking value from 10 arrivals.
- **Cancellations are shown with one decimal** ("2,5 %"), although design.md asks for whole percentages. Reason: the class limit 3.5 % needs it.
- **"Halte" instead of "Ankünfte"** in the meta line. Reason: n includes cancelled stops.
- **Mobile hit areas are at least 44 px without changing the visual size.** A `hit` utility adds an invisible 44 px area behind chips, buttons and the metric switch. Reason: design.md §5; the mockup's 32 px chips would be too small to tap. For the same reason the metric switch is one sideways-scrolling row on mobile: two wrapped rows leave no room for 44 px areas without overlap.
- **Dates and weekdays come from ICU** (`Intl`, de-DE): "Sept. 2026", "Mo." and "Montag". Reason: English follows without extra code; the mockup's "Sep 2026" is not what ICU produces.
- **The mockup's "Bald" group is included** (Live-Lage heute, Verspätungsketten, Gespeicherte Fahrten). Reason: the mockup wins over the earlier plan.
- **Inter is bundled with Fontsource** (`@fontsource-variable/inter`), no CDN. Reason: no third-party request at runtime. The no-library alternative is copying the woff2 and writing `@font-face` by hand, but the package carries version and licence.
- **No icon library.** The mockup's SVG paths live in one `Icon` component. Reason: about a dozen icons do not justify a dependency.
- **The logo is one static file, `frontend/public/favicon.svg`**, used as the tab icon and as the logo image in the sidebar and top bar: a white Germany silhouette with a railway track on the gradient badge. Its colours are literal copies of `--r1` and `--accent`. Reason: a favicon cannot read CSS tokens, and one file keeps tab icon and logo identical.
- **The page logo is an `<h2>` in the `<header>`.** Reason: one banner landmark on desktop and mobile; the page's `<h1>` follows in the main area.
- **Unbuilt pages are `<span>`s, not links.** Reason: a dead link is worse than an honest "bald".

## 4 Architecture and data keys

- `frontend/src/App.tsx`: routes, `Shell` (sidebar, mobile top bar, tab bar, footer), `/mehr`, data note.
- `frontend/src/HeatmapPage.tsx`: the page, grid, legend, tooltip, insights and states.
- `frontend/src/Filters.tsx`: filter bar and the station chip.
- `frontend/src/metrics.ts`: pure functions, no React: metric definitions with class limits, `classOf`, number and date formats, `readFilters` and `writeFilters` for the URL keys.
- `frontend/src/Icon.tsx`: the icon set. `frontend/src/api.ts`: typed client over `schema.d.ts`; `must()` turns any non-2xx response into a query error.
- UI text only via `frontend/src/i18n/de.ts` (`t()`, and `tx()` for placeholders filled with React nodes). Colours only via the tokens in `frontend/src/theme.css`; component classes in `index.css` use tokens only. Both rules are stated in [CLAUDE.md](../CLAUDE.md).
- `frontend/src/schema.d.ts` is generated from `backend/openapi.json`: `uv run python scripts/export_openapi.py`, then `npm.cmd --prefix frontend run gen`. The gate fails when it is stale (`gen:check`).
- Tests: `frontend/e2e/*.spec.ts` run in Playwright against fixtures served through `page.route` (`frontend/e2e/fixtures.ts`), never a backend. Two projects: desktop Chromium and a Pixel 7 profile (also Chromium).

## 5 Milestones

- [x] App shell per design: sidebar, routing, filter bar, heatmap view, mobile layout, Inter bundled. Re-check: `npm.cmd --prefix frontend run test:e2e` passes, including `frontend/e2e/shell.spec.ts` (redirects, query string kept, Inter loaded, sidebar and "bald" items, mobile tab bar and transposed grid, Mehr) and `frontend/e2e/heatmap.spec.ts` (grid, class boundaries, only-cancelled cells, low-data gate, tooltip, table mode, filters, reset, share, empty and error states, 44 px hit areas).

## 6 Platform checks

- [ ] Static Web Apps serves `index.html` for path routes such as `/muster/heatmap` on reload (SPA fallback), with a direct visit and a shared link. Verify on Azure.
- [ ] The station popover sits below its chip in Firefox and Safari. Without anchor positioning it falls back to a centred popover; tick when the product owner has seen both browsers.

## 7 Open decisions

- The Zeitraum picker: presets or free month range (arrives with multi-month data).
- Which single categories (S, RB, ICE …) become filter values; they need a new aggregate key.

## 8 Known shortcuts

- Zeitraum is read-only until multi-month data and a picker exist.
- No Linie chip: the aggregate has no line key (see [patterns.md](patterns.md)).
- The station search sends one request per keystroke, cached per term. Add a debounce if the API gets slow.
- Teilen gives no feedback when the browser denies the clipboard.
- An unknown station in `bhf` on the heatmap shows the generic empty state, not "Diesen Bahnhof kennen wir nicht" with a search (design.md §7); the station page has that state (see [map.md](map.md)).
- The mobile "Muster" segmented switch (Heatmap, Rankings, Zeitverlauf) is missing until Rankings exist.
- The sidebar has no collapse to a rail.
- Light mode only; the tokens are ready for dark.
- The station popover is positioned with CSS anchor positioning, with the centred default as fallback (see Platform checks).
