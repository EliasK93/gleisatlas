# SPEC.md – Rail Reliability Planner ("Gleisatlas")

> Product specification. Nothing under "Open points" may be assumed silently: resolve it first or decide it with a spike.
> Design target: [docs/design.md](docs/design.md) and the clickable mockup [docs/design/mockup.html](docs/design/mockup.html). Delivery plan: [docs/roadmap.md](docs/roadmap.md).

---

## 1. Problem and value

**What hurts today?**
Timetable apps (bahn.de, DB Navigator) optimise for the connection that is *scheduled* to be fastest. Whether a connection holds up in practice (typical delay, cancellations, missed transfers) is invisible. Anyone who has to arrive on time (start of work, a client appointment) plans by gut feeling.

**What do we gain?**
- For a time window ("arrive between 8:00 and 9:30"), all sensible connections with their **historically observed arrival distribution**: "With the 7:12 you are there before 8:41 in 90 % of cases, with the 7:42 only before 9:20."
- A conscious trade-off between "earlier and safe" and "later and riskier".
- Long-term **patterns**: which weekdays, times, lines and stations are problematic?

**Delimitation from existing tools** (use as reference, do not copy): next.bahnvorhersage.de, zugspaet.de, delaybahn, BayesianBahn, railwise. Own focus: **time-window trade-off + pattern analysis + transfer recommendation** in one app.

---

## 2. Users and situation

| Aspect | Decision |
|---|---|
| Primary user | A single user. No account system. |
| Public use | Code and app are meant to be shown publicly, and must be understandable for laypeople. |
| Trips | Regular (commute) and one-off (client appointment) trips in Germany. |
| Modes of transport | DB regional traffic (RE/RB/IRE/S-Bahn, including private operators in the dataset) and long-distance (ICE/IC/EC). **Train category selection is a filter** (e.g. "without ICE" for the Deutschlandticket). No subway/tram/bus. |
| When used | Before the trip (the evening before, in the morning, days ahead when planning an appointment) and occasionally to browse patterns. Not during the trip (live situation is v2). |
| Devices | Desktop browser first, **smartphone browser must be usable** (responsive). No native app. |
| UI language | German by default, switchable to English. Internationalisation is built in from the start (all UI strings in a message catalog); the English catalog exists ([docs/theme-and-language.md](docs/theme-and-language.md)). |
| Theme | Light and dark, switchable (System, Light, Dark). Theme tokens (CSS custom properties) are used from the start so that dark mode needs no restyling. |
| Development environment | Local (Windows, macOS or Linux), Python as main language. |

---

## 3. Scope and non-goals

### 3.1 Versions

| Version | Content |
|---|---|
| **v0.1 – Pattern analysis** | Data pipeline (nationwide), aggregates, dashboard for patterns (weekday, time, line, station, train category), cancellation vs. delay analysis. Runs locally. |
| **v0.2 – Deployment** | v0.1 deployed on Azure, data update reproducible. |
| **v0.3 – Day-level history** | Daily time series in place of the monthly one; the page "Live-Lage" (`/lage`): the map for one day against the normal for that weekday, drawn as a deviation map in the step colours of the stations, each area with its deviation from the usual (Germany, then Bundesländer, then stations), for the 131 large stations, with a Rückblick to any earlier day (the Karte stays a period of days for all stations); a line detail page with "Zeitfresser" sections and a graphic timetable (Bildfahrplan) for one day, planned against actual, as the visual form of delay propagation. Today is the page's default day: refreshed every 15 minutes for the large stations, with the community dataset's raw data as the fallback. Deployed. |
| **v1.0 – Connection comparison** | Start/destination/time window → connections with arrival distribution, transfer risk, transfer recommendation. Deployed. |
| **v1.x – Optional features** | Depending on time: weather correlation (on the daily time series), comparison with official DB statistics. |
| **v2 – Live situation** | Current delay of a concrete trip today + transfer risk in real time. |

### 3.2 In scope (v0.1–v1.0)

- Historical data nationwide, all stations in the dataset.
- Filter by train category (regional / long-distance / individually selectable).
- Pattern analysis (must).
- Day-level history: daily time series, Live-Lage (the day map), line detail page (v0.3).
- Connection comparison in a time window (must).
- **Transfer recommendation**: empirically sufficient transfer time at a station or for a concrete train pair (must).
- **Cancellations reported separately from delays** (must).
- Responsive web UI, deployed on Azure.
- UI language German by default, switchable to English; light and dark theme, switchable.

### 3.3 Non-goals (deliberately not in v1)

- **No live/real-time data** for a concrete trip (→ v2). The architecture must not rule it out, though (the connection engine should later be able to accept a "current delay" as input).
- **No own data collector** against DB APIs beyond the one for today's state at the large stations ([ADR 0002](docs/adr/0002-live-source.md)). A full collector stays a fallback if the community dataset goes stale (see 4.1).
- No public transport (subway, tram, bus), no walking paths between stations, no transport-association data.
- No prices, no booking, no ticket logic.
- No user accounts, no multi-user, no push notifications.
- No ML prediction models in v1 – purely empirical statistics. (Models are a later idea.)
- No raw-data hosting in the cloud – only aggregates are deployed.
- No guarantee or liability statements; the note "historical statistics, no forecast" appears in the UI.

### 3.4 Idea backlog (open, unprioritised)

On the daily time series (v0.3): a smoothed trend line, a calendar view, marked events (weather, holidays, strikes) and the 10 worst and best days; this is where the weather correlation (F6) would live · passenger-rights calculator (how often ≥ 60/120 min) · calendar export of the chosen connection · effect of timetable changes / construction work · holiday effects · compare regional vs. long-distance for the same relation · cause statistics (if a data source provides them) · records independent of delays: stations with the most/fewest stops, lines or trains per hour, lines with the most/fewest stops (needs a minimum sample, since one-off trains fill the "fewest" lists) · cross-border trains: the source only has German stations, so a train abroad ends at the border and its line names the last German station; marking such lines as "section in Germany" is small, the full run would need an own collector against foreign sources (see 3.3). On hold: a personal trip log with its own balance, and a saved "recurring trip" with a weekly report. Further ideas are welcome: add new items here, do not build them directly.

---

## 4. Data

### 4.1 Historical delays – `piebro/deutsche-bahn-data`

- Source: HuggingFace dataset `piebro/deutsche-bahn-data` (code: github.com/piebro/deutsche-bahn-data). License **CC BY 4.0 (Deutsche Bahn)** → attribution in UI and README is mandatory.
- Basis: DB Timetables API (IRIS), polled 4× daily.
- Coverage: about 135 large stations from 2024-07, **all stations from 2025-11-02**.
- Freshness: monthly Parquet files (`monthly_processed_data/data-YYYY-MM.parquet`, up to the end of the previous month) + raw data (`raw_data/`: the raw Timetables responses, four collection runs a day) with ~6 h lag.
- Relevant columns: `eva`, `station_name`, `train_type`, `train_number`, `line_number` (null for long-distance), `train_line_ride_id`, `train_line_station_num`, `arrival_planned_time`, `arrival_change_time`, `departure_planned_time`, `departure_change_time`, `arrival_is_canceled`, `departure_is_canceled`, `delay_in_min`. The files contain more columns (e.g. `time`, `xml_station_name`, `id`, `is_additional_stop`); see [docs/pipeline.md](docs/pipeline.md) for the findings.
- Known problems: missing hours 2025-11 to 2026-07 (among others 102 h in July 2026); schema changes in 2026-05 and 2026-08 (make the pipeline robust against schema changes, validate the schema on import).
- Time zone: Europe/Berlin, no conversion in the dataset.

**v1 decision:** monthly files are the basis for everything. The raw data is the source for the current month's day views (daily series and Live-Lage), up to the last complete day, one to two days back; month views stay on whole months. Details: [docs/pipeline.md](docs/pipeline.md) §2, "Raw days".

### 4.2 Connection / timetable source (for v1.0) – **open, spike needed**

Candidates to evaluate in the spike:
1. Unofficial bahn.de web API (used by delaybahn) – complete, but unofficial and possibly unstable.
2. Community wrapper (db-rest / transport.rest) – check current availability and stability.
3. Official GTFS timetable (DELFI / gtfs.de) + own routing (e.g. RAPTOR) – stable and offline, but considerably more effort.
4. Simplification: derive connections directly from the historical dataset (direct trains + 1 transfer at a station chosen by the user).

Decision criteria: stability, legal/terms of service, effort, regional + long-distance coverage, cost. Record the result as an ADR (`docs/adr/`).

### 4.3 Optional (optional features)
- Weather: DWD Open Data or Meteostat.
- Official DB punctuality figures (deutschebahn.com) for the comparison feature.
- Station coordinates for the map: Wikidata, see [ADR 0001](docs/adr/0001-station-coordinates.md).

### 4.4 Matching rules (important for correctness)
- A "train" across days = (`train_type`, `train_number`) + same route section; train numbers apply per timetable year → separate statistics **per timetable period** or mark the change (mid-December).
- Stations always by EVA number, never by name.
- Delay at a stop = `arrival_change_time − arrival_planned_time` (if no change: 0 min, unless cancelled).

---

## 5. Functional requirements

### F1 – Data pipeline
- F1.1 Loads monthly files from HuggingFace incrementally (new months only).
- F1.2 Validates the schema; aborts with a clear message on an unknown schema.
- F1.3 Cleans (duplicates, implausible values e.g. > 24 h), normalises time zones and marks timetable periods.
- F1.4 Produces **compact aggregates** (Parquet files) for API and UI: distributions per train × stop × day type, pattern cube (weekday × hour × category × line × station), transfer statistics.
- F1.5 Runs locally and reproducibly with one command (later optionally as a scheduled job).

### F2 – Pattern analysis (v0.1)
- F2.1 Punctuality and delay distribution by **weekday, time, line/train, station, train category, month**.
- F2.2 Filters: period, train categories, station(s), line.
- F2.3 **Cancellation rate separate** from delay.
- F2.4 Metrics: median, P90, share < 6 min (DB definition), cancellation rate, sample size n.
- F2.5 Visualisation: weekday × hour heatmap, ranking of worst/best lines and stations, time series.

### F3 – Connection comparison in a time window (v1.0)
- F3.1 Input: start, destination (autocomplete), time window as arrival *or* departure ("arrival between 8:00 and 9:30"), weekday or date, train category filter, optional max. transfers.
- F3.2 Output per connection:
  - **Arrival distribution** (core metric): median and P90 of the actual arrival time, visualised (e.g. box/strip plot over the time axis).
  - Cancellation risk (at least one leg cancelled).
  - **Transfer risk** per transfer (share of historical days on which the connection would have been missed).
  - Derived: punctuality rate (< 6 min) and optionally "P(arrival before deadline X)" if the user sets a deadline.
  - Sample size n and period of the data.
- F3.3 **"Historical replay" calculation method** (preferred): for each historical day of the same day type on which all partial trains ran, the connection is replayed, including missed connections (→ fall back to the next connection or count as "failed"; rule to be set in the ADR). This captures correlations between trains. Fallback for too small n: independence assumption, marked in the UI.
- F3.4 Sorting: by median arrival, P90 arrival, transfer risk, departure time.
- F3.5 Warning on a thin data basis (threshold configurable, default n < 15).

### F4 – Transfer recommendation (v1.0)
- F4.1 For a station or a train pair: which transfer time would have sufficed in 80/90/95 % of cases.
- F4.2 Integrated into F3: hint "This transfer (6 min) holds in only 71 % of cases; with the connection 20 min later 96 %."

### F5 – Web UI
- F5.1 Two main areas: "Verbindung planen" (plan a connection) and "Muster entdecken" (discover patterns).
- F5.2 Responsive (usable on a smartphone). Light and dark theme with a switch (theme tokens from the start).
- F5.3 Shareable URLs (search parameters in the URL).
- F5.4 Loading feedback, sensible empty and error states.
- F5.5 Attribution CC BY 4.0 + note "historical statistics, no guarantee".
- F5.6 UI language German by default, switchable to English. All user-visible strings come from a message catalog (i18n from the start); the German and English catalogs exist.

### F6 – Optional features (v1.x)
Weather correlation · comparison with official DB statistics.

---

## 6. Technical guidelines

| Area | Decision | Reason |
|---|---|---|
| Data processing | Python 3.12+, `uv`, **Polars** | Fast on large Parquet data, runs locally. |
| Backend | **FastAPI**, Pydantic, Polars queries on Parquet aggregates | OpenAPI generated automatically. |
| Frontend | **React + TypeScript + Vite**, **Tailwind**, native HTML controls, hand-drawn SVG charts, MapLibre GL for the map, data fetching with TanStack Query | No component or chart library was needed; see [docs/app-shell.md](docs/app-shell.md) §3. |
| API contract | **OpenAPI-first**; the TS client is generated from the schema | Clean interface between backend and frontend. |
| Design | Target in [docs/design.md](docs/design.md) and [docs/design/mockup.html](docs/design/mockup.html); theme tokens as CSS custom properties | One source for colours and spacing; dark mode without restyling. |
| i18n | Message catalog from the start, German and English catalogs | UI language is switchable. |
| Hosting (see [docs/deployment.md](docs/deployment.md)) | Frontend: Azure Static Web Apps (Free) · Backend: Azure Container Apps (Consumption, scale-to-zero) · Aggregates: Azure Blob Storage · infrastructure as code (Bicep) | Low fixed cost, scales to zero. |
| Operating cost | Low fixed cost; **Azure budget** on the resource group with e-mail alerts at 50 % and 90 % actual and 100 % forecast (amount is a deploy parameter) | Costs stay visible, and Azure has no hard cap. |
| Aggregate size | Target < 2 GB deployed; otherwise fall back to a watchlist (configurable station list) | Cost, cold-start time. |
| Repo | Monorepo: `core/`, `pipeline/`, `backend/`, `frontend/`, `scripts/`, `docs/` (incl. `docs/adr/`) and `infra/` | Clear working areas. |
| Conventions | Ruff + Pyright (Python), ESLint + TypeScript strict (frontend) | Hard, automatic guardrails. |

---

## 7. Delivery plan

See [docs/roadmap.md](docs/roadmap.md).

---

## 8. Acceptance criteria

### Pipeline (F1)
- [x] AC-1: One command downloads all available months and produces the aggregates; a repeated run downloads only new months. (`tests/pipeline/test_update.py`, `test_second_run_fetches_nothing_and_still_combines`)
- [x] AC-2: With a changed source schema the pipeline aborts with a message naming the missing/new columns. (`tests/pipeline/test_aggregate.py`, `test_schema_abort_names_a_new_column`)
- [x] AC-3: Deployed aggregates are < 2 GB (or the watchlist fallback is active and documented). (75 MB on Azure; `docs/deployment.md` §6)
- [x] AC-4: Spot check: for 5 random train/stop/day combinations the computed delays match the raw rows. (6 combinations, all match; `docs/pipeline.md` §6, "AC-4 spot check")

### Pattern analysis (F2)
- [x] AC-5: The weekday × hour heatmap loads in < 3 s (warm) for "nationwide, all categories, last 3 months". (seen on Azure warm under 3 s with the default period of 11 months, which reads more data than 3 months; `docs/patterns.md` §6)
- [x] AC-6: The filter "regional only" demonstrably removes all ICE/IC/EC from all metrics. (`tests/api/test_heatmap_api.py`, `test_regional_has_no_fern`; `tests/core/test_core.py`, `test_category_expr`)
- [x] AC-7: Cancellation rate and delay metrics are shown separately; cancelled stops do **not** enter the distribution as 0 min delay. (`tests/core/test_core.py`, `test_arrival_delay_rules` and `test_cell_stats_with_cancellations`; `tests/api/test_map_api.py`, `test_statistik_bins_and_cancelled_sum_to_n`; `frontend/e2e/heatmap.spec.ts`, "only-cancelled cells have their own look and are not thin")
- [x] AC-8: Every metric shows n and the data period. (`frontend/e2e/heatmap.spec.ts`, "7 weekday rows, hatched thin cells, approximate values, day totals"; `frontend/e2e/station.spec.ts`, "four tiles with value, sentence, meta and a coloured edge")

### Connection comparison (F3, F4)
- [ ] AC-9: For a test relation with 1 transfer and a 90 min window, all matching connections are shown with median, P90, cancellation and transfer risk.
- [ ] AC-10: The replay engine is tested against a hand-built mini dataset (at least 3 days, including a missed connection and a cancellation) with known expected results.
- [ ] AC-11: A visible warning appears when n is below the threshold.
- [ ] AC-12: The train category filter affects the connection selection (e.g. "without ICE" yields no connection with an ICE leg).
- [ ] AC-13: The transfer recommendation gives the P80/P90/P95 transfer time for a test station.

### UI and operation
- [ ] AC-14: Both main areas are usable at 375 px width without horizontal scrolling.
- [ ] AC-15: A search URL can be shared and reproduces the same view.
- [ ] AC-16: A budget with alerts is set up on the Azure resource group and its alert e-mail tested; the first full month of operation stays within it.
- [x] AC-17: CC BY 4.0 attribution is visible in UI and README. (`frontend/e2e/shell.spec.ts`, "the shell shows title, disclaimer and attribution"; the "Train data" row of the README's licences table)

---

## 9. Definition of done

**Per milestone:**
- Code merged, lint and type check green.
- Core logic covered by tests (pipeline transformations, statistics, replay engine) – no coverage quota, but every calculation rule has at least one test.
- Related acceptance criteria ticked.
- Feature doc §3 or ADR updated if decisions were made.

**For v1.0 overall (pragmatic):**
- App runs deployed on Azure within the configured budget.
- It is tried on real trips: a recurring one and a one-off one.
- Must features (F1–F5) fulfilled, AC-1 to AC-17 ticked.
- Data update is documented and repeatable with one command.

Not part of the v1.0 DoD: CI/CD auto-deploy, monitoring, backtest of prediction quality (sensible for v1.x).

---

## 10. Open points and assumptions

| # | Point | Approach |
|---|---|---|
| O1 | Connection source (4.2) | Spike, ADR |
| O2 | Rule for a missed connection in the replay: take the next connection or count as failed? | Set in the replay-engine ADR; proposal: next connection of the same relation, max. +120 min |
| O3 | Current Azure free grants and billing items | Checked, see [docs/deployment.md](docs/deployment.md) §4 |
| O5 | Project time frame | Not fixed; optional features only after v1.0 |
| O6 | Handling of the timetable change (train numbers) | Decided: mark the change; the split per period comes with the planner (see [docs/pipeline.md](docs/pipeline.md)) |
| O7 | Freshness of the community dataset | If no new month appears for > 2 months: evaluate an own collector as fallback |
