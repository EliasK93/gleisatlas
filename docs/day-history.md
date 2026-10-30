# Day history

## 1 Overview

Day-level history: a daily time series with a 28-day trend in place of the monthly one (months stay as a switch), and a day mode of the map that colours every station by one past day against its normal for that weekday. Both rest on a per-day delay histogram. The planned feature direction is in SPEC §3.4; Bundesländer, a calendar view and marked events come later.

## 2 Spec

**Daily time series** (`/muster/zeitverlauf`, nationwide or one station):

- One point per calendar day of the data: punctuality, cancellation rate, median and P90, each with `n`. A faint line shows the daily values, a bold line the trend.
- Days with missing source hours are drawn dashed and listed in the tooltip. They still show their own values but never feed the trend. The same goes for days with little data: a day feeds a metric's trend only when its value would be shown, by the same rule as the dashed days.
- Timetable changes stay marked. Days are the default view; a Tag/Monat switch returns to the monthly series. Line series and the station sparkline stay monthly.
- The table mode lists the days.

**Day map** (`/karte?tag=YYYY-MM-DD`):

- A "Zeitraum | Tag" switch in the map's filter bar; the day is picked with a native date field limited to the days in `/datenstand`.
- Each station is coloured by the deviation of the day's value from its normal on a five-step diverging scale (much better to much worse, the middle step is normal). A station without a normal is grey. The little-data rules of the period map apply to the day's `n`.
- A weather card for Germany shows one of five symbols, taken from the rank of the nationwide value among the reference days; the real values are in its tooltip.
- A day with missing source hours is selectable and marked.
- The station panel shows the day against the normal.

**Normal.** The median of the same weekday over the previous 12 weeks, per metric, without days with missing hours and without nationwide public holidays. At least 8 valid days must remain, otherwise there is no normal.

## 3 Decisions

- **A delay histogram per day, not counters.** The day table keeps (`day`, `gruppe`, `eva`, `bucket`, `n`), the same shape as the month aggregate without weekday and hour. Reason: all four metrics, filters by category and station, and the median and P90 can only be computed from a histogram (see [patterns.md](patterns.md) §3); counters would give the punctual share and cancellation rate only. It costs about 36 MB over 27 months (measured on 2025-06 and 2026-09).
- **The day key is the planned arrival date** (Europe/Berlin). Reason: the same rule as weekday and hour in the month aggregate, so a day's counts and the heatmap agree.
- **Edge days are summed across month files.** A file holds the stops planned on the edge day of its neighbour month (the month comes from `time`, see [pipeline.md](pipeline.md) §3), so the same day can sit in two files. `combine` sums per key instead of dropping rows. Reason: measured on the real files, the overlap is tiny (0 and 1 stops repeated at two month boundaries), and summing is correct whether a stop is repeated or split.
- **Day gaps use the same `GAP_SHARE` rule as the months.** `day_gaps` counts the thin hours of the month's hour table per calendar day, so the days add up to the month's `missing_hours`. Reason: one definition of "incomplete" for the month and the day views.
- **The trend is a centred 28-day median over days without gaps and with enough data, with at least 14 values.** A day with little data is one whose value the UI would not show (the low-data rule of [app-shell.md](app-shell.md) §2). Reason: a median ignores single bad days (strikes, storms) and a gap day would pull the line down for a reason that is not the railway; a trend drawn from days that the same page dashes as too thin would break the rule that no value is shown below the limit; with fewer than 14 values the line would claim a trend from too little.
- **Days are the default view, months a switch.** Reason: the daily series is the richer view and was the point of the feature; months stay for the long run and for readers who want the earlier chart.
- **Line series and the station sparkline stay monthly until the line page.** Reason: per-line days need per-run data that the line detail page brings; the day table has no line key.
- **A separate route `/tagesverlauf` instead of a parameter on `/zeitverlauf`.** Reason: the monthly contract, its models and its tests stay unchanged, and the daily series has fields the monthly one does not (gap hours, trend) and no `linie`.
- **For the day map, the normal is the median of the same weekday over the previous 12 weeks, without gap days and nationwide holidays, needing at least 8 valid days.** Reason: the same weekday removes the weekly rhythm, 12 weeks are recent enough to follow the timetable and long enough for a stable median, and holidays and gap days are not normal days. Fewer than 8 values would make the median depend on a few days.
- **The day map shows the deviation from the normal on a five-step diverging scale.** Reason: the question of a day map is "worse than usual?", not "how punctual?", and a station that is always late must not look like a bad day.
- **The Germany symbol comes from the rank among the reference days.** Reason: the rank says how unusual the day is without a threshold on a metric that differs by season.
- **The URL key is `tag`** (`/karte?tag=YYYY-MM-DD`). Reason: the existing filter keys are German and short (`von`, `bis`, `gattung`), and a link to a day must be shareable.
- **Bundesländer come later.** Reason: the day map and the daily series are the new ground; a state layer on top needs its own design (weather symbols per state, then the stations).

## 4 Architecture and data keys

- `core/holidays.py`: `nationwide_holidays(year)` returns the nine nationwide dates as a `frozenset[date]`: New Year, Good Friday, Easter Monday, 1 May, Ascension, Whit Monday, 3 October and both Christmas days. Easter comes from the anonymous Gregorian algorithm, no library.
- `pipeline/aggregate.py`: `days` builds the per-day histogram of a month file, `day_gaps` the missing hours per calendar day; both reuse `_hour_counts`, which `meta` uses too. `pipeline/update.py` lists them in `MONTH_FILES`; `combine` writes `data/days.parquet` and `data/tage.parquet` ([pipeline.md](pipeline.md) §2).
- `data/days.parquet`: `day`, `gruppe`, `eva`, `bucket`, `n`, sorted by day, EVA, group and bucket (NULL bucket = cancelled stop, never 0 minutes). `data/tage.parquet`: `day`, `missing_hours`, one row per calendar day.
- `backend/main.py`: `GET /tagesverlauf` (`eva`, `gattung`) returns `titel` and `tage` (`tag`, `n`, the four statistics, `fehlende_stunden`, `trend`); `trends` computes the centred median with `rolling_median_by`, and `tage_for` caches per selection and file modification times. `/datenstand` carries `erster_tag`, `letzter_tag` and `fehlende_stunden_tage`. The paths are `DAYS_PATH` and `TAGE_PATH`, both in the deploy download list ([patterns.md](patterns.md) §2 and §4, [deployment.md](deployment.md)).
- The day map's normal is built in `core/` (pure) and served by its own route; both are described here when built.
- `frontend/src/ZeitverlaufPage.tsx`: the page with the Tag/Monat switch, the day and month rows and the table mode. `frontend/src/charts.tsx`: the chart pieces both resolutions share (`Plot`, `Line`, `TrendLine`, `Band`, `Markers`, `tipOf`). `frontend/src/metrics.ts`: `readFilters` and `writeFilters` carry `z`. The shell around it is in [app-shell.md](app-shell.md).
- Frontend keys: the daily series is the default of `/muster/zeitverlauf`, `z=monat` switches to months and is dropped on every other page; a line URL drops `z`, stays monthly and hides the switch; `tag` switches `/karte` to day mode.

## 5 Milestones

- [x] Daily time series. Re-check: `uv run pytest -q`, in particular
  - `tests/api/test_tagesverlauf_api.py` (`test_day_sums_match_the_histogram_and_cancelled_stops_stay_cancelled`, `test_every_calendar_day_is_present_and_empty_days_have_no_statistics`, `test_gattung_filters`, `test_unknown_station_is_404_and_a_bad_eva_or_gattung_is_422`, `test_trend_is_the_centred_28_day_median`, `test_days_with_missing_hours_do_not_feed_the_trend`, `test_trend_needs_14_values_in_the_window`) and `tests/api/test_datenstand_api.py` (`test_datenstand_carries_the_day_range_and_only_the_days_with_gaps`)
  - the day tables: `tests/core/test_holidays.py`, `tests/pipeline/test_aggregate.py` and `tests/pipeline/test_update.py` ([pipeline.md](pipeline.md) §5)
  - `npm --prefix frontend run test:e2e`, `frontend/e2e/zeitverlauf.spec.ts`
  - Evidence from the real 27 months (one Polars thread, a local machine under load from a parallel test run):
    - sizes: `days.parquet` 36.6 MB, `tage.parquet` under 0.1 MB, `aggregate.parquet` 63.9 MB
    - `/tagesverlauf` cold: nationwide 1.6 s, one station 0.66 s, `gattung=fern` 0.76 s; warm about 30 ms
    - peak working set 491 MB, unchanged; the cold `/karte` sets it
    - spot check: Köln Hbf (`08000207`) on 2025-08-05, recounted from `data/raw/monthly_processed_data/data-2025-08.parquet` with the pipeline's own cleaning, gives n = 1,160, cancellation rate 6.38 %, punctuality 58.4 % and median 4 min, the same as the API
- [ ] Day map. Re-check: to be filled when built.

## 6 Platform checks

- [ ] Redeploy with the larger data: the size of the data files and the cold start against the earlier 20.9 s ([deployment.md](deployment.md) §6).

## 7 Open decisions

None.

## 8 Known shortcuts

- Regional public holidays (Epiphany, Corpus Christi and others) are left out of `core/holidays.py`. A regional holiday can therefore sit among the reference days of a normal.
- Day gaps are counted by the day of the poll time, while the day key of the histogram is the planned arrival. A gap around midnight can mark the neighbouring day.
- `tage_for` keeps the computed series per process (`lru_cache`, 16 entries, keyed by selection and both file modification times), like the other caches ([patterns.md](patterns.md) §8). The first request of a selection computes it: 1.6 s nationwide, 0.7 to 0.8 s for one station or `gattung=fern`, about 30 ms afterwards (measured, §5). An entry is one model per day. Revisit when the station page is used heavily or the days outgrow this.
- The nationwide trend around the start of full coverage (2025-11) blends two populations: about 135 stations before, all stations after, for roughly two weeks on each side of the change, because the window is centred. The "Datenbasis erweitert" marker explains the step; the monthly series has the same step. Not fixed. Resetting the rolling window at `vollabdeckung_ab` would remove it.
- The trend is the median of the days that pass the low-data rule, per metric. A station whose days all have little data therefore has no trend line, although its days are still drawn.
