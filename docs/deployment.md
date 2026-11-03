# Deployment on Azure

## 1 Overview

Gleisatlas v0.2 runs on Azure: the web app on Static Web Apps, the API on Container Apps, the aggregates in Blob Storage, and, when the deploy is given the DB key, the collector for today as a scheduled Container Apps job that keeps its files in the same blob container. Everything lives in one resource group in Sweden Central (the Static Web App's settings in East US 2), described by `infra/main.bicep` and deployed and torn down by one script each (§4). The container registry is the main fixed cost; at low traffic the rest stays near zero within the free grants (§4), and a budget on the resource group sends alert e-mails (SPEC AC-16).

## 2 Spec

- One resource group in Sweden Central holds every resource; the Static Web App resource sits in East US 2 and serves its files worldwide. Names come from `uniqueString(resourceGroup().id)` where they must be globally unique (storage account, registry).
- The web app is the production build of `frontend/` on Static Web Apps Free, under its default `*.azurestaticapps.net` hostname. Every path route falls back to `index.html`; `/assets/*` is cached as immutable; every response carries the CSP and the other headers of `frontend/public/staticwebapp.config.json`.
- The API is the image from `Dockerfile` on Container Apps with external HTTPS ingress, 0.5 vCPU and 1 GiB, scaling from 0 to 1 replica. At start it downloads the nine data files from the blob container `data` (`backend/fetch.py`), then serves on port 8000. It also fetches `heute.parquet` and `live_tage.parquet` when the container holds them and, while awake, checks them again at most once a minute ([day-history.md](day-history.md) §2). Only the web app's origin passes CORS. A replica stops 10 minutes after the last request. After the first requests of a fresh replica are answered, one background thread runs each page's default query once, so the next clicks find warm caches.
- The collector `pipeline.live` runs as a Container Apps job from the same image every 15 minutes (cron in UTC), with 0.25 vCPU and 0.5 GiB, one replica per execution, at most 14 minutes and no retry. It pulls its files from the blob container, asks the DB Timetables API, and writes `heute.parquet`, `live_tage.parquet` and its state under `live/` back ([pipeline.md](pipeline.md) §2). It exists only when the deploy is given the DB key; a refused key (HTTP 401 or 403) ends the execution as failed without a write.
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
- **The collector runs on Azure as a scheduled Container Apps job** ([ADR 0002](adr/0002-live-source.md), amended). Reason: the Azure deployment is the only one for now and the move to a VPS is far off, so the deployed Live-Lage would otherwise have no today and no collector days; the job's share of the free grant (§4) is accepted.
- **Scale-down cooldown 600 s** (`cooldownPeriod`, default 300 s, available in the stable API 2026-07-01; was 120 s). Reason: a visitor who reads a page for a few minutes and clicks on should not wait for another cold start; the price is 10 more minutes billed per wake-up (§4).
- **A warm-up after a wake.** The first answered request of a fresh process starts `backend.main.warm_up` in one background thread. It runs the default query of each cached page, one after another, with the arguments the web app sends without URL keys: the Karte, Live-Lage's newest day, the Muster heatmap, the station rankings and the daily Zeitverlauf. Before each page it waits until no request is in flight and none ended in the last 2 s (`QUIET`), so a visitor's next request goes first (Live-Lage asks for its day only after `/datenstand` has answered, and so does a month page whose URL holds a period). The pages go through the route functions, so the query cap and the caches are the same; a failure is logged (`warm-up failed: <page>: <error>`) and the next page warms anyway, and the end is logged with its duration (`warm-up done in <ms>ms`). Only with `DATA_URL` set. Reason: every wake-up is a fresh process with empty caches, and the first page alone warms only its own query; locally and in the tests the process lives long and the thread would only compete with the requests. The uncached station routes (statistics, lines: a few tens of ms) are left out, since warming them would keep nothing.
- **The heatmap is cached like the other heavy routes** (`heatmap_for`, [patterns.md](patterns.md) §8). Reason: about 1.9 s cold on one thread for the default period, and without a cache the warm-up could not keep it (the product owner's choice).

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
- **The job has its own user-assigned identity** (`gleisatlas-job`) with *Storage Blob Data Contributor* on the `data` container only and *AcrPull* on the registry. Reason: the API's pull identity stays without write access, and the job can write nowhere but that container. It fetches its token from the identity endpoint Container Apps gives the container (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`, its client id in `AZURE_CLIENT_ID`) and calls Blob REST with the standard library, so no Azure SDK enters the image. Reads stay anonymous, like the API's.
- **The job uses `DATA_URL`, the variable the API reads its files from.** Reason: one name for the one container both use.
- **The DB key reaches the job as two job secrets** (`db-client-id`, `db-api-key`), referenced by the environment variables `DB_CLIENT_ID` and `DB_API_KEY`, from the `@secure()` parameters `dbClientId` and `dbApiKey`. The deploy script reads them from the environment or a hidden prompt and hands them to `az` in a temporary parameters file that it deletes afterwards, also on a failure. Reason: a value on the command line is visible to every process of the machine and lands in shell histories and the script's failure output; secure parameters are not stored in the deployment's history.
- **The job only with an image and the key.** Reason: a deploy without the key (no DB account yet) still gives the whole site, without today.
- **Schedule `*/15 * * * *`, 0.25 vCPU / 0.5 GiB, parallelism 1, `replicaTimeout` 840 s, `replicaRetryLimit` 0.** Reason: the collector's rate and 12-minute request deadline assume one run every 15 minutes (ADR 0002); 14 minutes leaves room for the blob sync and never overlaps the next execution, and the next execution is the retry. The smallest size: a run holds a day's state of 131 stations (a few MB) and the kept days (about 2.5 MB).
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
| Container App | `gleisatlas-api` | only when `image` is set; port 8000, HTTPS only, single revision, 0–1 replicas, the platform's default HTTP scale rule, cooldown 600 s |
| User-assigned identity | `gleisatlas-job` | only with the job; Storage Blob Data Contributor on the container `data`, AcrPull on the registry |
| Container Apps job | `gleisatlas-collector` | only when `image`, `dbClientId` and `dbApiKey` are set; schedule `*/15 * * * *` (UTC), `python -m pipeline.live`, 0.25 vCPU / 0.5 GiB, parallelism 1, timeout 840 s, no retry, the key as two secrets |

Parameters: `budgetEmail`, `budgetStartDate` and `budgetAmount` (all required), `image` (default empty), `webLocation` (`eastus2`), `cpu` (`0.5`), `memory` (`1Gi`), `polarsMaxThreads` (`1`), `dbClientId` and `dbApiKey` (secure, default empty). Outputs: `apiUrl` (empty without the app), `webName`, `webHostname`, `registryName`, `registryServer`, `storageName`, `workspaceId`.

**Environment variables**

| Variable | Where | Value |
|---|---|---|
| `DATA_URL` | API and job, set by Bicep | `https://<storage>.blob.core.windows.net/data/`; unset locally, then `backend.fetch` does nothing, there is no warm-up, and the collector works in `data/` |
| `DB_CLIENT_ID`, `DB_API_KEY` | job, from its secrets | the DB API Marketplace application; locally from the product owner's environment |
| `AZURE_CLIENT_ID` | job, set by Bicep | the client id of `gleisatlas-job`, for its token |
| `IDENTITY_ENDPOINT`, `IDENTITY_HEADER` | job, set by Container Apps | the identity endpoint and its header |
| `CORS_ORIGINS` | API, set by Bicep | `https://<web hostname>`; comma-separated; default `http://localhost:5317` |
| `POLARS_MAX_THREADS` | API, set by Bicep | `1` |
| `LOG_FILE` | API, local only | a path for a timestamped copy of the request lines; unset on Azure |
| `AGGREGATE_PATH`, `STATIONS_PATH`, `MONATE_PATH`, `LINES_PATH`, `LINIEN_PATH`, `DAYS_PATH`, `TAGE_PATH`, `DAY_HOURS_PATH`, `LARGE_PATH` | API | default `data/<name>.parquet`; `backend.fetch` downloads to the same paths |
| `HEUTE_PATH`, `LIVE_TAGE_PATH` | API | default `data/heute.parquet`, `data/live_tage.parquet`; the collector's files, fetched from the container at start when present (a 404 means none) and checked again at most once a minute |
| `HEUTE_REST_PATH` | API, local only | default `data/heute_rest.parquet`; written by `pipeline.update` from the raw data, never downloaded |
| `VITE_API_URL` | frontend build | the `apiUrl` output, set by the deploy script |
| `VITE_IMPRESSUM_NAME`, `…_STREET`, `…_CITY`, `…_EMAIL` | frontend build | the provider's details; while one is empty, `/impressum` reads "Angaben folgen." |

**Data flow**

1. `pipeline.update` builds `data/*.parquet` locally ([pipeline.md](pipeline.md)).
2. The deploy script uploads the nine files the API reads (`aggregate`, `stations`, `monate`, `lines`, `linien`, `days`, `tage`, `day_hours`, `large`) to the container `data`; `day_hours` and `large` add about 24 MB to every cold start. `coords.parquet`, `raw/`, `months/` and `days/` stay local, and so do `heute_rest.parquet` and `live/`. `heute.parquet`, `live_tage.parquet` and `live/` are never uploaded by the script: they are the job's, and the API takes the first two from the container whenever they are there. Without the job the deployed site has no today and no collector days.
3. At container start `python -m backend.fetch` downloads `DATA_URL + <file name>` for each file, then uvicorn starts with `--no-access-log`.
4. Every 15 minutes an execution of the job syncs its files with the container around one collector run ([pipeline.md](pipeline.md) §2, "On Azure"). An awake API picks a new `heute.parquet` up within a minute (`backend.fetch.refresh_live`); the job never calls the API, so it never wakes it.
4. The browser loads the web app from Static Web Apps, calls the API at `VITE_API_URL` (CORS allows the web app's origin) and loads tiles, style and fonts from `tiles.openfreemap.org`.

**Cost items and free grants** (from the Azure pricing pages and the Learn billing pages; check the current prices before deploying)

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

Expected: the registry is the main fixed cost, and the rest stays near zero as long as the API and the job together use less than the free grant. Worst case: see §8.

- **The job** is billed per second of each execution at 0.25 vCPU and 0.5 GiB: 0.25 vCPU-s and 0.5 GiB-s per second, the same share of both grants. 96 executions a day are about 2,880 a month; at 3 minutes each (container start, about 165 requests at one a second, the blob sync) that is 2,880 × 180 × 0.25 = 129,600 vCPU-s and 259,200 GiB-s, **72 % of the grant**, at 3.5 minutes 84 %. The real duration is a platform check (§6); beyond the grant the job is billed at the active rate.
- **A wake-up of the API** lasts the visit plus the 10-minute cooldown at 0.5 vCPU / 1 GiB: a 2-minute visit is 12 minutes, 0.5 × 720 = 360 vCPU-s and 720 GiB-s. Without the job the grant covers 500 such wake-ups a month; next to a job at 72 to 84 % about 150 to 80.
- **An open Live-Lage tab on today** asks the API every 5 minutes ([day-history.md](day-history.md) §3), inside the cooldown, so the replica stays awake as long as the tab is open: 1,800 vCPU-s and 3,600 GiB-s an hour. No other page and no past day polls, so any other open tab lets the replica stop. Next to the job, what is left of the grant covers about 8 to 15 such hours a month.

**Deploy and teardown by script** (`scripts/azure.py`, standard library only; run from the repository root; the remaining code blocks are PowerShell: `powershell` on Windows, `pwsh` on macOS and Linux)

The account needs **Owner**, or **Contributor** plus **User Access Administrator** (or **Role Based Access Control Administrator**), on the resource group: Contributor creates the resources but not the AcrPull role assignment, and the other two roles create only role assignments. Teardown step 3 may make `az` offer to install the `log-analytics` extension; accept.

Sign in once per session, then run the script. Two personal values come from the environment or, if unset, from a prompt; they never go into the repository: `GLEISATLAS_BUDGET_EMAIL` (receives the budget alerts) and `GLEISATLAS_BUDGET_AMOUNT` (the monthly budget in the billing currency, a whole number). The DB key for the collector job comes from `DB_CLIENT_ID` and `DB_API_KEY` or, if unset, from a hidden prompt (nothing is shown while typing); leave the client id empty to deploy without the job. The script never prints the key and passes it to `az` only in a temporary parameters file, which it deletes afterwards.

```powershell
az login
az account set --subscription <subscription name or id>
uv run python scripts/azure.py deploy
```

`deploy` prints a numbered header per step, streams the long steps (image build, deployments, frontend build, upload) and stops at the first failure with the step, the command (never a secret) and the error output, exit code 1. Steps that start or add cost print a `COST:` line first.

1. Preflight: `az`, `git`, `npm` and `npx` on PATH; signed in (the subscription and user are printed); a clean working tree, because the image tag names the commit; the nine data files exist; the two personal values; the DB key or none (it prints `collector job: with the DB key` or `collector job: no DB key given (an existing job keeps its image and key)`).
2. Register the seven resource providers.
3. Create the resource group `gleisatlas` in Sweden Central.
4. Phase 1, everything except the Container App. **COST:** from here the container registry is billed per day until teardown. The budget starts on the first of the current month, or keeps the start date of an earlier deployment (Azure rejects a change).
5. Read the deployment outputs.
6. Upload exactly the nine files the API reads, with the signed-in user's account key.
7. Check the blob access: a file answers 200 by URL, the container listing answers 404.
8. Build the image `api:<short commit>` in the registry.
9. Phase 2, the same deployment plus the image, which adds the Container App, and with the DB key the job, its identity and its two role assignments (the key through the temporary parameters file). **COST:** the app is billed only while a replica runs; the job per second of each execution, every 15 minutes.
10. Poll `<apiUrl>/datenstand` until it answers 200 (up to 3 minutes) and print the seconds: the cold start.
11. Build the frontend with `VITE_API_URL` set to the `apiUrl` output in the build's environment.
12. Narrow `connect-src` in the built copy `frontend/dist/staticwebapp.config.json` from the wildcard `https://*.swedencentral.azurecontainerapps.io` to the API's exact origin. The file in the repository keeps the wildcard.
13. Fetch the Static Web App's deployment token and upload `frontend/dist` with the pinned SWA CLI; the token goes through the environment, not the command line, and is never printed.
14. Print the site URL and the API URL.

The frontend build reads `frontend/.env.production.local` (gitignored) for the Impressum: the keys `VITE_IMPRESSUM_NAME`, `VITE_IMPRESSUM_STREET`, `VITE_IMPRESSUM_CITY` and `VITE_IMPRESSUM_EMAIL` are the provider's full name, street and house number, postcode and city, and a contact e-mail address, exactly as they should appear on `/impressum`. The script never writes this file; `VITE_API_URL` comes from its own environment, which wins over the file. Leave the Impressum keys out and the page reads "Angaben folgen." instead. Save the file as UTF-8 without a BOM, which Vite needs.

Running `deploy` again repeats every step and is safe: the same commit gives the same image tag, and the budget keeps its start date. So a change to `infra/main.bicep`, the API, the collector or the web app goes live by committing and running `deploy` again; new data alone needs only `data`. A fresh deploy after a teardown starts from the uploaded complete days: the job writes today within its first few executions (a first run of the day catches up over about an hour, [day-history.md](day-history.md) §8) and the collector days from the next night on.

- **The collector job** (read-only checks):

  ```powershell
  # The recent executions with their status (Succeeded, Failed, Running) and start time.
  az containerapp job execution list --name gleisatlas-collector --resource-group gleisatlas --output table

  # Is heute.parquet fresh? Its last-modified time in the container (a public read).
  $storage = az deployment group show --resource-group gleisatlas --name main --query properties.outputs.storageName.value --output tsv
  (Invoke-WebRequest -Method Head -UseBasicParsing -Uri "https://$storage.blob.core.windows.net/data/heute.parquet").Headers['Last-Modified']
  ```

  Each execution writes one line to stdout, the collector's summary (`<day> before <hour>:00: <n> requests (<m> failed), <k> of 131 stations, <u> files uploaded, <d> deleted`), or one error line and a failed status: `stopped by HTTP 401: the DB API refused the key` (or 403), `token failed: …` (the identity endpoint did not answer; nothing was asked or written), `download failed: <blob>: …` (the run did not start), `blob sync failed: <blob>: HTTP <status>` (a missing role assignment, for example) or `blob sync failed: <error>` (a network failure). The lines land in `ContainerAppConsoleLogs_CL` like the API's; the portal shows them per execution under the job's Execution history.
- **Stop the job without a teardown** (for example after a 401): `az containerapp job delete --name gleisatlas-collector --resource-group gleisatlas --yes`; the next `deploy` with the key creates it again. Its files stay in the container until the teardown.

- **Data update** (touches Azure: overwrites the files in the deployed storage account): `uv run python -m pipeline.update`, then `uv run python scripts/azure.py data`. It checks that the nine data files exist, prints the subscription, reads the storage account from the deployment outputs and uploads only those files, without a build or a deployment. A running replica keeps the old data until it restarts; the next cold start fetches the new files. To switch at once:

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

The budget is scoped to the resource group and goes with it; check under Cost Management, Budgets that it is gone. So do the job, its identity and the storage account with the job's files (`heute.parquet`, `live_tage.parquet`, `live/`): the collector days exist only there, so a teardown loses the days after the last uploaded complete day until `pipeline.update` has them locally.

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
- [x] The collector job: the blob sync with the job's identity, the stop at a refused key, `pipeline/` in the image, the job in Bicep, the key through a temporary parameters file, the 10-minute cooldown and the warm-up. Re-check: `uv run pytest -q`, in particular `tests/pipeline/test_live.py` (`test_the_job_pulls_its_state_runs_and_pushes_what_changed`, `test_an_unchanged_file_is_not_pushed_again`, `test_a_missing_blob_means_none`, `test_a_failed_pull_stops_the_job_before_the_run`, `test_an_unreachable_identity_endpoint_ends_the_job_with_one_line`, `test_a_refused_key_in_the_job_pushes_nothing_and_never_shows_the_key`, `test_a_refused_key_stops_the_run_at_once_and_writes_nothing`, `test_the_collector_imports_without_the_download_library`), `tests/scripts/test_azure.py` (`test_deploy_hands_the_db_key_to_az_in_a_parameters_file_that_is_deleted`, `test_deploy_asks_for_the_db_key_hidden_and_skips_the_job_without_it`, `test_the_parameters_file_is_deleted_when_the_deployment_fails`, `test_data_leaves_the_collectors_files_alone`), `tests/api/test_warmup.py` (the warm-up, its quiet window, `test_the_heatmap_is_cached_until_the_aggregate_changes`); `az bicep build --file infra/main.bicep --stdout`; the poll on Live-Lage only, `npm --prefix frontend run test:e2e`, in `frontend/e2e/lage.spec.ts` "a past day is not polled" and "no other page polls /datenstand, even while the server has a today".
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
- [ ] The collector job (deployed with the key): its executions succeed (`az containerapp job execution list`, §4), each logs one summary line, and the duration of an execution (start to end) is noted for the cost in §4.
- [ ] Within 15 minutes of the deploy `heute.parquet` is in the container (its `Last-Modified`, §4), and "Heute" shows on the deployed Live-Lage with the live stand, all 131 stations within about an hour.
- [ ] The next morning, after the first execution from 01:00 local, "Gestern" on the deployed Live-Lage comes from the collector (`/datenstand.live_tage` lists it) before any `data` upload.
- [ ] Memory of the API with all caches warm on 1 GiB: after a wake-up the log shows `warm-up done in <ms>ms` and no `warm-up failed`, and the replica's memory (portal, Metrics, Memory Working Set Bytes) stays clear of 1 GiB while a visitor then clicks through every page and a few days of Live-Lage.
- [ ] The job's memory on 0.5 GiB: no execution ends with an out-of-memory error in `ContainerAppSystemLogs_CL`, also on the finalizing run after 01:00.
- [ ] The cost after a few days in Cost Management: the job's vCPU and memory seconds against the 72 to 84 % estimate in §4.
- Ticked on Azure as well, listed in their own docs: [app-shell.md](app-shell.md) §6 (SPA fallback, popover), [map.md](map.md) §6 (tiles and attribution, WebGL, cold `/karte`), [theme-and-language.md](theme-and-language.md) §6 (wordmark, no light flash), [patterns.md](patterns.md) §6 (AC-5, heatmap warm under 3 s).

## 7 Open decisions

- A custom domain, which would replace the default hostnames and keep the CSP's `connect-src` host stable across redeploys.
- Deploying from GitHub Actions (OIDC to Azure) instead of by the script, once the script has settled.

## 8 Known shortcuts

- **The committed CSP allows any Container App in Sweden Central** (`https://*.swedencentral.azurecontainerapps.io`), because the API's host is assigned when the Container App is created and differs on every fresh deploy. The deploy script narrows the built copy to the exact host, so the deployed site is tight; a build uploaded without the script is not. A custom domain would keep the host stable and the wildcard could go.
- **The blob container is public for reading** (`// ponytail:` in `infra/main.bicep`). Anyone with a file's URL can download the aggregates, which are CC BY anyway; listing is off. Every download counts as internet egress; beyond the free 100 GB a month it is billed per GB to the storage account, which the budget covers. If a policy forbids public access, switch to a managed-identity token in `backend/fetch.py`.
- **The per-process caches are lost on every scale to zero.** The first `/karte` after a wake-up recomputes (2.7 s locally on one thread for the default range from `days.parquet`), on top of the container start and the data download. Revisit with min 1 replica (costs idle time) or a precomputed map file.
- **The alerts do not stop anything.** Scale to zero does not cap the cost: a request at least every ten minutes (the 600 s cooldown; an open Live-Lage tab on today polls every five) keeps the replica active around the clock, so compute at 0.5 vCPU / 1 GiB is billed all month, far above the free grant and the fixed costs. The alert mails and the emergency stop in §4 are the protection.
- **Image tags come from the commit**; the script refuses a dirty tree, because `az acr build` uploads uncommitted changes too. Old images stay in the registry until deleted by hand (10 GB included).
- **The deploy script cannot resume.** A rerun repeats every step (all are safe to repeat), and a failure in step 8 or later costs the earlier steps again. Its budget-date lookup counts any failure as "no earlier deployment"; a wrong date makes Azure reject the budget deployment, which stops the script.
- **`backend.fetch` downloads all nine files at every container start**, without a checksum or ETag; a failed download leaves a `.part` file in a container that is thrown away anyway. It imports `backend.main` for the path list, which loads FastAPI and Polars before the download (a second or two).
- **The daily log cap of 0.1 GB drops lines.** Under a request flood, ingestion stops for the rest of the day, which is when the unfinished-requests query matters most. Raise the cap (`dailyQuotaGb`) if that happens.
- **The stdout lines carry no timestamp** (Log Analytics adds `TimeGenerated`); the 8-hex id pairs a start with its end line but is not unique forever.
- **The licence file lists the bundled JavaScript packages and the font, not Tailwind.** Vite's `build.license` (in `frontend/vite.config.ts`) only sees modules, while Tailwind's base styles (MIT) arrive through the CSS pipeline, and the minified CSS drops their notice. Add Tailwind's licence by hand to the file if a licence review asks for it.
- **The Impressum may be empty.** Without the four `VITE_IMPRESSUM_*` keys the page reads "Angaben folgen."
- **The gate's Bicep line passes on warnings**; only errors fail it. A new BCP081 warning after a Bicep update shows up in `az bicep build` output only.
- **A deploy without the DB key leaves an existing job untouched** (incremental mode, as for the app below): it keeps running on its old image and key. To remove it, delete it (§4) or tear down.
- **A failed execution sends no alert.** A refused key or a missing role shows only as failed executions and an aging `heute.parquet`; the API then falls back to the raw data or the last complete day. Look at the executions now and then, or add an alert rule on failed executions if it matters.
- **The job pulls and uploads its whole state on every execution** (`ponytail:` in `pipeline.live.sync`), a few MB, and lists `live/` once to delete old folders (one page of up to 5,000 names; the job keeps about ten).
- **The warm-up starts once per process and runs the pages one after another** (`ponytail:` in `backend.main.warm_up`). It waits for a quiet moment before each page, but a visitor who clicks while a page is running waits for it, or computes the same query in parallel (the caches do not merge requests in flight). Its duration on Azure is a platform check (§6).
- **A deployment without `image` leaves an existing Container App untouched** (incremental mode) and outputs an empty `apiUrl`; the script's phase 2 always passes the image. After a hand-run deployment of `infra/main.bicep`, pass the current image (`az deployment group show --resource-group gleisatlas --name main --query properties.parameters.image.value --output tsv`) or the app stays on its old revision.
