"""Deploy Gleisatlas to Azure in one command, and delete it again (docs/deployment.md §4).

    uv run python scripts/azure.py deploy
    uv run python scripts/azure.py data
    uv run python scripts/azure.py teardown

All three talk to the signed-in `az` account. Steps stream their output; the first failure stops the
script with the step, the command and the error, exit code 1. Personal values come from the
environment (GLEISATLAS_BUDGET_EMAIL, GLEISATLAS_BUDGET_AMOUNT) or a prompt, never from the repo;
so does the collector job's DB key (DB_CLIENT_ID, DB_API_KEY, or a hidden prompt). The key and the
e-mail address reach `az` only in a temporary parameters file, and no child process gets the key.
"""

import argparse
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend import main as api  # noqa: E402

WIN = sys.platform == "win32"
AZ, NPM, NPX = ("az.cmd", "npm.cmd", "npx.cmd") if WIN else ("az", "npm", "npx")

GROUP = "gleisatlas"
LOCATION = "swedencentral"
WORKSPACE = "gleisatlas-logs"
PROVIDERS = (
    "Microsoft.App",
    "Microsoft.OperationalInsights",
    "Microsoft.Storage",
    "Microsoft.Web",
    "Microsoft.ManagedIdentity",
    "Microsoft.Consumption",
)
DATA_FILES = tuple(Path(p).stem for p in api.DATA_FILES)  # the files the API downloads at start
DB_ENV = ("DB_CLIENT_ID", "DB_API_KEY")
# ponytail: the committed CSP allows any Container App in the region, since the API's host differs
# on every fresh deploy; `narrow_csp` tightens the built copy, a build uploaded without this script
# keeps the wildcard. A custom domain would keep the host stable and the wildcard could go.
CSP_WILDCARD = "https://*.swedencentral.azurecontainerapps.io"
SWA_CLI = "@azure/static-web-apps-cli@2.0.10"
# ponytail: a fork changes this one line (CI derives the image name from the repository); derive
# it from `git remote` if forks matter
IMAGE = "ghcr.io/eliask93/gleisatlas-api"
MANIFEST_TYPES = ",".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)
DEPLOY_STEPS = 13
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
    # No child needs the collector's key: npm and the npx package tree must not see it.
    full_env = {k: v for k, v in os.environ.items() if k not in DB_ENV} | (env or {})
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


def image_ready(image: str, tag: str) -> bool:
    """True when `image:tag` is on GHCR and pullable without credentials (so public): an anonymous
    pull token, then the manifest. Any error, missing token or status but 200 is False."""
    path = image.removeprefix("ghcr.io/")
    try:
        with urllib.request.urlopen(
            f"https://ghcr.io/token?scope=repository:{path}:pull", timeout=30
        ) as r:
            token = json.load(r)["token"]
        head = urllib.request.Request(
            f"https://ghcr.io/v2/{path}/manifests/{tag}",
            method="HEAD",
            headers={"Authorization": f"Bearer {token}", "Accept": MANIFEST_TYPES},
        )
        with urllib.request.urlopen(head, timeout=30) as r:
            return r.status == 200
    except (OSError, ValueError, KeyError, TypeError):  # HTTPError is an OSError
        return False


def account() -> None:
    info = json.loads(run([AZ, "account", "show", "--output", "json"], capture=True))
    print(f"subscription: {info['name']}")


def personal(name: str, prompt: str) -> str:
    return os.environ.get(name) or input(f"{prompt} (or set {name}): ").strip()


def db_key() -> dict[str, str]:
    """The collector job's DB key as Bicep parameters, from the environment or a hidden prompt;
    empty when not given (the job is skipped)."""

    def ask(name: str, prompt: str) -> str:
        return os.environ.get(name, "").strip() or getpass.getpass(f"{prompt}: ").strip()

    client_id = ask("DB_CLIENT_ID", "DB API client ID for the collector job (hidden, empty skips)")
    key = client_id and ask("DB_API_KEY", "DB API key (hidden)")
    return {"dbClientId": client_id, "dbApiKey": key} if key else {}


@contextmanager
def parameters_file(values: dict[str, str]) -> Iterator[list[str]]:
    """`--parameters` arguments for secret or personal values: a temporary parameters file, so they
    are never on a command line or in the output; the file is deleted afterwards, also on a
    failure."""
    # in the user's temp folder (its ACL on Windows, mode 0600 elsewhere)
    fd, path = tempfile.mkstemp(prefix="gleisatlas-secure-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
                    "contentVersion": "1.0.0.0",
                    "parameters": {k: {"value": v} for k, v in values.items()},
                },
                f,
            )
        yield [f"@{path}"]
    finally:
        os.remove(path)


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
        die(
            "the working tree is not clean: commit first. The image is CI's build of the pushed "
            "commit, while Bicep and the frontend come from the working tree, so all three must "
            "be the same commit"
        )
    tag = run(["git", "rev-parse", "HEAD"], capture=True)
    if not image_ready(IMAGE, tag):
        die(
            f"the image {IMAGE}:{tag} is not on GHCR, not public, or GHCR could not be reached.\n"
            "Push HEAD and wait for the CI job `image`. If the image exists but is private, set "
            "the package to public (GitHub, Packages, gleisatlas-api, Package settings, "
            "Change visibility)."
        )
    check_data()
    email = personal("GLEISATLAS_BUDGET_EMAIL", "E-mail address for the budget alerts")
    amount = personal("GLEISATLAS_BUDGET_AMOUNT", "Monthly budget, a whole number")
    if "@" not in email or not amount.isdigit():
        die("budget e-mail needs an @, budget amount must be a whole number")
    db = db_key()
    print(
        "collector job: with the DB key"
        if db
        else "collector job: no DB key given (an existing job keeps its image and key)"
    )

    step(2, total, "Register the resource providers")
    for ns in PROVIDERS:
        run([AZ, "provider", "register", "--namespace", ns, "--wait"])

    step(3, total, f"Create the resource group in {LOCATION}")
    run([AZ, "group", "create", "--name", GROUP, "--location", LOCATION, "--output", "none"])

    step(4, total, "Phase 1: everything except the Container App")
    print("COST: from here storage and logs are billed by use (a few cents) until teardown")
    last = probe(
        [AZ, "deployment", "group", "show", "--resource-group", GROUP, "--name", "main"]
        + ["--query", "properties.parameters.budgetStartDate.value", "--output", "tsv"]
    )
    params = [f"budgetAmount={amount}", f"budgetStartDate={budget_start(last, date.today())}"]

    def deployment(secure: dict[str, str], extra: list[str]) -> None:
        with parameters_file({"budgetEmail": email, **secure}) as files:
            run(
                [AZ, "deployment", "group", "create", "--resource-group", GROUP]
                + ["--template-file", "infra/main.bicep", "--output", "none"]
                + ["--parameters", *params, *files, *extra]
            )

    deployment({}, [])

    step(5, total, "Read the deployment outputs")
    out = outputs()
    storage = out["storageName"]
    print(f"storage {storage}, web {out['webName']}")

    step(6, total, "Upload the data files")
    upload_data(storage)

    step(7, total, "Check the blob access: a file is public, the listing is not")
    base = f"https://{storage}.blob.core.windows.net/data"
    if (code := status(f"{base}/monate.parquet", "HEAD")) != 200:
        die(f"{base}/monate.parquet answered {code}, expected 200")
    if (code := status(f"{base}?restype=container&comp=list")) != 404:
        die(f"the container listing answered {code}, expected 404 (it must stay private)")
    print("blob 200, listing 404")

    step(8, total, "Phase 2: add the Container App and the collector job")
    print("COST: the Container App is billed only while a replica runs (scales to zero when idle)")
    if db:
        print("COST: the collector job runs every 15 minutes, billed per second of each run")
    deployment(db, [f"image={IMAGE}:{tag}"])

    step(9, total, "Wait for the API's cold start")
    api_url = outputs()["apiUrl"]
    started = time.monotonic()
    while status(f"{api_url}/datenstand") != 200:
        if time.monotonic() - started > 180:
            die(f"{api_url}/datenstand did not answer 200 within 3 minutes")
        time.sleep(5)
    print(f"{api_url}/datenstand answered 200 after {time.monotonic() - started:.0f} s")

    step(10, total, "Build the frontend")
    run([NPM, "--prefix", "frontend", "run", "build"], env={"VITE_API_URL": api_url})

    step(11, total, "Narrow the CSP in the built copy to the API's host")
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

    step(12, total, "Upload the frontend to Static Web Apps")
    token = run(
        [AZ, "staticwebapp", "secrets", "list", "--name", out["webName"]]
        + ["--resource-group", GROUP, "--query", "properties.apiKey", "--output", "tsv"],
        capture=True,
    )
    run(
        [NPX, "--yes", SWA_CLI, "deploy", "frontend/dist", "--env", "production"],
        env={"SWA_CLI_DEPLOYMENT_TOKEN": token},  # environment only, never on the command line
    )

    step(13, total, "Done")
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
    sub.add_parser("deploy", help="deploy everything, 13 steps (starts billing, see COST lines)")
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
