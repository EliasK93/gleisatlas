# Roadmap

MVP = **v0.1, local pattern analysis** (SPEC 3.1). Azure (v0.2) and the planner (v1.0) follow.

## M0 Foundation
- [x] Repo rules, gate and hooks (re-check: `uv run python scripts/gate.py`)
- [x] English docs
- [x] Clean code base (core / pipeline / backend) (re-check: `uv run pytest -q`)
- [x] App shell with design tokens, i18n and smoke test (re-check: `npm.cmd --prefix frontend run test:e2e`)

## M1 App shell per design
- [ ] Sidebar, routing, filter bar
- [ ] Heatmap view on the existing aggregate
- [ ] Inter font bundled
- [ ] API input validation (`limit`, `von`, `bis`)
- [ ] Single category rule: remove the test-only `category_of` copy in `core/categories.py`

## M2 Map start page
- [ ] Decide the station-coordinate source (ADR)
- [ ] Map and station detail

## M3 More data
- [ ] Multi-month pipeline: incremental download, schema validation, cleaning, timetable periods
- [ ] Rankings
- [ ] Time series

## M4 Dark mode and English UI
- [ ] Dark theme on the existing tokens
- [ ] English message catalog and language switch

## M5 Azure deployment (v0.2)
- [ ] Bicep infrastructure
- [ ] Budget alert
- [ ] The product owner runs the deployment commands

## M6+ Planner (v1.0)
- [ ] Connection-source spike (ADR)
- [ ] Replay engine
- [ ] Planner and transfer UI

## After v1.0
Optional features and backlog per SPEC 3.1 and 3.4.
