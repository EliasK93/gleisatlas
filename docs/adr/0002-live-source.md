# ADR 0002: A live source for today

Status: accepted (based on a spike: research and measurements)

## Context

The day map ([day-history.md](../day-history.md)) reaches up to the last day of the monthly files; the current month comes from piebro's raw data, up to yesterday from about midday, at worst the day before (a day is complete only with the first run after 06:00 UTC the next day). The product owner wants the map to reach today, refreshed every 10 to 15 minutes, compared with the same hours of the reference days. piebro's collector is scheduled four times a day ([workflow](https://github.com/piebro/deutsche-bahn-data/blob/main/.github/workflows/fetch_and_upload_data.yml), cron `17 3,9,15,21 * * *` UTC), but the runs start hours late or are dropped: 3 to 6 runs per UTC day, and in October 2026 the data was up to about 10 hours behind (observed run starts on 2026-10-28, UTC: 00:31, 01:00, 09:37, 20:14). Anything fresher needs an own collector against the DB Timetables API, which SPEC §3.3 rules out before v2. This record decides it.

## The Timetables API

Facts from the DB API Marketplace, read on 2026-10-30:

- **One plan, "Free"**: free of charge, operated around the clock, no service hours, **60 calls per minute**. The product is described as a beta for station timetable data of DB Station&Service AG, and the data as CC BY 4.0. Source: [product page](https://developers.deutschebahn.com/db-api-marketplace/apis/product/timetables).
- **Endpoints** ([API reference](https://developers.deutschebahn.com/db-api-marketplace/apis/product/timetables/api/160160), base `https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1`, headers `DB-Client-ID` and `DB-Api-Key`):
  - `GET /plan/{evaNo}/{date}/{hour}`: planned stops of one station in one hourly slice; static, "generated many hours in advance", never contains changes. One request per station and hour, so a full day is 24 requests per station.
  - `GET /fchg/{evaNo}`: "all known changes" for the station, updated every 30 s. Changes carry the changed attributes (`ct`, `cp`, `cs`); planned attributes only for stops without planned data. The delay therefore needs the plan: `ct − pt` joins `fchg` onto `plan`.
  - `GET /rchg/{evaNo}`: only the changes of the last 2 minutes; meant for clients that poll more often than every 2 minutes after one `fchg`. At 10 to 15 minutes `fchg` is the right call.
- **Registering** ([terms of use](https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen), status 05/2022, § 3): a free DB Kundenkonto (e-mail, password, salutation and name), then registration in the marketplace and activation by DB, with no right to activation. Then the plan "Free" is subscribed to an application, which yields the client ID and API key. The product owner registers; the key lives in a secret store, never in the repository.
- **Terms that matter here**:
  - § 7: DB may limit a user's calls for technical or security reasons, may block a user, and gives no availability guarantee.
  - § 4: no use that puts excessive load on the infrastructure; registered users treat marketplace content as confidential "unless DB has expressly permitted it". § 1 puts separate licence agreements first, and the product page grants CC BY 4.0, which permits redistribution with attribution.
  - Attribution: the existing CC BY 4.0 notice ("Deutsche Bahn, aggregated") covers live data too; the source line would add "DB Timetables API" next to piebro's dataset.

## Measurements

piebro's raw files, read remotely with Polars (`hf://datasets/piebro/deutsche-bahn-data/raw_data/year=2026/month=10/day=28/…`, read-only), two runs on 2026-10-28 (01:00 and 20:15 UTC, 02:00 and 21:15 CET; the raw timestamps are UTC, the `ct` and `pt` values local time):

| | 01:00 run | 20:15 run |
|---|---|---|
| `fchg` requests (stations) | 5,461 | 5,461 |
| Duration of the `fchg` pass | 5.0 min | 4.75 min |
| Requests per minute, median (max) | 998 (1,728) | 1,002 (1,501) |
| Body size of the whole pass (XML, uncompressed) | 67.0 MB | 91.4 MB |
| One station: median / P90 / max | 5.5 / 28 / 400 kB | 7.2 / 40 / 486 kB |
| The 135 largest responses together (median), a stand-in for the large stations | 13.7 MB (111 kB) | 18.8 MB (146 kB) |
| HTTP 400 / empty body | 28 / 293 | 28 / 284 |
| `plan` slices fetched | 4 h × 5,461 in 20 min, 7.7 MB | 11 h × 5,461 in 52 min, 139 MB |

- The largest station is Köln Hbf (`08000207`): 400 to 486 kB and 852 to 1,033 stops per `fchg`.
- `fchg` holds changes reaching about 13 to 14 hours into the past (Köln Hbf at 21:16 CET: `ct` from 07:04 that morning to 09:02 the next day; at 02:02 CET: from 12:55 the day before). Although the API reference says departed trips are removed, a missed 15-minute run loses nothing.
- piebro's collector requests at up to 1,000 per minute with 10 in parallel ([db_data_fetcher.py](https://github.com/piebro/deutsche-bahn-data/blob/main/scripts/db_data_fetcher.py), [fetch_eva_plan_and_change.py](https://github.com/piebro/deutsche-bahn-data/blob/main/scripts/fetch_eva_plan_and_change.py)), and the passes above ran at that speed. The fetcher retries HTTP 429 silently, so the files cannot show whether DB throttled. Its four scheduled runs a day (4 × `fchg` + 24 × `plan` per station) alone average about 106 requests per minute, above the documented 60. **The documented limit is evidently not enforced today; nothing guarantees it stays that way.**
- Berlin Hbf (`08011160`) returned an empty body in both passes, Berlin Hbf (tief) (`08098160`) 181 to 214 kB: some large stations report under a second EVA.

Hour dimension, from the local monthly files with the pipeline's own cleaning (`pipeline.aggregate`), written as Parquet the way `days.parquet` is:

| Month | Day histogram (`days`) | Day × hour histogram | Factor |
|---|---|---|---|
| 2025-06 (≈131 stations) | 172,791 rows, 0.22 MB | 699,306 rows, 0.87 MB | 4.0 |
| 2026-09 (all stations) | 1,984,515 rows, 3.01 MB | 7,900,320 rows, 9.53 MB | 3.2 |

2026-09 has 13.4 M arrivals, about 447,000 per day.

## Polling: requests per minute

`fchg` once per station and run; `plan` 24 slices per station and day, fetched once each (static data):

| | ≈135 large stations | all 5,461 stations |
|---|---|---|
| `fchg` every 15 min | 9 / min | 364 / min |
| `fchg` every 10 min | 13.5 / min | 546 / min |
| `plan`, 24 slices a day | 2.3 / min | 91 / min |
| **Total at 15 min** | **≈ 11 / min** | **≈ 455 / min** |
| **Total at 10 min** | **≈ 16 / min** | **≈ 637 / min** |
| XML per day at 15 min | ≈ 1.3–1.8 GB | ≈ 6.4–8.8 GB |

- Within the documented 60 per minute: about 720 stations at 15 minutes, about 510 at 10 minutes. The `plan` slices alone for all stations (91 per minute) are already above it, whatever the `fchg` interval.
- The large stations are the ones in the data before full coverage (about 131 in 2025-06); their list comes from our own files, so the separate StaDa API is not needed.
- The XML is parsed and dropped; only today's state is kept. Inbound traffic is free on Azure ([bandwidth pricing](https://azure.microsoft.com/en-us/pricing/details/bandwidth/): "inbound data transfer is free").

## Hosting

**Azure Container Apps job on a schedule.** Cron in UTC, five fields, down to every minute; jobs have no ingress and are billed at the active rate per allocated second, from the same monthly free grant as the API (180,000 vCPU-s, 360,000 GiB-s per subscription); the smallest size is 0.25 vCPU / 0.5 GiB ([jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs), [billing](https://learn.microsoft.com/en-us/azure/container-apps/billing)).

- The large-station collector at 15 minutes, paced to 60 per minute: about 169 requests per run (135 `fchg` + 34 `plan` slices), so about 3 minutes of waiting plus the container start, say 3.5 minutes. 2,880 runs a month × 210 s × 0.25 vCPU ≈ 151,000 vCPU-s and ≈ 302,000 GiB-s: **about 84 % of the free grant**, which the API shares. What is left covers about 160 of the API's 6-minute wake-ups instead of about 1,000 ([deployment.md](../deployment.md) §4); a busier month goes beyond the grant. If the documented limit stays unenforced, a run is under a minute and the job uses about a quarter of the grant. The container start of a job was not measured.
- All stations at 15 minutes would need about 5 minutes per run at piebro's speed: beyond the free grant on its own.

**A VPS with cron** (one small rented server, as considered for the stable run). The collector runs on the same machine as the API: no extra cost beyond the server, inbound traffic free, no grant to watch. It exists only once the API moves there.

**GitHub Actions cron** (piebro's approach) is not a fit: scheduled runs "can be delayed during periods of high loads", and "some queued jobs may be dropped" ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)), which piebro's [changelog](https://github.com/piebro/deutsche-bahn-data) reports for 2026-07; the result would still need a place the API reads from.

**Today's state and how the API picks it up.** The collector keeps today's stops (planned time from `plan`, the latest `ct` and cancellation from `fchg`, keyed by stop id and EVA) and after each run writes a small `today.parquet` in the shape of the day × hour histogram (one day is about 0.3 MB at full coverage), to a temporary name and then renamed, so a reader never sees half a file. The API's caches already key on file modification times (`st_mtime_ns` in `backend/main.py`), so:

- **On a VPS**: the collector writes into `data/`; nothing else changes.
- **On Azure** the API container downloads its files once at start (`backend/fetch.py`) and the job cannot write into it. Either the job uploads `today.parquet` to the existing public blob container and the API re-downloads it when it is older than about a minute and the blob changed (`If-Modified-Since`, standard library, like `fetch.py`), or both mount one Azure Files share ([storage mounts](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts): "Multiple containers can mount the same file share"), which adds a share, a storage definition in the environment and an identity or key. The blob variant is the smaller change.

## The hour dimension

"Today so far against the same hours of the reference days" cuts every reference day at the hour reached today, so the reference days need an hour key. Options, measured or extrapolated from the table above:

- **Day × hour histogram over all days** (`day`, `hour`, `gruppe`, `eva`, `bucket`, `n`): 3.2 times the rows of `days.parquet`, about 115 to 120 MB instead of 36.7 MB. All four metrics, as on the day map.
- **The same, only for the last 12 weeks plus today** (the reference window is 12 weeks by definition): about 85 days × 0.31 MB ≈ 26 MB, rebuilt daily; `days.parquet` stays for the history. All four metrics.
- **Day × hour × station counts** (arrived, punctual, cancelled): about 80 MB over 27 months (measured in another spike); punctuality and cancellation rate only, no median or P90.

The hour key is the planned arrival hour, as in the month aggregate. Stops planned in the last hour are still running; a cut at the last complete hour, or an hour back, keeps them from counting as on time. That is a design point for the milestone, not for this record.

## Effort and risks

Rough estimate, not measured: collector (fetch, XML parsing, joining `fchg` onto `plan`, the pipeline's cleaning rules) 8–12 h; the hour table and `/tageskarte` for today with the hour cut 6–10 h; the frontend ("heute", the refresh, the time of the data) 3–5 h; hosting 2–3 h on a ready VPS or 4–6 h on Azure (job, secret, blob re-download). About 20 to 30 hours. piebro's parser (`scripts/parse_monthly_xml.py`, MIT) can be read for its rules, so live and monthly values agree.

- **Rate limit**: documented 60 per minute, apparently not enforced. All stations relies on that or on a higher quota that DB may grant (the contact address is on the [API reference](https://developers.deutschebahn.com/db-api-marketplace/apis/product/timetables/api/160160)).
- **Terms and beta**: DB may block or change the API without notice (§ 7); the product is labelled beta. The map has to fall back to the last complete data when the collector fails.
- **Two sources for one day**: live values and piebro's later monthly values come from different collectors and parsers, so a day can shift a little when the monthly file replaces it.
- **Second EVAs and empty answers** (Berlin Hbf above, about 290 empty bodies and 28 errors per pass): the large-station list must be checked against `fchg`, not taken from names.
- **Secret handling**: the API key goes into a Container Apps secret or the VPS's environment file; the gate's secret scan covers the repository.
- **Cost on Azure**: the job takes most of the free grant; the budget alerts ([deployment.md](../deployment.md)) stay the protection.

## Options considered

Scope:

1. **Own collector for the ≈131 large stations every 15 minutes; the other stations from piebro's raw data (up to about 10 hours behind).** About 11 requests per minute, within the documented limit; the map shows two freshness levels and must say so.
2. **All 5,461 stations every 15 minutes.** About 455 requests per minute, only while DB does not enforce 60 per minute or after DB grants a higher quota in writing.
3. **No own collector; today from piebro's raw data only.** No registration and no new hosting, but "today" is up to about 10 hours behind and refreshed 3 to 6 times a day, at irregular times.
4. **Up to about 700 stations every 15 minutes within 60 per minute.** More of the map is fresh within the terms, but the `plan` slices still cap it and the choice of stations needs a rule.

Hosting:

1. **A VPS with cron, together with the API's move there.** No extra cost, today's file is read like every other file; only once the VPS exists.
2. **Azure Container Apps job with a blob re-download in the API.** Works with today's deployment; takes about 84 % of the free grant at 60 requests per minute.
3. **GitHub Actions.** Free on a public repository, but runs can be delayed or dropped.

Hour table:

1. **Day × hour histogram for the last 12 weeks plus today, about 26 MB.** All four metrics; the history stays in `days.parquet`.
2. **Day × hour histogram over all days, about 115 to 120 MB.** All four metrics for any past day cut at any hour; three times the data to download at container start.
3. **Day × hour counts, about 80 MB.** Smaller rows, but no median or P90.

## Decision

- **Scope: an own collector for the ≈131 large stations** (option 1): `fchg` every 15 minutes plus the 24 `plan` slices a day, about 11 requests per minute, within the documented 60. All other stations keep coming from piebro's raw data, up to about 10 hours behind. The map shows two freshness levels and says so. Reason: it stays within the documented limit, which is not enforced today but may be.
- **Hosting: a VPS with cron**, on the same machine as the API, writing `heute.parquet` into `data/`. It ships with the API's move to the VPS; until then the collector runs locally. Reason: no extra cost, no grant to watch, and the API reads today's file like every other file. The Azure job and GitHub Actions are not chosen, for the reasons above.
- **Hour table: the day × hour histogram over all days**, about 115 to 120 MB, all four metrics, any past day cut at any hour. Reason: the reference days of any day can be cut at any hour, not only the last 12 weeks. Azure does not download it, because Azure has no today; on the VPS it sits on disk.
- **The key:** the product owner registers the DB API Marketplace account. The key stays outside the repository, in a local environment file and later in the VPS's environment file.

## Consequences

- SPEC §3.3 allows an own collector for today's state at the large stations; a full collector stays a fallback if the community dataset goes stale.
- The map has two freshness levels: the large stations refreshed every 15 minutes, the rest up to about 10 hours behind. It shows the time of the data.
- "Today" appears on the deployed site only after the move to the VPS.
- The hour table is the largest data file: 231 MB on the real data, about six times the day table and twice the estimate above ([day-history.md](../day-history.md) §5).
- When the collector fails, its stations fall back to piebro's raw data of today, and without that the map falls back to the last complete day. DB may block or change the API without notice (§ 7), and the product is labelled beta.
- Live values and piebro's later monthly values come from different collectors, so a day can shift a little when the monthly file replaces it.
- The API key is handled by the product owner outside the repository; the gate's secret scan covers the repository.

## Reproduce

The measuring scripts were throwaway and are not in the repository. With the project's Polars, `pl.scan_parquet("hf://datasets/piebro/deutsche-bahn-data/raw_data/year=2026/month=10/day=28/date_2026-10-28_hour_00_01_02_03.parquet")` returns one row per request (`timestamp`, `url`, `response_data`, `status_code`, `error`); the `fchg` rows are those whose `url` contains `/fchg/`. The hour table is `pipeline.aggregate.days` with `hour=_planned.dt.hour()` added to the keys, written with `write_parquet`.
