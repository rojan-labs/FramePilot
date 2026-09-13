"""``POST /brain/visual/search`` over footage the LOCAL visual-embed pack indexed (ADR 0176).

A query vector is only comparable with vectors from the model that embedded it. Until this
was wired, search always embedded the query with the hosted NVIDIA arm: a keyless machine
with the pack indexed its footage and then answered every search with ``no_api_key``, and a
machine with both a key and local rows scored a hosted query against local vectors. These
tests pin the three halves of the fix: the pack embeds the query when the brain is in its
space, the store never scores across spaces, and the hosted arm still wins a tie.

The pack is a scripted process — nothing here proves a vector is meaningful, only that the
right arm is asked and the right rows are ranked.
"""

from __future__ import annotations

import base64
import json
import struct
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.brain.local_visual_embed import LOCAL_MODEL_ID, LocalVisualEmbedClient
from framepilot_engine.brain.models import VisualSpanRow, VisualVectorRow
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.vector_store import VisualVectorStore
from framepilot_engine.brain.visual_embed import MODEL_ID as HOSTED_MODEL_ID
from framepilot_engine.brain.visual_embed import VisualEmbedderResolution
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

LOCAL_ASSET = "local-vid"
HOSTED_ASSET = "hosted-vid"


def _probe() -> dict[str, Any]:
    return MediaInfo(
        path="/clip.mp4",
        duration_seconds=3.0,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0)],
    ).model_dump(mode="json")


def _packed(vector: list[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(vector)}e", *vector)).decode("ascii")


class ScriptedTextPack:
    """Answers ``visual.text`` with a pinned 3-d query vector, or a typed failure."""

    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.requests: list[dict[str, Any]] = []
        self.returncode: int | None = 0

    def __call__(self, _handle: Any) -> ScriptedTextPack:
        return self

    def kill(self) -> None:  # pragma: no cover - no timeout path in these tests
        pass

    def communicate(
        self, input: str | None = None, timeout: float | None = None
    ) -> tuple[str, str]:
        request = json.loads(input or "{}")
        self.requests.append(request)
        if self.fail:
            message: dict[str, Any] = {
                "type": "failure",
                "protocolVersion": 1,
                "requestId": request["requestId"],
                "code": "hardware_unsupported",
                "detail": "no usable execution provider",
            }
        else:
            message = {
                "type": "result",
                "protocolVersion": 1,
                "requestId": request["requestId"],
                "projectRevision": request["projectRevision"],
                "capability": "visual.text",
                "dim": 3,
                "vectors": [_packed([1.0, 0.0, 0.0]) for _ in request["parameters"]["texts"]],
            }
        return json.dumps(message) + "\n", ""


def _span(asset_id: str, model: str, t0: float) -> VisualSpanRow:
    return VisualSpanRow(
        asset_id=asset_id,
        model=model,
        sampler_version=1,
        t0=t0,
        t1=t0 + 1.0,
        scene_index=int(t0),
        keyframe_t=t0,
        phash=1,
        content_hash=f"sha-{asset_id}",
        frame_count=1,
    )


def _vector(asset_id: str, model: str, t0: float, values: list[float]) -> VisualVectorRow:
    return VisualVectorRow(
        asset_id=asset_id, model=model, sampler_version=1, t0=t0, dim=len(values), vector=values
    )


def _seed_local(root: Path) -> None:
    """Two local-space spans: t0=0 aligns with the scripted query, t0=1 does not."""
    with open_brain(root, "p1") as store:
        store.upsert_asset(LOCAL_ASSET, path="l.mp4", content_sha256="sha-l", probe=_probe())
        store.upsert_visual_spans(
            [_span(LOCAL_ASSET, LOCAL_MODEL_ID, 0.0), _span(LOCAL_ASSET, LOCAL_MODEL_ID, 1.0)]
        )
        VisualVectorStore(store).upsert(
            [
                _vector(LOCAL_ASSET, LOCAL_MODEL_ID, 0.0, [1.0, 0.0, 0.0]),
                _vector(LOCAL_ASSET, LOCAL_MODEL_ID, 1.0, [0.0, 1.0, 0.0]),
            ]
        )


def _seed_mixed(root: Path) -> None:
    """A hosted 4-d space (in the derived index) beside a local 3-d space (durable rows)."""
    with open_brain(root, "p1") as store:
        store.upsert_asset(HOSTED_ASSET, path="h.mp4", content_sha256="sha-h", probe=_probe())
        store.upsert_asset(LOCAL_ASSET, path="l.mp4", content_sha256="sha-l", probe=_probe())
        store.upsert_visual_spans(
            [_span(HOSTED_ASSET, HOSTED_MODEL_ID, 0.0), _span(LOCAL_ASSET, LOCAL_MODEL_ID, 0.0)]
        )
        VisualVectorStore(store).upsert(
            [_vector(HOSTED_ASSET, HOSTED_MODEL_ID, 0.0, [1.0, 0.0, 0.0, 0.0])]
        )
        # Durable only: the derived vec0 index has one dimension, and it is the hosted one.
        store.upsert_visual_vectors([_vector(LOCAL_ASSET, LOCAL_MODEL_ID, 0.0, [1.0, 0.0, 0.0])])


@pytest.fixture
def handle(tmp_path: Path) -> str:
    entrypoint = tmp_path / "framepilot-visual-embed"
    entrypoint.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    return json.dumps(
        {
            "packId": "framepilot.visual-embed",
            "version": "1.0.0",
            "releaseDigest": "a" * 64,
            "entrypoint": str(entrypoint),
            "capabilities": ["visual.embed", "visual.text"],
        }
    )


def _client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pack: ScriptedTextPack, **settings: Any
) -> TestClient:
    original = LocalVisualEmbedClient.__init__

    def __init__(self: Any, pack_handle: Any, **_kw: Any) -> None:
        original(self, pack_handle, launch=pack)

    monkeypatch.setattr(LocalVisualEmbedClient, "__init__", __init__)
    return TestClient(create_app(Settings(projects_root=tmp_path, **settings)))


def _search(client: TestClient, **body: Any) -> dict[str, Any]:
    response = client.post(
        "/brain/visual/search", json={"projectId": "p1", "query": "skater", **body}
    )
    assert response.status_code == 200, response.text
    payload: dict[str, Any] = response.json()
    return payload


class _HostedQuery:
    def embed_query(self, text: str) -> list[float]:
        return [1.0, 0.0, 0.0, 0.0]


def test_a_keyless_brain_indexed_by_the_pack_is_searched_with_the_pack(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, handle: str
) -> None:
    pack = ScriptedTextPack()
    client = _client(tmp_path, monkeypatch, pack)
    _seed_local(tmp_path)

    body = _search(client, visualEmbedPack=handle)

    assert body["available"] is True
    assert body.get("reason") in (None, "")
    assert [packet["assetId"] for packet in body["packets"]][:1] == [LOCAL_ASSET]
    assert body["packets"][0]["t0"] == 0.0
    [request] = pack.requests
    assert request["capability"] == "visual.text"
    assert request["parameters"]["texts"] == ["skater"]


def test_without_the_pack_a_pack_indexed_brain_says_why_it_cannot_search(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pack = ScriptedTextPack()
    client = _client(tmp_path, monkeypatch, pack)
    _seed_local(tmp_path)

    body = _search(client)

    assert body["available"] is True
    assert body["reason"] == "no_api_key"
    assert body["packets"] == []
    assert pack.requests == []


def test_a_pack_that_cannot_embed_the_query_is_reported_not_swallowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, handle: str
) -> None:
    client = _client(tmp_path, monkeypatch, ScriptedTextPack(fail=True))
    _seed_local(tmp_path)

    body = _search(client, visualEmbedPack=handle)

    assert body["available"] is False
    assert "local visual-embed pack" in body["reason"]
    assert "no usable execution provider" in body["reason"]


def test_a_local_query_never_scores_the_hosted_space(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, handle: str
) -> None:
    client = _client(tmp_path, monkeypatch, ScriptedTextPack())
    _seed_mixed(tmp_path)

    body = _search(client, visualEmbedPack=handle)

    assert body["available"] is True
    assert {packet["assetId"] for packet in body["packets"]} == {LOCAL_ASSET}


def test_the_hosted_arm_still_wins_when_it_can_search_its_own_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, handle: str
) -> None:
    pack = ScriptedTextPack()
    client = _client(tmp_path, monkeypatch, pack, nvidia_embeddings_keys="key-abc")
    monkeypatch.setattr(
        service_module,
        "resolve_visual_embedder",
        lambda keys=None, **_pack: VisualEmbedderResolution(client=_HostedQuery()),  # type: ignore[arg-type]
    )
    _seed_mixed(tmp_path)

    body = _search(client, visualEmbedPack=handle)

    assert body["available"] is True
    assert {packet["assetId"] for packet in body["packets"]} == {HOSTED_ASSET}
    assert pack.requests == []
