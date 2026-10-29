import json
from datetime import date

import pytest

from scripts.azure import budget_start, narrow_csp

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
