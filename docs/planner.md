# Planner

## 1 Overview

The planner (v1.0) answers the question the rest of the app only hints at: given a start, a destination and a time window, which connections are worth taking, judged by how they actually went on past days. It lists the connections of the window and, for each, the arrival distribution it had historically, the cancellation risk, the risk of each transfer, and a transfer time that would have sufficed. The full requirements are in [SPEC.md](../SPEC.md) (§3.1, F3, F4, §4.2, §4.4); this doc holds the decisions and the plan of the feature. The page does not exist yet: the connection source is decided ([adr/0003-connection-source.md](adr/0003-connection-source.md)), the replay engine and the screens follow.

## 2 Spec

Short; [SPEC.md](../SPEC.md) has the full text.

- **Input** (F3.1): start and destination (autocomplete), the time window as arrival or departure, a weekday or date, the train category filter, optionally a maximum number of transfers.
- **Output per connection** (F3.2): the median and P90 of the actual arrival time, the cancellation risk (at least one leg cancelled), the transfer risk per transfer (the share of past days on which it would have been missed), the punctuality rate and optionally the chance of arriving before a deadline the user sets, the sample size n and the period. Sorting by median arrival, P90 arrival, transfer risk or departure time (F3.4). A warning when n is below the threshold, default 15 (F3.5).
- **Replay** (F3.3): each connection is played again on every past day of the same day type on which all its trains ran, with the actual times of those days, including missed transfers and cancellations. The rule for a missed transfer is set in the replay-engine record (SPEC O2). For a small n the fallback is the independence assumption, marked in the UI.
- **Transfer recommendation** (F4): the transfer time that would have sufficed in 80, 90 and 95 % of cases at a station or for a pair of trains, shown with the connection.
- **The list of trains.** The trains of a chosen date come from the GTFS timetable, up to about 30 days ahead; their history comes from our data ([adr/0003-connection-source.md](adr/0003-connection-source.md)).
- Cancelled stops are never counted as 0 minutes delay; stations are identified by EVA ([CLAUDE.md](../CLAUDE.md)).
- Acceptance: AC-9 to AC-13, and AC-14 and AC-15 for the planner ([SPEC.md](../SPEC.md) §8).

## 3 Decisions

- **A hybrid source: the GTFS timetable for the list of trains, our data for their history.** Reason: the published timetable answers "which trains run on that date" directly, and a list built from past days has measured flaws; the replay needs the "same train on past days" step in either case. Numbers and the rejected candidates: [adr/0003-connection-source.md](adr/0003-connection-source.md).
- **Quality checks are part of the feature.** Every GTFS refresh measures how many stops map to an EVA and how many trips match ours and flags a drop; a thorough check follows once the planner exists (§5, §6). Reason: the matching has no ground truth ([adr/0003-connection-source.md](adr/0003-connection-source.md)), so its quality has to be measured on every refresh, and a check that has to be remembered does not exist.

## 4 Architecture and data keys

Decided so far:

- The `fv` and `rv` feeds of gtfs.de are downloaded daily (about 11 MB together); the `nv` feed has no rail and is not used.
- GTFS stops map to EVAs by name and position, since the feeds have no EVA stop IDs. A GTFS trip is matched to our trips by the EVAs and planned minutes of two or more shared stops, since GTFS has no train numbers.
- The statistics come from the replay over the matched train's past runs, read from the per-trip tables (`runs`, [lines.md](lines.md) §4, [pipeline.md](pipeline.md) §2). A GTFS trip without a match shows that it has no history.
- Cancelled stops stay in the plan.

A note for the replay-engine milestone, not a decision: stop numbers in our data can run out of time order, so the stops of a trip are best ordered by planned time ([adr/0003-connection-source.md](adr/0003-connection-source.md), Consequences).

Everything else, the code split between `core/` and `backend/`, the compact layout of the replay data, the routes and the URL keys, is decided in the replay-engine milestone.

## 5 Milestones

- [x] Connection-source spike: desk research on the candidates, a timetable derived from our trips with a connection scan, gtfs.de against our trips, and the decision. Re-check: [adr/0003-connection-source.md](adr/0003-connection-source.md) is accepted.
- [ ] Replay engine: the stop mapping and the matching of GTFS trips to our trips, the connection search on the trains of the chosen date, the replay over past days with the missed-connection rule, the transfer statistics, as pure logic in `core/` with the API reading the compact replay data, and the automatic quality check of every GTFS refresh (the mapped share of stops and the matched share of trips, with a threshold set from the measured values). Re-check: AC-10 (a hand-built mini dataset of at least 3 days, with a missed connection and a cancellation, with known results), AC-13 (the P80, P90 and P95 transfer time for a test station), AC-9 on the API (a test relation with 1 transfer and a 90 minute window lists every matching connection with median, P90, cancellation and transfer risk) and a test that a refresh below the threshold is flagged; the tests are named here when the milestone is built.
- [ ] Planner and transfer UI: the input form, the connection list with the arrival distribution and the transfer hints, shareable URLs, the attribution of the GTFS source. Re-check: AC-11 (the warning below the sample threshold), AC-12 (the train category filter reaches the connection selection), AC-14 for the planner (375 px width without sideways scroll) and AC-15 for the planner (a shared URL reproduces the view), in `frontend/e2e`; the tests are named here when the milestone is built.
- [ ] The thorough quality check, once the matching and the planner are implemented. Proposed scope (the product owner has named the requirement, not its contents): real connections compared with DB Navigator, the unmatched trips counted by category and operator (long-distance in particular, [adr/0003-connection-source.md](adr/0003-connection-source.md)), and the daily refreshes over a full week (weekend and weekday). Re-check: the results are written into this doc and the thresholds of the automatic check are set or confirmed from them. The part that needs the deployed system and the timetable change is in §6.

## 6 Platform checks

What needs the deployed system and the calendar; the rest of the thorough check is in §5.

- [ ] The full week of daily refreshes (§5) on the deployed system: the mapped and matched shares stay above their thresholds.
- [ ] The timetable change of 2026-12-13: the first refresh whose dates pass it (from about mid-November, inferred from the 30-day horizon) and the first days after it. The mapped and matched shares are read, and the trips of the new timetable that find no history are counted.

## 7 Open decisions

- **How a GTFS trip is matched to past runs.** For example to the latest same weekday, then by train number back in time; the planned departure of ICE 103 was the same minute on only 11 of the 14 days it ran, so a train number is not enough ([adr/0003-connection-source.md](adr/0003-connection-source.md)). How far back a match carries was not measured.
- **O2, the rule for a missed connection** in the replay: take the next connection of the same relation, at most how much later, or count the day as failed ([SPEC.md](../SPEC.md) §10). Also open: a day on which a leg did not run at all, left out as SPEC F3.3 says or counted as failed.
- **The replay sample.** Whether it is the same weekday or a day type (SPEC F3.3 says day type, for example Monday to Friday, Saturday, Sunday), how far back it reaches, whether public holidays are left out, and how the timetable change of 2026-12-13 is handled (statistics per timetable period, SPEC §4.4).
- **Station groups.** A station can have several EVAs (Berlin Hauptbahnhof 3, München Hbf 4). A transfer within a group needs a rule and a source for the groups, since stations are identified by EVA and never by name.
- **The layout of the replay data.** The monthly `runs` tables are large ([lines.md](lines.md) §8), and the replay needs the actual times of a connection's trips on at least 15 past days. A compact layout, and what the API holds in memory or reads from disk, are decided in the replay-engine milestone; the answer sizes the server for the move to a VPS ([roadmap.md](roadmap.md), "Next, in order").
- **The default transfer slack.** No source has minimum transfer times, so the planner needs a slack parameter; the spike's effect is in [adr/0003-connection-source.md](adr/0003-connection-source.md).
- **Where the daily download runs,** for example the Azure job or `pipeline.update`, and where the matching results live.
- **Trips with one stop** (all of WEG and AKN and others) cannot meet the two-stop match rule: left without history, or a relaxed rule.
- **A weekday or a date as input** (SPEC F3.1). With a GTFS list of about 30 days, which date a weekday means, and what happens for a date beyond the horizon or in the past: the feed has no past dates, and our data has no future ones.
- **A closure or a missing train on the chosen date.** A stretch the plan still shows but our data does not (Hagen-side RB91 on 2026-11-09), or a direct train missing in our data (München to Garmisch on 2026-11-03). How the planner tells the user is decided with the UI.

## 8 Known shortcuts

None yet.
