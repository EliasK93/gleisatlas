# Deployment on Azure

## 1 Overview

Gleisatlas v0.2 runs on Azure: the web app on Static Web Apps, the API on Container Apps, the aggregates in Blob Storage. Everything lives in one resource group in Sweden Central (the Static Web App's settings in East US 2), described by `infra/main.bicep` and deployed and torn down by one script each (§4). The container registry is the main fixed cost; at low traffic the rest stays near zero within the free grants (§4), and a budget on the resource group sends alert e-mails (SPEC AC-16).

## 2 Spec

- One resource group in Sweden Central holds every resource; the Static Web App resource sits in East US 2 and serves its files worldwide. Names come from `uniqueString(resourceGroup().id)` where they must be globally unique (storage account, registry).
- The web app is the production build of `frontend/` on Static Web Apps Free, under its default `*.azurestaticapps.net` hostname. Every path route falls back to `index.html`; `/assets/*` is cached as immutable; every response carries the CSP and the other headers of `frontend/public/staticwebapp.config.json`.
- The API is the image from `Dockerfile` on Container Apps with external HTTPS ingress, 0.5 vCPU and 1 GiB, scaling from 0 to 1 replica. At start it downloads the seven data files from the blob container `data` (`backend/fetch.py`), then serves on port 8000. Only the web app's origin passes CORS.
- The aggregates are public CC BY data: anyone can read a blob by its URL, nobody can list the container.
- The API writes one start and one end line per request to stdout, without client addresses. Container Apps sends them to a Log Analytics workspace that keeps 30 days.
- A monthly budget on the resource group mails at 50 % and 90 % actual and at 100 % forecast; its amount is a deploy parameter.
- AC-3: the deployed aggregates stay under 2 GB (75 MB at the first deploy, before the day tables; measured again at the next deploy). AC-16: a budget with alerts is set up and its alert e-mail tested.

## 3 Decisions

**The product owner's picks**

- **Data comes from Blob Storage at container start.** Reason: the image stays small and code-only, and a data update needs no image build.
- **The API scales to zero.** Reason: most of the time nobody uses the site, and an idle replica costs nothing.
- **Sweden Central for everything except the Static Web App.** Reason: an EU region that took the first deploy; West Europe rejected the new subscription ("not accepting new customers"), and Germany West Central had no capacity for a new Container Apps environment.
- **The Static Web App resource in East US 2.** Reason: Static Web Apps is offered in five regions only, and the one in Europe (West Europe) is closed to the subscription; the region holds the resource's settings, while the files are served from Microsoft's worldwide edge locations either way.
- **Azure default hostnames, no custom domain.** Reason: no domain cost or DNS setup for a reference project.
- **The image is built in ACR Basic with `az acr build`.** Reason: no local Docker needed; ACR Tasks' free monthly build time covers it.
- **The Impressum's personal data stays outside the repository.** Reason: the repository is public; the values come from the gitignored `frontend/.env.production.local` at build time.
- **Cost protection is alerts plus tight limits** (max 1 replica, small size, log cap). Reason: Azure has no hard spending cap on a pay-as-you-go subscription; an automatic stop would need an extra function and identity.
- **The frontend is built locally and deployed with the SWA CLI.** Reason: no GitHub Actions secret or repository link needed for the first deploy.
- **Deploy and teardown by script** (`scripts/azure.py deploy` and `teardown`). Reason: one command each way, with a stop at the first failure; the API's host changes on every fresh deploy, so the script narrows the CSP in the built copy instead of a commit with the new host.

**Licences and attribution** (notes on the terms of the services used, not legal advice)

- **The data is used under CC BY 4.0, with attribution, a licence link and a note that it was aggregated.** Reason: the Timetables and Station Data API pages state CC BY 4.0, and the site takes the data from piebro/deutsche-bahn-data under that licence, without an API account; the UI (footer, map attribution) and the README carry the notice. Station coordinates come from Wikidata (CC0); the map tiles are OpenStreetMap data (ODbL), for which the attribution the style carries is enough.
- **No Deutsche Bahn branding.** Reason: CC BY 4.0 § 2(a)(6) rules out implied endorsement. The name appears only in the attribution and in the footer's "Kein Angebot der Deutschen Bahn"; there is no DB logo and nothing that looks official.
- **The map tiles come from the public OpenFreeMap instance, and the privacy text says so.** Reason: the operator is Hyperknot Software Kft. (Hungary), the tiles are served through Cloudflare (the DNS of `tiles.openfreemap.org` resolves to Cloudflare), access logs carry no IP address by default and are deleted after 7 days; commercial use is allowed, attribution is required (MapLibre adds it), there is no SLA, and the service may be discontinued without notice. The privacy text names the operator and Cloudflare and links OpenFreeMap's policy.
- **The bundled libraries' licence notices ship with the web app.** Reason: the web app bundles React, React Router, TanStack Query, openapi-fetch (MIT), MapLibre GL (BSD-3-Clause) and Inter (SIL OFL 1.1); all allow commercial use, and each wants its notice shipped with the copies. The build writes them to `/licenses.txt`, which a comment at the top of the bundle names; the UI links "Quellcode" to the repository next to Impressum and Datenschutz, and the data attribution sits on the map and in the footer (one gap in §8). The API's libraries (Polars, FastAPI, uvicorn) run on the server only, and the pipeline's huggingface-hub only on the machine that builds the aggregates; neither is distributed.

**Defaults**

- **A public-read blob container (blob level, no listing).** Reason: the aggregates are public CC BY data, so the download needs no SDK and no secret. Fallback if a policy forbids public access: a managed-identity token fetched with stdlib `urllib`.
- **A user-assigned identity with AcrPull on the registry pulls the image; the registry has no admin user.** Reason: no registry password exists anywhere, and the role covers one registry only.
- **CORS from the environment** (`CORS_ORIGINS`, default `http://localhost:5317`), set by Bicep to the web app's hostname. Reason: one code path for local and Azure.
- **The API's `/docs` and `/redoc` are off** (`docs_url=None, redoc_url=None`). Reason: both pages load Swagger UI or ReDoc from a CDN without a pinned version, which a public API should not serve; `backend/openapi.json` in the repository documents the API.
- **`huggingface-hub` lives in the uv dependency group `pipeline`**, installed by a local `uv sync` and skipped in the image. Reason: only the download step uses it; the API never imports it.
- **Our own request log without IPs**, with uvicorn's access log off and the ingress HTTP logs not enabled. Reason: the app needs paths, status and duration, not client addresses (the ingress HTTP log would store `X-Forwarded-For`).
- **Log Analytics with 30 days retention and a daily cap of 0.1 GB.** Reason: 31 days are included in the price, and the cap keeps ingestion inside the free 5 GB per month.
- **One process: max 1 replica, 1 uvicorn worker.** Reason: the query cap and the `lru_cache`s in `backend/main.py` are per process ([patterns.md](patterns.md) §8).
- **0.5 vCPU / 1 GiB with `POLARS_MAX_THREADS=1`.** Reason: the local peak working set over a cold start-page burst plus heatmap, both rankings and the time series was 474–505 MB with one thread, about 600 MB with two, and 1.35–1.5 GB unset (Polars then sees all host cores). One thread leaves 2x headroom; the cold `/karte` took 3.6–4.0 s locally (then on the month aggregate).
- **Consumption-only environment** (`environmentMode: 'ConsumptionOnly'`, no workload profiles, zone redundancy, VNet or private endpoints). Reason: those features bring the Dedicated plan's "Environment Management Hour" meter, an hourly management charge that runs all month.
- **Scale-down cooldown 120 s** (`cooldownPeriod`, default 300 s, available in the stable API 2026-07-01). Reason: a wake-up is billed until the replica stops; 120 s still covers a visitor clicking through a few pages.
- **The CSP is a static header, checked end to end.** `frontend/e2e/csp.spec.ts` runs the production build under `vite preview`, which sends the headers of `staticwebapp.config.json`, and fails on any CSP violation or console error on every page in both themes. Reason: this catches a wrong script hash and a missing directive (worker, tiles, fonts) alike, which a test that only compares the hash would not.
- **Bicep in the gate.** `az bicep build --file infra/main.bicep --stdout` runs offline without a login, so every clone needs the Azure CLI with Bicep (README, Development). CI downloads the Bicep 0.48.1 binary, checks it against the sha256 digest GitHub publishes for that release asset, and lets `az` take it from PATH, so it never pulls the latest version. Reason: a broken template fails before anyone deploys it.
- **The registry keeps the legacy role-assignment mode** (`roleAssignmentMode: 'LegacyRegistryPermissions'`). Reason: Microsoft announced the ABAC repository mode as the future default, and that mode ignores the AcrPull assignment the app pulls with.
- **A monthly budget on the resource group**, alerts at actual 50 % and 90 % and forecast 100 %; the amount and the e-mail address are deploy parameters. Reason: SPEC AC-16; the amount depends on the deployer, and no personal address belongs in the repository.
- **The budget start date is a required parameter without a default.** Reason: Azure rejects a change of an existing budget's start date, so a default from `utcNow()` would break every deploy after the first month. The deploy script reads the value back from the last deployment.
- **Two phases through the `image` parameter.** Reason: the Container App can only start once the registry holds the image and the container holds the data; phase 1 creates both, phase 2 adds the app.
- **Bicep API versions: the newest stable version the Bicep CLI has types for.** Reason: storage 2026-09-01 is listed on Learn but has no types in Bicep 0.48.1 (warning BCP081), so storage uses 2026-06-01.

## 4 Architecture and data keys

**Resources** (`infra/main.bicep`)

| Resource | Name | Notes |
|---|---|---|
| Log Analytics workspace | `gleisatlas-logs` | PerGB2018, 30 days, daily cap 0.1 GB |
| Storage account | `gleisatlas<suffix>` | StorageV2, Standard_LRS, HTTPS only, TLS 1.2; container `data` with blob-level public read |
| Container Registry | `gleisatlas<suffix>` | Basic, admin user disabled, legacy role-assignment mode |
| User-assigned identity | `gleisatlas-pull` | AcrPull on the registry only |
| Container Apps environment | `gleisatlas-env` | Consumption only, logs to the workspace |
| Static Web App | `gleisatlas-web` | Free, no repository link, region `webLocation` |
| Budget | `gleisatlas-budget` | `budgetAmount` per month in the billing currency |
| Container App | `gleisatlas-api` | only when `image` is set; port 8000, HTTPS only, single revision, 0–1 replicas, the platform's default HTTP scale rule |

Parameters: `budgetEmail`, `budgetStartDate` and `budgetAmount` (all required), `image` (default empty), `webLocation` (`eastus2`), `cpu` (`0.5`), `memory` (`1Gi`), `polarsMaxThreads` (`1`). Outputs: `apiUrl` (empty without the app), `webName`, `webHostname`, `registryName`, `registryServer`, `storageName`, `workspaceId`.

**Environment variables**

| Variable | Where | Value |
|---|---|---|
| `DATA_URL` | API, set by Bicep | `https://<storage>.blob.core.windows.net/data/`; unset locally, then `backend.fetch` does nothing |
| `CORS_ORIGINS` | API, set by Bicep | `https://<web hostname>`; comma-separated; default `http://localhost:5317` |
| `POLARS_MAX_THREADS` | API, set by Bicep | `1` |
| `LOG_FILE` | API, local only | a path for a timestamped copy of the request lines; unset on Azure |
| `AGGREGATE_PATH`, `STATIONS_PATH`, `MONATE_PATH`, `LINES_PATH`, `LINIEN_PATH`, `DAYS_PATH`, `TAGE_PATH` | API | default `data/<name>.parquet`; `backend.fetch` downloads to the same paths |
| `DAY_HOURS_PATH`, `HEUTE_PATH`, `HEUTE_REST_PATH` | API, local only | default `data/day_hours.parquet`, `data/heute.parquet`, `data/heute_rest.parquet`; not downloaded, so the deployed API has no today ([day-history.md](day-history.md)) |
| `VITE_API_URL` | frontend build | the `apiUrl` output, set by the deploy script |
| `VITE_IMPRESSUM_NAME`, `…_STREET`, `…_CITY`, `…_EMAIL` | frontend build | the provider's details; while one is empty, `/impressum` reads "Angaben folgen." |

**Data flow**

1. `pipeline.update` builds `data/*.parquet` locally ([pipeline.md](pipeline.md)).
2. The deploy script uploads the seven files the API reads (`aggregate`, `stations`, `monate`, `lines`, `linien`, `days`, `tage`) to the container `data`. `coords.parquet`, `raw/`, `months/` and `days/` stay local, and so do the files of today (`day_hours.parquet`, `heute.parquet`, `heute_rest.parquet`, `live/`): Azure has neither the collector nor the raw data, so it never has a today.
3. At container start `python -m backend.fetch` downloads `DATA_URL + <file name>` for each file, then uvicorn starts with `--no-access-log`.
4. The browser loads the web app from Static Web Apps, calls the API at `VITE_API_URL` (CORS allows the web app's origin) and loads tiles, style and fonts from `tiles.openfreemap.org`.

**Cost items and free grants** ( from the Azure pricing pages and the Learn billing pages; check the current prices before deploying)

| Item | Billing | Source |
|---|---|---|
| ACR Basic | a fixed daily fee for as long as the registry exists; 10 GB included | [pricing page](https://azure.microsoft.com/en-us/pricing/details/container-registry/) |
| ACR Tasks (`az acr build`) | first 6,000 vCPU-seconds per month free | Azure Retail Prices API, "Basic Task vCPU Duration" |
| Container Apps, active vCPU and memory | per vCPU-second and GiB-second while a replica is active | [Container Apps billing](https://learn.microsoft.com/en-us/azure/container-apps/billing) |
| Container Apps, requests | per million requests | [Container Apps billing](https://learn.microsoft.com/en-us/azure/container-apps/billing) |
| Container Apps free grant | 180,000 vCPU-s, 360,000 GiB-s, 2 million requests per subscription and month; nothing while scaled to zero | [Container Apps billing](https://learn.microsoft.com/en-us/azure/container-apps/billing) |
| Log Analytics | first 5 GB per month free, then per GB; 31 days retention included | [cost-logs](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/cost-logs) |
| Blob Storage Hot LRS | per GB-month and per 10,000 reads; negligible for the data size | [pricing page](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/) |
| Static Web Apps Free | free; 100 GB bandwidth per subscription and month, no overage | [quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas) |

Expected: the registry is the main fixed cost, and the rest stays near zero as long as the API is awake less than the free grant covers. One wake-up of 6 minutes at 0.5 vCPU / 1 GiB uses 0.5 × 360 = 180 vCPU-s and 1 × 360 = 360 GiB-s, so the grant covers 180,000 / 180 = 1,000 such wake-ups a month (about 100 active hours) at no charge. Worst case: see §8.

**Deploy and teardown by script** (`scripts/azure.py`, standard library only; run from the repository root; the remaining code blocks are PowerShell: `powershell` on Windows, `pwsh` on macOS and Linux)

The account needs **Owner**, or **Contributor** plus **User Access Administrator** (or **Role Based Access Control Administrator**), on the resource group: Contributor creates the resources but not the AcrPull role assignment, and the other two roles create only role assignments. Teardown step 3 may make `az` offer to install the `log-analytics` extension; accept.

Sign in once per session, then run the script. Two personal values come from the environment or, if unset, from a prompt; they never go into the repository: `GLEISATLAS_BUDGET_EMAIL` (receives the budget alerts) and `GLEISATLAS_BUDGET_AMOUNT` (the monthly budget in the billing currency, a whole number).

```powershell
az login
az account set --subscription <subscription name or id>
uv run python scripts/azure.py deploy
```

In VS Code, the launch configurations "Azure: deploy" and "Azure: teardown" run the same commands in the integrated terminal, where the prompts work.

`deploy` prints a numbered header per step, streams the long steps (image build, deployments, frontend build, upload) and stops at the first failure with the step, the command (never a secret) and the error output, exit code 1. Steps that start or add cost print a `COST:` line first.

1. Preflight: `az`, `git`, `npm` and `npx` on PATH; signed in (the subscription and user are printed); a clean working tree, because the image tag names the commit; the seven data files exist; the two personal values.
2. Register the seven resource providers.
3. Create the resource group `gleisatlas` in Sweden Central.
4. Phase 1, everything except the Container App. **COST:** from here the container registry is billed per day until teardown. The budget starts on the first of the current month, or keeps the start date of an earlier deployment (Azure rejects a change).
5. Read the deployment outputs.
6. Upload exactly the seven files the API reads, with the signed-in user's account key.
7. Check the blob access: a file answers 200 by URL, the container listing answers 404.
8. Build the image `api:<short commit>` in the registry.
9. Phase 2, the same deployment plus the image, which adds the Container App. **COST:** billed only while a replica runs.
10. Poll `<apiUrl>/datenstand` until it answers 200 (up to 3 minutes) and print the seconds: the cold start.
11. Build the frontend with `VITE_API_URL` set to the `apiUrl` output in the build's environment.
12. Narrow `connect-src` in the built copy `frontend/dist/staticwebapp.config.json` from the wildcard `https://*.swedencentral.azurecontainerapps.io` to the API's exact origin. The file in the repository keeps the wildcard.
13. Fetch the Static Web App's deployment token and upload `frontend/dist` with the pinned SWA CLI; the token goes through the environment, not the command line, and is never printed.
14. Print the site URL and the API URL.

The frontend build reads `frontend/.env.production.local` (gitignored) for the Impressum: the keys `VITE_IMPRESSUM_NAME`, `VITE_IMPRESSUM_STREET`, `VITE_IMPRESSUM_CITY` and `VITE_IMPRESSUM_EMAIL` are the provider's full name, street and house number, postcode and city, and a contact e-mail address, exactly as they should appear on `/impressum`. The script never writes this file; `VITE_API_URL` comes from its own environment, which wins over the file. Leave the Impressum keys out and the page reads "Angaben folgen." instead. Save the file as UTF-8 without a BOM, which Vite needs.

Running `deploy` again repeats every step and is safe: the same commit gives the same image tag, and the budget keeps its start date. So a change to `infra/main.bicep`, the API or the web app goes live by committing and running `deploy` again; new data alone needs only `data`.

- **Data update** (touches Azure: overwrites the files in the deployed storage account): `uv run python -m pipeline.update`, then `uv run python scripts/azure.py data`. It checks that the seven data files exist, prints the subscription, reads the storage account from the deployment outputs and uploads only those files, without a build or a deployment. A running replica keeps the old data until it restarts; the next cold start fetches the new files. To switch at once:

  ```powershell
  # Restart the active revision, so the container downloads the data again.
  az containerapp revision restart --name gleisatlas-api --resource-group gleisatlas --revision (az containerapp revision list --name gleisatlas-api --resource-group gleisatlas --query '[0].name' --output tsv)
  ```

Emergency stop and its undo:

```powershell
# Stop: no request reaches the API any more, so the replica scales to zero and compute stops.
az containerapp ingress disable --name gleisatlas-api --resource-group gleisatlas

# Undo: open the ingress again (running `deploy` restores it as well).
az containerapp ingress enable --name gleisatlas-api --resource-group gleisatlas --type external --target-port 8000 --transport auto
```

Delete everything:

```powershell
uv run python scripts/azure.py teardown
```

1. Print the subscription; if the resource group does not exist, say that nothing is deployed and stop.
2. Ask to type `gleisatlas`; anything else aborts, exit code 1.
3. Permanently delete the Log Analytics workspace (skipped if it does not exist), so a soft-deleted workspace never blocks a later deploy in another region.
4. Delete the resource group and wait until it is gone.
5. Check that the group no longer exists and say that billing has stopped.

The budget is scoped to the resource group and goes with it; check under Cost Management, Budgets that it is gone.

**Reading the app log**

The API's lines go to stdout and land in the table `ContainerAppConsoleLogs_CL` of the workspace, a few minutes after they are written. The columns used here are `TimeGenerated`, `ContainerAppName_s` and `Log_s` (the line). The format comes from `backend/main.py`:

```text
start <id> <METHOD> <path>[?<query>]
end <id> <status> <ms>ms
```

`<id>` is 8 hex characters that pair the two lines. Uvicorn's own start-up lines sit in the same table and are skipped by the queries.

```powershell
# Live stream of the API's lines (Ctrl+C ends it); --type system shows the platform's events instead.
az containerapp logs show --name gleisatlas-api --resource-group gleisatlas --follow --format text
```

Each query below runs the same way: paste it into the here-string, then run the lines after it (the query becomes one line, so `az` receives it in one piece; the queries use single quotes only, because Windows PowerShell 5.1 splits native-command arguments at double quotes).

```powershell
$workspace = az monitor log-analytics workspace show --resource-group gleisatlas --workspace-name gleisatlas-logs --query customerId --output tsv
$kql = @'
<query>
'@
$kql = $kql -replace '\s*\r?\n\s*', ' '
az monitor log-analytics query --workspace $workspace --analytics-query $kql --output table
```

Requests that never finished (a start line without an end line, older than 5 minutes, last 3 days; the Polars warning watch in [patterns.md](patterns.md) §8). An empty result is the good case:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == 'gleisatlas-api' and TimeGenerated > ago(3d)
| parse Log_s with phase ' ' id ' ' rest
| where phase in ('start', 'end')
| summarize started = minif(TimeGenerated, phase == 'start'), ends = countif(phase == 'end'), request = take_anyif(rest, phase == 'start') by id
| where isnotnull(started) and ends == 0 and started < ago(5m)
| order by started desc
```

Requests per hour (last day):

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == 'gleisatlas-api' and TimeGenerated > ago(1d)
| where Log_s startswith 'start '
| summarize requests = count() by hour = bin(TimeGenerated, 1h)
| order by hour asc
```

The slowest paths (p50 and p95 of the end line's duration, joined to the start line's path by id, last 7 days):

```kusto
let lines = ContainerAppConsoleLogs_CL
| where ContainerAppName_s == 'gleisatlas-api' and TimeGenerated > ago(7d)
| parse Log_s with phase ' ' id ' ' a ' ' b;
lines
| where phase == 'start'
| project id, path = tostring(split(b, '?')[0])
| join kind=inner (lines | where phase == 'end' | project id, ms = toint(extract('^[0-9]+', 0, b))) on id
| summarize requests = count(), p50 = percentile(ms, 50), p95 = percentile(ms, 95) by path
| order by p95 desc
```

Responses outside 2xx (last 7 days, newest first):

```kusto
let lines = ContainerAppConsoleLogs_CL
| where ContainerAppName_s == 'gleisatlas-api' and TimeGenerated > ago(7d)
| parse Log_s with phase ' ' id ' ' a ' ' b;
lines
| where phase == 'end' and (toint(a) < 200 or toint(a) > 299)
| project TimeGenerated, id, status = toint(a), duration = b
| join kind=leftouter (lines | where phase == 'start' | project id, method = a, request = b) on id
| project TimeGenerated, status, method, request, duration
| order by TimeGenerated desc
```

Not in this log: page views of the web app (Static Web Apps Free has no access log for us, and the app has no tracking), client addresses, and the platform's own events (revision provisioning, image pulls, crashes), which live in `ContainerAppSystemLogs_CL` with the same `ContainerAppName_s` and `Log_s` columns.

## 5 Milestones

- [x] API ready for Container Apps: CORS from the environment, the request log, the data download at start, the image. Re-check: `uv run pytest -q`, `tests/api/test_deploy_api.py` (`test_cors_defaults_to_the_local_dev_server`, `test_cors_origins_come_from_the_environment`, `test_a_request_logs_one_start_and_one_end_line_with_the_same_id`, `test_a_failing_request_still_logs_its_end_line`, `test_the_log_file_gets_timestamped_lines_and_is_detached_again`, `test_fetch_downloads_every_file_with_the_same_bytes`, `test_fetch_names_the_file_that_cannot_be_downloaded`, `test_fetch_rejects_a_download_that_ends_early`, `test_fetch_does_nothing_without_a_data_url`).
- [x] Impressum and privacy policy. Re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/legal.spec.ts`.
- [x] Static Web Apps configuration with the CSP. Re-check: `npm --prefix frontend run test:e2e`, `frontend/e2e/csp.spec.ts`.
- [x] Bicep infrastructure with the budget. Re-check: `az bicep build --file infra/main.bicep --stdout` prints no warning; the gate line `bicep` in `uv run python scripts/gate.py`.
- [ ] Deployed by the product owner with the runbook in §4. Re-check: the platform checks in §6.

## 6 Platform checks

- [x] Both phases of `infra/main.bicep` deploy without errors.
- [x] `az acr build` builds the image in the registry.
- [x] The container downloads the data and starts: the live log stream shows uvicorn's start-up and the first `start`/`end` lines, the system log no pull or crash error.
- [x] Cold start after idle, measured: the first `/datenstand` after the replica stopped took 20.9 s (container start and data download); warm 46 ms.
- [x] `/karte` cold and warm on Azure, measured (map.md §6 refers here): 42 s cold, started together with the cold `/datenstand`, so about 20 s of start-up and 20 s of computation; warm 275 ms. Accepted while under a minute.
- [x] AC-3: the deployed data is under 2 GB (75 MB at the first deploy, before the day tables, which are measured in [day-history.md](day-history.md) §6) (`az storage blob list --account-name $storage --container-name data --auth-mode key --query '[].properties.contentLength'`).
- [ ] AC-16: the budget alert e-mail arrives, tested with a temporary budget of 1 that is deleted afterwards; the first full month stays within the configured budget.
- [ ] The first day in Cost Management shows no "Environment Management Hour" charge.
- [x] No CSP violation in the browser console on the deployed site ([theme-and-language.md](theme-and-language.md) §6 refers here).
- [x] The Impressum and Datenschutz pages show the real values, or "Angaben folgen." while the Impressum keys are not set; `/licenses.txt` opens as text, not as a download.
- [ ] After a few days the unfinished-requests query in §4 returns nothing (the Polars warning watch, [patterns.md](patterns.md) §8).
- Ticked on Azure as well, listed in their own docs: [app-shell.md](app-shell.md) §6 (SPA fallback, popover), [map.md](map.md) §6 (tiles and attribution, WebGL, cold `/karte`), [theme-and-language.md](theme-and-language.md) §6 (wordmark, no light flash), [patterns.md](patterns.md) §6 (AC-5, heatmap warm under 3 s).

## 7 Open decisions

- A custom domain, which would replace the default hostnames and keep the CSP's `connect-src` host stable across redeploys.
- Deploying from GitHub Actions (OIDC to Azure) instead of by the script, once the script has settled.

## 8 Known shortcuts

- **The committed CSP allows any Container App in Sweden Central** (`https://*.swedencentral.azurecontainerapps.io`), because the API's host is assigned when the Container App is created and differs on every fresh deploy. The deploy script narrows the built copy to the exact host, so the deployed site is tight; a build uploaded without the script is not. A custom domain would keep the host stable and the wildcard could go.
- **The blob container is public for reading** (`// ponytail:` in `infra/main.bicep`). Anyone with a file's URL can download the aggregates, which are CC BY anyway; listing is off. Every download counts as internet egress; beyond the free 100 GB a month it is billed per GB to the storage account, which the budget covers. If a policy forbids public access, switch to a managed-identity token in `backend/fetch.py`.
- **The per-process caches are lost on every scale to zero.** The first `/karte` after a wake-up recomputes (2.7 s locally on one thread for the default range from `days.parquet`), on top of the container start and the data download. Revisit with min 1 replica (costs idle time) or a precomputed map file.
- **The alerts do not stop anything.** Scale to zero does not cap the cost: a request at least every two minutes (the 120 s cooldown) keeps the replica active around the clock, so compute at 0.5 vCPU / 1 GiB is billed all month, far above the free grant and the fixed costs. The alert mails and the emergency stop in §4 are the protection.
- **Image tags come from the commit**; the script refuses a dirty tree, because `az acr build` uploads uncommitted changes too. Old images stay in the registry until deleted by hand (10 GB included).
- **The deploy script cannot resume.** A rerun repeats every step (all are safe to repeat), and a failure in step 8 or later costs the earlier steps again. Its budget-date lookup counts any failure as "no earlier deployment"; a wrong date makes Azure reject the budget deployment, which stops the script.
- **`backend.fetch` downloads all seven files at every container start**, without a checksum or ETag; a failed download leaves a `.part` file in a container that is thrown away anyway. It imports `backend.main` for the path list, which loads FastAPI and Polars before the download (a second or two).
- **The daily log cap of 0.1 GB drops lines.** Under a request flood, ingestion stops for the rest of the day, which is when the unfinished-requests query matters most. Raise the cap (`dailyQuotaGb`) if that happens.
- **The stdout lines carry no timestamp** (Log Analytics adds `TimeGenerated`); the 8-hex id pairs a start with its end line but is not unique forever.
- **The licence file lists the bundled JavaScript packages and the font, not Tailwind.** Vite's `build.license` (in `frontend/vite.config.ts`) only sees modules, while Tailwind's base styles (MIT) arrive through the CSS pipeline, and the minified CSS drops their notice. Add Tailwind's licence by hand to the file if a licence review asks for it.
- **The Impressum may be empty.** Without the four `VITE_IMPRESSUM_*` keys the page reads "Angaben folgen."
- **The gate's Bicep line passes on warnings**; only errors fail it. A new BCP081 warning after a Bicep update shows up in `az bicep build` output only.
- **A deployment without `image` leaves an existing Container App untouched** (incremental mode) and outputs an empty `apiUrl`; the script's phase 2 always passes the image. After a hand-run deployment of `infra/main.bicep`, pass the current image (`az deployment group show --resource-group gleisatlas --name main --query properties.parameters.image.value --output tsv`) or the app stays on its old revision.
