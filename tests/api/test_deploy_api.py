import importlib
import logging
import os
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
