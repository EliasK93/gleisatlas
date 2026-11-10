"""Install the pre-commit hook that runs the gate. Overwrites it."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOOK = "#!/bin/sh\nexec uv run python scripts/gate.py --hook\n"


def main() -> None:
    out = subprocess.run(
        ["git", "rev-parse", "--git-path", "hooks"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    hooks = Path(out) if Path(out).is_absolute() else ROOT / out
    hooks.mkdir(parents=True, exist_ok=True)
    hook = hooks / "pre-commit"
    hook.write_bytes(HOOK.encode("utf-8"))
    hook.chmod(0o755)
    print(f"installed {hook}")


if __name__ == "__main__":
    main()
