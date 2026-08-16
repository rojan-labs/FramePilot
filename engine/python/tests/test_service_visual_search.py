"""Service tests for ``POST /brain/visual/search`` (plan MI5.1, MI5.2).

The query embedder is mocked at the service seam and the retrieval fixtures use
PINNED vectors written straight into the brain (plan §6 — no live NVIDIA calls
in any tier). The brain reads under test are real SQLite, so fusion runs over
the actual vector store, FTS5 captions/transcript, and the span→timeline
projection.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.brain.embeddings import EmbedderResolution
from framepilot_engine.brain.keyring import KeyRingExhaustedError
from framepilot_engine.brain.models import (
    SearchHit,
    SearchHitType,
    VisualCaptionRow,
    VisualSpanRow,
    VisualVectorRow,
)
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.vector_store import VisualVectorStore
from framepilot_engine.brain.visual_embed import (
    MODEL_ID,
    VisualEmbedderResolution,
    VisualEmbedError,
)
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

_SAMPLER = 1


class _FakeQueryEmbedder:
    """Returns a pinned query vector regardless of the query text."""

    def __init__(self, vector: list[float]) -> None:
        self._vector = vector

    def embed_query(self, text: str) -> list[float]:
        return self._vector


class _ExhaustedQueryEmbedder:
    def embed_query(self, text: str) -> list[float]:
        raise KeyRingExhaustedError(last_status=429, last_error="HTTP 429: rate limited")


class _ErrorQueryEmbedder:
    def embed_query(self, text: str) -> list[float]:
        raise VisualEmbedError("The query text exceeds the embeddings API payload limit.")


class _FakeTextEmbedder:
    model_id = "text-model"
    dim = 2

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[0.5, 0.5]] * len(texts)


def _video_probe() -> dict[str, Any]:
    return MediaInfo(
        path="/clip.mp4",
        duration_seconds=3.0,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0)],
    ).model_dump(mode="json")


def _span(asset_id: str, t0: float, t1: float, scene: int) -> VisualSpanRow:
    return VisualSpanRow(
        asset_id=asset_id,
        model=MODEL_ID,
        sampler_version=_SAMPLER,
        t0=t0,
        t1=t1,
        scene_index=scene,
        keyframe_t=t0,
        phash=1,
        content_hash=f"sha-{asset_id}",
        frame_count=1,
    )


def _vector(asset_id: str, t0: float, values: list[float]) -> VisualVectorRow:
    return VisualVectorRow(
        asset_id=asset_id, model=MODEL_ID, sampler_version=_SAMPLER, t0=t0, dim=len(values),
        vector=values,
    )


def _seed(root: Any, project_id: str = "p1", *, caption: bool = True) -> None:
    """Two pinned spans on one asset: span0 aligns with query [1,0,0], span1 does not."""
    with open_brain(root, project_id) as store:
        store.upsert_asset("vid", path="clip.mp4", content_sha256="sha-vid", probe=_video_probe())
        store.upsert_visual_spans([_span("vid", 0.0, 1.0, 0), _span("vid", 1.0, 2.0, 1)])
        VisualVectorStore(store).upsert(
            [_vector("vid", 0.0, [1.0, 0.0, 0.0]), _vector("vid", 1.0, [0.0, 1.0, 0.0])]
        )
        if caption:
            rows = [
                VisualCaptionRow(
                    asset_id="vid", scene_index=0, t0=0.0, t1=1.0,
                    text="A person demonstrates the app interface.", model="claude-x",
                )
            ]
            store.upsert_visual_captions(rows)
            store.reindex_captions(rows, asset_id="vid")


def _project_doc() -> dict[str, Any]:
    """Inline project: identity clip (asset time == timeline time) + a transcript word."""
    return {
        "id": "p1",
        "name": "Demo",
        "timeline": {
            "tracks": [
                {
                    "id": "t1",
                    "type": "video",
                    "clips": [
                        {
                            "id": "c1",
                            "assetId": "vid",
                            "trackId": "t1",
                            "start": 0.0,
                            "end": 2.0,
                            "sourceStart": 0.0,
                            "sourceEnd": 2.0,
                        }
                    ],
                }
            ]
        },
        "transcript": [{"word": "app", "start": 0.2, "end": 0.6}],
    }


def _client(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
    *,
    embedder: object | None,
    with_key: bool = True,
) -> TestClient:
    if embedder is not None:
        monkeypatch.setattr(
            service_module,
            "resolve_visual_embedder",
            lambda keys=None: VisualEmbedderResolution(client=embedder),  # type: ignore[arg-type]
        )
    settings = Settings(
        projects_root=tmp_path, nvidia_embeddings_keys="key-abc" if with_key else None
    )
    return TestClient(create_app(settings))


def _search(client: TestClient, **body: Any) -> Any:
    return client.post("/brain/visual/search", json={"projectId": "p1", "query": "app", **body})


def _describe(client: TestClient, **body: Any) -> Any:
    return client.post(
        "/brain/visual/describe", json={"projectId": "p1", "assetId": "vid", **body}
    )


# --- Honest-unavailable ---------------------------------------------------------


def test_search_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings(nvidia_embeddings_keys="k")))
    body = client.post("/brain/visual/search", json={"projectId": "p1", "query": "x"}).json()
    assert body["available"] is False and "sandbox root" in body["reason"]


def test_search_reports_no_key(tmp_path: Any) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.post("/brain/visual/search", json={"projectId": "p1", "query": "x"}).json()
    assert body["available"] is True and body["reason"] == "no_api_key"
    assert body["packets"] == []


def test_search_key_exhaustion_is_honest(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_ExhaustedQueryEmbedder())
    _seed(tmp_path)
    body = _search(client).json()
    assert body["available"] is True and "429" in body["reason"]
    assert body["packets"] == []


def test_search_embed_error_is_unavailable(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_ErrorQueryEmbedder())
    _seed(tmp_path)
    body = _search(client).json()
    assert body["available"] is False and "payload limit" in body["reason"]


def test_search_empty_index_returns_no_packets(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_FakeQueryEmbedder([1.0, 0.0, 0.0]))
    # Brain exists but nothing indexed.
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("vid", path="clip.mp4", content_sha256="h", probe=_video_probe())
    body = _search(client).json()
    assert body["available"] is True and body["packets"] == []
    assert body["backend"] in {"sqlite-vec", "brute-force"}


# --- Happy path -----------------------------------------------------------------


def test_describe_enumerates_every_span_in_time_order_without_embedding_key(tmp_path: Any) -> None:
    # Regression: describe_footage used to issue a semantic query and sort only its
    # top-k results, so it could omit indexed scenes and required a live NVIDIA key.
    # Enumeration is a local derived-data read and must return the full asset record.
    _seed(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = _describe(client, project=_project_doc()).json()
    assert body["available"] is True
    assert [(p["t0"], p["t1"]) for p in body["packets"]] == [(0.0, 1.0), (1.0, 2.0)]
    assert body["packets"][0]["caption"] == "A person demonstrates the app interface."
    assert body["packets"][0]["transcriptOverlap"] == "app"
    assert body["packets"][0]["sources"] == ["visual-index"]


def test_describe_filters_the_enumerated_asset_time_range(tmp_path: Any) -> None:
    _seed(tmp_path)
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = _describe(client, timeRange=[1.1, 1.9]).json()
    assert [(p["t0"], p["t1"]) for p in body["packets"]] == [(1.0, 2.0)]


def test_search_fuses_visual_caption_and_transcript(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_FakeQueryEmbedder([1.0, 0.0, 0.0]))
    _seed(tmp_path)
    body = _search(client, project=_project_doc()).json()
    assert body["available"] is True
    assert body["backend"] in {"sqlite-vec", "brute-force"}
    packets = body["packets"]
    assert packets, "expected at least one evidence packet"
    top = packets[0]
    assert top["assetId"] == "vid" and top["t0"] == 0.0 and top["t1"] == 1.0
    assert top["sceneId"] == 0
    # span0 is hit by all three lanes; the caption + transcript resolve onto it.
    assert set(top["sources"]) == {"visual", "caption-fts", "transcript"}
    assert top["caption"] == "A person demonstrates the app interface."
    assert top["transcriptOverlap"] == "app"


def test_search_without_project_doc_has_empty_transcript_overlap(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_FakeQueryEmbedder([1.0, 0.0, 0.0]))
    _seed(tmp_path)
    body = _search(client).json()  # no project source
    top = body["packets"][0]
    # Visual + caption still fire; transcript needs clips to project, so it is empty.
    assert set(top["sources"]) == {"visual", "caption-fts"}
    assert top["transcriptOverlap"] == ""


# --- Filters --------------------------------------------------------------------


def test_search_asset_filter_excludes_other_assets(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_FakeQueryEmbedder([1.0, 0.0, 0.0]))
    _seed(tmp_path)
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("other", path="o.mp4", content_sha256="sha-o", probe=_video_probe())
        store.upsert_visual_spans([_span("other", 0.0, 1.0, 0)])
        VisualVectorStore(store).upsert([_vector("other", 0.0, [1.0, 0.0, 0.0])])
    body = _search(client, assetIds=["vid"]).json()
    assert {p["assetId"] for p in body["packets"]} == {"vid"}


def test_search_time_range_filters_spans(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_FakeQueryEmbedder([0.0, 1.0, 0.0]))
    _seed(tmp_path)
    # Query aligns with span1 [1,2); restrict to [0, 0.9] which only span0 covers.
    body = _search(client, timeRange=[0.0, 0.9]).json()
    assert {(p["assetId"], p["t0"]) for p in body["packets"]} == {("vid", 0.0)}


def test_search_rejects_inverted_time_range(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_FakeQueryEmbedder([1.0, 0.0, 0.0]))
    _seed(tmp_path)
    resp = _search(client, timeRange=[5.0, 1.0])
    assert resp.status_code == 422


# --- Semantic (text-vector) lane ------------------------------------------------


def test_search_includes_semantic_lane(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_FakeQueryEmbedder([1.0, 0.0, 0.0]))
    _seed(tmp_path)
    monkeypatch.setattr(
        service_module,
        "resolve_embedder",
        lambda model_dir: EmbedderResolution(embedder=_FakeTextEmbedder()),
    )
    # A semantic caption-type hit onto span0's scene → adds the "semantic" source.
    monkeypatch.setattr(
        service_module,
        "semantic_hits",
        lambda embedder, query, rows, *, limit: [
            SearchHit(
                type=SearchHitType.CAPTION, asset_id="vid", start=0.0, end=1.0, snippet="s",
                score=0.9,
            )
        ],
    )
    body = _search(client).json()
    assert "semantic" in body["packets"][0]["sources"]
