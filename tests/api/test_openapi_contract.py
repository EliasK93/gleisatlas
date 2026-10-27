import json
from pathlib import Path

from backend.main import app


def test_openapi_json_matches_app():
    path = Path(__file__).parents[2] / "backend" / "openapi.json"
    committed = json.loads(path.read_text("utf-8"))
    assert committed == app.openapi(), "regenerate backend/openapi.json (see CLAUDE.md)"
