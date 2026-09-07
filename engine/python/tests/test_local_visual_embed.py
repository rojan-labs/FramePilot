"""The local tier-1 arm: decoding a pack's answer, and winning the resolution.

What matters here is not that the arm works — that needs weights — but that it is
**honest about what it received**. Every short, mismatched or foreign answer must become
an error rather than a row in the ledger, because a partial tier-1 write is indistinguishable
from real coverage once it is stored.

The second half is the gate itself: the local pack must be PREFERRED over the hosted
NVIDIA arm, and the two spaces must stay separable by their model id.
"""

from __future__ import annotations

import base64
import json
import struct
from pathlib import Path
from typing import Any

import pytest

from framepilot_engine.analysis.prompt_bank import PROMPT_BANK_VERSION
from framepilot_engine.brain.local_visual_embed import (
    LOCAL_MODEL_ID,
    LocalVisualEmbedClient,
    unpack_fp16,
)
from framepilot_engine.brain.pack_worker import PackHandle, PackWorkerError
from framepilot_engine.brain.visual_embed import MODEL_ID, resolve_visual_embedder


def pack(vector: list[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(vector)}e", *vector)).decode("ascii")


@pytest.fixture
def entrypoint(tmp_path: Path) -> Path:
    path = tmp_path / "framepilot-visual-embed"
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    return path


@pytest.fixture
def handle(entrypoint: Path) -> PackHandle:
    return PackHandle(
        pack_id="framepilot.visual-embed",
        version="1.0.0",
        release_digest="a" * 64,
        entrypoint=str(entrypoint),
        capabilities=("visual.embed", "visual.text"),
    )


class Scripted:
    """A launcher that replays one canned stdout per request."""

    def __init__(self, *messages: dict[str, Any]) -> None:
        self._messages = list(messages)
        self.requests: list[dict[str, Any]] = []
        self.returncode: int | None = 0

    def __call__(self, _handle: PackHandle) -> Scripted:
        return self

    def kill(self) -> None:  # pragma: no cover - only a timeout path uses this
        pass

    def communicate(
        self, input: str | None = None, timeout: float | None = None
    ) -> tuple[str, str]:
        self.requests.append(json.loads(input or "{}"))
        message = self._messages.pop(0)
        return json.dumps({**message, "requestId": self.requests[-1]["requestId"]}) + "\n", ""


def embed_reply(shots: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
    message: dict[str, Any] = {
        "type": "result",
        "protocolVersion": 1,
        "projectRevision": 0,
        "capability": "visual.embed",
        "backend": "onnxruntime-CPUExecutionProvider",
        "modelDigests": {},
        "promptBankVersion": PROMPT_BANK_VERSION,
        "dim": 2,
        "faceDim": 2,
        "shots": shots,
    }
    message.update(overrides)
    return message


def shot(index: int, **overrides: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "shotIndex": index,
        "vector": pack([1.0, 0.0]),
        "labels": {"shotSize": {"value": "MS", "p": 0.82}},
        "faces": 0,
        "faceVectors": [],
    }
    entry.update(overrides)
    return entry


def embed(client: LocalVisualEmbedClient, *indices: int) -> Any:
    return client.embed_shots(
        asset_id="a1",
        media_path="/sandbox/a.mp4",
        shots=[(index, float(index) + 0.5) for index in indices],
        duration_seconds=60.0,
        fps=30.0,
    )


class TestDecoding:
    def test_decodes_vectors_labels_and_faces(self, handle: PackHandle) -> None:
        launcher = Scripted(
            embed_reply(
                [shot(0, faces=1, faceVectors=[pack([0.0, 1.0])]), shot(1)],
            )
        )
        client = LocalVisualEmbedClient(handle, launch=launcher)
        [first, second] = embed(client, 0, 1)
        assert first.shot_index == 0
        assert first.labels["shotSize"].value == "MS"
        assert first.labels["shotSize"].p == pytest.approx(0.82)
        assert first.faces == 1
        assert first.face_vectors[0] == pytest.approx([0.0, 1.0], abs=1e-3)
        assert second.faces == 0
        assert client.dim == 2

    def test_the_media_handle_spans_the_asset(self, handle: PackHandle) -> None:
        launcher = Scripted(embed_reply([shot(0)]))
        embed(LocalVisualEmbedClient(handle, launch=launcher), 0)
        media = launcher.requests[0]["media"]
        assert media["sourceStartSeconds"] == 0.0
        assert media["sourceEndSeconds"] == 60.0
        assert media["lastFrameExclusive"] == 1800

    def test_the_request_names_the_engine_s_prompt_bank_version(self, handle: PackHandle) -> None:
        launcher = Scripted(embed_reply([shot(0)]))
        embed(LocalVisualEmbedClient(handle, launch=launcher), 0)
        assert launcher.requests[0]["parameters"]["promptBankVersion"] == PROMPT_BANK_VERSION

    def test_batches_are_bounded_and_every_shot_comes_back(self, handle: PackHandle) -> None:
        first = list(range(64))
        second = list(range(64, 70))
        launcher = Scripted(
            embed_reply([shot(index) for index in first]),
            embed_reply([shot(index) for index in second]),
        )
        results = embed(LocalVisualEmbedClient(handle, launch=launcher), *(first + second))
        assert len(launcher.requests) == 2
        assert [item.shot_index for item in results] == first + second

    def test_a_short_answer_is_refused(self, handle: PackHandle) -> None:
        # The dangerous case: two shots asked, one answered. Storing it would record
        # coverage for a shot nobody looked at.
        launcher = Scripted(embed_reply([shot(0)]))
        with pytest.raises(PackWorkerError, match="answered 1 of 2"):
            embed(LocalVisualEmbedClient(handle, launch=launcher), 0, 1)

    def test_an_unrequested_shot_is_refused(self, handle: PackHandle) -> None:
        launcher = Scripted(embed_reply([shot(9)]))
        with pytest.raises(PackWorkerError, match="unrequested shot"):
            embed(LocalVisualEmbedClient(handle, launch=launcher), 0)

    def test_a_foreign_prompt_bank_version_is_refused(self, handle: PackHandle) -> None:
        launcher = Scripted(embed_reply([shot(0)], promptBankVersion=PROMPT_BANK_VERSION + 1))
        with pytest.raises(PackWorkerError, match="prompt bank"):
            embed(LocalVisualEmbedClient(handle, launch=launcher), 0)

    def test_a_label_group_the_ledger_cannot_store_is_refused(self, handle: PackHandle) -> None:
        launcher = Scripted(embed_reply([shot(0, labels={"vibe": {"value": "moody", "p": 0.9}})]))
        with pytest.raises(PackWorkerError, match="not a ledger label group"):
            embed(LocalVisualEmbedClient(handle, launch=launcher), 0)

    def test_a_declared_dimension_that_disagrees_with_the_bytes_is_refused(
        self, handle: PackHandle
    ) -> None:
        launcher = Scripted(embed_reply([shot(0)], dim=768))
        with pytest.raises(PackWorkerError, match="declared dim 768"):
            embed(LocalVisualEmbedClient(handle, launch=launcher), 0)

    def test_a_face_count_its_vectors_disagree_with_is_refused(self, handle: PackHandle) -> None:
        launcher = Scripted(embed_reply([shot(0, faces=3, faceVectors=[pack([1.0, 0.0])])]))
        with pytest.raises(PackWorkerError, match="disagree"):
            embed(LocalVisualEmbedClient(handle, launch=launcher), 0)

    def test_an_asset_with_no_duration_never_reaches_the_pack(self, handle: PackHandle) -> None:
        launcher = Scripted()
        with pytest.raises(PackWorkerError, match="no usable duration"):
            LocalVisualEmbedClient(handle, launch=launcher).embed_shots(
                asset_id="a1",
                media_path="/sandbox/a.mp4",
                shots=[(0, 0.0)],
                duration_seconds=0.0,
                fps=30.0,
            )
        assert launcher.requests == []

    def test_no_shots_costs_no_process(self, handle: PackHandle) -> None:
        launcher = Scripted()
        assert (
            LocalVisualEmbedClient(handle, launch=launcher).embed_shots(
                asset_id="a1",
                media_path="/sandbox/a.mp4",
                shots=[],
                duration_seconds=60.0,
                fps=30.0,
            )
            == []
        )
        assert launcher.requests == []


class TestTextQueries:
    def test_embeds_a_query_with_no_media_handle(self, handle: PackHandle) -> None:
        launcher = Scripted(
            {
                "type": "result",
                "protocolVersion": 1,
                "projectRevision": 0,
                "capability": "visual.text",
                "backend": "fake",
                "modelDigests": {},
                "dim": 2,
                "vectors": [pack([0.0, 1.0])],
            }
        )
        vector = LocalVisualEmbedClient(handle, launch=launcher).embed_query("a city street")
        assert vector == pytest.approx([0.0, 1.0], abs=1e-3)
        assert "media" not in launcher.requests[0]


class TestUnpack:
    def test_refuses_a_payload_that_is_not_base64(self) -> None:
        with pytest.raises(PackWorkerError, match="not base64"):
            unpack_fp16("not base64!")

    def test_refuses_a_payload_that_is_not_whole_halves(self) -> None:
        with pytest.raises(PackWorkerError, match="whole fp16"):
            unpack_fp16(base64.b64encode(b"abc").decode("ascii"))


class TestResolution:
    def test_the_local_pack_wins_over_a_configured_hosted_key(self, handle: PackHandle) -> None:
        resolution = resolve_visual_embedder("nvapi-aaaaaaaaaaaaaaaaaaaa", pack=handle)
        assert resolution.backend == "local"
        assert resolution.client is None
        assert resolution.local is not None
        assert resolution.model_id == LOCAL_MODEL_ID
        assert resolution.available is True

    def test_the_hosted_arm_still_resolves_with_no_pack(self) -> None:
        resolution = resolve_visual_embedder("nvapi-aaaaaaaaaaaaaaaaaaaa")
        assert resolution.backend == "nvidia"
        assert resolution.model_id == MODEL_ID
        assert resolution.local is None

    def test_neither_arm_is_honest_absence_not_a_crash(self) -> None:
        resolution = resolve_visual_embedder(None)
        assert resolution.available is False
        assert resolution.reason == "no_api_key"
        assert resolution.model_id is None

    def test_a_pack_missing_a_capability_does_not_win(self, entrypoint: Path) -> None:
        partial = PackHandle(
            pack_id="framepilot.visual-embed",
            version="1.0.0",
            release_digest="a" * 64,
            entrypoint=str(entrypoint),
            capabilities=("visual.embed",),
        )
        # Without `visual.text` the arm could index but never search what it indexed, so
        # it must not claim the space.
        resolution = resolve_visual_embedder("nvapi-aaaaaaaaaaaaaaaaaaaa", pack=partial)
        assert resolution.backend == "nvidia"
