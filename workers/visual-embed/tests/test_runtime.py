"""One request in, exactly one terminal message out."""

from __future__ import annotations

import io
import json
import tomllib
from dataclasses import replace
from pathlib import Path

import pytest
from conftest import DIM, FakeBackend

from framepilot_visual_embed import PACK_CAPABILITIES, PACK_ID, PACK_VERSION
from framepilot_visual_embed.backend import BackendUnavailableError, ModelUnavailableError
from framepilot_visual_embed.identity import HealthCheckError, build_handshake
from framepilot_visual_embed.models import (
    MODELS_BY_ID,
    PINNED_MODELS,
    UNPINNED_DIGEST,
    resolve_model,
)
from framepilot_visual_embed.prompt_bank import PROMPT_BANK_VERSION, all_prompts, bank_digest
from framepilot_visual_embed.prompt_vectors import cache_path, load_or_compute
from framepilot_visual_embed.protocol import unpack_fp16
from framepilot_visual_embed.runtime import run_worker

PACK_DIR = Path(__file__).resolve().parent.parent

MEDIA = {
    "handleId": "media:1",
    "assetId": "asset-1",
    "absolutePath": "/sandbox/a.mp4",
    "sourceStartSeconds": 0.0,
    "sourceEndSeconds": 60.0,
    "fps": 30.0,
    "firstFrame": 0,
    "lastFrameExclusive": 1800,
}


def run(line: str, backend: FakeBackend | None = None) -> list[dict[str, object]]:
    stdout = io.StringIO()
    code = run_worker(io.StringIO(line), stdout, lambda: backend or FakeBackend())
    assert code == 0
    return [json.loads(raw) for raw in stdout.getvalue().splitlines()]


def embed_line(**parameters: object) -> str:
    return json.dumps(
        {
            "type": "request",
            "protocolVersion": 1,
            "requestId": "embed:1",
            "projectRevision": 4,
            "capability": "visual.embed",
            "media": MEDIA,
            "parameters": {
                "promptBankVersion": PROMPT_BANK_VERSION,
                "shots": [{"shotIndex": 0, "keyframeT": 1.0}],
                **parameters,
            },
        }
    )


class TestEmbedRuntime:
    def test_emits_progress_then_exactly_one_result(self) -> None:
        messages = run(embed_line())
        terminal = [m for m in messages if m["type"] in {"result", "failure"}]
        assert len(terminal) == 1
        assert terminal[0]["capability"] == "visual.embed"
        assert terminal[0]["dim"] == DIM
        assert terminal[0]["promptBankVersion"] == PROMPT_BANK_VERSION
        assert {m["type"] for m in messages[:-1]} == {"progress"}

    def test_the_result_carries_an_unpackable_vector_and_four_label_groups(self) -> None:
        [result] = [m for m in run(embed_line()) if m["type"] == "result"]
        shot = result["shots"][0]
        assert len(unpack_fp16(shot["vector"])) == DIM
        assert set(shot["labels"]) == {"shotSize", "subjectKind", "setting", "screenContent"}

    def test_a_prompt_bank_mismatch_fails_before_any_decode(self) -> None:
        backend = FakeBackend()
        messages = run(embed_line(promptBankVersion=PROMPT_BANK_VERSION + 1), backend)
        assert messages[-1]["code"] == "invalid_request"
        assert backend.decoded == []

    def test_a_cancel_line_before_work_starts_produces_a_cancelled_failure(self) -> None:
        stdout = io.StringIO()
        stdin = io.StringIO(
            embed_line()
            + "\n"
            + json.dumps({"type": "cancel", "protocolVersion": 1, "requestId": "embed:1"})
            + "\n"
        )
        run_worker(stdin, stdout, FakeBackend)
        messages = [json.loads(raw) for raw in stdout.getvalue().splitlines()]
        assert messages[-1]["type"] in {"result", "failure"}

    def test_a_malformed_line_is_a_typed_failure_not_a_crash(self) -> None:
        messages = run("{not json")
        assert messages == [
            {
                "type": "failure",
                "protocolVersion": 1,
                "requestId": "unidentified",
                "code": "invalid_request",
                "detail": messages[0]["detail"],
                "retryable": False,
            }
        ]

    def test_empty_stdin_is_a_typed_failure(self) -> None:
        messages = run("")
        assert messages[-1]["code"] == "invalid_request"

    def test_a_missing_runtime_is_reported_as_hardware_unsupported(self) -> None:
        stdout = io.StringIO()

        def refuse() -> FakeBackend:
            raise BackendUnavailableError("no onnxruntime here")

        run_worker(io.StringIO(embed_line()), stdout, refuse)
        assert json.loads(stdout.getvalue().splitlines()[-1])["code"] == "hardware_unsupported"

    def test_an_unpinned_weight_is_reported_as_model_unavailable(self) -> None:
        stdout = io.StringIO()

        def refuse() -> FakeBackend:
            raise ModelUnavailableError("placeholder pin")

        run_worker(io.StringIO(embed_line()), stdout, refuse)
        assert json.loads(stdout.getvalue().splitlines()[-1])["code"] == "model_unavailable"


class TestTextRuntime:
    def test_embeds_queries_with_no_media_handle(self) -> None:
        messages = run(
            json.dumps(
                {
                    "type": "request",
                    "protocolVersion": 1,
                    "requestId": "query:1",
                    "projectRevision": 0,
                    "capability": "visual.text",
                    "parameters": {"texts": ["a city street", "someone at a desk"]},
                }
            )
        )
        assert messages[-1]["capability"] == "visual.text"
        assert len(messages[-1]["vectors"]) == 2


class TestPromptVectorCache:
    def test_computes_once_and_reuses_the_cached_file(self, tmp_path: Path) -> None:
        backend = FakeBackend()
        first = load_or_compute(backend, tmp_path)
        second = load_or_compute(backend, tmp_path)
        assert len(first) == len(all_prompts())
        assert [list(v) for v in second] == [list(v) for v in first]
        assert len(backend.text_calls) == 1
        assert cache_path(tmp_path).is_file()

    def test_a_corrupt_cache_costs_time_not_correctness(self, tmp_path: Path) -> None:
        backend = FakeBackend()
        load_or_compute(backend, tmp_path)
        cache_path(tmp_path).write_text("{ truncated", encoding="utf-8")
        load_or_compute(backend, tmp_path)
        assert len(backend.text_calls) == 2

    def test_the_cache_is_keyed_by_the_bank_digest(self, tmp_path: Path) -> None:
        assert bank_digest()[:16] in cache_path(tmp_path).name

    def test_no_directory_means_no_file_is_written(self, tmp_path: Path) -> None:
        backend = FakeBackend()
        load_or_compute(backend, None)
        assert list(tmp_path.iterdir()) == []


class TestIdentityAndPins:
    def _environment(self, **overrides: str) -> dict[str, str]:
        env = {
            "FRAMEPILOT_CAPABILITY_PACK_ID": PACK_ID,
            "FRAMEPILOT_CAPABILITY_PACK_VERSION": PACK_VERSION,
            "FRAMEPILOT_CAPABILITY_PACK_RELEASE_DIGEST": "b" * 64,
            "FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES": json.dumps(list(PACK_CAPABILITIES)),
        }
        env.update(overrides)
        return env

    def test_handshake_echoes_the_approved_identity(self) -> None:
        handshake = build_handshake(FakeBackend, self._environment())
        assert handshake["pack"] == {
            "id": PACK_ID,
            "version": PACK_VERSION,
            "releaseDigest": "b" * 64,
        }
        assert handshake["capabilities"] == sorted(PACK_CAPABILITIES)

    def test_a_foreign_capability_roster_is_refused(self) -> None:
        with pytest.raises(HealthCheckError, match="capability roster"):
            build_handshake(
                FakeBackend,
                self._environment(
                    FRAMEPILOT_CAPABILITY_PACK_CAPABILITIES=json.dumps(["subject.detect"])
                ),
            )

    def test_a_foreign_pack_id_is_refused(self) -> None:
        with pytest.raises(HealthCheckError, match="is not this worker"):
            build_handshake(
                FakeBackend,
                self._environment(FRAMEPILOT_CAPABILITY_PACK_ID="framepilot.tracking-lite"),
            )

    def test_every_shipped_weight_carries_a_real_pin(self) -> None:
        # The intended state today: every weight has been fetched and approved. This is
        # the assertion that turns "the pack is live" into something a test can fail on.
        assert [model.id for model in PINNED_MODELS if model.sha256 == UNPINNED_DIGEST] == []

    def test_a_placeholder_pin_refuses_to_load_by_name(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # No shipped weight carries the sentinel any more, so the refusal is exercised
        # against an injected one. It still has to fire: the sentinel is what stands
        # between a future unfetched weight and a silent "hash matched".
        pinned = PINNED_MODELS[0]
        monkeypatch.setitem(
            MODELS_BY_ID,
            pinned.id,
            replace(pinned, sha256=UNPINNED_DIGEST),
        )
        with pytest.raises(ModelUnavailableError, match="no approved digest yet"):
            resolve_model(pinned.id, tmp_path)

    def test_a_tampered_weight_is_refused(self, tmp_path: Path) -> None:
        pinned = next(model for model in PINNED_MODELS if model.sha256 != UNPINNED_DIGEST)
        (tmp_path / pinned.file).write_bytes(b"not the approved model")
        with pytest.raises(ModelUnavailableError, match="refusing to load it"):
            resolve_model(pinned.id, tmp_path)

    def test_models_py_and_the_lock_file_agree(self) -> None:
        # The wheel enforces models.py; the lock file is the human record. A pack whose
        # two pin lists disagreed would verify against one and be documented as the other.
        with (PACK_DIR / "pack" / "models.lock.toml").open("rb") as handle:
            lock = tomllib.load(handle)
        locked = {entry["file"]: (entry["sha256"], entry["license"]) for entry in lock["model"]}
        compiled = {model.file: (model.sha256, model.license) for model in PINNED_MODELS}
        assert locked == compiled

    def test_the_manifest_roster_is_the_worker_s_roster(self) -> None:
        with (PACK_DIR / "pack" / "manifest.toml").open("rb") as handle:
            manifest = tomllib.load(handle)
        assert tuple(manifest["pack"]["capabilities"]) == PACK_CAPABILITIES
        assert manifest["pack"]["id"] == PACK_ID
        assert manifest["pack"]["version"] == PACK_VERSION
        assert manifest["pack"]["prompt_bank_version"] == PROMPT_BANK_VERSION
