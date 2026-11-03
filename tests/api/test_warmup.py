import logging
import os
import threading
import time

import pytest
from fastapi.testclient import TestClient

from backend import fetch, main

# Each cached page's default query, in the order the warm-up runs them.
ROUTES = ("karte", "tageskarte", "heatmap", "rankings", "tagesverlauf")


@pytest.fixture
def deployed(client: TestClient, monkeypatch) -> list[tuple[str, tuple, dict]]:
    """The client as on the deploy (DATA_URL set, a fresh process); returns the route calls the
    warm-up makes, each still running the real route."""
    monkeypatch.setenv("DATA_URL", "http://127.0.0.1:9/")
    monkeypatch.setattr(fetch, "refresh_live", lambda paths: None)  # nothing to download here
    monkeypatch.setattr(main, "warming", None)
    monkeypatch.setattr(main, "QUIET", 0.05)  # the tests' visitor is done at once
    called: list[tuple[str, tuple, dict]] = []
    for name in ROUTES:
        real = getattr(main, name)

        def spy(*args, _name=name, _real=real, **kwargs):
            called.append((_name, args, kwargs))
            return _real(*args, **kwargs)

        monkeypatch.setattr(main, name, spy)
    return called


def test_the_first_answered_request_warms_every_page_once_in_the_background(
    client: TestClient, deployed, monkeypatch, caplog: pytest.LogCaptureFixture
):
    release = threading.Event()
    real_karte = main.karte

    def waiting_karte(*args, **kwargs):
        release.wait(10)
        return real_karte(*args, **kwargs)

    monkeypatch.setattr(main, "karte", waiting_karte)
    with caplog.at_level(logging.INFO, logger="gleisatlas"):
        assert client.get("/stationen").status_code == 200  # answered while the warm-up waits
        warming = main.warming
        assert warming is not None and warming.is_alive()
        release.set()
        warming.join(30)
        assert client.get("/stationen").status_code == 200
    assert main.warming is warming  # the second request started no other warm-up
    assert [name for name, _, _ in deployed] == list(ROUTES)
    rankings = next(kw for name, _, kw in deployed if name == "rankings")
    assert rankings == {"typ": "bahnhoefe"}  # the Rankings page's default
    tag = next(kw for name, _, kw in deployed if name == "tageskarte")["tag"]
    assert tag == client.get("/datenstand").json()["letzter_tag"]  # Live-Lage's newest day
    lines = [r.getMessage() for r in caplog.records if r.name == "gleisatlas"]
    assert not [line for line in lines if "failed" in line]
    assert [line for line in lines if line.startswith("warm-up done")]


def test_the_warm_up_lets_the_visitors_next_request_go_first(
    client: TestClient, deployed, monkeypatch
):
    """Live-Lage asks /tageskarte only once /datenstand has answered."""
    monkeypatch.setattr(main, "QUIET", 1.0)
    started: list[float] = []
    real_karte = main.karte  # the warm-up's first page

    def timed_karte(*args, **kwargs):
        started.append(time.monotonic())
        return real_karte(*args, **kwargs)

    monkeypatch.setattr(main, "karte", timed_karte)
    client.get("/datenstand")
    time.sleep(0.5)  # inside the quiet window
    client.get("/tageskarte", params={"tag": "2026-09-07"})
    answered = time.monotonic()
    assert main.warming is not None
    main.warming.join(30)
    assert [name for name, _, _ in deployed] == list(ROUTES)
    # The first page started only a quiet second after the visitor's last answer.
    assert started and started[0] >= answered + 0.5


def test_a_failing_page_is_logged_and_the_others_still_warm(
    client: TestClient, deployed, monkeypatch, caplog: pytest.LogCaptureFixture
):
    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(main, "heatmap", broken)
    with caplog.at_level(logging.INFO, logger="gleisatlas"):
        client.get("/stationen")
        assert main.warming is not None
        main.warming.join(30)
    lines = [r.getMessage() for r in caplog.records if r.name == "gleisatlas"]
    assert "warm-up failed: heatmap: boom" in lines
    assert [name for name, _, _ in deployed] == [n for n in ROUTES if n != "heatmap"]


def test_without_a_data_url_nothing_is_warmed(client: TestClient, deployed, monkeypatch):
    monkeypatch.delenv("DATA_URL")
    client.get("/stationen")
    assert main.warming is None
    assert deployed == []


def test_the_heatmap_is_cached_until_the_aggregate_changes(client: TestClient, monkeypatch):
    computed: list[tuple] = []
    real = main.heatmap_from

    def counting(*args, **kwargs):
        computed.append(args[1:])
        return real(*args, **kwargs)

    monkeypatch.setattr(main, "heatmap_from", counting)
    first = client.get("/heatmap").json()
    assert client.get("/heatmap").json() == first
    assert len(computed) == 1
    client.get("/heatmap", params={"gattung": "fern"})  # other parameters, another entry
    assert len(computed) == 2
    stamp = os.stat(main.AGG_PATH).st_mtime + 10
    os.utime(main.AGG_PATH, (stamp, stamp))  # new data
    assert client.get("/heatmap").json() == first
    assert len(computed) == 3
