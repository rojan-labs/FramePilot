"""Self-restriction and the pure geometry the wire format depends on."""

from __future__ import annotations

import os
import socket

import pytest

from framepilot_subject_intelligence.geometry import (
    clamp,
    contains,
    decode_run_lengths,
    encode_run_lengths,
    normalize_box,
    point_in_pixels,
    to_pixel_box,
)
from framepilot_subject_intelligence.protocol import NormalizedBox, NormalizedPoint
from framepilot_subject_intelligence.sandbox import (
    NetworkDisabledError,
    configure_determinism,
    disable_network,
)


def test_the_worker_cannot_open_a_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    """This pack runs models over people's faces; it must not be able to phone home."""
    monkeypatch.setattr(socket, "socket", socket.socket, raising=False)
    monkeypatch.setattr(socket, "create_connection", socket.create_connection, raising=False)
    monkeypatch.setattr(socket, "create_server", socket.create_server, raising=False)

    disable_network()

    with pytest.raises(NetworkDisabledError):
        socket.socket()
    with pytest.raises(NetworkDisabledError):
        socket.create_connection(("127.0.0.1", 9))


def test_determinism_pins_the_thread_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)

    configure_determinism()

    assert os.environ["OMP_NUM_THREADS"] == "1"


def test_a_run_length_round_trip_survives_every_shape() -> None:
    for values in (
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [0, 1, 0, 1],
        [1, 0, 0, 1, 1, 1],
    ):
        counts = encode_run_lengths(values)
        assert decode_run_lengths(counts, len(values)) == tuple(values)


def test_run_lengths_always_start_with_the_zero_run() -> None:
    # Without the leading zero a mask beginning in foreground decodes inverted.
    assert encode_run_lengths([1, 1, 0])[0] == 0
    assert encode_run_lengths([0, 1, 1])[0] == 1


def test_decoding_the_wrong_length_is_an_error() -> None:
    with pytest.raises(ValueError, match="run lengths cover"):
        decode_run_lengths((0, 2), 5)


def test_a_box_is_clipped_into_the_frame() -> None:
    box = normalize_box((-20.0, -20.0, 200.0, 200.0), 100, 100)

    assert box.x == 0.0
    assert box.y == 0.0
    assert box.x + box.width <= 1.0


def test_pixel_and_normalized_boxes_round_trip() -> None:
    original = NormalizedBox(x=0.25, y=0.5, width=0.25, height=0.25)

    pixels = to_pixel_box(original, 800, 400)
    restored = normalize_box(pixels, 800, 400)

    assert restored.x == pytest.approx(original.x)
    assert restored.height == pytest.approx(original.height)


def test_containment_is_inclusive_of_its_edges() -> None:
    box = (10.0, 10.0, 100.0, 100.0)

    assert contains(box, (10.0, 10.0))
    assert contains(box, (110.0, 110.0))
    assert not contains(box, (110.1, 50.0))


def test_a_point_maps_to_pixels() -> None:
    assert point_in_pixels(NormalizedPoint(x=0.5, y=0.25), 800, 400) == (400.0, 100.0)


def test_clamp_holds_its_bounds() -> None:
    assert clamp(5.0, 0.0, 1.0) == 1.0
    assert clamp(-5.0, 0.0, 1.0) == 0.0
