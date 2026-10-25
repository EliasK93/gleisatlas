import json
from pathlib import Path

from backend.main import app


def test_openapi_json_matches_app():
    committed = json.loads(Path("backend/openapi.json").read_text("utf-8"))
    assert committed == app.openapi(), "regenerate backend/openapi.json (see CLAUDE.md)"
