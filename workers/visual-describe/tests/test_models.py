"""Pinned artifacts: placeholders are refused by name, and digests are enforced."""

from __future__ import annotations

import hashlib
import tomllib
from pathlib import Path

import pytest

from framepilot_visual_describe.backend import ModelUnavailableError
from framepilot_visual_describe.models import (
    ENV_PACK_ROOT,
    MODELS_BY_ID,
    PINNED_MODELS,
    UNPINNED_DIGEST,
    file_digest,
    models_directory,
    resolve_model,
    verify_all,
)

LOCK_PATH = Path(__file__).resolve().parent.parent / "pack" / "models.lock.toml"


def test_every_pin_is_still_a_placeholder_and_says_so() -> None:
    # This test is the record of the pack's actual state. When the weights are fetched and
    # recorded it must be replaced by real digests, not deleted.
    assert all(not model.pinned for model in PINNED_MODELS)


def test_the_lock_file_and_the_compiled_in_pins_agree() -> None:
    with LOCK_PATH.open("rb") as handle:
        lock = tomllib.load(handle)
    recorded = {entry["file"]: entry["sha256"] for entry in lock["model"]}
    assert recorded == {model.file: model.sha256 for model in PINNED_MODELS}


def test_a_placeholder_pin_is_refused_by_name(tmp_path: Path) -> None:
    with pytest.raises(ModelUnavailableError, match="placeholder pin"):
        resolve_model("vlm", tmp_path)


def test_an_unknown_artifact_id_is_refused(tmp_path: Path) -> None:
    with pytest.raises(ModelUnavailableError, match="not an artifact of this pack"):
        resolve_model("whisper", tmp_path)


def test_a_missing_file_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pinned = MODELS_BY_ID["vlm"]
    # Pin the artifact to a real digest without touching the shipped tuple.
    monkeypatch.setitem(
        MODELS_BY_ID,
        "vlm",
        type(pinned)(id="vlm", file=pinned.file, sha256="b" * 64, license="Apache-2.0"),
    )
    with pytest.raises(ModelUnavailableError, match="is not installed"):
        resolve_model("vlm", tmp_path)


def test_a_digest_mismatch_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pinned = MODELS_BY_ID["vlm"]
    path = tmp_path / pinned.file
    path.write_bytes(b"not the approved weights")
    monkeypatch.setitem(
        MODELS_BY_ID,
        "vlm",
        type(pinned)(id="vlm", file=pinned.file, sha256="b" * 64, license="Apache-2.0"),
    )
    with pytest.raises(ModelUnavailableError, match="hashes to"):
        resolve_model("vlm", tmp_path)


def test_a_runtime_binary_that_is_not_executable_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pinned = MODELS_BY_ID["runtime"]
    path = tmp_path / pinned.file
    path.write_bytes(b"#!/bin/sh\n")
    path.chmod(0o644)
    digest = file_digest(path)
    monkeypatch.setitem(
        MODELS_BY_ID,
        "runtime",
        type(pinned)(id="runtime", file=pinned.file, sha256=digest, license="MIT", executable=True),
    )
    with pytest.raises(ModelUnavailableError, match="not executable"):
        resolve_model("runtime", tmp_path)


def test_file_digest_matches_hashlib(tmp_path: Path) -> None:
    path = tmp_path / "blob"
    path.write_bytes(b"framepilot")
    assert file_digest(path) == hashlib.sha256(b"framepilot").hexdigest()


def test_models_directory_follows_the_installer_root(tmp_path: Path) -> None:
    assert models_directory({ENV_PACK_ROOT: str(tmp_path)}) == tmp_path / "models"
    assert models_directory({}).name == "models"


def test_verify_all_refuses_while_any_pin_is_a_placeholder(tmp_path: Path) -> None:
    with pytest.raises(ModelUnavailableError):
        verify_all(tmp_path)


def test_the_unpinned_sentinel_cannot_collide_with_a_real_digest(tmp_path: Path) -> None:
    # Sixty-four zeros is not the sha256 of anything, which is what makes "not fetched"
    # safe to store in the same field as an approved digest.
    path = tmp_path / "blob"
    path.write_bytes(b"")
    assert file_digest(path) != UNPINNED_DIGEST
