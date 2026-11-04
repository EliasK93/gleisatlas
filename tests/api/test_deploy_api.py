import importlib
import logging
import math
import os
from email.utils import formatdate, parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import pytest
from fastapi.testclient import TestClient

from backend import fetch, main


@pytest.fixture
def reloaded(monkeypatch):
    """Rebuild the app after an environment change; the original app is rebuilt afterwards."""

    def reload() -> TestClient:
        return TestClient(importlib.reload(main).app)

    yield reload
    monkeypatch.undo()
    importlib.reload(main)


def allowed(client: TestClient, origin: str) -> str | None:
    # An unknown route: CORS headers are added to the 404 too, and no data file is read.
    return client.get("/nope", headers={"Origin": origin}).headers.get(
        "access-control-allow-origin"
    )


@pytest.mark.parametrize("path", ["/docs", "/redoc"])
def test_the_api_browsers_are_off(client: TestClient, path: str):
    assert client.get(path).status_code == 404


def test_cors_defaults_to_the_local_dev_server(client: TestClient):
    assert allowed(client, "http://localhost:5317") == "http://localhost:5317"
    assert allowed(client, "http://localhost:5173") is None
    assert allowed(client, "https://example.org") is None


def test_cors_origins_come_from_the_environment(monkeypatch, reloaded):
    monkeypatch.setenv("CORS_ORIGINS", " https://a.example.org , ,https://b.example.org ")
    other = reloaded()
    assert allowed(other, "https://a.example.org") == "https://a.example.org"
    assert allowed(other, "https://b.example.org") == "https://b.example.org"
    assert allowed(other, "http://localhost:5317") is None


def test_a_request_logs_one_start_and_one_end_line_with_the_same_id(
    client: TestClient, caplog: pytest.LogCaptureFixture
):
    with caplog.at_level(logging.INFO, logger="gleisatlas"):
        client.get("/stationen", params={"q": "alp"})
    start, end = [r.getMessage() for r in caplog.records if r.name == "gleisatlas"]
    start_parts, end_parts = start.split(" "), end.split(" ")
    assert start_parts[0] == "start" and end_parts[0] == "end"
    assert start_parts[1] == end_parts[1]
    assert start_parts[2:] == ["GET", "/stationen?q=alp"]
    assert end_parts[2] == "200" and end_parts[3].endswith("ms")
    assert "testclient" not in start + end


def test_a_path_cannot_forge_a_log_line(client: TestClient, caplog: pytest.LogCaptureFixture):
    # Decoded: a line break and a made-up end line (the URL parser drops a decoded \n, not these).
    forged = "/x%0Bend%20abcd1234%20200%201ms%E2%80%A8end%20abcd1234%20200%201ms"
    with caplog.at_level(logging.INFO, logger="gleisatlas"):
        client.get(forged)
    start, end = [r.getMessage() for r in caplog.records if r.name == "gleisatlas"]
    assert len((start + "\n" + end).splitlines()) == 2
    assert start.split(" ")[2:] == ["GET", forged]


def test_a_failing_request_still_logs_its_end_line(
    client: TestClient, caplog: pytest.LogCaptureFixture, monkeypatch
):
    def boom():
        raise RuntimeError("boom")

    monkeypatch.setattr(main, "named_stations", boom)
    with caplog.at_level(logging.INFO, logger="gleisatlas"):
        with pytest.raises(RuntimeError):
            client.get("/stationen")
    start, end = [r.getMessage() for r in caplog.records if r.name == "gleisatlas"]
    assert end.startswith(f"end {start.split(' ')[1]} 500 ")


def test_the_log_file_gets_timestamped_lines_and_is_detached_again(monkeypatch, reloaded, tmp_path):
    path = tmp_path / "logs" / "api.log"  # the parent directory does not exist yet
    monkeypatch.setenv("LOG_FILE", str(path))
    reloaded().get("/nope")
    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    start, end = (line.split(" ", 2)[2].split(" ") for line in lines)  # after "date time"
    assert start[0] == "start" and end[0] == "end" and start[1] == end[1]
    monkeypatch.delenv("LOG_FILE")
    reloaded()
    assert not [h for h in main.log.handlers if isinstance(h, logging.FileHandler)]


DATA_NAMES = ("a.parquet", "b.parquet", "c.parquet", "d.parquet", "e.parquet")


@pytest.fixture
def remote(tmp_path, monkeypatch):
    """Five source files in a directory addressed by a file:// URL; returns (url, target paths)."""
    src = tmp_path / "src"
    src.mkdir()
    for name in DATA_NAMES:
        (src / name).write_bytes(name.encode() * 1000)
    targets = tuple(str(tmp_path / "data" / name) for name in DATA_NAMES)
    monkeypatch.setattr(main, "DATA_FILES", targets)
    # the live files are optional: this source has none, and a real data/ is never touched
    monkeypatch.setattr(main, "HEUTE_PATH", str(tmp_path / "data" / "heute.parquet"))
    monkeypatch.setattr(main, "LIVE_TAGE_PATH", str(tmp_path / "data" / "live_tage.parquet"))
    return src.as_uri() + "/", targets


def test_fetch_downloads_every_file_with_the_same_bytes(remote, monkeypatch, tmp_path):
    url, targets = remote
    monkeypatch.setenv("DATA_URL", url)
    fetch.main()
    for path, name in zip(targets, DATA_NAMES, strict=True):
        assert open(path, "rb").read() == name.encode() * 1000
    assert sorted(p.name for p in (tmp_path / "data").iterdir()) == sorted(DATA_NAMES)


def test_fetch_names_the_file_that_cannot_be_downloaded(remote, monkeypatch, tmp_path):
    url, targets = remote
    (tmp_path / "src" / "c.parquet").unlink()
    monkeypatch.setenv("DATA_URL", url)
    with pytest.raises(SystemExit) as stop:
        fetch.main()
    assert "c.parquet" in str(stop.value)


def test_fetch_rejects_a_download_that_ends_early(remote, monkeypatch, tmp_path):
    _, targets = remote

    class Truncating(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "1000")
            self.end_headers()
            self.wfile.write(b"x" * 10)  # then the connection closes

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Truncating)
    Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("DATA_URL", f"http://127.0.0.1:{server.server_port}/")
    try:
        with pytest.raises(SystemExit) as stop:
            fetch.main()
    finally:
        server.shutdown()
        server.server_close()
    assert "a.parquet" in str(stop.value)
    assert not os.path.exists(targets[0])


def test_fetch_does_nothing_without_a_data_url(remote, monkeypatch, tmp_path):
    monkeypatch.delenv("DATA_URL", raising=False)
    fetch.main()
    assert not (tmp_path / "data").exists()


def test_every_file_the_day_views_need_is_downloaded():
    names = {os.path.basename(p) for p in main.DATA_FILES}
    assert {"day_hours.parquet", "large.parquet", "days.parquet", "tage.parquet"} <= names
    assert not names & {"heute.parquet", "live_tage.parquet", "heute_rest.parquet"}


HEUTE, LIVE_TAGE = "heute.parquet", "live_tage.parquet"
STAMP = 1_780_000_000  # the blob's modified time (an epoch second)


class Blob:
    """A blob container over HTTP: Last-Modified, If-Modified-Since, 404 for a missing name."""

    def __init__(self, data):
        self.data = data  # the API's data folder
        self.clock = [1000.0]  # the monotonic clock of the refresh
        self.files: dict[str, tuple[bytes, int]] = {}  # name -> (content, modified)
        self.requests: list[tuple[str, str | None]] = []  # (name, If-Modified-Since)
        self.broken: set[str] = set()  # answered with 500
        self.truncated: set[str] = set()  # the connection closes after 10 bytes

    def handler(self) -> type[BaseHTTPRequestHandler]:
        store = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                name = self.path.lstrip("/")
                since = self.headers.get("If-Modified-Since")
                store.requests.append((name, since))
                body, stamp = store.files.get(name, (b"", 0))
                if name in store.broken:
                    self.send_response(500)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif name not in store.files:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif since and parsedate_to_datetime(since).timestamp() >= stamp:
                    self.send_response(304)
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.send_header("Last-Modified", formatdate(stamp, usegmt=True))
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body[:10] if name in store.truncated else body)

            def log_message(self, *args):
                pass

        return Handler

    def names(self) -> list[str]:
        return [name for name, _ in self.requests]

    def put(self, name: str, content: bytes, stamp: int = STAMP) -> None:
        self.files[name] = (content, stamp)

    def paths(self) -> tuple[str, str]:
        return str(self.data / HEUTE), str(self.data / LIVE_TAGE)


@pytest.fixture
def blob(tmp_path, monkeypatch):
    store = Blob(tmp_path / "data")
    server = HTTPServer(("127.0.0.1", 0), store.handler())
    Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("DATA_URL", f"http://127.0.0.1:{server.server_port}/")
    monkeypatch.setattr(main, "DATA_FILES", ())
    monkeypatch.setattr(main, "HEUTE_PATH", store.paths()[0])
    monkeypatch.setattr(main, "LIVE_TAGE_PATH", store.paths()[1])
    monkeypatch.setattr(fetch, "_clock", lambda: store.clock[0])
    monkeypatch.setattr(fetch, "_checked", -math.inf)
    yield store
    server.shutdown()
    server.server_close()


def test_the_live_files_are_downloaded_at_start_with_the_blobs_modified_time(blob):
    blob.put(HEUTE, b"h" * 500)
    blob.put(LIVE_TAGE, b"l" * 700)
    fetch.main()
    heute, live_tage = blob.paths()
    assert open(heute, "rb").read() == b"h" * 500
    assert open(live_tage, "rb").read() == b"l" * 700
    assert os.stat(heute).st_mtime == STAMP  # what the next check sends as If-Modified-Since
    assert sorted(p.name for p in blob.data.iterdir()) == [HEUTE, LIVE_TAGE]


def test_a_404_for_a_live_file_means_none_and_removes_an_old_copy(blob):
    blob.put(LIVE_TAGE, b"l" * 10)
    blob.data.mkdir()
    (blob.data / HEUTE).write_bytes(b"yesterday")
    fetch.main()  # no SystemExit: the collector may not have run yet
    assert sorted(p.name for p in blob.data.iterdir()) == [LIVE_TAGE]


def test_a_changed_live_file_is_downloaded_again_and_an_unchanged_one_is_not(blob):
    blob.put(HEUTE, b"first")
    blob.put(LIVE_TAGE, b"days")
    fetch.main()
    blob.requests.clear()
    blob.clock[0] += 61
    blob.put(HEUTE, b"second!", STAMP + 900)
    fetch.refresh_live(blob.paths())
    heute, live_tage = blob.paths()
    assert open(heute, "rb").read() == b"second!"
    assert os.stat(heute).st_mtime == STAMP + 900
    assert open(live_tage, "rb").read() == b"days"
    assert os.stat(live_tage).st_mtime == STAMP  # a 304: not rewritten
    assert sorted(blob.names()) == [HEUTE, LIVE_TAGE]
    since = dict(blob.requests)
    assert parsedate_to_datetime(since[HEUTE] or "").timestamp() == STAMP  # conditional
    assert sorted(p.name for p in blob.data.iterdir()) == [HEUTE, LIVE_TAGE]  # no .part left


def test_the_live_files_are_checked_at_most_once_a_minute(blob):
    blob.put(HEUTE, b"h")
    blob.put(LIVE_TAGE, b"l")
    fetch.refresh_live(blob.paths())
    assert len(blob.requests) == 2
    blob.clock[0] += 59
    fetch.refresh_live(blob.paths())
    assert len(blob.requests) == 2
    blob.clock[0] += 1
    fetch.refresh_live(blob.paths())
    assert len(blob.requests) == 4


def test_a_file_that_vanished_from_the_blob_is_removed_by_a_refresh(blob):
    blob.put(HEUTE, b"h")
    blob.put(LIVE_TAGE, b"l")
    fetch.refresh_live(blob.paths())
    del blob.files[HEUTE]
    blob.clock[0] += 60
    fetch.refresh_live(blob.paths())
    assert [p.name for p in blob.data.iterdir()] == [LIVE_TAGE]


@pytest.mark.parametrize("failure", ["broken", "truncated"])
def test_a_failed_refresh_keeps_the_old_file_logs_one_line_and_retries_later(
    blob, caplog: pytest.LogCaptureFixture, failure: str
):
    blob.put(HEUTE, b"first!!!!!")
    blob.put(LIVE_TAGE, b"days")
    fetch.refresh_live(blob.paths())
    blob.put(HEUTE, b"second" * 10, STAMP + 900)
    getattr(blob, failure).add(HEUTE)
    blob.clock[0] += 60
    with caplog.at_level(logging.INFO, logger="gleisatlas"):
        fetch.refresh_live(blob.paths())
    lines = [r.getMessage() for r in caplog.records if r.name == "gleisatlas"]
    assert len(lines) == 1 and HEUTE in lines[0]
    assert open(blob.paths()[0], "rb").read() == b"first!!!!!"
    assert sorted(p.name for p in blob.data.iterdir()) == [HEUTE, LIVE_TAGE]  # no .part left
    getattr(blob, failure).discard(HEUTE)
    blob.clock[0] += 60
    fetch.refresh_live(blob.paths())
    assert open(blob.paths()[0], "rb").read() == b"second" * 10


def test_two_requests_never_check_at_once(blob, monkeypatch):
    seen: list[str] = []

    def sync(base: str, path: str) -> None:
        seen.append(path)
        fetch.refresh_live(blob.paths())  # a request arriving while this one checks

    monkeypatch.setattr(fetch, "_sync", sync)
    fetch.refresh_live(blob.paths())
    assert seen == list(blob.paths())  # one check of both files, no nested one


def test_without_a_data_url_nothing_is_checked(blob, monkeypatch):
    monkeypatch.delenv("DATA_URL")
    fetch.refresh_live(blob.paths())
    fetch.main()
    assert blob.requests == []
    assert not blob.data.exists()


def test_both_routes_refresh_the_live_files(client: TestClient, monkeypatch):
    asked: list[tuple[str, ...]] = []
    monkeypatch.setattr(fetch, "refresh_live", lambda paths: asked.append(tuple(paths)))
    client.get("/datenstand")
    client.get("/tageskarte", params={"tag": "2026-09-07"})
    assert asked == [(main.HEUTE_PATH, main.LIVE_TAGE_PATH)] * 2
