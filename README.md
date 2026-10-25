# Verlässlich

Rail reliability for Germany: historical delay, cancellation and transfer statistics from public DB data, shown as patterns (weekday, hour, station, category) and later as a connection planner with arrival distributions. The UI is German.

**Status:** early, milestone M0 (foundation). Historical statistics, no forecast or guarantee.

## Quick start (PowerShell)

```powershell
uv sync
npm.cmd --prefix frontend install
uv run python scripts/install_hooks.py

# data: download one month, build the aggregate
uv run python -m pipeline.download 2026-09
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

## Data

Data: Deutsche Bahn (DB Timetables API) via piebro/deutsche-bahn-data, CC BY 4.0. Historical statistics, no forecast or guarantee.
