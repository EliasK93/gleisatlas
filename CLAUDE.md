# CLAUDE.md

Working rules for AI-assisted development in this repository, followed by the project section.
Personal and machine-specific rules live in `CLAUDE.local.md` (gitignored).

## Working rules

### Roles
- The product owner decides what gets built, approves plans, tests in the running app and says "commit". Pushing, publishing and releases are theirs.
- The main session orchestrates: it plans, writes briefs, dispatches work to subagents, checks results, stages, runs the gate and commits. It keeps its own context free instead of doing large edits itself.
- Subagents do the work. Sonnet at high effort for routine implementation, docs and mechanical refactors; Opus at high effort for hard design work and quality reviews. Model and effort are stated in each dispatch.
- Every subagent writes its result to a reply file, and the orchestrator reads that file instead of trusting a summary.

### Dispatching work
- Briefs live in files outside the repo. The prompt is only "Read and follow the brief in <path>".
- A brief states: what to read first, the goal, the exact files it may edit (anything else: report, don't edit), limits, the checks to run with "paste the real output", the reply file path and a fixed final reply line.
- Limits travel with the work: a subagent passes its limits on to any helper it starts.
- Shared files (package manifests, `pyproject.toml`, theme tokens, the message catalog, `backend/openapi.json`) belong to one subagent at a time.
- At most two writing subagents in parallel, with disjoint file lists. Parallel subagents never stage. Read-only helpers may run alongside.
- Reviews are separate subagents with a fresh view: they get the diff and the plan, not the doer's conclusions. Findings go back to a doer.
- Never claim a run that didn't happen: tests, builds, reviews and dispatches.

### Planning and decisions
- Plan mode for every milestone: present the plan, wait for approval, then work autonomously until the next test or decision point.
- Ambiguity or trade-offs: ask with clickable options, recommended option first and marked "(Recommended)", each with a one-line consequence. Batch questions.
- Where a sensible default exists, decide, say so in one line and move on.
- Each feature has its own doc `docs/<feature>.md` with this structure: 1 Overview, 2 Spec, 3 Decisions (each with its reason), 4 Architecture and data keys, 5 Milestones (each with its re-check), 6 Platform checks, 7 Open decisions, 8 Known shortcuts. This file holds only project-wide rules and links to the docs; docs are read on demand.
- The repository wins: where a doc and the code disagree, the code is right. Check the code before acting on a status claim.

### Test-driven, with evidence
- Write the check first, see it fail, then write the code. Paste the real output.
- Test through the real entry point (API routes via the test client, screens via Playwright). Pure logic lives in `core/` without framework imports, enforced by lint, with fast unit tests.
- Checks never touch real state: mini fixtures and temporary directories, never the real data files.
- Every status claim carries its re-check: a test name, a grep or a command.
- Refactors prove themselves: when behaviour must not change, existing tests stay unchanged and the gate passing is the proof. If a test has to change, stop and report.

### The gate
- One command runs everything: `uv run python scripts/gate.py`. It stages (`git add -A`), checks formatting and lint, type-checks, runs all tests, compares `THIRD_PARTY_LICENSES.md` with the build's licence file, scans the staged content for secrets and fails if anything is unstaged or untracked afterwards.
- `uv run python scripts/format.py` fixes formatting; the gate only checks it.
- The git pre-commit hook runs the same checks (`scripts/gate.py --hook`, without staging or the clean-tree check). They run on the working tree, so a commit of selected paths is checked together with everything else on disk. Never skip the hook (`--no-verify`). Hooks are not part of a clone: run `uv run python scripts/install_hooks.py` once after cloning.
- CI (`.github/workflows/gate.yml`) runs the same gate on every push and pull request with `scripts/gate.py --ci`: no staging, the secret scan covers the whole history, and the clean-tree check stays. Actions are pinned to commit SHAs, gitleaks and Bicep to a checksum; updating a pin is a `Repo:` commit.
- Every check is a gate line. A check people must remember to run doesn't exist.

### Commits and history
- Commit yes, push never. Commits happen after plan approval, a green gate and the product owner's test of any user-visible change.
- Never rewrite history (no amend, rebase, reset --hard, force) and never skip hooks. Fix mistakes with a new commit.
- Messages start with the area (`Core: `, `Pipeline: `, `API: `, `Web: `, `Docs: `, `Repo: `), one area per commit, subject says what changed and why. Code and the tests it needs go together.
- The only trailer is `Co-Authored-By: <model> <noreply@anthropic.com>`.
- Nothing personal in tracked files or commit messages: no real names beyond the public handle, no e-mail addresses, no machine paths, no employer or customer names.
- Public tone: no diary noise, dates only on milestones and releases; delete superseded items instead of striking them through; no instructions aimed at the AI in human-facing docs; no milestone codes in code or test names; no TODO, FIXME or commented-out code; no template leftovers; one rule lives in one place; every module follows the same structure.
- Accessibility labels are never changed to make tests easier; tests find elements by role, container or test ID.
- Before going public: a fresh read-only review pass (code, then docs, config and history).

### Batched testing
- Queue several changes, then hand over one test round with a numbered checklist: what to open, what to do, what to see, and what needs no check.
- "Commit" approves that batch.
- Checks only possible on the real target (e.g. Azure) go into the feature doc's "Platform checks" and are ticked only after confirmation there.
- Dev servers are started and stopped visibly, with exact URLs.

### Inside the repo vs. outside effects
- Inside the repo: go. Edits, tests, the gate, local commits per these rules, local dev servers, downloads of the public dataset into the gitignored `data/` folder.
- Outside effects: ask every time. Push, publish, anything that costs money, global config, files outside the repo, anything irreversible.
- Logged-in CLIs that reach real accounts (`az`, `gh`, deploy services) are run by the product owner only.
- No new library without saying why and what the no-library alternative is. Install with the stack's installer (`uv add`, `npm.cmd install`) and check the versioned docs before using an API.

### ponytail
- The laziest version that passes the contract and the checks. ponytail decides how much code satisfies the contract, never whether to satisfy it.
- A deliberate shortcut gets a `ponytail:` comment naming its ceiling and when to revisit, and is listed under "Known shortcuts" in its feature doc.
- `/ponytail-review` on diffs in the review step, `/ponytail-audit` on the whole repo now and then.

### graphify
- Orient with `graphify query "<question>"`, then read the code. Absence in the graph is not evidence.
- `graphify-out/` is gitignored. Docs need `/graphify . --update` after changes.

### Communication
- Short and concrete: result first, then what the product owner needs to do.
- Commands are explained in one line and say which shell they are for.
- Report outcomes faithfully: failing tests with their output, skipped steps as skipped.

### Session handover
- Sessions are cleared between larger steps, and a new session may start without any memory. Everything it needs lives in the repo: `docs/roadmap.md` (public status), the feature docs, and the handover section of `CLAUDE.local.md` (private status, next step, pending decisions).
- At a natural break (a milestone or batch committed, nothing in flight), the orchestrator updates those files and says that this is a good time to clear the session.
- A new session reads `CLAUDE.local.md`'s handover section and `docs/roadmap.md` first and checks `git log --oneline -5` and `git status --short` before acting.

## Project: Gleisatlas

Historical reliability of German rail traffic: pattern analysis, connection comparison within a time window, transfer recommendations. Requirements: [SPEC.md](SPEC.md). Roadmap: [docs/roadmap.md](docs/roadmap.md). Design target: [docs/design.md](docs/design.md) with the clickable reference [docs/design/mockup.html](docs/design/mockup.html). App shell and heatmap UI: [docs/app-shell.md](docs/app-shell.md). Map, station detail and search: [docs/map.md](docs/map.md). Dark theme and language: [docs/theme-and-language.md](docs/theme-and-language.md). Azure deployment: [docs/deployment.md](docs/deployment.md).

### Stack
- Python 3.12+ with `uv`; Polars for data processing; FastAPI + Pydantic for the API.
- React + TypeScript (strict) + Vite + Tailwind; TanStack Query; TS client generated from `backend/openapi.json`; Playwright for smoke tests.
- Azure: Static Web Apps (frontend), Container Apps (API), Blob Storage (aggregates), Bicep in `infra/`.

### Layout
- `core/`: pure logic (delay rules, train-category mapping, statistics). No framework or I/O imports, enforced by ruff's banned-api list; the builtin `open()` and Polars `.write_*` methods cannot be banned that way and are kept out by review.
- `pipeline/`: reads monthly source files and writes aggregates.
- `backend/`: FastAPI routes over the aggregates.
- `frontend/`: the web app.
- `docs/`: feature docs, design, roadmap, ADRs in `docs/adr/`.
- `infra/`: the Azure resources as Bicep.
- `scripts/`: gate, formatter, hook installer, helper scripts.

### Project rules
- UI text only via the message catalogs (German and English; their keys must match); German UI text avoids direct address. Colours only via theme tokens, which have a light and a dark set.
- Stations are identified by EVA number, never by name.
- Cancelled stops are never counted as 0 minutes delay.
- Attribution CC BY 4.0 (Deutsche Bahn, via piebro/deutsche-bahn-data) in UI and README.

### Commands
- Install: `uv sync` and `npm.cmd --prefix frontend install`, then `uv run python scripts/install_hooks.py`. The gate also needs gitleaks (`winget install Gitleaks.Gitleaks`) and the Azure CLI with Bicep: `winget install Microsoft.AzureCLI`, then `az bicep install --version v0.48.1`.
- Gate: `uv run python scripts/gate.py`. Format: `uv run python scripts/format.py`.
- Data and aggregates: see [docs/pipeline.md](docs/pipeline.md).
- API: `uv run uvicorn backend.main:app --port 8317`; with a log file (PowerShell): `$env:LOG_FILE = "logs/api.log"; uv run uvicorn backend.main:app --port 8317`. Web: `npm.cmd --prefix frontend run dev` (http://localhost:5317). The e2e suite starts its own servers on 5318 and 4317.
- Deploy to Azure (product owner only): the runbook in [docs/deployment.md](docs/deployment.md) §4.
- After an API change: `uv run python scripts/export_openapi.py`, then `npm.cmd --prefix frontend run gen` (the gate fails on a stale `backend/openapi.json` or `schema.d.ts`).
