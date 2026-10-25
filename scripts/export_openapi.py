"""Write the API schema to backend/openapi.json, the source of the generated TS client.

Run after changing a route or model: `uv run python scripts/export_openapi.py`.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.main import app  # noqa: E402

if __name__ == "__main__":
    out = ROOT / "backend" / "openapi.json"
    out.write_text(json.dumps(app.openapi(), indent=1) + "\n", encoding="utf-8", newline="\n")
