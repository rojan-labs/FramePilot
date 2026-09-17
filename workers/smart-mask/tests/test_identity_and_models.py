"""Identity, manifest, model pins and the parity allow list agree with each other."""

from __future__ import annotations

import json
import tomllib
from pathlib import Path

import pytest

from framepilot_smart_mask import PACK_CAPABILITIES, PACK_ID, PACK_VERSION
from framepilot_smart_mask.backend import ModelUnavailableError
from framepilot_smart_mask.identity import HealthCheckError, HealthFacts, build_handshake
from framepilot_smart_mask.models import (
    PARITY_TABLE,
    PINNED_MODELS,
    UNPINNED_DIGEST,
    DigestCache,
    PinnedModel,
    file_digest,
    provider_chain,
    result_provider,
    select_provider,
)

PACK_ROOT = Path(__file__).resolve().parent.parent
SHA = "b" * 64


def environment(**overrides: str) -> dict[str, str]:
    env = {
        "FRAMEPILOT_CAPABILITY_PACK_ID": PACK_ID,
        "FRAMEPILOT_CAPABILITY_PACK_VERSION": PACK_VERSION,
        "FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST": SHA,
        "FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": json.dumps(list(reversed(PACK_CAPABILITIES))),
    }
    env.update(overrides)
    return env


def test_manifest_matches_compiled_identity() -> None:
    manifest = tomllib.loads((PACK_ROOT / "pack" / "manifest.toml").read_text())
    assert manifest["pack"]["id"] == PACK_ID
    assert manifest["pack"]["version"] == PACK_VERSION
    assert tuple(manifest["pack"]["capabilities"]) == PACK_CAPABILITIES
    assert manifest["runtime"]["network"] == "disabled"
    pyproject = tomllib.loads((PACK_ROOT / "pyproject.toml").read_text())
    assert pyproject["project"]["version"] == PACK_VERSION


def test_models_lock_matches_compiled_pins() -> None:
    lock = tomllib.loads((PACK_ROOT / "pack" / "models.lock.toml").read_text())
    locked = {entry["id"]: entry for entry in lock["model"]}
    assert set(locked) == {model.id for model in PINNED_MODELS}
    for model in PINNED_MODELS:
        entry = locked[model.id]
        assert (entry["file"], entry["sha256"], entry["bytes"], entry["license"]) == (
            model.file,
            model.sha256,
            model.bytes,
            model.license,
        ), model.id
        assert entry.get("tile") == model.tile
    assert {model.license for model in PINNED_MODELS} <= {"Apache-2.0", "MIT"}


def test_handshake_echoes_identity_after_health_facts() -> None:
    handshake = build_handshake(
        lambda: HealthFacts("onnxruntime-1.30.0:sam=cpu", {"z.onnx": SHA, "a.onnx": SHA}),
        environment(),
    )
    assert handshake["pack"] == {"id": PACK_ID, "version": PACK_VERSION, "releaseDigest": SHA}
    assert handshake["capabilities"] == sorted(PACK_CAPABILITIES)
    assert list(handshake["modelDigests"]) == ["a.onnx", "z.onnx"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"FRAMEPILOT_CAPABILITY_PACK_ID": "framepilot.subject-intelligence"},
        {"FRAMEPILOT_CAPABILITY_PACK_VERSION": "9.9.9"},
        {"FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST": "nope"},
        {"FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": '["subject.matte"]'},
        {"FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": "{"},
    ],
)
def test_handshake_refuses_a_foreign_identity(overrides: dict[str, str]) -> None:
    with pytest.raises(HealthCheckError):
        build_handshake(lambda: HealthFacts("x", {}), environment(**overrides))


def test_handshake_refuses_unverifiable_models() -> None:
    def broken() -> HealthFacts:
        raise ModelUnavailableError("digest mismatch")

    with pytest.raises(HealthCheckError, match="digest mismatch"):
        build_handshake(broken, environment())


def test_digest_cache_refuses_placeholder_missing_and_tampered(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    good = tmp_path / "good.onnx"
    good.write_bytes(b"weights")
    pins = (
        PinnedModel("good", "sam", "good.onnx", file_digest(good), 7, "MIT"),
        PinnedModel("placeholder", "sam", "p.onnx", UNPINNED_DIGEST, 0, "MIT"),
        PinnedModel("missing", "sam", "m.onnx", SHA, 1, "MIT"),
    )
    from framepilot_smart_mask import models

    monkeypatch.setattr(models, "MODELS_BY_ID", {pin.id: pin for pin in pins})
    cache = DigestCache()
    assert cache.resolve("good", tmp_path) == good
    with pytest.raises(ModelUnavailableError, match="no approved digest"):
        cache.resolve("placeholder", tmp_path)
    with pytest.raises(ModelUnavailableError, match="not installed"):
        cache.resolve("missing", tmp_path)
    good.write_bytes(b"tampered")
    with pytest.raises(ModelUnavailableError, match="approved digest"):
        cache.resolve("good", tmp_path)


def test_parity_rule_disables_unmeasured_and_failed_pairs() -> None:
    available = ("CoreMLExecutionProvider", "CPUExecutionProvider")
    provider, skipped = select_provider("sam", available, provider_chain("darwin"))
    assert provider == "cpu"
    assert skipped[0]["provider"] == "coreml" and "parity" in skipped[0]["reason"]
    provider, skipped = select_provider(
        "birefnet", ("DmlExecutionProvider", "CPUExecutionProvider"), provider_chain("win32", 19045)
    )
    assert provider == "cpu" and "not measured" in skipped[0]["reason"]
    assert provider_chain("win32", 26100)[0] == "winml"
    assert result_provider("winml") == "directml"


def test_a_pair_that_passes_parity_is_used() -> None:
    from framepilot_smart_mask.models import ParityVerdict

    table = {**PARITY_TABLE, ("birefnet", "directml"): ParityVerdict(True, "measured")}
    provider, _ = select_provider(
        "birefnet", ("DmlExecutionProvider", "CPUExecutionProvider"), ("directml", "cpu"), table
    )
    assert provider == "directml"
    provider, skipped = select_provider(
        "birefnet", ("CPUExecutionProvider",), ("directml", "cpu"), table
    )
    assert provider == "cpu" and skipped[0]["reason"] == "not available in this runtime"
