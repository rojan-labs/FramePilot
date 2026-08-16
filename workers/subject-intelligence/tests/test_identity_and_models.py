"""Health identity and the model pins it verifies."""

from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import ClassVar

import pytest

from framepilot_subject_intelligence import PACK_CAPABILITIES, PACK_ID, PACK_VERSION
from framepilot_subject_intelligence.backend import (
    BackendUnavailableError,
    ModelUnavailableError,
)
from framepilot_subject_intelligence.identity import (
    HealthCheckError,
    build_handshake,
    read_installer_identity,
)
from framepilot_subject_intelligence.models import (
    MODELS_BY_ID,
    PINNED_MODELS,
    models_directory,
    resolve_model,
    verify_all,
)

PACK_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = PACK_ROOT / "pack" / "models.lock.toml"
DIGEST = "b" * 64


def environment(**overrides: str) -> dict[str, str]:
    env = {
        "FRAMEPILOT_CAPABILITY_PACK_ID": PACK_ID,
        "FRAMEPILOT_CAPABILITY_PACK_VERSION": PACK_VERSION,
        "FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST": DIGEST,
        "FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": json.dumps(list(PACK_CAPABILITIES)),
    }
    env.update(overrides)
    return env


class StubBackend:
    name = "stub"
    model_digests: ClassVar[dict[str, str]] = {"m.onnx": "c" * 64}

    def open_frames(self, path: str, first: int, last: int) -> object:  # pragma: no cover
        raise NotImplementedError

    def detect_faces(self, frame: object) -> tuple[()]:  # pragma: no cover
        return ()

    def detect_objects(self, frame: object) -> tuple[()]:  # pragma: no cover
        return ()

    def segment_subject(self, frame: object, region: object) -> object:  # pragma: no cover
        raise NotImplementedError


def test_the_approved_identity_must_be_this_worker() -> None:
    identity = read_installer_identity(environment())

    assert identity.pack_id == PACK_ID
    assert identity.capabilities == tuple(sorted(PACK_CAPABILITIES))


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"FRAMEPILOT_CAPABILITY_PACK_ID": "framepilot.tracking-lite"}, "is not this worker"),
        ({"FRAMEPILOT_CAPABILITY_PACK_VERSION": "9.9.9"}, "does not match this worker"),
        ({"FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST": "short"}, "malformed"),
        ({"FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": "not json"}, "not valid JSON"),
    ],
)
def test_a_mislabelled_pack_is_refused(overrides: dict[str, str], message: str) -> None:
    with pytest.raises(HealthCheckError, match=message):
        read_installer_identity(environment(**overrides))


def test_an_inflated_capability_roster_is_refused() -> None:
    """The signed roster may not advertise something this worker cannot do."""
    inflated = json.dumps([*PACK_CAPABILITIES, "subject.reidentify"])

    with pytest.raises(HealthCheckError, match="capability roster"):
        read_installer_identity(
            environment(FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES=inflated)
        )


def test_a_missing_capability_is_also_refused() -> None:
    with pytest.raises(HealthCheckError, match="capability roster"):
        read_installer_identity(
            environment(FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES=json.dumps(["subject.detect"]))
        )


def test_the_handshake_reports_the_real_model_digests() -> None:
    handshake = build_handshake(StubBackend, environment())

    assert handshake["pack"] == {
        "id": PACK_ID,
        "version": PACK_VERSION,
        "releaseDigest": DIGEST,
    }
    # Unlike a purely algorithmic pack, this one must name its weights.
    assert handshake["modelDigests"] == {"m.onnx": "c" * 64}


def test_health_fails_when_the_backend_cannot_load() -> None:
    def broken() -> StubBackend:
        raise BackendUnavailableError("no OpenCV here")

    with pytest.raises(HealthCheckError, match="backend is unavailable"):
        build_handshake(broken, environment())


def test_health_fails_when_a_model_fails_its_digest() -> None:
    def tampered() -> StubBackend:
        raise ModelUnavailableError("weights hash to something else")

    with pytest.raises(HealthCheckError, match="model verification failed"):
        build_handshake(tampered, environment())


def test_compiled_pins_match_the_lock_file() -> None:
    """The lock file is the human record; the compiled constants are what runs.

    They are separate on purpose — the constants ship inside the signed wheel —
    so this test is what stops them drifting apart.
    """
    with LOCK_PATH.open("rb") as handle:
        lock = tomllib.load(handle)
    locked = {entry["id"]: entry for entry in lock["model"]}

    assert set(locked) == set(MODELS_BY_ID)
    for model in PINNED_MODELS:
        entry = locked[model.id]
        assert model.file == entry["file"]
        assert model.sha256 == entry["sha256"]
        assert model.license == entry["license"]


def test_every_pinned_model_licence_is_commercially_permissive() -> None:
    # A copyleft weight would be a licensing decision, not a dependency bump, and
    # it must not be possible to make it by editing one line.
    assert {model.license for model in PINNED_MODELS} <= {"MIT", "Apache-2.0"}


def test_a_missing_model_is_named_in_the_refusal(tmp_path: Path) -> None:
    with pytest.raises(ModelUnavailableError, match="is not installed"):
        resolve_model("face", tmp_path)


def test_a_tampered_model_is_refused(tmp_path: Path) -> None:
    (tmp_path / PINNED_MODELS[0].file).write_bytes(b"definitely not a neural network")

    with pytest.raises(ModelUnavailableError, match="hashes to"):
        resolve_model(PINNED_MODELS[0].id, tmp_path)


def test_verify_all_refuses_a_partially_installed_pack(tmp_path: Path) -> None:
    with pytest.raises(ModelUnavailableError):
        verify_all(tmp_path)


def test_the_models_directory_follows_the_installer(tmp_path: Path) -> None:
    resolved = models_directory({"FRAMEPILOT_CAPABILITY_PACK_ROOT": str(tmp_path)})

    assert resolved == tmp_path / "models"


def test_an_unknown_model_id_is_not_silently_accepted(tmp_path: Path) -> None:
    with pytest.raises(ModelUnavailableError, match="not a model of this pack"):
        resolve_model("imagination", tmp_path)
