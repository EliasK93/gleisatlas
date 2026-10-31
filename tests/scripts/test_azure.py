import json
from datetime import date
from pathlib import Path

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


def test_data_stops_before_any_upload_when_a_file_is_missing(
    az_calls: list[list[str]], tmp_path: Path
):
    (tmp_path / "data" / "tage.parquet").unlink()
    with pytest.raises(SystemExit) as stop:
        azure.main(["data"])
    assert stop.value.code == 1
    assert uploads(az_calls) == []
