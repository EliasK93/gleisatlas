import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from backend import main
from scripts import azure
from scripts.azure import DATA_FILES, budget_start, narrow_csp

WILDCARD = "https://*.swedencentral.azurecontainerapps.io"
ORIGIN = "https://gleisatlas-api.example.swedencentral.azurecontainerapps.io"


def config(csp: str) -> str:
    return json.dumps(
        {
            "routes": [{"route": "/assets/*"}],
            "globalHeaders": {"Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff"},
        },
        indent=2,
    )


def test_narrow_csp_swaps_the_wildcard_for_the_origin_and_keeps_the_rest():
    csp = f"default-src 'self'; connect-src 'self' {WILDCARD} https://tiles.openfreemap.org"
    out = json.loads(narrow_csp(config(csp), ORIGIN))
    assert out == json.loads(config(csp.replace(WILDCARD, ORIGIN)))


@pytest.mark.parametrize("csp", ["default-src 'self'", f"connect-src {WILDCARD} {WILDCARD}"])
def test_narrow_csp_refuses_a_wildcard_that_is_missing_or_repeated(csp: str):
    with pytest.raises(ValueError, match="wildcard"):
        narrow_csp(config(csp), ORIGIN)


def test_budget_start_reuses_the_date_of_the_last_deployment():
    assert budget_start("2026-08-01", date(2026, 10, 29)) == "2026-08-01"


@pytest.mark.parametrize("existing", [None, "", "None", "garbage"])
def test_budget_start_is_the_first_of_this_month_without_a_usable_date(existing: str | None):
    assert budget_start(existing, date(2026, 10, 29)) == "2026-10-01"


@pytest.fixture
def az_calls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """Every command the script runs, with az answered by stand-ins and the data in tmp_path."""
    calls: list[list[str]] = []

    def run(cmd: list[str], **_: object) -> str:
        calls.append(cmd)
        if cmd[1:3] == ["account", "show"]:
            return json.dumps({"name": "sub", "user": {"name": "user"}})
        if cmd[1:4] == ["deployment", "group", "show"]:
            return json.dumps({"storageName": {"value": "gleisatlasdata"}})
        return ""

    monkeypatch.setattr(azure, "run", run)
    monkeypatch.setattr(azure, "ROOT", tmp_path)
    (tmp_path / "data").mkdir()
    for f in DATA_FILES:
        (tmp_path / "data" / f"{f}.parquet").write_bytes(b"")
    return calls


def uploads(calls: list[list[str]]) -> list[str]:
    return [c[c.index("--name") + 1] for c in calls if c[1:4] == ["storage", "blob", "upload"]]


def test_the_uploaded_files_are_the_ones_the_api_downloads():
    assert sorted(DATA_FILES) == sorted(Path(p).stem for p in main.DATA_FILES)


def test_data_uploads_exactly_the_data_files_and_nothing_else(az_calls: list[list[str]]):
    assert azure.main(["data"]) == 0
    assert uploads(az_calls) == [f"{f}.parquet" for f in DATA_FILES]
    for cmd in az_calls:
        assert cmd[0] == azure.AZ
        assert cmd[1:3] != ["acr", "build"]
        assert cmd[1:4] != ["deployment", "group", "create"]
        assert "staticwebapp" not in cmd


def test_data_leaves_the_collectors_files_alone(az_calls: list[list[str]], tmp_path: Path):
    data = tmp_path / "data"
    for name in ("heute.parquet", "live_tage.parquet", "live/2026-11-03/plan.parquet"):
        (data / name).parent.mkdir(parents=True, exist_ok=True)
        (data / name).write_bytes(b"")
    assert azure.main(["data"]) == 0
    assert not {"heute.parquet", "live_tage.parquet"} & set(uploads(az_calls))
    assert not [u for u in uploads(az_calls) if u.startswith("live")]


DB_CLIENT, DB_KEY = "fake-db-client", "fake-db-key-never-shown"
OUTPUTS = {
    "storageName": "gleisatlasdata",
    "registryName": "gleisatlasacr",
    "registryServer": "gleisatlasacr.azurecr.io",
    "webName": "gleisatlas-web",
    "webHostname": "web.example.azurestaticapps.net",
    "apiUrl": ORIGIN,
}


@pytest.fixture
def deploy_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """`deploy` with every command answered by stand-ins; returns the commands and, per command,
    the contents of the parameters files it names (read while they exist)."""
    calls: list[list[str]] = []
    files: list[str] = []

    def run(cmd: list[str], **_: object) -> str:
        calls.append(cmd)
        files.extend(Path(p).read_text(encoding="utf-8") for p in parameter_files(cmd))
        if cmd[1:3] == ["account", "show"]:
            return json.dumps({"name": "sub", "user": {"name": "user"}})
        if cmd[1:4] == ["deployment", "group", "show"]:
            return json.dumps({k: {"value": v} for k, v in OUTPUTS.items()})
        if cmd[1:3] == ["rev-parse", "--short"]:
            return "abc1234"
        if cmd[2:5] == ["frontend", "run", "build"]:
            dist = tmp_path / "frontend" / "dist"
            dist.mkdir(parents=True, exist_ok=True)
            (dist / "staticwebapp.config.json").write_text(config(f"connect-src {WILDCARD}"))
        return ""

    monkeypatch.setattr(azure, "run", run)
    monkeypatch.setattr(azure, "probe", lambda cmd: "" if cmd[1:3] == ["account", "show"] else None)
    monkeypatch.setattr(
        azure, "status", lambda url, method="GET": 404 if "comp=list" in url else 200
    )
    monkeypatch.setattr(azure.shutil, "which", lambda tool: tool)
    monkeypatch.setattr(azure, "ROOT", tmp_path)
    monkeypatch.setenv("GLEISATLAS_BUDGET_EMAIL", "budget@example.org")
    monkeypatch.setenv("GLEISATLAS_BUDGET_AMOUNT", "5")
    (tmp_path / "data").mkdir()
    for f in DATA_FILES:
        (tmp_path / "data" / f"{f}.parquet").write_bytes(b"")
    return calls, files


def deployments(calls: list[list[str]]) -> list[list[str]]:
    return [c for c in calls if c[1:4] == ["deployment", "group", "create"]]


def parameter_files(cmd: list[str]) -> list[str]:
    """The paths a deployment names as `@file` parameters."""
    if cmd[1:4] != ["deployment", "group", "create"]:
        return []
    return [a[1:] for a in cmd if a.startswith("@")]


def test_deploy_hands_the_db_key_to_az_in_a_parameters_file_that_is_deleted(
    deploy_run, monkeypatch, capsys
):
    calls, files = deploy_run
    monkeypatch.setenv("DB_CLIENT_ID", DB_CLIENT)
    monkeypatch.setenv("DB_API_KEY", DB_KEY)
    assert azure.main(["deploy"]) == 0
    first, second = deployments(calls)
    named = parameter_files(second)
    assert len(named) == 1 and not parameter_files(first)  # phase 2 only
    assert json.loads(files[0])["parameters"] == {
        "dbClientId": {"value": DB_CLIENT},
        "dbApiKey": {"value": DB_KEY},
    }
    assert not Path(named[0]).exists()
    assert not [c for c in calls if any(DB_KEY in a or DB_CLIENT in a for a in c)]
    out = capsys.readouterr()
    assert DB_KEY not in out.out + out.err


def test_deploy_asks_for_the_db_key_hidden_and_skips_the_job_without_it(
    deploy_run, monkeypatch, capsys
):
    calls, files = deploy_run
    monkeypatch.delenv("DB_CLIENT_ID", raising=False)
    monkeypatch.delenv("DB_API_KEY", raising=False)
    asked: list[str] = []
    monkeypatch.setattr(azure.getpass, "getpass", lambda prompt: (asked.append(prompt), "")[1])
    assert azure.main(["deploy"]) == 0
    assert len(asked) == 1  # no client id: the key is not asked for
    assert files == []
    assert not [p for c in calls for p in parameter_files(c)]
    assert "collector job: no DB key given" in capsys.readouterr().out


def test_the_parameters_file_is_deleted_when_the_deployment_fails(deploy_run, monkeypatch):
    monkeypatch.setenv("DB_CLIENT_ID", DB_CLIENT)
    monkeypatch.setenv("DB_API_KEY", DB_KEY)
    real = azure.run
    named: list[str] = []

    def failing(cmd: list[str], **kw: Any) -> str:
        if parameter_files(cmd):
            named.extend(parameter_files(cmd))
            raise SystemExit(1)  # what `die` does
        return real(cmd, **kw)

    monkeypatch.setattr(azure, "run", failing)
    with pytest.raises(SystemExit):
        azure.main(["deploy"])
    assert named and not Path(named[0]).exists()


def test_data_stops_before_any_upload_when_a_file_is_missing(
    az_calls: list[list[str]], tmp_path: Path
):
    (tmp_path / "data" / "tage.parquet").unlink()
    with pytest.raises(SystemExit) as stop:
        azure.main(["data"])
    assert stop.value.code == 1
    assert uploads(az_calls) == []
