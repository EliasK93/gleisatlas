"""Deploy Gleisatlas to Azure in one command, and delete it again (docs/deployment.md §4).

    uv run python scripts/azure.py deploy
    uv run python scripts/azure.py data
    uv run python scripts/azure.py teardown

All three talk to the signed-in `az` account. Steps stream their output; the first failure stops the
script with the step, the command and the error, exit code 1. Personal values come from the
environment (GLEISATLAS_BUDGET_EMAIL, GLEISATLAS_BUDGET_AMOUNT) or a prompt, never from the repo.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
WIN = sys.platform == "win32"
AZ, NPM, NPX = ("az.cmd", "npm.cmd", "npx.cmd") if WIN else ("az", "npm", "npx")

GROUP = "gleisatlas"
LOCATION = "swedencentral"
WORKSPACE = "gleisatlas-logs"
PROVIDERS = (
    "Microsoft.App",
    "Microsoft.OperationalInsights",
    "Microsoft.ContainerRegistry",
    "Microsoft.Storage",
    "Microsoft.Web",
    "Microsoft.ManagedIdentity",
    "Microsoft.Consumption",
)
DATA_FILES = ("aggregate", "stations", "monate", "lines", "linien", "days", "tage")
CSP_WILDCARD = "https://*.swedencentral.azurecontainerapps.io"
SWA_CLI = "@azure/static-web-apps-cli@2.0.10"
DEPLOY_STEPS = 14
DATA_STEPS = 3
TEARDOWN_STEPS = 5

current_step = ""


def narrow_csp(text: str, origin: str) -> str:
    """The built config's wildcard API host becomes the exact origin of the deployed API."""
    if text.count(CSP_WILDCARD) != 1:
        raise ValueError(f"expected the wildcard {CSP_WILDCARD} exactly once in the CSP")
    return text.replace(CSP_WILDCARD, origin)


def budget_start(existing: str | None, today: date) -> str:
    """Azure rejects a changed budget start date: reuse the last deployment's, else this month's."""
    if existing and re.fullmatch(r"\d{4}-\d{2}-\d{2}", existing):
        return existing
    return today.replace(day=1).isoformat()


def die(message: str) -> NoReturn:
    print(f"\nFAILED at: {current_step}\n{message}")
    sys.exit(1)


def step(n: int, total: int, title: str) -> None:
    global current_step
    current_step = title
    print(f"\n[{n}/{total}] {title}")


def exec_(cmd: list[str], env: dict[str, str] | None, capture: bool) -> tuple[int, str, str]:
    """Exit code, stdout and stderr; az warnings go to stderr, so stdout stays parseable."""
    full_env = {**os.environ, **env} if env else None
    p = subprocess.run(
        cmd,
        cwd=ROOT,
        env=full_env,
        capture_output=capture,
        stdin=subprocess.DEVNULL if capture else None,  # a prompt would hang a captured call
        text=capture,
        errors="replace" if capture else None,
    )
    return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()


def run(cmd: list[str], *, env: dict[str, str] | None = None, capture: bool = False) -> str:
    """Run a command, stop the script on failure; returns stdout when captured, else streams."""
    code, out, err = exec_(cmd, env, capture)
    if code:
        detail = f"{err}\n{out}".strip() if capture else f"exit code {code}, output above"
        die(f"command: {' '.join(cmd)}\n{detail}")
    return out


def probe(cmd: list[str]) -> str | None:
    """Captured stdout of a command that may fail without being an error, else None."""
    code, out, _ = exec_(cmd, None, True)
    return out if code == 0 else None


def outputs() -> dict[str, str]:
    raw = run(
        [AZ, "deployment", "group", "show", "--resource-group", GROUP, "--name", "main"]
        + ["--query", "properties.outputs", "--output", "json"],
        capture=True,
    )
    return {key: item["value"] for key, item in json.loads(raw).items()}


def status(url: str, method: str = "GET") -> int:
    """HTTP status, 0 when the host cannot be reached."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except OSError:
        return 0


def account() -> None:
    info = json.loads(run([AZ, "account", "show", "--output", "json"], capture=True))
    print(f"subscription: {info['name']}, user: {info['user']['name']}")


def personal(name: str, prompt: str) -> str:
    return os.environ.get(name) or input(f"{prompt} (or set {name}): ").strip()


def check_data() -> None:
    missing = [
        f"data/{f}.parquet" for f in DATA_FILES if not (ROOT / "data" / f"{f}.parquet").exists()
    ]
    if missing:
        die(f"missing data files: {', '.join(missing)} (build them with pipeline.update)")


def upload_data(storage: str) -> None:
    for f in DATA_FILES:
        print(f"  {f}.parquet")
        run(
            [AZ, "storage", "blob", "upload", "--account-name", storage]
            + ["--container-name", "data", "--name", f"{f}.parquet", "--file", f"data/{f}.parquet"]
            + ["--auth-mode", "key", "--overwrite", "--only-show-errors", "--output", "none"],
            capture=True,
        )


def deploy() -> None:
    # ponytail: no resume, a rerun repeats every step (all are safe to repeat); split into stages
    # if the run time gets in the way. The budget-date lookup treats any failure as "no earlier
    # deployment"; Azure then rejects a wrong date and the deployment fails loudly.
    total = DEPLOY_STEPS
    step(1, total, "Preflight")
    for tool in (AZ, "git", NPM, NPX):
        if shutil.which(tool) is None:
            die(f"{tool} is not on PATH")
    if probe([AZ, "account", "show"]) is None:
        die("not signed in: run `az login` (and `az account set --subscription <name>`)")
    account()
    if run(["git", "status", "--porcelain"], capture=True):
        die("the working tree is not clean: commit first, the image tag must name the commit")
    check_data()
    email = personal("GLEISATLAS_BUDGET_EMAIL", "E-mail address for the budget alerts")
    amount = personal("GLEISATLAS_BUDGET_AMOUNT", "Monthly budget, a whole number")
    if "@" not in email or not amount.isdigit():
        die("budget e-mail needs an @, budget amount must be a whole number")
    tag = run(["git", "rev-parse", "--short", "HEAD"], capture=True)

    step(2, total, "Register the resource providers")
    for ns in PROVIDERS:
        run([AZ, "provider", "register", "--namespace", ns, "--wait"])

    step(3, total, f"Create the resource group in {LOCATION}")
    run([AZ, "group", "create", "--name", GROUP, "--location", LOCATION, "--output", "none"])

    step(4, total, "Phase 1: everything except the Container App")
    print(
        "COST: from here the container registry is billed per day (a small amount) until teardown"
    )
    last = probe(
        [AZ, "deployment", "group", "show", "--resource-group", GROUP, "--name", "main"]
        + ["--query", "properties.parameters.budgetStartDate.value", "--output", "tsv"]
    )
    params = [f"budgetEmail={email}", f"budgetAmount={amount}"]
    params.append(f"budgetStartDate={budget_start(last, date.today())}")

    def deployment(extra: list[str]) -> None:
        run(
            [AZ, "deployment", "group", "create", "--resource-group", GROUP]
            + ["--template-file", "infra/main.bicep", "--output", "none"]
            + ["--parameters", *params, *extra]
        )

    deployment([])

    step(5, total, "Read the deployment outputs")
    out = outputs()
    storage = out["storageName"]
    print(f"registry {out['registryName']}, storage {storage}, web {out['webName']}")

    step(6, total, "Upload the data files")
    upload_data(storage)

    step(7, total, "Check the blob access: a file is public, the listing is not")
    base = f"https://{storage}.blob.core.windows.net/data"
    if (code := status(f"{base}/monate.parquet", "HEAD")) != 200:
        die(f"{base}/monate.parquet answered {code}, expected 200")
    if (code := status(f"{base}?restype=container&comp=list")) != 404:
        die(f"the container listing answered {code}, expected 404 (it must stay private)")
    print("blob 200, listing 404")

    step(8, total, "Build the API image in the registry")
    run(
        [AZ, "acr", "build", "--registry", out["registryName"], "--image", f"api:{tag}", "."],
        env={"PYTHONIOENCODING": "utf-8"},  # az crashes streaming the build log on Windows without
    )

    step(9, total, "Phase 2: add the Container App")
    print("COST: the Container App is billed only while a replica runs (scales to zero when idle)")
    deployment([f"image={out['registryServer']}/api:{tag}"])

    step(10, total, "Wait for the API's cold start")
    api_url = outputs()["apiUrl"]
    started = time.monotonic()
    while status(f"{api_url}/datenstand") != 200:
        if time.monotonic() - started > 180:
            die(f"{api_url}/datenstand did not answer 200 within 3 minutes")
        time.sleep(5)
    print(f"{api_url}/datenstand answered 200 after {time.monotonic() - started:.0f} s")

    step(11, total, "Build the frontend")
    run([NPM, "--prefix", "frontend", "run", "build"], env={"VITE_API_URL": api_url})

    step(12, total, "Narrow the CSP in the built copy to the API's host")
    config = ROOT / "frontend" / "dist" / "staticwebapp.config.json"
    parts = urlsplit(api_url)
    try:
        narrowed = narrow_csp(
            config.read_text(encoding="utf-8"), f"{parts.scheme}://{parts.netloc}"
        )
    except ValueError as e:
        die(str(e))
    config.write_text(narrowed, encoding="utf-8", newline="\n")
    print(f"connect-src now names {parts.scheme}://{parts.netloc}")

    step(13, total, "Upload the frontend to Static Web Apps")
    token = run(
        [AZ, "staticwebapp", "secrets", "list", "--name", out["webName"]]
        + ["--resource-group", GROUP, "--query", "properties.apiKey", "--output", "tsv"],
        capture=True,
    )
    run(
        [NPX, "--yes", SWA_CLI, "deploy", "frontend/dist", "--env", "production"],
        env={"SWA_CLI_DEPLOYMENT_TOKEN": token},  # environment only, never on the command line
    )

    step(14, total, "Done")
    print(f"site: https://{out['webHostname']}\napi:  {api_url}")


def data() -> None:
    total = DATA_STEPS
    step(1, total, "Preflight")
    check_data()
    account()

    step(2, total, "Read the storage account from the deployment outputs")
    storage = outputs()["storageName"]

    step(3, total, f"Upload the data files to {storage}")
    upload_data(storage)
    print("Uploaded. A running replica keeps the old data until its next cold start.")


def teardown() -> int:
    total = TEARDOWN_STEPS
    step(1, total, "Check what is deployed")
    account()
    if run([AZ, "group", "exists", "--name", GROUP, "--output", "tsv"], capture=True) != "true":
        print(f"Nothing is deployed: the resource group {GROUP} does not exist.")
        return 0

    step(2, total, "Confirm")
    answer = input(f"This deletes every resource in {GROUP}. Type {GROUP} to continue: ")
    if answer.strip() != GROUP:
        print("Aborted, nothing was deleted.")
        return 1

    step(3, total, "Delete the Log Analytics workspace for good")
    exists = probe(
        [AZ, "resource", "show", "--resource-group", GROUP, "--name", WORKSPACE]
        + ["--resource-type", "Microsoft.OperationalInsights/workspaces", "--output", "none"]
    )
    if exists is None:
        print("no workspace, skipped")
    else:
        run(
            [AZ, "monitor", "log-analytics", "workspace", "delete", "--resource-group", GROUP]
            + ["--workspace-name", WORKSPACE, "--force", "true", "--yes"]
        )

    step(4, total, "Delete the resource group")
    run([AZ, "group", "delete", "--name", GROUP, "--yes"])

    step(5, total, "Check that it is gone")
    if run([AZ, "group", "exists", "--name", GROUP, "--output", "tsv"], capture=True) != "false":
        die(f"the resource group {GROUP} still exists")
    print("Deleted: billing for the resources has stopped.")
    print("The budget went with the group (check Cost Management, Budgets).")
    return 0


def main(argv: list[str]) -> int:
    getattr(sys.stdout, "reconfigure", lambda **_: None)(errors="replace")  # cp1252 consoles
    parser = argparse.ArgumentParser(description="Deploy Gleisatlas to Azure, or delete it.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("deploy", help="deploy everything, 14 steps (starts billing, see COST lines)")
    sub.add_parser("data", help="upload only the data files to the deployed storage account")
    sub.add_parser("teardown", help="delete the resource group and everything in it")
    args = parser.parse_args(argv)
    if args.command == "teardown":
        return teardown()
    if args.command == "data":
        data()
        return 0
    deploy()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
