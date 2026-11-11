# ADR 0003: The connection source of the planner

Status: accepted (based on a spike: research and measurements)

## Context

The planner ([SPEC](../../SPEC.md) F3 and F4, [planner.md](../planner.md)) takes a start, a destination and a time window and lists the connections that fit, each with the arrival distribution it actually had. Two things are needed for that: the **trains that run** on the chosen date, and the **actual times** of those trains on past days for the replay of F3.3 (a connection is played again on every past day of the same day type on which all its trains ran, including missed transfers and cancellations). The actual times are in the project's own data. What is open is where the list of trains comes from, and how a train of that list is recognised in our data of past days.

SPEC §4.2 listed four candidates, and the spike added a variant of the third.

1. The unofficial bahn.de web API.
2. A community wrapper (db-rest, transport.rest).
3. An official GTFS timetable (DELFI, gtfs.de), with an own router.
4. A timetable derived from the project's own data.
5. A hybrid of 3 and 4: the GTFS timetable for the list of trains, our data for their history.

Criteria: stability, legal and terms of use, effort, coverage of regional and long-distance traffic, cost, and how well the list fits the replay.

## The candidates

Facts from the desk research, read on 2026-11-10. Page summaries and search results are paraphrases, so nothing below is a quotation unless marked; secondary sources are marked as such.

### The bahn.de web API (unofficial)

- The [db-vendo-client](https://github.com/public-transport/db-vendo-client) documents it as the "bahn.de Web API (Vendo/Movas)", with endpoints for connections, stops, departures, arrivals and trips; no key is needed ([endpoint list](https://app.unpkg.com/db-vendo-client@6.11.1/files/docs/db-apis.md)).
- That README says the DB APIs are subject to haphazard blocking and have become very unreliable, and that strictly speaking permission is necessary to use the library with them. Its profile table rates the `dbweb` profile as less stable, with aggressive blocking, and lists no CORS on any endpoint.
- [An issue in the db-rest tracker](https://github.com/derhuerst/db-rest/issues/78), dated 19 May 2026, reports in its title a 403 for all vendo profiles from datacenter IPs after the endpoint migration of 2026-05-18 (title and date only; the discussion was not read).
- No terms of use from DB for these endpoints were found. [delay_bahn](https://github.com/sha2nkt/delay_bahn) uses the same API for journeys and matches the legs to history by train number, arrival EVA and time of day (secondary; licence CC BY-NC 4.0).

### db-rest and transport.rest

- The [db-rest README](https://github.com/derhuerst/db-rest) says the API is not operational anymore, that DB's HAFAS API is not available and seems to have been shut off permanently; the wrapper now uses db-vendo-client as backend. It advises against automated bulk requests and names GTFS, GTFS-RT and [transitous.org](https://transitous.org) as alternatives.
- The hosted instance `v6.db.transport.rest` did not resolve in one fetch attempt (a DNS error, not retried, so not conclusive); the [transport.rest](https://transport.rest/) page still lists it, without dates, limits or terms.
- Self-hosting is documented (a Docker image of db-rest, or of db-vendo-client with the `dbnav` profile on port 3000). Inferred from both READMEs: it only moves the dependency on the same DB endpoints onto our own server, with their blocking and the permission remark above. A third-party instance ([db.emmabyte.de](https://db.emmabyte.de/)) names a limit of 100 requests per minute and recommends running one's own.

### GTFS from DELFI and gtfs.de

- **gtfs.de** ([overview](https://gtfs.de)) lists three free feeds, long-distance (`de_fv`), regional (`de_rv`) and local (`de_nv`), generated daily from the national NeTEx data of DELFI e.V., under Creative Commons 4.0 (CC BY 4.0 deed linked on the [feed pages](https://gtfs.de/de/feeds/de_fv)). The free basic version has a limited validity of the timetable; the paid versions cover the whole timetable period. Feed sizes as listed on 2026-11-10: `fv` 340 KB with about 4.4 thousand trips, `rv` 11 MB with about 99 thousand, `nv` 253 MB with 1.7 million. Secondary: the Mobility Database lists the `nv` feed with a licence link to a page of the NVBW, not to CC BY, and its page of the `rv` feed names no licence ([nv](https://mobilitydatabase.org/feeds/gtfs/mdb-1090), [rv](https://mobilitydatabase.org/feeds/gtfs/mdb-1089)).
- **DELFI's national GTFS** ([download page](https://opendata-oepnv.de/ht/de/organisation/delfi/startseite?tx_vrrkit_view[dataset_name]=deutschlandweite-sollfahrplandaten-gtfs&tx_vrrkit_view[action]=details&tx_vrrkit_view[controller]=View)) needs a registration, in German only; the licence is CC BY. It is updated usually on Mondays; the dataset read on 2026-11-10 is valid from 16 November 2026 to 31 March 2027. Its stop IDs are IFOPT-based (DHID), not EVA numbers (secondary: the README of [db-hafas-gtfs-stops-mapping](https://github.com/traines-source/db-hafas-gtfs-stops-mapping)). The [zHV issue tracker](https://github.com/mfdz/zhv-issues/issues/12) reports thousands of DELFI GTFS stops that are not in the zHV or not DHID-compliant.
- **EVA to DHID.** No official table that carries both numbers was found: the description of the old DB station list ([rdrr.io](https://rdrr.io/github/ottlngr/DBopen/man/haltestellendaten.html), secondary) has no IFOPT column, and its original page [data.deutschebahn.com](https://data.deutschebahn.com/dataset/data-haltestellen.html) returned 404. The community mapping repository above is "incomplete and error-prone" by its own README, with no licence of its own. A [search result](https://awesome.ecosyste.ms/projects/github.com%2Ftraines-source%2Fdb-hafas-gtfs-stops-mapping) says the DB RIS::Stations API maps the two but needs a subscription (second-hand, not verified).

## Measurements

Both measurements are from throwaway prototypes that are not in the repository. They only read the app's data. The days named below are days of the project's data.

### (a) A timetable derived from the project's own trips

**Method.** The per-trip stop tables (`runs`, [lines.md](../lines.md) §4) hold, per stop of every trip, the train, the planned times and the change times. The prototype took the planned times of four Tuesdays (2026-10-13, 10-20 and 10-27 from the October month table, 2026-11-03 from a raw day) and turned every pair of consecutive stops of a trip into an elementary connection (departure at one stop, arrival at the next, as minutes since the trip's start day, so night trips pass 1,440). A connection scan then answered queries with up to three transfers, the same trip without slack and a change of trip with a slack in minutes (default 5, only within one EVA). Cancelled stops stay in the plan, and the scan counts how often a connection was cancelled. A window query is one scan per departure from the origin between 07:00 and 09:00, dominated results dropped. The replay read the actual times of one chosen connection on 15 Tuesdays (2026-07-28 to 2026-11-03) from the four month files and the raw day, filtered by day, train and EVA.

**The timetable.**

| What | Number |
|---|---|
| Trips on the 4 days | 163,656 (about 40,650 to 41,140 a day) |
| Trips with at least 2 stops (used) | 151,906 (11,750 single-stop trips dropped) |
| Stop patterns | 56,839 |
| Elementary connections, union of the patterns | 677,843 |
| Unique connections (same train, stops and times merged) | 541,219 |
| Stations (EVAs) | 5,159 |
| Build time | 1.7 s (0.1 s read, 1.6 s derive) |
| The connection table in memory | 43.6 MB (the scan's six int columns 15.5 MB) |

**Stability across days.** Only 41 % of the stop patterns ran on all 4 Tuesdays (23,417 of 56,839 patterns; by type ICE 4 %, NX 12 %, RE 29 %, S 40 %, RB 60 %). A pattern includes the planned times, so one stop differing splits it; counted per connection, 69 % ran on all 4 days (371,456 of 541,219) and 31 % on fewer, 11 % on a single day. For train numbers that exist on all 4 days, the stop list is identical on the three monthly days for 44 % of ICE, 74 % of RE, 80 % of S and 88 % of RB. Part of this variation is real: ICE 1536 ends in Rostock on one day and runs on to Stralsund and Binz on two, and ICE 855 left at 07:45 on three days and at 07:25 on 2026-11-03. Part is an artefact of the stop numbering described below (ICE 1205 gets Schwarzenbek, near Hamburg, appended after Rosenheim on one day; ICE 1010 lists Essen Hbf after Dortmund Hbf on 2026-11-03). The shares above count both.

**Queries.** Window 07:00 to 09:00, slack 5 minutes, up to 3 transfers, pure Python lists, on the union timetable of the 4 days (677,843 connections):

| Relation | Queries | Per query, mean / max | Whole window | Connections left |
|---|---|---|---|---|
| Köln Hbf to Kassel-Wilhelmshöhe | 88 | 48 / 86 ms | 4.25 s | 5 |
| Dortmund Hbf to Dillenburg | 60 | 60 / 70 ms | 3.57 s | 10 |
| Düsseldorf Hbf to Winterberg (Westf) | 81 | 53 / 70 ms | 4.30 s | 2 |
| Berlin Hauptbahnhof to Rostock Hbf | 90 | 42 / 50 ms | 3.79 s | 3 |
| München Hbf to Garmisch-Partenkirchen | 104 | 27 / 34 ms | 2.78 s | 3 |

The results read as real trips: Köln to Kassel via Hamm or Frankfurt in 172 to 191 minutes, München to Garmisch as one direct regional train of 87 minutes, Berlin to Rostock with one change in 157 to 167 minutes. The whole prototype peaked at a working set of 1.8 GB because it held the stop-level frames of the build.

**Transfer slack.** The slack changes the result only where transfers are tight. For Dortmund to Dillenburg the shortest connection is 188 minutes at 2 minutes of slack, 227 at 5 and 243 at 8, and the set of connections goes from 6 to 10 to 7; three of the other four relations keep their shortest connection, and Berlin to Rostock grows from 157 to 167 at 8 minutes.

**Which days.** The same query on restricted timetables, slack 5:

| Relation | Union of 4 days | Patterns on at least 3 of 4 days | The latest day only |
|---|---|---|---|
| Köln to Kassel | 5 connections, shortest 172 min | 3, 172 | 5, 172 |
| Dortmund to Dillenburg | 10, 227 | 4, 272 | 6, 239 |
| Düsseldorf to Winterberg | 2, 170 | 3, 192 | 2, 192 |
| Berlin to Rostock | 3, 157 | 3, 211 | 2, 167 |
| München to Garmisch | 3, 87 | none found | 2, 171 (changes, no direct train) |

The rule "ran on at least 3 of 4 days" found no München to Garmisch connection at all, because the direct regional trains run as patterns on only 2 of the 4 days. The latest day alone (2026-11-03) lost the direct train too; the cause was not looked at (a closure, a different EVA or a data gap would all fit). The union offers connections that exist on one day only: Dortmund to Dillenburg changes at Plettenberg (a wait of 38 to 56 minutes) onto RE 33084, a train that ran on one of the four days and was cancelled that day. It is not among the trips of 2026-11-03 that touch Plettenberg, so it comes from an October day (inferred).

**Replay read cost.** For one chosen connection with one change (ICE 103, ICE 992, Köln to Kassel via Frankfurt Flughafen), reading the 15 Tuesdays took 0.39 and 0.41 s in two runs (57 rows returned from about 58 million in the files; 0.09 s per month file of 14 million rows, so the filter is pushed into the scan; row groups skipped were not counted). Both legs were present on 14 of the 15 days, and the first leg's planned departure was the same minute as in the derived timetable on 11 of the 14. The planned transfer was 20 minutes; the actual transfer time (departure of the second leg minus arrival of the first) ranged from minus 16 to plus 20 minutes, and it held (at least 0 minutes, no slack applied) on 7 of the 14 days. The second leg was cancelled at its boarding stop on 3 days.

**Weak spots the prototype found.**

- 9,919 of 151,906 trips (6.5 %) have a cancelled stop on at least one day, and 55,258 unique connections are cancelled on at least one day; cancelled trips stay in the plan, so many "best" results use a leg that failed on one of the four days.
- Stop numbering is not always chronological: 1,679 connections (mostly S-Bahn, also RE, ICE, RB and OE) have an arrival before the departure; in the examples looked at, the stop numbers there sit at 100 and above, a second block that interleaves when sorted by number. There are also 8,928 gaps in the numbering, 1,665 trips with a repeated EVA, 9 stops with the departure before the arrival and 80 zero-length connections.
- Equivalent trains (same times, different train number) were picked arbitrarily because Polars' grouping is unordered: two runs gave RB 5512 and RB 98933 for the same times.
- Station identity: the data has no "Berlin Hbf", it names "Berlin Hauptbahnhof" under 3 EVAs (08011160, 08098160, 08089021) and München Hbf under 4 (08000261, 08098261, 08098262, 08098263). The prototype took all EVAs of a name as one origin or target; transfers stayed per EVA, so a change between the S-Bahn level and the long-distance level of one station was impossible.
- 7.2 % of the trips have a single stop (11,750 of 163,656); they give no connection and were dropped.

### (b) gtfs.de against the project's trips

**Method.** The `fv` and `rv` feeds were downloaded once (the `nv` feed was inspected for route types and dates only) and read with Polars. GTFS stops were mapped to EVAs: first by normalised name (the stop or its parent station) to the nearest station of our 5,433 within 3 km, then by the nearest station within 150 m. Trips of one date were matched by at least 2 shared stops with the same EVA and the same planned minute; the best pair per trip of ours wins, ties go to the trip with fewer stops, then by id. Our side is the day table of the same date. Agreement of the planned times was then measured over all shared stops of the pair (60 s tolerance on the departure, else the arrival); the two anchor stops of the match agree by construction.

**What the feeds hold.**

- Only `fv` and `rv` contain rail (route type 2); `nv` has none (buses, trams, subways, ferries, funiculars, cable cars). S-Bahn is in `rv`.
- `trips.txt` has only route, service and trip IDs: **no train number** (no `trip_short_name`) and no headsign. `route_short_name` is the line ("ICE 10", "RE1", "S1"). The key "train number plus two stops" of our trips therefore does not exist on the GTFS side.
- Stop IDs are plain numbers inside the feed: **not EVA, not DHID**; 0.0 % of the mapped stops have an ID equal to their EVA. The feeds have parent stations (`location_type` 1) whose names can differ from the child's ("Aachen, Hbf" against "Aachen Hbf"). They hold no `transfers.txt`, no `shapes.txt` and no `frequencies.txt`.
- Service dates of all three feeds run from 2026-11-07 to 2026-12-07, so the free feeds cover about 30 days from their build date, and 12-08 and later have no trips. The timetable change on 2026-12-13 is out of reach.
- One day of rail (Monday 2026-11-09) is 43,035 trips (`fv` 1,063, `rv` 41,972) and 603,855 stop times. Loading them took 0.1 to 0.2 s (warm file cache), and the process peaked at a working set of 448 MiB for the load, against 47 MiB for the bare interpreter.
- The attributions file names DELFI e.V., GTFS.de and the OpenStreetMap contributors; the licence itself is not in the feed (CC BY 4.0 on the feed pages).
- The stability of stop and trip IDs across the daily rebuilds was not tested (one download); the desk research warns that stop IDs can shift between versions.

**Stops to EVA.**

| Scope | Count | Mapped |
|---|---|---|
| Distinct rail stop IDs in `fv` and `rv` (30 days) | 8,493 | 5,813 = 68.4 % (by name 5,004, by coordinates 809) |
| Stop times on 2026-11-09 | 603,855 | 503,604 = 83.4 % |

Most failures are stops our station set does not contain (our stations are the ones the DB Timetables API serves): tram and light-rail stops of the Karlsruhe lines, the Hamburg Jungfernstieg U-Bahn stop, foreign stops (Turnov, Liège-Guillemins, Bludenz, Schaffhausen), and a few near misses beyond 150 m ("Freiburg, Hauptbahnhof" at 179 m, "Ludwigshafen(Rh)Hbf" at 162 m). That is a station-set gap, not a gap of the rule.

**Our trips to GTFS trips, one date (Monday 2026-11-09).**

| | Our trips | With a GTFS counterpart | Of those with at least 2 stops |
|---|---|---|---|
| Regional | 39,845 | 36,173 (90.8 %) | 97.9 % |
| Long-distance | 981 | 910 (92.8 %) | 98.1 % |
| All | 40,866 | 37,083 (90.7 %) | **97.9 %** (of 37,889) |

One week apart (GTFS Tuesday 2026-11-10 against our Tuesday 2026-11-03): 96.0 % of those with at least 2 stops (all 89.1 %; long-distance 95.2 %). Of our trips 7.3 % have a single stop in the day table and cannot match by construction: all trips of WEG (319) and AKN (236), which the source shows with one station, and many of S (392), RB (496), RE (107) and R (72). Of the one-stop trips 81.1 % at least have a single hit of EVA and planned minute on a same-line GTFS trip.

**Do the planned times agree?** For the matched pairs, over all shared stops, within 60 s:

| | Pairs | All shared stops agree | At least 90 % agree |
|---|---|---|---|
| Regional, same date | 36,173 | 98.5 % | 99.1 % |
| Long-distance, same date | 910 | 91.0 % | 92.2 % |
| All, same date | 37,083 | 98.3 % | 98.9 % |
| Regional, a week apart | 35,610 | 96.0 % | 97.3 % |
| Long-distance, a week apart | 898 | 78.1 % | 80.7 % |

Of all our stops, 93.5 % sit in the counterpart with the same planned minute (within 1 min); a week apart 90.3 %. As an independent check, our line name equals the feed's `route_short_name` in 96.8 % of the matched pairs (regional 99.2 %), and for long-distance the type prefix is equal in 99.8 %. 98.6 % of our trips have a unique best partner; 529 have several equally good ones (coupled and split train parts, and the same IC listed in both `fv` and `rv`). So on the one date compared, 97.9 % of our trips with at least 2 stops have a gtfs.de counterpart, and in 98.3 % of those pairs (91.0 % for long-distance) every shared stop has the same planned time. That supports that our planned times are the day's real timetable; other past days were not compared. A week apart the long-distance agreement falls to 78.1 %, consistent with real change from week to week.

Of the 3,783 of our trips without a counterpart, most are one-stop trips or trips the feed does not carry on that day; of 3,296 with a same-named line in the feed only 318 have a same-line trip sharing two stops, and for 290 of those the best candidate is more than 30 minutes off, i.e. another trip of the line, so almost none is a time shift. The other direction, which is the one the planner uses, since the trains of a future date have no runs of our own on that date:

| GTFS trips | All | With at least 2 mapped stops |
|---|---|---|
| Same date (Monday 2026-11-09), 43,035 trips | 85.2 % have a counterpart in our trips | 97.0 % |
| A week apart (GTFS Tuesday 2026-11-10 against our Tuesday 2026-11-03), 43,014 trips | 82.8 % | 94.2 % |

5,239 of the 6,379 same-date trips without a counterpart have fewer than 2 mapped stops (tram, foreign or outside our station set). Long-distance is weaker than the whole: of the 1,063 `fv` trips of 2026-11-09 28.3 % have no counterpart, and of the 90 long-distance types in `rv` 63.3 %, mostly foreign trains and foreign stops; a week apart the long-distance agreement of the matched pairs is 78.1 %. Further back than a week was not measured.

**Hagen to Siegen, a stretch where the sources differ.**

- In the `rv` feed no trip serves both Hagen Hbf and Siegen Hbf, on Monday 2026-11-09 or on Tuesday 2026-11-10. The trips break between Lennestadt-Altenhundem and Kirchhundem-Welschen Ennest (none touches both): the Hagen side runs RB91 as one trip of 10 stops from Altenhundem through Plettenberg and Altena to Hagen Hbf, the Siegen side starts at Welschen Ennest. So the split is in the plan.
- Our data of 2026-11-03 has the same split: RB91 Hagen Hbf to Lennestadt-Altenhundem (18 trips each way, 10 stops), RE34 Dortmund Hbf to Lennestadt-Altenhundem, and the Siegen side separately.
- On 2026-11-09 **our data has no row at Altena, Werdohl, Plettenberg or Lennestadt-Altenhundem** (nor on 11-01 and 11-07) and its Hagen-side RB91 trips are 3-stop fragments, while GTFS still plans the whole stretch for that day. That fits a closure or replacement service on 11-09 that the planned feed does not show; this is an inference, since neither source has a closure field.

**What GTFS has that we lack, and the reverse.** GTFS has 30 future days, structured trips of most European operators including stops outside our station set, and platform codes and pickup rules in part. It has no train numbers, no EVAs, no transfer times and no observed behaviour. We have the train number and the DB trip id, the EVA, actual times, delays and cancellations of 27 months, and trips the feed does not hold (single-stop views of private operators, extra and night trains).

**Weak spots of (b).** One date pair and one stretch; no weekend day and no timetable-change week; "matched" means equal stop and planned minute at 2 or more stops and has no ground truth beyond that; the 150 m and name rule was checked on examples only; the cause of the Hagen to Siegen gap is visible in neither source.

## Options considered

Effort and cost are judgements from the spike, not measurements; everything is free of licence fees.

| Candidate | Stability | Terms | Coverage | Effort | Fit to the replay |
|---|---|---|---|---|---|
| bahn.de web API | blocked at times, a 403 from datacenters reported | unofficial; permission probably needed (inferred) | all rail, not measured | small client, then a matching layer to our trips | matching of every connection to our trips |
| db-rest, transport.rest | hosted instance not operational; self-hosting inherits the above | the same DB endpoints | as above | a server to run, then a matching layer | as above |
| GTFS with an own router | stable, daily files | CC BY 4.0, attribution | `fv` and `rv`, about 30 days ahead | router, stop mapping, matching | matching, measured 97.0 % of GTFS trips with 2 mapped stops (one date) |
| Derived from our trips only | our own data | nothing new | our trips with at least 2 stops (WEG, AKN not routable) | small; the prototype built in 1.7 s | none between sources, but the list of trains has two flaws (below) |
| Hybrid: GTFS list of trains, our history | as GTFS | as GTFS | as GTFS | stop mapping and matching, daily download of about 11 MB | the matching could serve as the replay's "same train on past days" step |

## Decision

1. **The source is a hybrid: the GTFS timetable for the list of trains, our data for their history.**
   - The `fv` and `rv` feeds of gtfs.de (long-distance and regional; `nv` has no rail and is not used) say which trains run on the chosen date, up to the feed's horizon of about 30 days ahead. The feeds are downloaded daily, about 11 MB together.
   - Each GTFS trip is matched to our trips by the stops' EVAs and planned minutes at two or more shared stops, since GTFS has no train numbers and no EVA stop IDs; stops map to EVAs by name and position, as measured in (b). Measured from the GTFS side: on the same date 85.2 % of the GTFS trips had a counterpart in our trips (97.0 % of those with at least 2 mapped stops), a week apart 82.8 % (94.2 %); further back was not measured. From our side, one date: 97.9 % of our trips with at least 2 stops had a GTFS counterpart.
   - The statistics come from the replay over the matched train's past runs in our data. A GTFS trip without a match shows that it has no history, never a guess.
   - Reason: the published timetable answers "which trains run on that date" directly. Building that list from past days went wrong in two ways in the spike: the latest same weekday alone missed the direct München to Garmisch train on 2026-11-03 (171 minutes with changes instead of 87; cause not checked, a closure would fit), and a union of 4 weekdays paired trains of different days (inferred: a change at Plettenberg with a wait of 38 to 56 minutes onto RE 33084, which ran on 1 of the 4 days). The two errors run in opposite directions: the first may have been right and GTFS, which shows no closures, would list a train that did not run. Most other issues (station groups, no minimum transfer times, cancelled stops, recognising a train on past days) exist with either source, and the replay needs the "same train on past days" step anyway.
   - Accepted limits: GTFS does not show every disruption (on 2026-11-09 it still planned Hagen-side RB91 and RE34 trains where our data shows none, an inference that a closure was missing from the plan); the horizon is about 30 days; a new source needs its attribution once the planner uses it (Consequences).
   - Accepted risk, long-distance: it matches worst. Of the `fv` trips 28.3 % had no counterpart on the same date and of the long-distance types in `rv` 63.3 % (mostly foreign trains and stops), and a week apart the planned times of matched long-distance pairs agree at every shared stop in only 78.1 %. Long-distance is where the planner is most used, so the "no history" rows will cluster there; the quality checks have to watch it per feed and per category.
2. **Quality checks, a requirement of the product owner.**
   - Regular and automatic: every GTFS refresh measures the stop-mapping share and the trip-match share and flags a drop below a threshold set from the measured values. A check that has to be remembered does not exist; the mechanism and the threshold are decided in the replay-engine milestone.
   - One thorough check once the matching and the planner are implemented; its proposed scope is in [planner.md](../planner.md) §5 and §6.
3. **The other candidates are rejected.**
   - The bahn.de web API: unofficial, blocked at times, an issue reports a 403 from datacenter IPs since 2026-05-18 (title only), and permission is needed (inferred from the README's remark); a planner that depends on it can break without notice and may not be usable without DB's permission.
   - db-rest and transport.rest: the hosted instance is not operational since DB's HAFAS shutdown; self-hosting db-vendo-client inherits the bahn.de issues.
   - DELFI's GTFS is not pursued: it needs a registration, uses DHID stop IDs, and no official EVA to DHID table was found; gtfs.de's feeds come from the same data without a registration.
   - A timetable derived from our trips only: the two flaws above, a list of trains built from past days.

## Consequences

For the replay-engine milestone and the hosting:

- **Recognising a train across days.** Within our data the replay needs the key of [SPEC](../../SPEC.md) §4.4 (type and number plus the same route section), and the same number does not mean the same plan: the planned departure of ICE 103 was the same minute on only 11 of the 14 days it ran, and ICE 855 left at 07:25 instead of 07:45 on 2026-11-03. A rule for whether a same-numbered train at another planned time is the same connection is open; so is how far back a GTFS trip is matched, since only the same date and a week apart were measured.
- **Trips with one stop.** All trips of WEG and AKN and many others show a single stop in our data and cannot meet the two-stop rule. They cannot be matched, so a GTFS trip of such a line shows no history; 81.1 % of them at least have a single hit on a same-line GTFS trip, which a relaxed rule might use.
- **Unmatched GTFS trips** show that they have no history. 14.8 % of the GTFS trips of one day have no counterpart on that date (a week apart 17.2 %), most of them because fewer than 2 of their stops map to our stations (tram, foreign, outside the station set); for long-distance (`fv`) it is 28.3 %, mostly foreign trains and foreign stops. 83.4 % of the stop times map; the rest is a gap of the station set that a bigger EVA set would close, not of the rule.
- **Station groups.** A station can have several EVAs: Berlin Hauptbahnhof has 3, München Hbf 4, and GTFS has parent stations with other names. Stations are identified by EVA, never by name ([CLAUDE.md](../../CLAUDE.md)), so a transfer within a group needs a rule and a source for the groups; without it a change between the S-Bahn and the long-distance level of one station is impossible.
- **Cancelled stops stay in the plan** and count as cancelled in the replay; they never count as 0 minutes (SPEC §4.4).
- **Stop order and ties.** A finding of the spike, not a decision: stop numbers can run out of time order, so the stops of a trip are best ordered by planned time (with its own edge cases: zero-length connections, stops with one planned time), and equivalent trains need a deterministic tie-break.
- **No minimum transfer times in any source,** neither in GTFS nor in our data. The planner needs a slack parameter; the spike's effect is above, the default is set with the planner.
- **The timetable change on 2026-12-13.** The downloaded build ended on 2026-12-07; the daily rebuilds reach past the change from about mid-November (inferred: the build date plus 30 days). Trips of the new timetable then match old runs only where their times stay the same, and a train whose times move shows no history until it has run under the new plan; the share that matches is the checkpoint. Train numbers apply per timetable year, and SPEC §4.4 asks for statistics per timetable period or a marked change: after the change the past runs of a train of the new timetable are those of the old year's train with the same number, or none. With a sample of one weekday that lasts about 15 weeks.
- **Public holidays.** A holiday has a holiday timetable; the project already keeps holidays out of its normal (`core/holidays.py`). Whether the replay sample leaves them out is open.
- **A closure or missing train** shows as a trip with no run on that day (Hagen-side RB91 on 2026-11-09), and the replay counts it by the rule for a leg that did not run (SPEC F3.3, O2), which is open.
- **Replay data.** The replay needs the actual times of a connection's trips on at least 15 past days of the same day type (SPEC F3.5, n below 15 warns). The monthly `runs` tables are about 200 MB each since full coverage, 2.8 GB over 28 months ([lines.md](../lines.md) §8), far above the API's 2 GiB of memory ([deployment.md](../deployment.md)) as they are (inferred); `fahrten.parquet` already holds the per-trip minutes of 28 days in 56 MB ([lines.md](../lines.md) §4) and is a starting point. The replay-engine milestone decides a compact layout and what the API holds; the figure sets what the server needs, today the API container on Azure ([deployment.md](../deployment.md)).
- **The daily download** of about 11 MB, the stop mapping and the matching have to run somewhere; where (the Azure job, `pipeline.update`) is open.
- **Attribution and licence.** Once the planner uses the feeds, the UI and the README add gtfs.de, DELFI e.V. and the OpenStreetMap contributors (the feed's `attributions.txt`) to the existing CC BY 4.0 notice. The licence of the `rv` and `fv` feeds is CC BY 4.0 on the feed pages only (the Mobility Database notes above differ for `nv` and `rv`), so it is checked against the feed pages when the planner is built.
- **Feed handling.** The feeds are not part of the app's image. Stop and trip IDs may not be stable across rebuilds (untested, warned against), so nothing may rely on them across days.
- The feeds are free of fees; the 30-day horizon is a property of the free version, and a paid version covers the whole timetable period.

## Reproduce

The prototypes were throwaway and are not in the repository. The derived timetable reads `runs.parquet` of a month (and the raw day's) with Polars filtered by `day`, sorts the stops of a trip by `num`, and pairs consecutive stops; the connection scan is the standard algorithm over those pairs. The GTFS comparison reads `trips.txt`, `stop_times.txt`, `stops.txt`, `calendar.txt` and `calendar_dates.txt` of the `fv` and `rv` feeds (`https://download.gtfs.de/germany/fv_free/latest.zip`, `https://download.gtfs.de/germany/rv_free/latest.zip`; the feeds are regenerated daily and their date range moves, so a rerun gives other numbers) and joins them to the day's `runs` by EVA and planned minute as described under (b).
