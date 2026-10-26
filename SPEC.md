# SPEC.md – Rail Reliability Planner (working title "Verlässlich")

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
| UI language | German by default, switchable to English. Internationalisation is built in from the start (all UI strings in a message catalog); the English catalog is added later. |
| Theme | Light first; dark mode switchable later. Theme tokens (CSS custom properties) are used from the start so that dark mode needs no restyling. |
| Development environment | Windows 11, Python as main language. |

---

## 3. Scope and non-goals

### 3.1 Versions

| Version | Content |
|---|---|
| **v0.1 – Pattern analysis** | Data pipeline (nationwide), aggregates, dashboard for patterns (weekday, time, line, station, train category), cancellation vs. delay analysis. Runs locally. |
| **v0.2 – Deployment** | v0.1 deployed on Azure, data update reproducible. |
| **v1.0 – Connection comparison** | Start/destination/time window → connections with arrival distribution, transfer risk, transfer recommendation. Deployed. |
| **v1.x – Optional features** | Depending on time: delay propagation along lines, weather correlation, map heatmap, comparison with official DB statistics. |
| **v2 – Live situation** | Current delay of a concrete trip today + transfer risk in real time. |

### 3.2 In scope (v0.1–v1.0)

- Historical data nationwide, all stations in the dataset.
- Filter by train category (regional / long-distance / individually selectable).
- Pattern analysis (must).
- Connection comparison in a time window (must).
- **Transfer recommendation**: empirically sufficient transfer time at a station or for a concrete train pair (must).
- **Cancellations reported separately from delays** (must).
- Responsive web UI, deployed on Azure.
- UI language German by default, switchable to English; light theme first, dark theme switchable later.

### 3.3 Non-goals (deliberately not in v1)

- **No live/real-time data** for the current trip (→ v2). The architecture must not rule it out, though (the connection engine should later be able to accept a "current delay" as input).
- **No own data collector** against DB APIs as long as the community dataset stays current (see 4.1). Fallback option if the dataset goes stale.
- No public transport (subway, tram, bus), no walking paths between stations, no transport-association data.
- No prices, no booking, no ticket logic.
- No user accounts, no multi-user, no push notifications.
- No ML prediction models in v1 – purely empirical statistics. (Models are a later idea.)
- No raw-data hosting in the cloud – only aggregates are deployed.
- No guarantee or liability statements; the note "historical statistics, no forecast" appears in the UI.

### 3.4 Idea backlog (open, unprioritised)

Personal trip log with own balance · passenger-rights calculator (how often ≥ 60/120 min) · calendar export of the chosen connection · effect of timetable changes / construction work · holiday effects · save a "recurring trip" with a weekly report · compare regional vs. long-distance for the same relation · cause statistics (if a data source provides them). Further ideas are welcome: add new items here, do not build them directly.

---

## 4. Data

### 4.1 Historical delays – `piebro/deutsche-bahn-data`

- Source: HuggingFace dataset `piebro/deutsche-bahn-data` (code: github.com/piebro/deutsche-bahn-data). License **CC BY 4.0 (Deutsche Bahn)** → attribution in UI and README is mandatory.
- Basis: DB Timetables API (IRIS), polled 4× daily.
- Coverage: ~100 largest stations from 2024-07, **all stations from 2025-11-02**.
- Freshness: monthly Parquet files (`monthly_processed_data/data-YYYY-MM.parquet`, up to the end of the previous month) + raw data with ~6 h lag.
- Relevant columns: `eva`, `station_name`, `train_type`, `train_number`, `line_number` (null for long-distance), `train_line_ride_id`, `train_line_station_num`, `arrival_planned_time`, `arrival_change_time`, `departure_planned_time`, `departure_change_time`, `arrival_is_canceled`, `departure_is_canceled`, `delay_in_min`. The files contain more columns (e.g. `time`, `xml_station_name`, `id`, `is_additional_stop`); see [docs/pipeline.md](docs/pipeline.md) for the findings.
- Known problems: missing hours 2025-11 to 2026-07 (among others 102 h in July 2026); schema changes in 2026-05 and 2026-08 (make the pipeline robust against schema changes, validate the schema on import).
- Time zone: Europe/Berlin, no conversion in the dataset.

**v1 decision:** monthly files as the basis. Fetching raw data for the current month is optional.

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
- F1.5 Runs locally on Windows 11 and reproducibly with one command (later optionally as a scheduled job).

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
- F5.2 Responsive (usable on a smartphone). Light theme first; dark/light switch later (theme tokens from the start).
- F5.3 Shareable URLs (search parameters in the URL).
- F5.4 Loading feedback, sensible empty and error states.
- F5.5 Attribution CC BY 4.0 + note "historical statistics, no guarantee".
- F5.6 UI language German by default, switchable to English. All user-visible strings come from a message catalog (i18n from the start); the English catalog follows later.

### F6 – Optional features (v1.x)
Delay propagation along a line · weather correlation · map heatmap by station · comparison with official DB statistics.

---

## 6. Technical guidelines

| Area | Decision | Reason |
|---|---|---|
| Data processing | Python 3.12+, `uv`, **Polars** | Fast on large Parquet data, runs locally on Windows. |
| Backend | **FastAPI**, Pydantic, Polars queries on Parquet aggregates | OpenAPI generated automatically. |
| Frontend | **React + TypeScript + Vite**, **Tailwind**, **shadcn/ui**, charts with Recharts or ECharts, data fetching with TanStack Query | shadcn is React-native, large ecosystem. |
| API contract | **OpenAPI-first**; the TS client is generated from the schema | Clean interface between backend and frontend. |
| Design | Target in [docs/design.md](docs/design.md) and [docs/design/mockup.html](docs/design/mockup.html); theme tokens as CSS custom properties | One source for colours and spacing; dark mode without restyling. |
| i18n | Message catalog from the start, German catalog first, English later | UI language is switchable. |
| Hosting (assumption, to verify in the roadmap) | Frontend: Azure Static Web Apps (Free) · Backend: Azure Container Apps (Consumption, scale-to-zero) · Aggregates: Azure Blob Storage · infrastructure as code (Bicep) | Budget. |
| Budget | Target ≤ …/month, cap …/month; **Azure budget alert** at … and … | Requirement. |
| Aggregate size | Target < 2 GB deployed; otherwise fall back to a watchlist (configurable station list) | Cost, cold-start time. |
| Repo | Monorepo: `core/`, `pipeline/`, `backend/`, `frontend/`, `scripts/`, `docs/` (and `infra/` later) (incl. `docs/adr/`) | Clear working areas. |
| Conventions | Ruff + Pyright/mypy (Python), ESLint + TypeScript strict (frontend) | Hard, automatic guardrails. |

---

## 7. Delivery plan

See [docs/roadmap.md](docs/roadmap.md).

---

## 8. Acceptance criteria

### Pipeline (F1)
- [ ] AC-1: One command downloads all available months and produces the aggregates; a repeated run downloads only new months.
- [ ] AC-2: With a changed source schema the pipeline aborts with a message naming the missing/new columns.
- [ ] AC-3: Deployed aggregates are < 2 GB (or the watchlist fallback is active and documented).
- [ ] AC-4: Spot check: for 5 random train/stop/day combinations the computed delays match the raw rows.

### Pattern analysis (F2)
- [ ] AC-5: The weekday × hour heatmap loads in < 3 s (warm) for "nationwide, all categories, last 3 months".
- [ ] AC-6: The filter "regional only" demonstrably removes all ICE/IC/EC from all metrics.
- [ ] AC-7: Cancellation rate and delay metrics are shown separately; cancelled stops do **not** enter the distribution as 0 min delay.
- [ ] AC-8: Every metric shows n and the data period.

### Connection comparison (F3, F4)
- [ ] AC-9: For a test relation with 1 transfer and a 90 min window, all matching connections are shown with median, P90, cancellation and transfer risk.
- [ ] AC-10: The replay engine is tested against a hand-built mini dataset (at least 3 days, including a missed connection and a cancellation) with known expected results.
- [ ] AC-11: A visible warning appears when n is below the threshold.
- [ ] AC-12: The train category filter affects the connection selection (e.g. "without ICE" yields no connection with an ICE leg).
- [ ] AC-13: The transfer recommendation gives the P80/P90/P95 transfer time for a test station.

### UI and operation
- [ ] AC-14: Both main areas are usable at 375 px width without horizontal scrolling.
- [ ] AC-15: A search URL can be shared and reproduces the same view.
- [ ] AC-16: Azure costs in the first full month of operation ≤ …, budget alert is set up and tested.
- [ ] AC-17: CC BY 4.0 attribution is visible in UI and README.

---

## 9. Definition of done

**Per milestone:**
- Code merged, lint and type check green.
- Core logic covered by tests (pipeline transformations, statistics, replay engine) – no coverage quota, but every calculation rule has at least one test.
- Related acceptance criteria ticked.
- README section or ADR updated if decisions were made.

**For v1.0 overall (pragmatic):**
- App runs deployed on Azure within budget.
- It is used for real commutes and at least one other trip type.
- Must features (F1–F5) fulfilled, AC-1 to AC-17 ticked.
- Data update is documented and repeatable with one command.

Not part of the v1.0 DoD: CI/CD auto-deploy, monitoring, UI tests, backtest of prediction quality (sensible for v1.x).

---

## 10. Open points and assumptions

| # | Point | Approach |
|---|---|---|
| O1 | Connection source (4.2) | Spike, ADR |
| O2 | Rule for a missed connection in the replay: take the next connection or count as failed? | Set in the replay-engine ADR; proposal: next connection of the same relation, max. +120 min |
| O3 | Current Azure prices / free grants | Verify before creating resources |
| O4 | Tooling for parallel work on Windows | Check before starting; assumption: Windows-native tooling suffices |
| O5 | Project time frame | Not fixed; optional features only after v1.0 |
| O6 | Handling of the timetable change (train numbers) | Decide and document in the multi-month pipeline milestone |
| O7 | Freshness of the community dataset | If no new month appears for > 2 months: evaluate an own collector as fallback |
