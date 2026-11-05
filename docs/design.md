# Gleisatlas – Design Concept

> **Note:** Light and dark mode are both implemented; the dark values in section 3.1 are the mockup's, except `--text-3`, which is lightened for contrast (see [theme-and-language.md](theme-and-language.md)). The mockup mixes light and dark areas in places; the light token set in section 3.1 is authoritative. UI strings are quoted in German as they appear in the app; the app also has an English catalog. The implementation deviates where the feature docs record a decision: Inter is bundled instead of loaded from a CDN, there is no component library (the "shadcn/ui basis" cells), and the URL keys are those of [app-shell.md](app-shell.md) §2. Clickable mockup with fake data: [design/mockup.html](design/mockup.html).

## 0. Guiding idea

**"Calm map, clear answers."** The app answers two questions: *"Where and when does it go wrong?"* (Discover) and *"Which train do I take to arrive safely?"* (Plan). Everything else is context.

Three principles from which all detailed decisions follow:

1. **Sentences before numbers.** Every metric is first phrased as an everyday sentence ("9 von 10 Fahrten kommen vor 8:41 an"), with the exact statistic (median, P90, n) directly below, smaller. Laypeople read the sentence, technical users the number.
2. **Uncertainty is visible, not hidden.** Little data → the element looks *different* (hollow, hatched, a note), not just a footnote.
3. **A cancellation is not a delay value.** Cancellations get their own colour (neutral slate grey + ✕), their own tile and their own bar – never folded into delay scales.

---

## 1. Information architecture

### 1.1 Pages and URLs

All views are addressable through hash/path routes with query parameters → **shareable links** (filters, station and metric live in the URL; the map position does not).

| Area | Page | Route (example) |
|---|---|---|
| Discover ("Entdecken") | **Map** (start page) | `/karte?k=median&g=regional` |
| Discover | Live-Lage (the map for one day) | `/lage?tag=2026-09-15` |
| Discover | Station detail | `/bahnhof/8000105?von=2025-11&bis=2026-09` |
| Discover | Line detail (stations, Zeitfresser) | `/linie/RE57%3A08000037?von=2025-11&richtung=2` |
| Discover | Weekday × hour | `/muster/heatmap?bhf=8000105&g=fern` |
| Discover | Rankings | `/muster/rankings?typ=linien&min=1000` |
| Discover | Time series | `/muster/zeitverlauf?bhf=8000105` |
| Plan ("Planen") | Plan a connection | `/planen?von=…&nach=…&an=08:00-09:30&tag=di&deadline=09:00` |
| Plan | Check a transfer | `/umstieg?bhf=8000261&an=RE4&ab=ICE599` |
| Info | How to read the numbers / data and license | `/methodik` |

### 1.2 Sidebar (desktop ≥ 1024 px, 248 px wide, collapsible to a 64 px icon rail)

```
[Logo "Gleisatlas"]
[🔍 Bahnhof, Linie …       ⌘K]       ← global search for stations and lines, ⌘K focuses it
ENTDECKEN
  ◉ Karte                         ← start page
  ☀ Live-Lage                     ← the map for one day, today by default
  ▦ Wochentag × Uhrzeit
  ≡ Rankings
  ∿ Zeitverlauf
PLANEN
  → Verbindung planen
  ⇄ Umstieg prüfen
BALD                              ← greyed out, "bald" badge, not clickable
  Gespeicherte Fahrten
────────────
  ⓘ So liest man die Zahlen
  Datenstand: Sep 2026 · CC BY 4.0
  [☀/☾ Hell/Dunkel/System]
```

**Why:** Grouping by *intent* (Discover/Plan) instead of chart type; matches the release order, and "Plan" can be filled in later. The "soon" group visibly reserves room for future features without rebuilding the navigation. Search sits at the very top because the most common entry point is "my station".

### 1.3 Global filter bar (Discover area)

Above every Discover content area, as a row of chips, **persistent across pages** (in the URL):
`Zeitraum: Nov 25 – Sep 26 ▾` · `Gattung: Alle ▾ (Nahverkehr / Fernverkehr / individually: S, RB, RE, IC, ICE …)` · `Bahnhof ▾` · `Linie ▾` · `Zurücksetzen`.
Active filters are filled (light accent colour), inactive ones only outlined. On the map the same bar floats as an overlay.

### 1.4 Mobile (< 768 px)

- Sidebar → **bottom tab bar** with 4 tabs: *Karte · Live-Lage · Muster · Mehr*. "Muster" bundles heatmap/rankings/time series as a segmented switch at the top; "Mehr" contains plan a connection (bald), check transfer, methodology, theme, license.
- Filter bar → horizontally scrollable chip row (only the chips scroll, never the page) + a "Filter" button that opens a bottom sheet.
- Search → icon at the top right, full-screen overlay.

---

## 2. Layouts of the main views

Grid: 12 columns, content width max. 1200 px (map full-bleed), gutter 24 px desktop / 16 px mobile.

### 2.1 Map (start page)
**Desktop:** The map fills the whole content area to the right of the sidebar. Floating elements (cards on `surface` with a light shadow, 12 px from the edge):
- top left: metric switch (segments: *Pünktlichkeit · Typische Verspätung (Median) · Schlechteste 10 % · Ausfälle*) + filter chips.
- bottom left: **legend** (5-step scale with class limits as text, plus "◌ hohl = wenig Daten", "Punktgröße = Anzahl Halte"). On Live-Lage (see [day-history.md](day-history.md) §2) the scale carries the five step names instead of class limits, a sentence says what "wie üblich" means (no numbers: the limits differ per station), and the Germany card stands above it in the same 300 px column.
- right: **station panel** (360 px) appears after a click: name, identifier, 4 mini tiles, a sentence ("8 von 10 Ankünften sind pünktlich"), button "Alle Details". The map stays visible and usable.
- bottom right: zoom, attribution. "My position" is left out (not needed before the trip).

**Mobile:** Map full-bleed, metric as a compact dropdown chip at the top, collapsible legend ("Legende ▴"), station panel as a **bottom sheet** (peek 40 % → pull up to full).

**Why:** The map is mood picture and entry point at once; overlays instead of columns keep it large (requested by the product owner). A panel instead of a page change allows quick "clicking around".

### 2.2 Station detail
Header: breadcrumb `Karte › Köln Hbf`, title, identifier (EVA no.) + federal state, actions *Teilen* · *Verbindung ab hier planen* · *Umstiege hier prüfen*.
Below:
1. **Metric row** (4 tiles): punctuality · median · P90 · **cancellations (separate, grey)**. Each tile: large value, everyday sentence, footer `n = 48 210 Halte · Nov 25 – Sep 26`.
2. **"So verteilen sich die Ankünfte"** – histogram of the delay (0–1, 1–3, 3–6, 6–10, 10–20, 20–30, > 30 min) plus a *separate* grey bar "ausgefallen" on the right, set apart by a gap.
3. Two columns: **weekday × hour** (mini heatmap, link to the large one) | **by train category** (horizontal bars per category with n).
4. **Lines at this station** – sortable table, worst first, with mini bars.
5. **Time series** (12-month sparkline).

**Mobile:** everything single-column, tiles 2×2, the table becomes a list of row cards.

### 2.3 Weekday × hour (heatmap)
Filter bar + metric switch. Heatmap with 7 rows (Mon–Sun) × 24 columns (0–23 h). Cells with n < 15 → **hatched light grey, no value**. Hover/tap shows a tooltip: "Dienstag 7–8 Uhr · 71 % pünktlich · n = 1 240". Marginal totals next to it (weekday mean as bars), hour means below – so it can be read without colour. Below that, automatically generated **insight sentences** ("Freitags 16–18 Uhr ist es am schlechtesten: 64 % pünktlich").
**Mobile:** The heatmap is **transposed** (24 rows × 7 columns) to fit into 375 px; cell height 18 px.

### 2.4 Rankings
Switch *Linien · Bahnhöfe*, metric, **minimum sample** (stepper: 100/500/1 000/5 000 stops; default 500). Two columns "Am unzuverlässigsten" / "Am zuverlässigsten", each top 10 as rows: rank, name, category badge, value bar, value, n. Cancellation rate as its own grey mini column. **Mobile:** the columns become tabs.

### 2.5 Time series
Line chart month by month (punctuality or median/P90 as a band), optionally compare up to 3 stations/lines (categorical colours). **Below it, separately,** a bar chart "Ausfallquote" on the same x axis. Months with little data as a dashed line segment.

### 2.6 Plan a connection
**Desktop:** Split in two – form on the left (320 px, sticky), results on the right. **Mobile:** compact form at the top (From/To + "Zeitfenster Di 8:00–9:30 an ▾"), details in a collapsible section, results below.
Form: From / To (autocomplete with identifier and place; duplicate names are resolved: "Hamburg Hbf · 8002549" vs. "Hamburg Hbf (tief) · 8098549"), segment *Ankunft | Abfahrt*, time window (two time fields), weekday chips or date, categories (preset chip "Nur Nahverkehr – Deutschlandticket"), max. transfers (0/1/2/any), optional **deadline** ("muss da sein um").
Results: header with sorting (*Sicherste Ankunft (P90)* by default when a deadline is set, otherwise *Typische Ankunft (Median)* · transfer risk · departure) and a **shared time axis** across all rows, the deadline as a vertical line through all rows.
One row per connection (see 4.1 arrival band). Expanded: quantile dot plot, sections with transfers including transfer risk and a link "Umstieg prüfen".

### 2.7 Check a transfer
Input: station, arriving train/line, departing train/line (or "all transfers at this station"), planned transfer time.
Result:
1. **Traffic-light sentence**, large: "Dieser Umstieg (6 min) klappt in **71 %** der Fälle."
2. **Curve** "Anteil geschaffter Umstiege nach Umstiegszeit" (x: 0–30 min, y: 0–100 %) with markers at 80/90/95 % and the current transfer time.
3. **Recommendation cards**: "Für 90 %: mind. 12 min einplanen" · "Alternative: RE 1 um 7:54 (+20 min) → 96 %".
4. Table "Reicht in x % der Fälle" for 80/90/95 %.

---

## 3. Visual language

### 3.1 Colour tokens (CSS custom properties, in the mockup under `:root`)

**Neutral (light / dark)**

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F5F6F8` | `#0F1216` | Page background |
| `--surface` | `#FFFFFF` | `#171B21` | Cards, panels |
| `--surface-2` | `#EEF0F3` | `#1F242C` | Inputs, hover, zebra |
| `--border` | `#E1E4E9` | `#2A3039` | Dividers |
| `--text` | `#141820` | `#E8EBF0` | Primary text |
| `--text-2` | `#4A5363` | `#A6AFBD` | Secondary text |
| `--text-3` | `#656D7E` | `#838B99` | Meta (n, period); both values give at least 4.5:1 on `--bg`, `--surface` and `--surface-2` (the mockup's `#7A8394` and `#6F7888` stay below 4.5:1) |
| `--accent` | `#4B47D6` | `#8B88FF` | Active navigation, buttons, focus |
| `--accent-soft` | `#ECEBFD` | `#25244A` | Active chips |

The accent is deliberately **indigo** – it does not sit on the reliability scale and so is never read as "good/bad". No DB red (no confusion with the official DB app, and red is reserved for "bad").

**Reliability scale** (5 classes, diverging blue → sand → red, derived from ColorBrewer *RdYlBu*, distinguishable for deutan/protan/tritan because both the light-dark *and* the blue-orange axis vary):

| Token | Light | Dark | Punctuality | Median delay |
|---|---|---|---|---|
| `--r1` very reliable | `#2166AC` | `#5AA2E6` | ≥ 90 % | < 1 min |
| `--r2` reliable | `#67A9CF` | `#8FC4E8` | 80–90 % | 1–2 min |
| `--r3` mixed | `#D8BE5C` | `#E3CB6E` | 70–80 % | 2–4 min |
| `--r4` unreliable | `#EF8A47` | `#F39A5C` | 60–70 % | 4–7 min |
| `--r5` very unreliable | `#B2182B` | `#E5576A` | < 60 % | ≥ 7 min |

**Special colours**
- `--cancel` `#5D6675` / dark `#8A93A3` – **cancellations**, always with a ✕ symbol or hatching.
- `--lowdata` – hatching from `--border` on `--surface-2`, for n < 15.
- `--deadline` = `--text` (dashed line) – neutral, so it does not compete with the scale.
- Arrival band: fill from the scale colour of the connection at 25 % / 100 % opacity.

**Redundancy (never colour only):** classes always have a text label; on the map additionally dot size (traffic volume) and shape (hollow = little data); in tables value + bar length.

### 3.2 Typography
- **Inter** (variable, via Fontsource CDN; fallback `system-ui`). Calm, very legible at small sizes, has **tabular figures** (`font-variant-numeric: tabular-nums`) – important for times in lists.
- Scale (rem, base 16 px): 12 (meta) · 13 (labels) · 14 (UI body) · 16 (body text) · 20 (section) · 28 (page title) · 36 (metric value).
- Weights: 400 text, 500 labels, 600 titles/metrics. No uppercase except small group labels in the sidebar (11 px, letter spacing +0.06 em).

### 3.3 Spacing, shapes, depth
- 4 px grid: 4 · 8 · 12 · 16 · 24 · 32 · 48.
- Radii: 6 (chips, inputs) · 12 (cards) · 16 (panels/sheets).
- Shadows only for elements floating above the map (`0 4px 16px rgb(0 0 0 / .08)`); otherwise flat with a 1 px border. **Why:** calm – depth signals "floats above the map", not decoration.

### 3.4 Map style
- MapLibre GL (production, vector) or Leaflet (mockup) with a calm greyscale base map – production: own light/dark vector style (e.g. OpenFreeMap/Protomaps); in the mockup Esri *Light/Dark Gray Canvas*, since CARTO raster tiles now require an API key – without labels below zoom 7 so the data points dominate. Federal border optional as a thin line.
- Stations as circles: radius 3–10 px by √(number of stops), fill = scale class, 1 px border in `--surface` for contrast on any background. **Little data** (n < 15 stops in the filter): hollow circle with a scale border, or grey.
- Draw order: bad stations on top (problem spots must not be hidden). At low zoom, hide/cluster the smallest stations (production: MapLibre layer with `circle-sort-key` and zoom filters).
- Hover: tooltip with name + value; click: panel. The selected station gets a ring in `--accent`.

---

## 4. Components

| Component | Description | shadcn/ui basis |
|---|---|---|
| **Metric tile** | Label · value (36 px) · everyday sentence · meta line `n · period` · optional warning badge | Card |
| **Scale badge** | Colour dot + class label ("durchwachsen") | Badge |
| **Category badge** | S, RB, RE, IC, ICE … monochrome (outline), not colour-coded – colour belongs to reliability | Badge (outline) |
| **Filter chip** | Label + current value + ▾, opens a popover | Popover + Command |
| **Station autocomplete** | Name **bold**, below it place/state + identifier; same-name entries get the note "2 Einträge mit diesem Namen" | Command |
| **Arrival band** | see 4.1 | custom SVG component |
| **Quantile dot plot** | 20 dots = 20 typical trips, stacked on the time axis; cancellations as ✕ dots separately on the right | custom SVG |
| **Data-basis note** | ◌ icon + "Wenig Daten (n = 9) – Werte schwanken stark" | Alert (subtle) |
| **Insight sentence** | automatically generated one-sentence summary in a typographic style without emoji (bold highlighted number) | – |
| **Mini bar** | Inline bar in tables | – |
| **Bottom sheet** (mobile) | Panel with handle, 3 snap levels | Drawer (vaul) |
| **Statistics note** | permanent footer: "Historische Statistik, keine Prognose oder Garantie. Kein Angebot der Deutschen Bahn. Daten: Deutsche Bahn (via piebro/deutsche-bahn-data und DB Timetables API), CC BY 4.0, aggregiert" | – |

### 4.1 Arrival band – the core visualisation

One horizontal track per connection on a **time axis shared by all results** (e.g. 7:45–9:45):

```
            8:00      8:30      9:00      9:30
7:12 RE 1   ·  ▏▓▓▓▓▓▓▓░░░░░──           │        90 % vor 8:41 · 97 % vor Deadline
                ↑planmäßig  ↑Median  ↑P90  │Deadline
```
- **Thin tick** = scheduled arrival.
- **Strong bar** = half of the trips (scheduled arrival to median → "typical").
- **Light bar** up to P90 ("the worst 10 %").
- **Fine line (whisker)** up to P95/max.
- **Deadline** as a dashed vertical line across *all* rows → you see immediately whose band the line crosses.
- Band colour = scale class of the connection (probability before the deadline or punctuality).
- Right: sentence "9 von 10 vor 8:41" + chips `Ausfall 2 %` (grey, ✕) · `Anschluss 71 %` (only with a transfer) · `n = 42`.

**Why this form:** A bar on a real clock-time axis answers "when will I be there?" more directly than delay minutes; comparing connections *with each other* becomes a pure position comparison (the most precise visual encoding). The expanded **quantile dot plot** (20 dots) translates probability into countable frequencies – demonstrably easier for laypeople to understand than percentages or density curves ("18 von 20 Punkten liegen vor der Deadline").

---

## 5. Interaction patterns

- **One click to detail, never dead ends:** every mention of a station/line is a link; detail pages link to Plan/Transfer with pre-filled fields.
- **Filters take effect immediately** (no "apply" button on desktop; on mobile in the sheet "Ergebnisse anzeigen (124)").
- **Hover = preview, click = pin.** Tooltips on desktop; on touch a tap replaces hover, a second tap opens the detail.
- **Share:** the button copies the current URL, toast "Link kopiert".
- **Search (⌘K / Ctrl+K):** the shortcut focuses the search field, which finds stations and lines (no palette dialog); the rules are in [map.md](map.md).
- **Keyboard and accessibility:** focus ring 2 px `--accent`, every chart has an "Als Tabelle anzeigen" alternative, contrast ≥ 4.5:1 for text, touch targets ≥ 44 px on mobile.
- **Term tooltips:** dotted-underlined technical terms (median, P90, pünktlich) explain themselves on hover: "Die verspätetsten 10 % der Ankünfte sind mindestens so spät (90. Perzentil, P90)."

---

## 6. Making statistical uncertainty understandable

1. **Language:** "typisch" (median), "schlechteste 10 %" (P90), "pünktlich = weniger als 6 Minuten zu spät (DB-Definition)". Technical term in parentheses or tooltip.
2. **n and period on every metric** as a meta line in `--text-3`, 12 px: `n = 1 240 Fahrten · Nov 25 – Sep 26`. Unobtrusive, but always in the same place.
3. **Thresholds for a thin data basis:**
   - n < 15: the element becomes **hollow/hatched**, value in `--text-3`, badge "◌ Wenig Daten". Excluded from rankings (minimum n).
   - 15 ≤ n < 50: a subtle "~" before the value ("~ 82 %") – signals approximation.
   - Heatmap cells with n < 15 stay empty (hatched) instead of faking a colour.
4. **Cancellations separate:** own tile, own grey bar, a separate chip in the arrival band; percentages of the arrival distribution refer to *arrived* trains, with the note "Zusätzlich fielen 2 % aus". For "P(before deadline)" a cancellation counts as *not in time* (conservative) – this is stated in the tooltip.
5. **No false precision:** integer percentages, integer minutes, times to the minute.
6. **Disclaimer** as a calm footer on every page, not a popup.

---

## 7. States

| State | Design |
|---|---|
| **Loading** | Skeletons shaped like the final content (tiles, band rows, heatmap grid) with a soft shimmer; the map shows the base map immediately, points fade in. After > 3 s an extra text "Rechne 1,2 Mio. Halte durch …". |
| **Empty** | Illustration-free, friendly card: icon, sentence, concrete action. E.g. "Keine Verbindung mit höchstens 1 Umstieg im Zeitfenster. → *Zeitfenster um 1 h erweitern* · *Umstiege erlauben*". |
| **Little data** | Content is shown, but with the data-basis note (see 6.3). |
| **Error** | Inline banner in the affected area (not the whole page): "Daten konnten nicht geladen werden." + *Erneut versuchen*; filters are kept. |
| **Unknown station (URL)** | "Diesen Bahnhof kennen wir nicht" + search. |

---

## 8. Light and dark mode

- Light and dark share the same token names; System is the default and follows the device. Details and decisions: [theme-and-language.md](theme-and-language.md).
- Three levels: *System* · *Hell* · *Dunkel*; switch in the sidebar footer or "Mehr".
- Implementation via `data-theme` on `<html>` + identical token names. Dark is **not inverted**: surfaces dark grey (not black), scale colours lightened so they are perceived the same on a dark ground; the base map switches to the dark variant.
- Charts read their colours from the tokens and re-render on change.

---

## 9. Room for later

- *Live-Lage heute*: additional row in the expanded arrival band ("Heute: +4 min") – space reserved on the right.
- *Weather correlation*: another tab in the time series.
- *Delay chains*: the Bildfahrplan on the line page (`/linie/<id>`, [lines.md](lines.md)), the line as a route with the delay per stop for one day; the sections of the line page already show where time is lost.
- *Save a recurring trip*: star button on connections, list under Plan (local in the browser, no account).

## 10. Assumptions

- Punctuality is the default metric of the map (familiar, intuitive); median/P90 via the switch.
- The map colours by arrival punctuality at the station.
- "P(before deadline)" counts cancellations as missed; transfer risk is estimated from the historical pairing of arrival and departure delays.
- The station identifier is the EVA number, displayed but small.
