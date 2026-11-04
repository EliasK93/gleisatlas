"""Download the API's data files at container start: `python -m backend.fetch`, and keep the
collector's two files current while the API runs.

DATA_URL is a base URL ending in `/`; each file comes from DATA_URL + its file name. Without
DATA_URL nothing happens (local runs read `data/` directly).

The files of `DATA_FILES` must come, or the start fails. The collector's files (`heute.parquet`,
`live_tage.parquet`) are optional: a 404 means "none" and removes an old copy, any other failure
keeps the old copy. `refresh_live` checks them again at most once a minute with a conditional GET:
the downloaded file gets the blob's Last-Modified as its modified time, which is also what the next
check sends as If-Modified-Since (so a restarted process needs no memory of the last check)."""

import logging
import math
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from email.utils import formatdate, parsedate_to_datetime
from http.client import HTTPException

TIMEOUT = 60  # seconds per connection read at start
REFRESH_TIMEOUT = 10  # a request waits for no longer than this for a refresh
COOLDOWN = 60  # seconds between two checks of the live files

log = logging.getLogger("gleisatlas")
_lock = threading.Lock()
_checked = -math.inf  # _clock() of the last check
_clock = time.monotonic  # replaced in tests


def _copy(src, path: str) -> None:
    """Write the response to `path` via a `.part` file, modified time = the blob's."""
    part = path + ".part"  # a half-written file never sits under the real name
    try:
        with open(part, "wb") as dst:
            shutil.copyfileobj(src, dst)
            # a connection that closes early ends the copy without an error
            if dst.tell() != int(src.headers.get("Content-Length", dst.tell())):
                raise OSError("incomplete")
        if modified := src.headers.get("Last-Modified"):
            stamp = parsedate_to_datetime(modified).timestamp()
            os.utime(part, (stamp, stamp))
        os.replace(part, path)
    finally:
        if os.path.exists(part):
            os.remove(part)


def _sync(base: str, path: str) -> None:
    """Bring the optional file at `path` up to date with DATA_URL + its name. Raises OSError (or
    an HTTP error) when the blob cannot be read."""
    name = os.path.basename(path)
    req = urllib.request.Request(base + name)
    if os.path.exists(path):
        req.add_header("If-Modified-Since", formatdate(os.stat(path).st_mtime, usegmt=True))
    try:
        with urllib.request.urlopen(req, timeout=REFRESH_TIMEOUT) as src:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            _copy(src, path)
    except urllib.error.HTTPError as e:
        if e.code == 404 and os.path.exists(path):
            os.remove(path)  # the collector's file is gone: so is today
        elif e.code not in (304, 404):
            raise


def _sync_all(base: str, paths: Iterable[str]) -> None:
    for path in paths:
        try:
            _sync(base, path)
        except (OSError, HTTPException, ValueError) as e:
            log.info("refresh failed: %s: %s", os.path.basename(path), e)


def refresh_live(paths: Iterable[str]) -> None:
    """Check the optional files again unless a check ran in the last COOLDOWN seconds or another
    request is checking right now (that one's answer serves both). A failure keeps the old files
    and logs one line per file."""
    global _checked
    base = os.environ.get("DATA_URL")
    if not base or not _lock.acquire(blocking=False):
        return
    try:
        if _clock() - _checked >= COOLDOWN:
            _checked = _clock()  # a failed check counts: no hammering of a blob that is down
            _sync_all(base, paths)
    finally:
        _lock.release()


def main() -> None:
    # ponytail: every start downloads all files, checked only by their length (no checksum or ETag),
    # and imports backend.main (FastAPI and Polars, a second or two) for the path list; compare a
    # checksum if a damaged download ever shows.
    from backend import main as api  # here: backend.main imports this module

    base = os.environ.get("DATA_URL")
    if not base:
        return
    for path in api.DATA_FILES:
        name = os.path.basename(path)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        try:
            with urllib.request.urlopen(base + name, timeout=TIMEOUT) as src:
                _copy(src, path)
        except OSError as e:
            sys.exit(f"download failed: {name}: {e}")
    _sync_all(base, (api.HEUTE_PATH, api.LIVE_TAGE_PATH))


if __name__ == "__main__":
    main()
