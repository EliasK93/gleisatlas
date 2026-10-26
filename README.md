# Verlässlich

Rail reliability for Germany: historical delay, cancellation and transfer statistics from public DB data, shown as patterns (weekday, hour, station, category) and later as a connection planner with arrival distributions. The UI is German.

**Status:** early. The map start page, station detail, station search and the weekday × hour heatmap work on one month of data. Historical statistics, no forecast or guarantee.

## Quick start (PowerShell)

```powershell
uv sync
npm.cmd --prefix frontend install
uv run python scripts/install_hooks.py

# data: download one month, fetch station coordinates, build the aggregate
uv run python -m pipeline.download 2026-09
uv run python -m pipeline.coords
uv run python -m pipeline.aggregate data/raw/monthly_processed_data/data-2026-09.parquet data/aggregate.parquet

# API (port 8000) and web UI (separate terminals)
uv run uvicorn backend.main:app --port 8000
npm.cmd --prefix frontend run dev
```

Gate (tests, lint, types, frontend checks, secret scan):

```powershell
uv run python scripts/gate.py
uv run python scripts/format.py   # fixes formatting
```

## Documentation

- [SPEC.md](SPEC.md) – product specification and acceptance criteria
- [docs/roadmap.md](docs/roadmap.md) – milestones
- [docs/design.md](docs/design.md) – design concept, mockup in [docs/design/mockup.html](docs/design/mockup.html)
- [docs/pipeline.md](docs/pipeline.md) – data pipeline
- [docs/patterns.md](docs/patterns.md) – pattern analysis
- [docs/app-shell.md](docs/app-shell.md) – app shell and heatmap UI
- [docs/map.md](docs/map.md) – map, station detail and search
- [docs/adr/](docs/adr/) – architecture decisions, e.g. the station-coordinate source

## Data

Data: Deutsche Bahn (DB Timetables API) via piebro/deutsche-bahn-data, CC BY 4.0. Historical statistics, no forecast or guarantee.

Station coordinates and federal states: Wikidata, CC0.

Map: © OpenStreetMap contributors, OpenMapTiles, tiles and style by OpenFreeMap.
