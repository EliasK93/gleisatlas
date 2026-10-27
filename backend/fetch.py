"""Download the API's data files at container start: `python -m backend.fetch`.

DATA_URL is a base URL ending in `/`; each file comes from DATA_URL + its file name. Without
DATA_URL nothing happens (local runs read `data/` directly)."""

import os
import shutil
import sys
import urllib.request

from backend import main as api

TIMEOUT = 60  # seconds per connection read


def main() -> None:
    base = os.environ.get("DATA_URL")
    if not base:
        return
    for path in api.DATA_FILES:
        name = os.path.basename(path)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        part = path + ".part"  # a half-written file never sits under the real name
        try:
            with (
                urllib.request.urlopen(base + name, timeout=TIMEOUT) as src,
                open(part, "wb") as dst,
            ):
                shutil.copyfileobj(src, dst)
                # a connection that closes early ends the copy without an error
                if dst.tell() != int(src.headers.get("Content-Length", dst.tell())):
                    raise OSError("incomplete")
        except OSError as e:
            sys.exit(f"download failed: {name}: {e}")
        os.replace(part, path)


if __name__ == "__main__":
    main()
