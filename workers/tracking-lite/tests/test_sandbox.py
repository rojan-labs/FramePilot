"""The worker's own half of the isolation contract."""

from __future__ import annotations

import os
import socket

import pytest

from framepilot_tracking_lite.sandbox import (
    NetworkDisabledError,
    configure_determinism,
    disable_network,
)


@pytest.fixture(autouse=True)
def restore_socket_module(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the process-wide patch from leaking into other tests."""
    for attribute in ("socket", "create_connection", "create_server"):
        monkeypatch.setattr(socket, attribute, getattr(socket, attribute))


def test_media_cannot_leave_the_machine_once_the_worker_starts() -> None:
    disable_network()
    with pytest.raises(NetworkDisabledError):
        socket.socket()
    with pytest.raises(NetworkDisabledError):
        socket.create_connection(("example.invalid", 443))


def test_determinism_pins_thread_counts_and_seeds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    configure_determinism()
    assert os.environ["OMP_NUM_THREADS"] == "1"
    assert os.environ["OPENBLAS_NUM_THREADS"] == "1"
