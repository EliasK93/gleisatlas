# <img src="frontend/public/logo.svg" height="44" alt="Gleisatlas">

[![CI](https://github.com/EliasK93/gleisatlas/actions/workflows/gate.yml/badge.svg)](https://github.com/EliasK93/gleisatlas/actions/workflows/gate.yml) [![Tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/EliasK93/3b48a1a6b1af4d54d8e76c88ed1e72d4/raw/tests.json)](https://github.com/EliasK93/gleisatlas/actions/workflows/gate.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) ![Platform](https://img.shields.io/badge/platform-Web-blue)

Rail reliability for Germany: historical delay, cancellation and transfer statistics from public DB data, shown as patterns (weekday, hour, station, category) and later as a connection planner with arrival distributions. The UI is German or English and has a light and a dark theme.

**Status:** early. The map start page, station detail, station search, the weekday × hour heatmap, rankings of stations and lines, and the time series by month work on 27 months of data (2024-07 to 2026-09). Historical statistics, no forecast or guarantee.

**Licences:** the code is MIT. The data, the map and the bundled libraries keep their own licences: see [Licences](#licences) and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Quick start (PowerShell)

Needs [uv](https://docs.astral.sh/uv/) and Node.js 22; uv installs the Python version from `.python-version`.

```powershell
uv sync
npm.cmd --prefix frontend install
uv run python scripts/install_hooks.py

# the gate's secret scan needs gitleaks, its Bicep build the Azure CLI with Bicep (open a new terminal after the installs)
winget install Gitleaks.Gitleaks
winget install Microsoft.AzureCLI
az bicep install --version v0.48.1

# data: fetch station coordinates, then download and aggregate every month (a second run skips finished months)
# the first run downloads about 5 GB into data/raw/ and takes about 8-14 min
uv run python -m pipeline.coords
uv run python -m pipeline.update

# API (port 8317) and web UI on http://localhost:5317 (separate terminals)
uv run uvicorn backend.main:app --port 8317
npm.cmd --prefix frontend run dev
```

In VS Code, "Gleisatlas (API + Web)" in Run and Debug starts both and opens the browser; Stop ends both. The API there writes its request log to `logs/api.log`.

Gate (tests, lint, types, frontend checks, licence file, Bicep build, secret scan):

```powershell
uv run python scripts/gate.py
uv run python scripts/format.py   # fixes formatting
```

## Deployment

The site is set up for Azure (Static Web Apps, Container Apps, Blob Storage), described in Bicep in `infra/main.bicep`. Resources, costs and the PowerShell runbook are in [docs/deployment.md](docs/deployment.md).

## Documentation

- [SPEC.md](SPEC.md) – product specification and acceptance criteria
- [docs/roadmap.md](docs/roadmap.md) – milestones
- [docs/design.md](docs/design.md) – design concept, mockup in [docs/design/mockup.html](docs/design/mockup.html)
- [docs/pipeline.md](docs/pipeline.md) – data pipeline
- [docs/patterns.md](docs/patterns.md) – pattern analysis
- [docs/app-shell.md](docs/app-shell.md) – app shell and heatmap UI
- [docs/map.md](docs/map.md) – map, station detail and search
- [docs/theme-and-language.md](docs/theme-and-language.md) – dark theme and English UI
- [docs/deployment.md](docs/deployment.md) – Azure resources, costs and the deployment runbook
- [docs/adr/](docs/adr/) – architecture decisions, e.g. the station-coordinate source

## Licences

| Part | Source | Licence |
|---|---|---|
| Code of this repository | Gleisatlas | MIT, see [LICENSE](LICENSE) |
| Train data | Deutsche Bahn (DB Timetables API) via [piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data); aggregated by Gleisatlas | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Station coordinates and federal states | [Wikidata](https://www.wikidata.org) | CC0 |
| Map tiles and style | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, [OpenMapTiles](https://openmaptiles.org), [OpenFreeMap](https://openfreemap.org) | OpenStreetMap data under ODbL; the attribution is on the map |
| Libraries in the web app | React, React DOM, React Router, TanStack Query, openapi-fetch, MapLibre GL JS, the Inter font | MIT, BSD-3-Clause, SIL OFL 1.1; the full texts are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) and on the site at `/licenses.txt` |
| Libraries of the API and the pipeline (not shipped to the browser) | Polars, FastAPI, uvicorn; the pipeline adds huggingface-hub (direct dependencies in [pyproject.toml](pyproject.toml)) | MIT, MIT, BSD-3-Clause, Apache-2.0 |

`THIRD_PARTY_LICENSES.md` is the licence file Vite writes for the production build (`build.license` in `frontend/vite.config.ts`). The gate fails when it differs from the build's file, for example after a dependency update; then copy it over: `Copy-Item frontend/dist-e2e/licenses.txt THIRD_PARTY_LICENSES.md`.

Historical statistics, no forecast or guarantee.
