# <img src="frontend/public/logo.svg" height="44" alt="Gleisatlas">

[![CI](https://github.com/EliasK93/gleisatlas/actions/workflows/gate.yml/badge.svg)](https://github.com/EliasK93/gleisatlas/actions/workflows/gate.yml) [![Tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/EliasK93/3b48a1a6b1af4d54d8e76c88ed1e72d4/raw/tests.json)](https://github.com/EliasK93/gleisatlas/actions/workflows/gate.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) ![Platform](https://img.shields.io/badge/platform-Web-blue)

Web app that shows the punctuality, typical delay, the worst 10% of arrivals and cancellations of German rail traffic by station, line, weekday and hour, from public Deutsche Bahn data, since July 2024 and up to the last complete day. The data is aggregated with [Python](https://www.python.org) and [Polars](https://pola.rs) and served by [FastAPI](https://fastapi.tiangolo.com); the UI is built with [React](https://react.dev), [TypeScript](https://www.typescriptlang.org), [Vite](https://vite.dev), [Tailwind](https://tailwindcss.com) and [MapLibre](https://maplibre.org), and is set up for [Azure](https://azure.microsoft.com). It reads in German or English, in a light or a dark theme. Historical statistics, no forecast or guarantee. Not a Deutsche Bahn service; the data is Deutsche Bahn's under CC BY 4.0.

<table>
<tr>
<td align="center" valign="top" width="50%"><p><b>Map</b></p><img src="docs/images/map.png" width="100%" alt="Map of Germany with every station as a dot coloured by punctuality"><br>Every station as a dot, coloured by punctuality, sized by the number of stops.</td>
<td align="center" valign="top" width="50%"><p><b>Map (dark) with a station</b></p><img src="docs/images/map-dark.png" width="100%" alt="Dark map zoomed to Köln Hbf with the station panel open"><br>A click on a dot opens the station's key figures.</td>
</tr>
<tr>
<td align="center" valign="top" width="50%"><p><b>Map for a range of days</b></p><img src="docs/images/period.png" width="100%" alt="Map with two date fields set to 10 to 31 October 2026"><br>Any range of days up to the last complete one, set with two date fields.</td>
<td align="center" valign="top" width="50%"><p><b>Live situation</b></p><img src="docs/images/lage.png" width="100%" alt="Map of the large stations with a card per federal state showing its deviation from the usual"><br>One day against the usual for that weekday: the 16 federal states as cards, Germany as a card.</td>
</tr>
<tr>
<td align="center" valign="top" width="50%"><p><b>A federal state</b></p><img src="docs/images/lage-state.png" width="100%" alt="Live situation zoomed to North Rhine-Westphalia with the state's card open"><br>A click on a state zooms in and opens its card, with long-distance and regional apart.</td>
<td align="center" valign="top" width="50%"><p><b>Station</b></p><img src="docs/images/station.png" width="100%" alt="Station page of Köln Hbf"><br>Four key figures, the delay distribution, the weekday × hour pattern and the split by train type.</td>
</tr>
<tr>
<td align="center" valign="top" width="50%"><p><b>Weekday × hour</b></p><img src="docs/images/heatmap.png" width="100%" alt="Heatmap of punctuality by weekday and hour at Köln Hbf"><br>When it is worst, for one station or all of them.</td>
<td align="center" valign="top" width="50%"><p><b>Four metrics, one switch</b></p><img src="docs/images/metrics.png" width="100%" alt="Heatmap of the worst 10% by weekday and hour at Köln Hbf with the metric switch and its explanation line"><br>Punctuality, typical delay, worst 10% and cancellations on every page, each with a line that explains it.</td>
</tr>
<tr>
<td align="center" valign="top" width="50%"><p><b>Over time</b></p><img src="docs/images/zeitverlauf.png" width="100%" alt="Monthly punctuality and cancellation rate of the RE1"><br>Month by month for a line (the RE1 here), timetable changes marked; for the network or a station also day by day with a trend.</td>
<td align="center" valign="top" width="50%"><p><b>Rankings</b></p><img src="docs/images/rankings.png" width="100%" alt="Rankings of the least and most reliable stations"><br>The least and most reliable stations or lines, with a minimum sample.</td>
</tr>
</table>

## Features

- **Map**: about 5,400 stations on a map of Germany, coloured by punctuality, typical delay, worst 10% (P90) or cancellations, for any range of days up to the last complete one (two date fields).
- **Live situation**: the 131 large stations for one day, today so far against the same hours of the usual days (the same weekday over the 12 weeks before), or any past day back to 2024-07. The 16 federal states show their deviation from the usual as a card and an area, Germany as a card, every station as a dot. Today comes from its own collector for the DB Timetables API (optional, see below); without it the page falls back to the source's partial raw day.
- **Four metrics on every page**: one switch for punctuality, typical delay, worst 10% and cancellations, with a line that explains the selected one; the choice stays when the page changes.
- **Station page**: key figures, the delay distribution, the weekday × hour pattern, the split by train category, the lines at the station and a sparkline by month.
- **Weekday × hour heatmap**: when trains are least and most punctual, with a short summary.
- **Rankings**: stations or lines, worst and best, with a minimum sample so that chance doesn't win.
- **Time series**: day by day, with a trend; monthly as a switch (lines are monthly); timetable changes and gaps in the data are marked.
- **Filters in the URL**: period, category (regional or long-distance), station and metric live in the link, so a shared link opens the same view.
- **Station search**: Ctrl+K jumps to the search field.
- **German or English, light or dark**: the language follows the browser on the first visit; the theme follows the system or a fixed choice.
- **Cancellations are counted as cancellations**, never as 0 minutes delay.

## How it was developed with Claude Code

The project was built with [Claude Code](https://claude.com/claude-code); the rules it works by are in [CLAUDE.md](CLAUDE.md), and each feature has its spec, decisions and milestones in `docs/<feature>.md`.

- Every milestone starts in plan mode. The plan is approved before any code is written, and any decision with trade-offs goes back to the human as options.
- The main Claude Code session only orchestrates. The work is done by subagents: each gets a brief file with what to read, the files it may edit, the checks to run and a fixed reply line, and writes its result to a reply file that the orchestrator reads. Sonnet takes routine implementation and docs, Opus the harder design work and the reviews.
- Reviews are separate subagents with a fresh view: they get the diff and the plan, not the doer's conclusions. One of them uses [ponytail](https://github.com/DietrichGebert/ponytail) to look for over-engineering: the laziest version that passes the checks.
- [graphify](https://github.com/Graphify-Labs/graphify) keeps a knowledge graph of the code and docs for orientation.
- The check is written first, then the code. Pure logic lives in `core/` without framework imports and is unit-tested with [pytest](https://pytest.org); the API is tested through its routes and the screens with [Playwright](https://playwright.dev) on the real pages.
- The gate (`uv run python scripts/gate.py`) runs before every hand-off: [ruff](https://docs.astral.sh/ruff/), [pyright](https://microsoft.github.io/pyright/), pytest, the frontend's type check, ESLint, Prettier and Playwright, the licence file, a [Bicep](https://learn.microsoft.com/azure/azure-resource-manager/bicep/) build and a [gitleaks](https://github.com/gitleaks/gitleaks) secret scan. It also runs as the git pre-commit hook, and the same gate runs on GitHub Actions for every push and pull request.
- The change is tried in the running app before each commit. Commits are local, and pushing is done by hand.

## Run it yourself

Needs [uv](https://docs.astral.sh/uv/) (it installs the Python version from `.python-version`), Node.js 22 (CI uses 22.13.0) and git.

```sh
uv sync
npm --prefix frontend install
uv run python scripts/install_hooks.py

# station coordinates, then the data: the first run downloads about 5 GB into data/raw/
# and takes about 8-14 min to process. Later runs fetch only new months and the new days
# after the last monthly file (about 70 s per day) and skip what is done.
uv run python -m pipeline.coords
uv run python -m pipeline.update

# API on port 8317 and the web app on http://localhost:5317 (two terminals)
uv run uvicorn backend.main:app --port 8317
npm --prefix frontend run dev
```

Optional, live data for today on the Live situation page: register an application with the plan "Free" of the Timetables API in the [DB API Marketplace](https://developers.deutschebahn.com/db-api-marketplace/apis/product/timetables), and put its client id and key into your environment as `DB_CLIENT_ID` and `DB_API_KEY`, never into the repository. Then `uv run python -m pipeline.live` makes one collector run for the 131 large stations (it needs the `data/large.parquet` that `pipeline.update` writes); for a running day call it every 15 minutes. Without the key the page works as well: today then comes from the data source's partial raw day, up to about 10 hours behind. Details: [docs/pipeline.md](docs/pipeline.md) and [docs/day-history.md](docs/day-history.md).

## Deploy to Azure

The site is set up for Azure Static Web Apps (frontend), Container Apps (API) and Blob Storage (the aggregates), described in Bicep in `infra/main.bicep`. The resources and the runbook are in [docs/deployment.md](docs/deployment.md).

## Development

- `uv run python scripts/gate.py` runs every check listed above. It stages your changes first (`git add -A`), because the secret scan reads the staged content, and fails if anything is left unstaged or untracked.
- `uv run python scripts/format.py` fixes formatting; the gate only checks it.
- The pre-commit hook that runs the gate is not part of a clone: install it once with `uv run python scripts/install_hooks.py`.
- The gate's end-to-end tests drive a browser: install Playwright's Chromium once with `npx --prefix frontend playwright install chromium`.
- The gate also needs [gitleaks](https://github.com/gitleaks/gitleaks#installing) and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) with Bicep: `az bicep install --version v0.48.1`. Neither needs a login.
- After an API change: `uv run python scripts/export_openapi.py`, then `npm --prefix frontend run gen` (the gate fails on a stale `backend/openapi.json` or `frontend/src/schema.d.ts`).
- When the gate's `licence file` check fails, for example after a dependency update, copy the build's licence file over: `cp frontend/dist-e2e/licenses.txt THIRD_PARTY_LICENSES.md`.

Documentation:

- [SPEC.md](SPEC.md): product specification and acceptance criteria
- [docs/roadmap.md](docs/roadmap.md): milestones
- [docs/design.md](docs/design.md): design concept, with the mockup [docs/design/mockup.html](docs/design/mockup.html)
- [docs/pipeline.md](docs/pipeline.md): data pipeline
- [docs/patterns.md](docs/patterns.md): pattern analysis
- [docs/app-shell.md](docs/app-shell.md): app shell and heatmap
- [docs/map.md](docs/map.md): map, station page and search
- [docs/day-history.md](docs/day-history.md): daily time series and day map
- [docs/theme-and-language.md](docs/theme-and-language.md): dark theme and English UI
- [docs/deployment.md](docs/deployment.md): Azure resources and runbook
- [docs/adr/](docs/adr/): architecture decisions

## Licences

| Part | Source | Licence |
|---|---|---|
| Code of this repository | Gleisatlas | MIT, see [LICENSE](LICENSE) |
| Train data | Deutsche Bahn (DB Timetables API) via [piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data); aggregated by Gleisatlas. `pipeline/raw.py` reimplements the rules of that project's monthly-release parser (MIT) to read its raw responses | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Live data for today (optional) | DB Timetables API, called by `pipeline.live` with your own key; aggregated by Gleisatlas | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) per the product page; the [DB API Marketplace](https://developers.deutschebahn.com/db-api-marketplace/apis/nutzungsbedingungen) terms of use apply |
| Station coordinates and federal states | [Wikidata](https://www.wikidata.org) | CC0 |
| State shapes on the Live situation map | [Natural Earth](https://www.naturalearthdata.com) admin-1 boundaries, simplified | Public domain |
| Map tiles and style | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, [OpenMapTiles](https://openmaptiles.org), [OpenFreeMap](https://openfreemap.org) | OpenStreetMap data under ODbL; the attribution is on the map |
| Libraries in the web app | React, React DOM, React Router, TanStack Query, openapi-fetch, MapLibre GL JS, the Inter font | MIT, BSD-3-Clause, SIL OFL 1.1; the full texts are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) and on the site at `/licenses.txt` |
| Libraries of the API and the pipeline (not shipped to the browser) | Polars, FastAPI, uvicorn; the pipeline adds huggingface-hub (direct dependencies in [pyproject.toml](pyproject.toml)) | MIT, MIT, BSD-3-Clause, Apache-2.0 |

`THIRD_PARTY_LICENSES.md` is the licence file Vite writes for the production build (`build.license` in `frontend/vite.config.ts`).