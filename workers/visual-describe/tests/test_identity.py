"""The health handshake: the worker verifies the installer's claim about itself."""

from __future__ import annotations

import json

import pytest
from conftest import FAKE_DIGEST, FakeDescribeBackend

from framepilot_visual_describe import PACK_CAPABILITIES, PACK_ID, PACK_VERSION
from framepilot_visual_describe.backend import (
    BackendUnavailableError,
    DescribeBackend,
    ModelUnavailableError,
)
from framepilot_visual_describe.identity import (
    HealthCheckError,
    build_handshake,
    read_installer_identity,
)

RELEASE_DIGEST = "c" * 64


def env(**overrides: str) -> dict[str, str]:
    base = {
        "FRAMEPILOT_CAPABILITY_PACK_ID": PACK_ID,
        "FRAMEPILOT_CAPABILITY_PACK_VERSION": PACK_VERSION,
        "FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST": RELEASE_DIGEST,
        "FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": json.dumps(list(PACK_CAPABILITIES)),
    }
    base.update(overrides)
    return base


def test_a_matching_identity_is_accepted() -> None:
    identity = read_installer_identity(env())
    assert identity.pack_id == PACK_ID
    assert identity.capabilities == tuple(sorted(PACK_CAPABILITIES))


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"FRAMEPILOT_CAPABILITY_PACK_ID": "Not An Id"}, "missing or malformed"),
        ({"FRAMEPILOT_CAPABILITY_PACK_VERSION": "one"}, "missing or malformed"),
        ({"FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST": "short"}, "missing or malformed"),
        ({"FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": "{"}, "not valid JSON"),
        ({"FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": "{}"}, "array of strings"),
        ({"FRAMEPILOT_CAPABILITY_PACK_ID": "framepilot.visual-embed"}, "is not this worker"),
        ({"FRAMEPILOT_CAPABILITY_PACK_VERSION": "9.9.9"}, "does not match this worker"),
        (
            {"FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": '["visual.describe","visual.embed"]'},
            "capability roster",
        ),
    ],
)
def test_a_mismatched_identity_is_refused(overrides: dict[str, str], message: str) -> None:
    with pytest.raises(HealthCheckError, match=message):
        read_installer_identity(env(**overrides))


def test_the_handshake_reports_the_backend_and_its_digests() -> None:
    handshake = build_handshake(FakeDescribeBackend, env())
    assert handshake["pack"] == {
        "id": PACK_ID,
        "version": PACK_VERSION,
        "releaseDigest": RELEASE_DIGEST,
    }
    assert handshake["capabilities"] == ["visual.describe"]
    assert handshake["hardwareBackend"] == "fake"
    assert handshake["modelDigests"] == {"fake.gguf": FAKE_DIGEST}


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (BackendUnavailableError("no OpenCV"), "backend is unavailable"),
        (ModelUnavailableError("placeholder pin"), "artifact verification failed"),
    ],
)
def test_the_health_check_fails_while_the_backend_cannot_load(
    error: Exception, message: str
) -> None:
    def create() -> DescribeBackend:
        raise error

    with pytest.raises(HealthCheckError, match=message):
        build_handshake(create, env())
