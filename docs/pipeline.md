# Pipeline

## 1 Overview

Turns the monthly source files from `piebro/deutsche-bahn-data` into compact tables: a delay histogram (weekday × hour × category × station × month), a station table with names, stop counts and coordinates, line histograms per month, a delay histogram per day, a line table, a month table with coverage figures and a day table with the hours missing per day. Each month is processed once into its own folder; a combine step then writes the files the API reads. Raw data stays local.

The current month, which has no monthly file yet, is covered for the day views only: the days after the last monthly file are built from the source's raw Timetables responses, up to the last complete day (§2, "Raw days"). The month views never use them.

Today so far comes from two places: `pipeline.update` writes the current day from the raw responses as far as they reach (§2, "Today so far"), and the collector `pipeline.live` asks the DB Timetables API for the large stations every 15 minutes (§2, "Live collector"). An hour table (the day histogram per planned arrival hour) lets the API cut the reference days at the hour today has reached. How the map uses them is in [day-history.md](day-history.md).

## 2 Spec

Commands (from the repo root):

- `uv run python -m pipeline.coords` runs one SPARQL query against Wikidata and writes `data/coords.parquet`. Needs network access; run it once and again to refresh.
- `uv run python -m pipeline.update` is the one command for the data. It lists the monthly files on HuggingFace, downloads and processes every month whose folder `data/months/YYYY-MM/` is missing or incomplete, then processes the complete raw days after the last month (see "Raw days"), then combines everything, and last writes today so far (see "Today so far"). A second run downloads no month again (AC-1) and no raw day that is done. It reads `data/coords.parquet` and aborts before fetching anything if the file is missing, so run `pipeline.coords` first.
- `uv run python -m pipeline.live` makes one run of the live collector for the large stations (see "Live collector"); it needs the DB API key in the environment.
- `uv run python -m pipeline.download YYYY-MM` downloads one monthly file into `data/raw/`; `pipeline.update` calls it, you rarely need it directly.
- `uv run python scripts/check_sample.py <source.parquet>` compares computed arrival delays against raw rows (spot check for AC-4, outside the gate).

After a change to the per-month logic (cleaning, line names, coverage rule) the existing month folders are stale: delete `data/months/` and run `pipeline.update` again. The skip check only looks for the folder, not for the version of the code that wrote it.

**Source schema.** The source must carry exactly the 23 known columns (`COLUMNS` in `pipeline/aggregate.py`). A missing or a new column aborts the run with a message that names it (AC-2).

**Month folder** `data/months/YYYY-MM/`, written to a temporary sibling and renamed only when all nine files exist, so a crash never leaves a half-complete month (a folder from before the day tables or the hour table lacks some of them and is processed again by the next run):

| File | Keys |
|---|---|
| `aggregate.parquet` | `weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`, `n` |
| `lines.parquet` | `name`, `train_type`, `eva`, `gruppe`, `month`, `bucket`, `n` |
| `ends.parquet` | `name`, `eva`, `dest`, `n` (arrival stops per line name, station and end station) |
| `networks.parquet` | `name`, `eva`, `net` (the line networks within the month) |
| `stations.parquet` | `eva`, `name`, `n` |
| `meta.parquet` | `month`, `missing_hours`, `stations` |
| `days.parquet` | `day`, `gruppe`, `eva`, `bucket`, `n` (the delay histogram per planned arrival day) |
| `day_gaps.parquet` | `day`, `missing_hours`: one row per calendar day of the month, days without a gap included |
| `day_hours.parquet` | `day`, `hour`, `gruppe`, `eva`, `bucket`, `n`: the `days` histogram per planned arrival hour as well (`hour` Int8) |

**Raw days.** The source's `raw_data` folder (`raw_data/year=/month=/day=/…parquet`, one folder per UTC day, no zero padding) holds the raw DB Timetables API responses: `plan` and `fchg` as IRIS XML in `response_data`, with `url`, `api_name`, `status_code` and `timestamp` (naive UTC). The collector runs four times a day in blocks of six hours, and a pass over all stations takes about five minutes. A month is about 4.8 GB, about 160 MB a day. Licence as the monthly files (CC BY 4.0, Deutsche Bahn).

- **Which days.** From the first day after the last complete monthly folder, day by day, up to the last complete day. A day D is complete once a `fchg` snapshot from after D+1 06:00 (UTC, so 08:00 local) exists in the folders of D+1: its late trains are settled by then, in practice with the run at about 08:40 UTC. The newest file of a folder can hold no `fchg` (a run whose requests all failed), so the check looks back through the folder's files from the newest. Day D reads the folders of UTC D-1, D and D+1: the runs fetch the plan for the local hours 00:00 to 03:00 a day ahead, so it often sits in the folder before D, and the late changes land in the folder after.
- **Folder** `data/days/YYYY-MM-DD/`, written to a temporary sibling and renamed like a month folder:

  | File | Keys |
  |---|---|
  | `days.parquet` | `day`, `gruppe`, `eva`, `bucket`, `n`: the same histogram as a month's, for the stops planned on that day |
  | `hours.parquet` | `hour`, `rows`: the cleaned rows per local hour of `time` on that day, what the gap rule needs |
  | `day_hours.parquet` | the month folder's hour table, for the stops planned on that day |
  | `day_gaps.parquet` | `day`, `missing_hours`: one row, rewritten for every raw day on each update |

- **Superseded by the monthly file.** Once a month's folder under `data/months/` is complete, the raw day folders of that month are deleted and `combine` ignores them: the monthly file wins. The folder of the new first raw day is deleted and processed again too, because the boundary moved (see §3).
- **Downloads are temporary.** Each raw folder is fetched once per run into a temporary directory, kept while the next days need it (three days in a row) and deleted when no later day does; nothing of the raw files stays on disk, about 1 GB at a time.
- **After a network error, run the command again.** There is no retry; a day that is done is skipped without any network call, so the rerun picks up where the failure was.

**Combined files** in `data/`, the only ones the API reads:

| File | Content |
|---|---|
| `aggregate.parquet` | All months of the month aggregates, sorted. One row per (`weekday`, `hour`, `gruppe`, `eva`, `month`, `bucket`) with count `n`. `weekday` 0 = Monday, `hour` from the planned arrival, `gruppe` is `fern` or `regional`, `bucket` is the delay in whole minutes, NULL = cancelled stop. |
| `stations.parquet` | `eva`, `name` (from the newest month), `n` (summed), `lat`, `lon`, `land`. |
| `lines.parquet` | `linie`, `eva`, `gruppe`, `month`, `bucket`, `n`: the delay histogram per line and station. |
| `linien.parquet` | `linie`, `name`, `label`, `typ`: one row per line. |
| `monate.parquet` | `month`, `missing_hours`, `stations`: one row per month. The API requires it. |
| `days.parquet` | `day`, `gruppe`, `eva`, `bucket`, `n`: the month files and the raw days summed per key (an edge day can sit in two of them, or in the last month and the first raw day), sorted by day, EVA, group and bucket, in row groups of `DAYS_ROW_GROUP` = 50,000 rows (about one day), so the API's day filters (Live-Lage's one day, the Karte's range) skip the others ([day-history.md](day-history.md) §3). |
| `tage.parquet` | `day`, `missing_hours`: every calendar day from the first month to the last complete raw day, sorted. |
| `day_hours.parquet` | `day`, `hour`, `gruppe`, `eva`, `bucket`, `n`: the hour table of the month files and the raw days, summed per key like `days.parquet`, sorted by day, hour, EVA, group and bucket, in row groups of `DAYS_ROW_GROUP` rows. It holds the large stations only (`large_evas` over the combined `days.parquet` and `monate.parquet`, the core rule), so summed over the hour it equals `days.parquet` for those stations. The API reads it only for today, and the Azure deployment does not download it. |

`aggregate.parquet`, `lines.parquet`, `linien.parquet`, `stations.parquet` and `monate.parquet` are built from the month folders only.

**Today so far.** After `combine`, `pipeline.update` writes `data/heute_rest.parquet`, the current local day as far as the raw responses reach:

- It reads the UTC folders of the day before and of today, the way a raw day does, and takes the newest file with a `fchg` pass. If that pass ended on an earlier local day, or there is none, the file gets zero rows and nothing is downloaded.
- `stand` is the start of that pass (UTC), and the cut is the local hour of `stand`: only arrivals planned on today before that hour count, because the stops of the current hour are not settled.
- Only the large stations that answered that pass with a body count (the same set as in `day_hours.parquet`); a station whose request failed would otherwise keep older changes and look on time.
- The content is `day_hours` of those stops plus the constant `stand`, written to a `.tmp` sibling and renamed. It is rewritten on every update and never becomes a folder in `data/days/`, so `combine` and the completeness rule do not see it. Because it runs last, a failing download of today's files never keeps the complete days from being combined.
- It downloads both UTC folders again on every update (about 2 × 160 MB, deleted afterwards).

**Live collector.** `pipeline.live` fetches today's state of the large stations from the DB Timetables API ([adr/0002-live-source.md](adr/0002-live-source.md)):

- **Running it.** Register an application in the DB API Marketplace (plan "Free") and put its two values into the environment, `DB_CLIENT_ID=<client id>` and `DB_API_KEY=<api key>`, kept in an environment file outside the repository; the key is never committed, and the gate's secret scan covers the repository. Then `uv run python -m pipeline.live`. One call is one run and prints one line: the day and the cut, the requests and how many failed, how many stations are ready, and whether the deadline or HTTP 429 stopped it. The line never contains the key. For a fresh today, call it every 15 minutes, by cron or by a loop in the shell. It needs `data/days.parquet` and `data/monate.parquet` from `pipeline.update`, and the `pipeline` dependency group.
- **Stations.** `core.periods.large_stations` on `data/days.parquet`: the EVAs with stops in the last month before full coverage (`core.periods.full_coverage_start`), 131 stations, the ones the source had before it took every station in. The API uses the same function for Live-Lage.
- **A run.** First `fchg` for every station, then the missing `plan` slices of today before the current hour, station by station, then the slices of the current hour and the next three for all stations. Every slice is fetched once a day. HTTP 429 ends the run's requests; other errors, empty bodies and unparsable XML skip that request, and a skipped slice is asked for again next run. The state and the output are written in any case.
- **Rate.** One request per second at most, so never more than the documented 60 a minute; on average about 11 a minute (131 changes per run plus 24 slices per station and day). No request starts later than 12 minutes after the run's start, so runs every 15 minutes do not overlap unless one request hangs for its 30-second timeout.
- **State** in `data/live/YYYY-MM-DD/`: `plan.parquet`, `fchg.parquet` and `slices.parquet`; the XML is parsed with the raw days' rules (`pipeline.raw.parse` and `merge`) and dropped. Folders older than yesterday are deleted.
- **Output** `data/heute.parquet`: `day_hours` of today's arrivals before the last full hour of the run's start, at the stations whose changes came in this run and whose slices before that hour are all in, plus the run's start as `stand` (UTC). It is written to a `.tmp` sibling and renamed. Before 01:00, or when every request failed, it has zero rows.

## 3 Decisions

- **Delay is computed from arrival times** (`arrival_change_time − arrival_planned_time`; no change time = 0 min). Reason: `delay_in_min` in the source is the *departure* delay (arrival delay only at terminal stops), so it is not used.
- **Stops without `arrival_planned_time` are dropped from the delay data** (first stops, about 1.1 million rows per month). Reason: they have no arrival to measure. They still feed the line networks, because a first stop belongs to its trip.
- **Buses and rail replacement are excluded** (`Bus`, `bus`, `Bsv`, `BSv`, `SEV`). Reason: the product covers rail only, the dataset contains them.
- **Month is taken from `time`**, not from the planned arrival. Reason: a monthly file contains stops planned on the last day of the previous or the first day of the next month; `time` lies exactly within the file month.
- **Stations are identified by EVA; names are not unique.** Reason: the dataset has about 5,200 EVAs and some names occur twice (e.g. Hamburg Hbf with two EVAs). The UI shows "name (EVA)"; filters use the EVA only.
- **Cancelled stops are a NULL bucket**, never 0 min. Reason: a cancelled train is not an on-time train (AC-7); the cancellation rate is computed from the NULL bucket.
- **Delay histogram instead of precomputed median/P90.** Reason: percentiles cannot be merged across cells, and filters (period, station) must re-aggregate.
- **Category group by a fixed list**: `ICE, IC, EC, ECE, TGV, RJ, RJX, NJ, EN` are long-distance (`fern`), everything else is `regional`. Reason: the filter is required, the mapping is not specified.
- **Cleaning, per month, in this order:**
  - Delays below −30 min or above +1440 min (24 h, both bounds inclusive) are dropped as implausible. Cancelled stops are kept whatever their times say. A missing change time is plausible. Reason: the observed range is −150 to +1428 min; a delay beyond a day or an arrival half an hour early is a data error, not train behaviour.
  - Duplicates on (`eva`, `train_type`, `train_number`, `arrival_planned_time`) are dropped, keeping the first. Rows without an arrival are never duplicates. Reason: the source repeats stops, and a repeated stop would count twice. This runs after the plausibility rule, so a plausible copy survives an implausible first one.
  - The run prints how many rows each rule dropped per month (3–1,118 duplicates and 158–1,241 implausible rows over the 27 months).
- **No clamp.** The bucket is the exact minute. Reason: clamping hid the long tail from P90 and from the share of delays over an hour; the histogram stays small anyway.
- **A line is its name split into networks.** The name is `line_number`, or `"{train_type} {train_number}"` where that is missing (long-distance trains and a few regional ones, e.g. "ICE 679"). Reason: "S1" alone exists in 15 federal states and splits into 14 networks. Details:
  - **The train type goes in front of a bare number, for every train type** ("57" with RE becomes "RE57", "35" with FLX becomes "FLX35"), and letters and digits lose a space between them ("RE 3" becomes "RE3"). Reason: until the December 2025 timetable change the source gives regional lines as bare numbers and from then on prefixed. Without the rule one line splits in two (`57` and `RE57`), and S1, RE1 and IRE1 sharing a station merge into one line with mixed statistics.
  - Within one name, stations that share a `train_line_ride_id` belong to one network, transitively. A ride id is a trip pattern that repeats daily; 817 ride ids carry more than one name, so (name, ride id) is the unit, not the ride id alone. The networks are connected components, found by min-label propagation in `core/lines.py`.
  - Each month gets its own networks; the combine step joins them across months, with (month, network) standing in for a trip.
  - **Id** `"{name}:{lowest EVA of the network}"`, with the name as built above. It stays the same as months are added, unless a network gains a station with a lower EVA or merges with another one; a saved link to a line can then point at nothing.
  - **Label** names the line's two most frequent end stations by stops, e.g. "RE57 Dortmund Hbf – Warburg (Westf)"; ties go to the lower name. A train-number line ("ICE 679", one direction) reads "ICE 679 → Kassel-Wilhelmshöhe". With one end station the label is the name and that end, with none the name alone. Reason: the name alone does not say where a line runs, and the same name in two networks (S1) must be told apart. **Typ** is the most frequent `train_type` of the line and serves as the badge.
  - **End stations** come from `final_destination_station`; `destination_expr` fixes the spelling ("Schwerte(Ruhr)" becomes "Schwerte (Ruhr)", "Langenhagen - Kaltenweide" becomes "Langenhagen-Kaltenweide"). Null or blank destinations are left out. Reason: the column has 4,647 spellings, and the fix leaves only 32 duplicate groups.
  - A network that only has stops without an arrival (no delay data) is not a line: `linien.parquet` lists only networks with stops, so no row has an empty label or typ. Most lines are single long-distance train numbers. Rankings filter by minimum sample.
- **Missing hours are recorded per month, not repaired.** The usual level of an hour of the day is the lowest, over the seven weekdays, of the median row count of that (weekday, hour) in the month. An hour counts as a gap when it has fewer than `GAP_SHARE` (half) of that level in `pipeline/aggregate.py`; an hour with no rows at all counts too. Reason: the source is quiet at night and on Sunday mornings, so a fixed threshold, or the median over all days, would flag normal hours, while a relative rule also catches a half-empty hour. The hours are counted against the real local month, so the skipped hour of the March clock change is not a gap and the doubled October hour is not one either. The months after the station jump (2025-11) stay flagged for the days before 2025-11-02. Over the 27 months this flags 50 h in 2025-11, 4–12 h in 2024-11 and in six months between 2026-02 and 2026-08 (2026-07: 8 h), 1 h in 2025-06 and 2025-07, and none elsewhere. SPEC §4.1 names 102 h for July 2026; the way it counts is not known, so the figures can differ.
- **Missing hours are also counted per day** (`day_gaps`), with the same rule and the same hour table (`hour_table` in `pipeline/aggregate.py`) as the month figure, so the days of a month add up to its `missing_hours`. Reason: the daily series and the day map must know which days are incomplete. The day is the calendar day of the poll time, while the delay histogram's day is the planned arrival (see [day-history.md](day-history.md) §3).
- **`hour_table` is the one gap rule.** It takes the row count per hour over a range, adds the hours with no rows as 0, computes the usual level and marks the thin hours. The monthly figures (`_hour_counts`, for `meta` and `day_gaps`) call it with the month, the raw days (`raw_gaps`) with the days of the month so far. Reason: one definition of a missing hour, however much of the month is there.
- **The current month's days come from the raw responses, for the day views only.** Reason: the monthly file arrives after the month ends, so the day map and the daily series stopped up to five weeks back. Heatmap, rankings and the month views keep whole months, because a partial month would skew them (the product owner chose this). The raw days stand in until the monthly file replaces them.
- **Our own minimal parser** (`pipeline/raw.py`, stdlib `xml.etree`), not piebro's code. Reason: it needs only the columns that `clean`, `days` and `day_gaps` read, and piebro's release code is a reference, nothing is copied. The other columns are filled with NULL, so the schema check and the existing table functions apply unchanged. Source and responses are DB's own data via a public dataset; `xml.etree` is not hardened against hostile XML, and expat limits entity expansion.
- **How `plan` and `fchg` combine**, as piebro's monthly release does:
  - Files are read in time order, the responses of a file by `timestamp`; only HTTP 200 and non-empty responses count.
  - From `plan`, the latest snapshot per stop `id` gives type, number and the planned times.
  - From `fchg`, a snapshot replaces an earlier one of the same `id`, as a whole, only if it carries change data: `ct`, `clt`, `cs` or `ps="a"` on `ar` or `dp`, a `tl` of type `e`, or a `ref/tl` with attributes. Messages alone never replace one.
  - Full outer join on `id`. The planned time is the plan's, else the change's. The arrival change time is the `ct`, else the planned time; `time` is the departure change time, else the arrival change time. A stop is cancelled by `cs="c"` or a `clt`; it stays a NULL bucket in `days`, never 0 minutes.
  - The EVA comes from the request URL (zero-padded like the monthly files). `timestamp` is naive UTC, the stop times are local.
- **A raw day holds the stops planned on it, but only those recorded at or after the first raw day's 00:00.** Reason: the day key of `days` is the planned arrival, and the month comes from `time` (the "Month is taken from `time`" decision); a stop planned on the first raw day but recorded before midnight is already in the last monthly file, so summing raw and monthly never counts a stop twice.
  - The first raw day also keeps the stops planned on an earlier day but recorded at or after the boundary: the late stops of the last monthly day (about 0.2 % of it, mostly delayed ones), counted under their planned day. Without them that day would look slightly too punctual for a month.
  - When a monthly file arrives, the boundary moves a month on and the new first raw day is processed again under it; its folder is deleted first, so a crash leaves it to be redone.
- **A raw day reads three UTC folders: D-1, D and D+1.** Reason: the runs fetch the plan for the local hours 00:00 to 03:00 a day ahead, so it often sits in the folder before D, and that run's `fchg` pass is the last one that holds those stops. With only D and D+1, 17 of the 29 days of the first real run had under 2,000 rows in hour 0 (about 9,700 is normal) and six October days were flagged as gaps that were artefacts. A folder is used by three days in a row, so each is downloaded once per run.
- **Completeness is a snapshot after D+1 06:00 UTC.** Reason: trains running past midnight, and late changes, are settled by then; 08:00 local is conservative. The timestamp is the one stored (UTC).
- **Raw days are re-judged for gaps on every update.** The usual level of an hour grows with the month, so every raw day is judged again against the raw days of its month so far, from the stored `hours.parquet` and without downloading anything. Hours after the last complete day are never missing.
- **Duplicates keep the first in `time`, then `id` order.** Reason: the monthly release sorts by `time` and leaves ties open, so no rule on the id can reproduce it; the id order at least makes the raw result reproducible.
- **Equivalence with the monthly file was checked on four past days** (see the milestone). Reason: the product owner wanted exact or a stated cause before any tolerance.
- **Timetable changes are marked, not split.** `core.periods.timetable_changes` returns the Sunday after the second Saturday of December (2024-12-15, 2025-12-14, 2026-12-13). The API lists those inside the data range and trains keep one key across years. Reason: product owner's choice (SPEC O6); splitting statistics per timetable period comes with the planner, where train numbers matter.
- **Full coverage starts where the station count jumps.** `core.periods.full_coverage_start` returns the first month with at least half as many stations as the largest month. The source has about 135 stations per month until 2025-10 and about 5,2xx from 2025-11, so it returns 2025-11. Reason: views default to the period where "nationwide" is true.
- **The hour table is `days` with the planned arrival hour in the keys** (`day_hours`, both through `_per_day`), over all days. Reason: the reference days of today are cut at the hour today has reached, with all four metrics ([adr/0002-live-source.md](adr/0002-live-source.md)). `days.parquet` stays as it is, so the existing day views are unchanged.
- **The live collector and the partial day reuse the raw days' parser.** `stop_rows` is `parse` (fold one response into the `plan` and `fchg` dicts) plus `merge` (dicts to stop rows); the collector calls both steps, so live, raw and partial days follow one set of rules. The decisions about today (the cut, the deadline, which stations count, `stand`) are in [day-history.md](day-history.md) §3.
- **Local time comes from `core.periods.local_time`** (Polars' time zone rules), not from `zoneinfo`. Reason: Windows has no `tzdata`, and no package is added for it.
- **Output size over 27 months:** `aggregate.parquet` 60.8 MB, `lines.parquet` 10.9 MB, `linien.parquet` 0.2 MB, `stations.parquet` 0.1 MB, `monate.parquet` under 0.1 MB. The per-day histogram adds about 36 MB over 27 months (measured on 2025-06 and 2026-09); the real file is 36.7 MB, 0.3 % more with the row groups ([day-history.md](day-history.md) §5). The hour table `day_hours.parquet` holds the 131 large stations only and is 24.9 MB with the raw days up to 2026-10-30 (19.3 million rows; for all stations it was 231 MB and 106.0 million rows). The 2 GB limit of AC-3 is far away, so no watchlist fallback is needed.

## 4 Architecture and data keys

- `pipeline/aggregate.py`: per-month tables from one source file, read lazily with Polars. `check_schema` validates, `clean` applies the cleaning, and `aggregate`, `lines`, `ends`, `month_networks`, `stations`, `meta`, `days`, `day_gaps` and `day_hours` build the nine month tables (`days` and `day_hours` share `_per_day`). `with_coords` and `coverage_report` serve the combine step.
- `pipeline/update.py`: `update` walks the remote months and calls `process` for each incomplete one, then `update_days` for the raw days, then `combine`, then (when `main` passes a clock) `update_rest` for today so far. The downloader, the list of remote months and the raw source (`RawSource`: list a UTC day's files, read the newest `fchg` time of a file, download a file) are passed in, so tests run it with fakes that count their calls. `combine` writes the eight combined files; `MONTH_FILES` lists the month tables, so a month folder without one of them counts as incomplete. `update_days` deletes leftover `.tmp` folders and the day folders of complete months (the new first day first), then walks from the first day after the last month to the first incomplete day; `process_day` writes one folder, `_write_gaps` re-judges all of them, `_raw_dirs` lists the folders `combine` adds (`DAY_FILES`: `days`, `hours`, `day_hours`; `SETTLED_HOUR` = 6). `newest_fchg` finds the newest file with a `fchg` snapshot, looking back past files without one, for `update_days` and `update_rest`; `update_rest` writes `heute_rest.parquet`.
- `pipeline/raw.py`: `stop_rows` parses `plan` and `fchg` into one row per stop id in the monthly schema, as `parse` (one response into the dicts) and `merge` (the dicts into rows); `fchg_pass` gives a file's `fchg` pass start and the stations that answered with a body; `day_tables` returns `days`, `hours` and `day_hours` of one day; `raw_gaps` returns the missing hours per raw day through `hour_table`; `remote_source` is the real `RawSource` (the HuggingFace listing per day folder, a remote read of the two columns `api_name` and `timestamp`, the download).
- `pipeline/live.py`: the live collector (`run`, `large_evas`, `main`; see §2, "Live collector"). Its `large_evas` calls `core.periods.large_stations` on `data/days.parquet` and is also the set `combine` and `update_rest` keep in `day_hours.parquet` and `heute_rest.parquet`; `run` exits when it is empty.
- `core/lines.py`, `core/periods.py`, `core/delay.py`, `core/holidays.py`: the pure parts (line names, end-station spelling and networks, timetable changes, coverage start, the large stations and German local time, the delay and plausibility rules, the nationwide public holidays: fixed dates plus the Easter-based ones, no library; regional holidays are not included).
- `data/coords.parquet`: `ibnr`, `lat`, `lon`, `land`, one row per IBNR for the whole of Wikidata (not only Germany). The join strips the leading zero of our EVA (`08000207` to `8000207`) with `core.stations.ibnr_expr`. An EVA without a match takes the coordinates of the one located station with exactly the same name (secondary EVAs such as S-Bahn platforms). Details and the source decision: [adr/0001-station-coordinates.md](adr/0001-station-coordinates.md).
- `data/stations.parquet`: `n` is all stops of the EVA in the source, arrival stops with cancelled ones included; it ranks search results and sizes map dots. `lat`, `lon` and `land` are NULL where Wikidata has no match or no state.
- Coverage report, printed by the combine step: named stations with coordinates (number and share), the share of stops that belong to them, and the unmatched named stations with the most stops. Over 27 months: 5,418 of 5,419 named stations (100.0 %, as the report rounds it). Unmatched: Trebitz (b Könnern), one stop, no Wikidata item.
- The source also contains `xml_station_name`, `id`, `is_additional_stop`, the departure columns and more; most are not used yet.
- Time zone: Europe/Berlin, as in the source; the stop times are not converted. The request times (`timestamp` of the raw files, the collector's clock) are UTC; where they decide a local day or hour (today, the cut), `core.periods.local_time` converts them.

## 5 Milestones

- [x] M0 – Download command and one-month aggregate run through the gate. Re-check: `tests/core` (delay semantics, NULL bucket) and `tests/pipeline` (incl. schema abort) pass.
- [x] M3 – Multi-month pipeline: incremental download, strict schema, cleaning, line networks, coverage, timetable changes marked. Re-check: `uv run pytest -q` passes, in particular
  - AC-1: `tests/pipeline/test_update.py` (`test_second_run_fetches_nothing_and_still_combines`, `test_month_missing_a_file_is_reprocessed`, `test_leftover_temporary_folder_is_not_complete`, `test_update_aborts_without_coords_before_fetching`)
  - AC-2: `tests/pipeline/test_aggregate.py` (`test_schema_abort`, `test_schema_abort_names_a_new_column`)
  - cleaning and missing hours: `tests/pipeline/test_aggregate.py` (`test_cleaning_drops_duplicates_and_implausible_delays`, `test_a_plausible_copy_survives_an_implausible_first_one`, `test_stops_without_arrival_are_never_duplicates`, `test_meta_counts_thin_hours_as_missing`, `test_meta_compares_an_hour_with_its_usual_level_on_that_weekday`, `test_meta_doubled_october_hour_is_not_missing`, `test_meta_counts_missing_hours_against_the_real_month`), `tests/pipeline/test_update.py` (`test_cleaning_counts_are_printed`, `test_monate`) and `tests/core/test_core.py` (`test_arrival_delay_rules`, `test_plausible_bounds_are_inclusive_and_missing_change_is_plausible`)
  - combine: `tests/pipeline/test_update.py` (`test_combine_stations_newest_name_and_summed_n`, `test_combine_station_keeps_the_newest_name_that_is_not_null`, `test_combine_lines_networks_and_labels`, `test_lines_sum_back_to_the_aggregate`)
  - line networks: `tests/core/test_lines.py` (`test_two_networks_without_shared_station_stay_apart`, `test_cross_month_join_via_month_and_net`, `test_line_ids`, `test_line_table_leaves_out_networks_without_stops`)
  - timetable changes and coverage: `tests/core/test_periods.py` (`test_timetable_changes`, `test_full_coverage_start`)
  - the real run: `uv run python -m pipeline.update` over all 27 months, then again; the second run skips every month and downloads nothing.
- [x] Line names – one line per train type and network, labelled by its end stations. Re-check: `uv run pytest -q`, in particular
  - `tests/core/test_lines.py` (`test_line_name_puts_the_train_type_before_a_bare_number`, `test_destination_spelling_is_unified`, `test_line_table_labels_name_the_two_most_frequent_ends`, `test_line_table_train_number_names_show_an_arrow_to_the_top_end`)
  - `tests/pipeline/test_update.py` (`test_bare_number_and_prefixed_name_become_one_line` for "57" in one month and "RE57" in the next, `test_bare_numbers_of_different_train_types_stay_apart` for S1 and RE1 at a shared station, `test_blank_destination_is_not_an_end`, `test_combine_lines_networks_and_labels`)
  - the real run over all 27 months, before and after: stations showing a line name more than once 4,118 of 5,430 and 0; regional stops on bare-number names 27.7 % and 0; Winterberg (Westf) lists RE57 twice and once; lines 19,379 and 18,971.

- [x] Day tables – a delay histogram and the missing hours per day. Re-check: `uv run pytest -q`, in particular
  - `tests/core/test_holidays.py` (`test_easter_2025_and_its_neighbours`, `test_easter_2026_moves_the_other_holidays`, `test_nine_fixed_and_movable_days`)
  - `tests/pipeline/test_aggregate.py` (`test_days_sum_back_to_the_aggregate`, `test_days_take_the_planned_arrival_and_keep_cancelled_null`, `test_days_are_sorted_with_nulls_last`, `test_day_gaps_has_one_row_per_day_and_adds_up_to_meta`, `test_day_gaps_follow_the_real_clock_changes`)
  - `tests/pipeline/test_update.py` (`test_month_without_the_day_tables_is_reprocessed`, `test_days_sum_back_to_the_aggregate_and_tage_to_monate`, `test_an_edge_day_split_over_two_months_is_summed`)
  - the real run: `uv run python -m pipeline.update` over all 27 months writes `data/days.parquet` and `data/tage.parquet`.

- [x] Fresh days – the days after the last monthly file, from the raw responses. Re-check: `uv run pytest -q`, in particular
  - `tests/pipeline/test_raw.py` (`test_rows_have_every_source_column`, `test_a_planned_stop_without_changes_is_on_time`, `test_a_changed_arrival_time_is_the_delay`, `test_a_cancelled_stop_is_never_0_minutes`, `test_the_cancellation_time_alone_cancels`, `test_the_later_snapshot_wins_across_files`, `test_the_later_snapshot_wins_whatever_the_row_order_in_a_file`, `test_a_snapshot_without_change_data_does_not_replace_one_with`, `test_a_stop_without_plan_takes_its_times_from_the_change`, `test_the_time_is_the_departure_change_where_there_is_one`, `test_failed_responses_are_ignored`, `test_raw_gaps_cover_only_the_given_days_and_find_a_thin_hour`, `test_a_day_without_any_row_misses_all_its_hours`)
  - `tests/pipeline/test_update.py` (`test_complete_raw_days_after_the_last_month_reach_the_day_tables` including a stop planned just before and arriving just after midnight, `test_raw_days_leave_the_monthly_tables_alone`, `test_a_second_run_downloads_nothing_new`, `test_a_day_waits_for_a_snapshot_after_the_next_days_6am`, `test_a_last_file_without_fchg_does_not_hide_a_late_snapshot_before_it`, `test_an_added_day_is_processed_by_the_next_run`, `test_a_day_folder_is_dropped_once_its_month_is_complete`, `test_combine_sums_a_raw_day_with_the_same_day_from_a_monthly_file`, `test_a_raw_day_keeps_a_stop_whose_plan_is_in_the_previous_folder`, `test_files_nobody_needs_any_more_are_deleted`, `test_the_first_raw_day_keeps_the_late_stops_of_the_last_monthly_day`, `test_the_boundary_shift_reprocesses_the_new_first_day`, `test_an_empty_folder_of_the_day_is_reported`)
  - the gap rule is unchanged: the existing `meta` and `day_gaps` tests in `tests/pipeline/test_aggregate.py` pass without an edit after `hour_table` was split out.
  - Evidence from the real data (one Polars thread, Windows):
    - **Equivalence with the monthly files.** The raw folders of the day and its neighbours were processed and the `days` rows of the day compared per (EVA, group, bucket) with the same day of `data/months/`. 2026-03-10 and 2026-09-15 keep their early plan in their own folder; 2026-09-14 and 2026-09-18 have it in the previous folder, so they test the three-folder rule (the first two ran on the earlier two-folder code, which gives the same result for such days):

      | | 2026-03-10 | 2026-09-15 | 2026-09-14 | 2026-09-18 |
      |---|---|---|---|---|
      | stops counted, ours / monthly | 473,888 / 473,888 | 476,880 / 476,880 | 472,421 / 472,421 | 478,310 / 478,310 |
      | (EVA, group, bucket) cells | 71,713 | 77,038 | 70,932 | 73,300 |
      | equal cells | 100 % | 99.992 % (6 differ) | 99.997 % (2 differ) | 100 % |
      | stations on one side only | 0 | 0 | 0 | 0 |

      The 2026-09-15 cells are 3 stops of one S-Bahn train (number 38102, a split and join with two ids per station, same planned arrival and same `time`), the 2026-09-14 cells one stop of one train (RE 11449) with two ids at the same `time`, each counted a minute off: the tie in the duplicate rule (§3), not the parsing. For 2026-09-15, joined by `id`, every stop of the day is on both sides and no stop has a different arrival change time; the cancelled stops (28,353) are equal. The product owner accepted this noise.
    - **Why three folders.** The first real run, over the 29 days 2026-10-01 to 2026-10-29 with two folders per day, left 17 of them under 2,000 rows in hour 0 and flagged six October days as gaps; the early plan sat in the previous folder. With D-1 it is fixed (see the rerun).
    - **Real run with three folders**, the same 29 days: about 32 minutes (about 70 s a day for downloading and parsing three folders, 1.3 to 1.7 million stops per day, plus `combine`), 29 folders in `data/days/`, `data/days.parquet` 39.5 MB (36.7 MB before; 26.4 million rows), the last day in `data/tage.parquet` 2026-10-29. No gap day in October. Rows in hour 0 per raw day: median 9,851 (minimum 9,385), against a median of 10,237 (minimum 9,291) in September's monthly file. The daily trend reaches the newest day for all four metrics, nationwide and for Köln Hbf (before, it ended on 2026-10-22).
    - **Time**, `/tageskarte?tag=2026-10-29` (5,023 stations, 1.55 MB, measured before the API listed only the 131 large stations) cold 0.63 s and warm 42 ms; `/tagesverlauf` nationwide (851 days) cold 0.46 s and warm 8 ms; test client over the real data, one thread (measured on the first run; the rerun did not change the data's size).

- [x] Hour table and today so far – the day histogram per hour, the partial current day from the raw responses and the live collector. Re-check: `uv run pytest -q`, in particular `tests/pipeline/test_aggregate.py` (`test_day_hours_sum_over_the_hour_to_days`), `tests/pipeline/test_update.py` (`test_day_hours_sum_an_edge_day_and_add_up_to_days_of_the_large_stations`, `test_day_hours_take_the_raw_days_too`), `tests/pipeline/test_rest.py`, `tests/pipeline/test_live.py` and `tests/core/test_periods.py` (`test_local_time_is_naive_german_time_in_winter_summer_and_the_doubled_hour`); `tests/pipeline/test_raw.py` passes unchanged after the split into `parse` and `merge`. The test names and the real-data figures are in [day-history.md](day-history.md) §5; the run with the real DB key is a platform check there (§6).

## 6 Platform checks

- `uv`; paths use forward slashes in code and commands, so the commands run the same on Windows, macOS and Linux.
- The first run over 27 months took 8–14 min with the downloads already local; a second run only combines and took 53 s. Memory stays moderate because Polars scans lazily.
- **AC-4 spot check.** Six stops drawn at random from six different months (delays of 1, 1, 4, 9 and 13 min, and one cancelled stop), each on a unique key. For each, the delay was computed by hand from the raw timestamps (change minus plan in whole minutes, truncated toward zero; cancelled is no delay) and compared with `arrival_delay_expr`. Then the stop's cell (weekday, hour, group, EVA, month, bucket) was looked up in `data/months/YYYY-MM/aggregate.parquet` and recounted from the whole raw month with the cleaning rules written out again in plain Python. All six agree, in the delay and in the cell count:

  | Train | Station (EVA) | Planned arrival | Raw change | Raw delay | Computed delay | Cell count raw / file |
  |---|---|---|---|---|---|---|
  | S 1554 | Berlin-Friedenau (08089058) | 2025-12-22 09:04 | 09:05 | 1 min | 1 min | 41 / 41 |
  | S 8903 | München Ost (08000262) | 2025-09-26 20:04 | 20:13 | 9 min | 9 min | 8 / 8 |
  | S 41085 | Hamburg-Altona (08098553) | 2025-02-20 09:50 | 09:54 | 4 min | 4 min | 19 / 19 |
  | NWB 83437 | Schierbrok (08005343) | 2026-03-02 23:37 | 23:50 | 13 min | 13 min | 1 / 1 |
  | S 7088 | Berlin-Lichtenberg (08089182) | 2025-06-09 12:06 | 12:07 | 1 min | 1 min | 43 / 43 |
  | RE 10207 | Dülmen (08000083) | 2026-08-02 08:19 | 09:19 | cancelled | NULL bucket | 1 / 1 |

  The cell is the finest granularity the file has, so a count match shows the stop sits in the right bucket and nothing was dropped or doubled. The throwaway script is not in the repo; `scripts/check_sample.py` is the repeatable version of the delay comparison.

## 7 Open decisions

None.

## 8 Known shortcuts

- The skip check looks only at the month folder: a month file that HuggingFace replaces later is not fetched again, and month folders carry no version. Changing the per-month logic needs `data/months/` deleted by hand (see §2).
- Downloads use no pinned dataset `revision`. If the upstream dataset re-uploads a month, a newly fetched month and the older processed ones can come from different upstream states without notice. Revisit when upstream corrections matter: record the dataset commit in `meta` and reprocess the months whose commit differs.
- The combine step rewrites every combined file on every run, also when no month is new.
- The monthly source files stay in `data/raw/` after processing, about 5 GB for 27 months. The raw-day downloads are deleted after processing.
- **Tie-break noise in raw days.** About 3 stops a day (one train's two ids with the same `time`) keep the other duplicate than the monthly file does and sit 1 to 2 minutes off. It ends when the monthly file replaces the raw days (`ponytail:` comment in `day_tables`).
- **An early-month gap may stay unflagged.** The raw days' usual level comes from the raw days of the month so far, one value per weekday early on, so a gap is found only once its weekday has come round about three times. A gap in the first two weeks of a month may stay unflagged until the monthly file arrives. Pooling the previous month's level would fix it (`ponytail:` comment in `raw_gaps`).
- **No retry on network errors** in `remote_source`: a failure stops the run, and running it again is the remedy; days that are done are skipped.
- **Raw downloads are not kept.** A day's raw files are downloaded again if its folder is lost or the parse logic changes (`ponytail:` comment in `update_days`); keeping them would cost about 250 MB a day. After a change to the parsing, delete `data/days/` and run `pipeline.update` again.
- **An empty folder after a day stalls the later days.** If the source loses a whole UTC day, the folder of D+1 is empty, the completeness check never passes and no day after D is processed until the folder appears or the monthly file arrives (`ponytail:` comment in `update_days`). A day whose own folder is empty is processed from its neighbours and prints a warning; the gap rule flags it. Skipping over an empty folder needs a rule for the day after.
- `combine` fails when no month folder is complete; it only happens if the remote list is empty.
- The shortcuts of today (the partial day's repeated download, the collector's catch-up, its frozen station list and whole-state rewrite) are listed in [day-history.md](day-history.md) §8.
- The spot check script runs on demand, not in the gate.
- `pipeline.coords` is not run by tests or the gate (it needs the network); only its parser is tested, on canned JSON.
- The end-station spelling fix is a regex. Variants such as "Bahnhof, Arnsberg" stay separate; map destinations to station EVAs if they show in labels.
- The train type comes from `train_type` before December 2025 and from `line_number` after. A line the source typed differently before the change (RB68 then, RE68 now; IRE1 then, ARV1 now) stays a separate line that ends in 2025-11. Over 27 months that is 77 lines and 0.045 % of stops; revisit if one shows up in the rankings.
- A line is shown as a train-number line (label with "→") when its name matches `^\S+ \d+$`. A source line number with a space before the digits would match too; 2 such labels exist in the real data.
