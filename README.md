# <img src="frontend/public/logo.svg" height="44" alt="Gleisatlas">

[![CI](https://github.com/EliasK93/gleisatlas/actions/workflows/gate.yml/badge.svg)](https://github.com/EliasK93/gleisatlas/actions/workflows/gate.yml) [![Tests](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/EliasK93/3b48a1a6b1af4d54d8e76c88ed1e72d4/raw/tests.json)](https://github.com/EliasK93/gleisatlas/actions/workflows/gate.yml) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) ![Platform](https://img.shields.io/badge/platform-Web-blue)

Rail reliability for Germany: historical delay, cancellation and transfer statistics from public DB data, shown as patterns (weekday, hour, station, category) and later as a connection planner with arrival distributions. The UI is German or English and has a light and a dark theme.

**Status:** early. The map start page, station detail, station search, the weekday × hour heatmap, rankings of stations and lines, and the time series by month work on 27 months of data (2024-07 to 2026-09). Historical statistics, no forecast or guarantee.

## Quick start (PowerShell)

```powershell
uv sync
npm.cmd --prefix frontend install
uv run python scripts/install_hooks.py

# the gate's secret scan needs gitleaks, its Bicep build the Azure CLI with Bicep (open a new terminal after the installs)
winget install Gitleaks.Gitleaks
winget install Microsoft.AzureCLI
az bicep install --version v0.48.1

# data: fetch station coordinates, then download and aggregate every month (a second run skips finished months)
uv run python -m pipeline.coords
uv run python -m pipeline.update

# API (port 8000) and web UI (separate terminals)
uv run uvicorn backend.main:app --port 8000
npm.cmd --prefix frontend run dev
```

In VS Code, "Gleisatlas (API + Web)" in Run and Debug starts both and opens the browser; Stop ends both. The API there writes its request log to `logs/api.log`.

Gate (tests, lint, types, frontend checks, Bicep build, secret scan):

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

## Data

Data: Deutsche Bahn (DB Timetables API) via piebro/deutsche-bahn-data, CC BY 4.0. Historical statistics, no forecast or guarantee.

Station coordinates and federal states: Wikidata, CC0.

Map: © OpenStreetMap contributors, OpenMapTiles, tiles and style by OpenFreeMap.
