"""Health mode must verify the installer-provided identity, not merely echo it."""

from __future__ import annotations

import json

import pytest
from conftest import ScriptedBackend

from framepilot_tracking_lite import PACK_CAPABILITIES, PACK_ID, PACK_VERSION
from framepilot_tracking_lite.backend import BackendUnavailableError, TrackingBackend
from framepilot_tracking_lite.identity import HealthCheckError, build_handshake

DIGEST = "a" * 64


def environment(**overrides: str) -> dict[str, str]:
    env = {
        "FRAMEPILOT_CAPABILITY_PACK_ID": PACK_ID,
        "FRAMEPILOT_CAPABILITY_PACK_VERSION": PACK_VERSION,
        "FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST": DIGEST,
        "FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": json.dumps(sorted(PACK_CAPABILITIES)),
    }
    env.update(overrides)
    return env


def scripted() -> TrackingBackend:
    return ScriptedBackend()


def test_handshake_echoes_the_approved_identity_with_the_real_backend() -> None:
    handshake = build_handshake(scripted, environment())
    assert handshake["type"] == "handshake"
    assert handshake["pack"] == {"id": PACK_ID, "version": PACK_VERSION, "releaseDigest": DIGEST}
    assert handshake["capabilities"] == sorted(PACK_CAPABILITIES)
    assert handshake["hardwareBackend"] == "scripted-cpu"
    # Tracking Lite ships no weights, so an empty digest map is the honest answer.
    assert handshake["modelDigests"] == {}


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"FRAMEPILOT_CAPABILITY_PACK_ID": "framepilot.subject-intelligence"}, "not this worker"),
        ({"FRAMEPILOT_CAPABILITY_PACK_ID": "Not An Id"}, "malformed"),
        ({"FRAMEPILOT_CAPABILITY_PACK_VERSION": "9.9.9"}, "does not match this worker"),
        ({"FRAMEPILOT_CAPABILITY_PACK_VERSION": "one"}, "malformed"),
        ({"FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST": "abc"}, "malformed"),
        ({"FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": "not json"}, "valid JSON"),
        ({"FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": json.dumps([1, 2])}, "array of strings"),
    ],
)
def test_rejects_an_identity_that_does_not_describe_this_worker(
    overrides: dict[str, str], expected: str
) -> None:
    with pytest.raises(HealthCheckError, match=expected):
        build_handshake(scripted, environment(**overrides))


def test_rejects_a_capability_roster_that_is_not_exactly_this_workers() -> None:
    extra = json.dumps([*sorted(PACK_CAPABILITIES), "subject.segment"])
    with pytest.raises(HealthCheckError, match="capability roster"):
        build_handshake(scripted, environment(FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES=extra))
    missing = json.dumps(["tracking.point"])
    with pytest.raises(HealthCheckError, match="capability roster"):
        build_handshake(scripted, environment(FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES=missing))


def test_fails_health_when_the_backend_cannot_load() -> None:
    def unavailable() -> TrackingBackend:
        raise BackendUnavailableError("the Tracking Lite CV runtime is not installed")

    with pytest.raises(HealthCheckError, match="backend is unavailable"):
        build_handshake(unavailable, environment())
