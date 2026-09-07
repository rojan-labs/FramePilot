"""Service tests for the visual-index routes (plan MI4.1, MI4.3, VU6).

The embedder, tier-2 describer, and frame decode are monkeypatched at the service seam
(the same pattern the analyze/batch tests use) so pacing, cursor persistence,
resume/idempotency, cancellation, key-exhaustion honesty, and status all run
without ffmpeg or a live NVIDIA/vision API (plan §6 — no live calls in any tier).
The brain writes under test are real SQLite.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.visual_sampler import VisualSpan
from framepilot_engine.brain.described import parse_described
from framepilot_engine.brain.keyring import KeyRingExhaustedError
from framepilot_engine.brain.ledger_models import (
    TIER0_VERSION,
    ChromaStats,
    LumaStats,
    MeasuredFacts,
    MotionClass,
    MotionStats,
    ShotRecord,
)
from framepilot_engine.brain.sidecars import export_all_sidecars, import_sidecars
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.visual_embed import (
    MODEL_ID,
    EmbedResult,
    VisualEmbedderResolution,
    VisualEmbedError,
)
from framepilot_engine.config import Settings
from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app
from framepilot_engine.visual_indexing import FrameExtractionError

# --- Fakes ----------------------------------------------------------------------


class _FakeEmbedder:
    """Returns deterministic 3-dim vectors, one per input frame."""

    def __init__(self, dim: int = 3) -> None:
        self.dim = dim

    def embed_passages(self, images: list[bytes]) -> EmbedResult:
        return EmbedResult(model=MODEL_ID, dim=self.dim, vectors=[[0.1, 0.2, 0.3]] * len(images))


class _ExhaustedEmbedder:
    dim = 3

    def embed_passages(self, images: list[bytes]) -> EmbedResult:
        raise KeyRingExhaustedError(last_status=429, last_error="HTTP 429: rate limited")


class _MalformedResponseEmbedder:
    """A non-retryable failure rotating keys can't fix (bad payload/response)."""

    dim = 3

    def embed_passages(self, images: list[bytes]) -> EmbedResult:
        raise VisualEmbedError("NVIDIA embeddings request failed with HTTP 400: bad model id")


class _FakeDescriber:
    """A hosted describer that answers the structured schema (VU6.3).

    It funnels its answer through the SAME `parse_described` the real provider arms use,
    so a fake cannot produce a row shape the real path could not.
    """

    def __init__(self, model: str = "claude-x") -> None:
        self.model = model
        self.calls: list[int] = []

    def describe_scene(self, frames_jpeg: list[bytes]) -> Any:
        self.calls.append(len(frames_jpeg))
        return parse_described(
            {
                "summary": "A person speaks to camera in a bright room.",
                "subject": "person",
                "action": "speaking to camera",
                "setting": "bright room",
                "camera": {"shotSize": "MS", "angle": "eye-level", "movement": "static"},
                "mood": "bright",
                "onScreenText": [],
                "quality": ["well-lit"],
                "confidence": "medium",
            },
            model=self.model,
        )


class _FailingDescriber:
    model = "gpt-v"

    def describe_scene(self, frames_jpeg: list[bytes]) -> Any:
        from framepilot_engine.brain.captioner import DescribeError

        raise DescribeError("provider 500")


class _FakeTextEmbedder:
    """Stands in for the ONNX text embedder so caption text-embed runs offline."""

    model_id = "text-model"

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.5, 0.5]] * len(texts)


def _video_probe() -> dict[str, Any]:
    return MediaInfo(
        path="/clip.mp4",
        duration_seconds=3.0,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0)],
    ).model_dump(mode="json")


def _image_probe() -> dict[str, Any]:
    return MediaInfo(
        path="/photo.png",
        format_name="png_pipe",
        streams=[StreamInfo(index=0, codec_type="video", width=800, height=600)],
    ).model_dump(mode="json")


def _span(t0: float, t1: float, *, scene: int = 0, phash: int = 111) -> VisualSpan:
    return VisualSpan(
        t0=t0, t1=t1, scene_index=scene, keyframe_t=t0, phash=phash, frame_count=1
    )


def _seed_asset(
    root: Path, project_id: str, asset_id: str, path: str, probe: dict[str, Any]
) -> None:
    with open_brain(root, project_id) as store:
        store.upsert_asset(asset_id, path=path, content_sha256=f"hash-{asset_id}", probe=probe)


def _measured_shot(asset_id: str, index: int, t0: float, t1: float) -> ShotRecord:
    return ShotRecord(
        asset_id=asset_id,
        content_hash=f"hash-{asset_id}",
        shot_index=index,
        t0=t0,
        t1=t1,
        keyframe_t=t0,
        measured=MeasuredFacts(
            tier0_version=TIER0_VERSION,
            luma=LumaStats(mean=0.5, std=0.1, p10=0.2, p90=0.8),
            chroma=ChromaStats(u_mean=128.0, v_mean=128.0, sat_mean=0.2),
            warmth=0.0,
            contrast_idx=0.6,
            motion=MotionStats(si=10.0, ti=2.0, motion_class=MotionClass.STATIC),
            cut_score=0.0,
            black=False,
            freeze=False,
            sharpness=0.8,
        ),
    )


def _seed_measured_shots(
    root: Path, project_id: str, asset_id: str, spans: list[tuple[float, float]]
) -> None:
    """Give an asset a tier-0 shot list without decoding anything.

    Tier 2 describes SHOTS (VU6), so a describer test needs the ledger floor to exist.
    Seeding it also makes `_measure_tier0` a no-op resume, which keeps these tests free of
    ffmpeg exactly as they were before.
    """
    with open_brain(root, project_id) as store:
        store.upsert_shots(
            asset_id,
            f"hash-{asset_id}",
            "measured",
            [_measured_shot(asset_id, i, t0, t1) for i, (t0, t1) in enumerate(spans)],
        )


def _client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    embedder: object | None = None,
    describer: object | None = None,
    with_key: bool = True,
) -> TestClient:
    """A sandboxed client with the embedder/describer/decode seams faked."""
    embed_client = embedder if embedder is not None else _FakeEmbedder()
    monkeypatch.setattr(
        service_module,
        "resolve_visual_embedder",
        lambda keys=None, **_pack: VisualEmbedderResolution(client=embed_client),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(
        service_module, "detect_scenes", lambda path, **kw: []
    )
    monkeypatch.setattr(
        service_module,
        "sample_asset",
        lambda media_path, **kw: [_span(0.0, 3.0)] if not kw.get("is_image") else [_span(0.0, 0.0)],
    )
    monkeypatch.setattr(
        service_module, "extract_keyframe_jpeg", lambda media_path, t, **kw: b"\xff\xd8jpeg"
    )
    if describer is not None:
        from framepilot_engine.brain.captioner import DescriberResolution

        monkeypatch.setattr(
            service_module,
            "resolve_describer",
            lambda cfg, **kw: DescriberResolution(describer=describer),  # type: ignore[arg-type]
        )
    settings = Settings(
        projects_root=tmp_path,
        nvidia_embeddings_keys="key-abc" if with_key else None,
    )
    return TestClient(create_app(settings))


def _index(client: TestClient, **body: Any) -> Any:
    return client.post("/brain/visual/index", json={"projectId": "p1", **body})


# --- Honest-unavailable ---------------------------------------------------------


def test_index_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings(nvidia_embeddings_keys="k")))
    body = client.post("/brain/visual/index", json={"projectId": "p1"}).json()
    assert body["available"] is False and "sandbox root" in body["reason"]


def test_index_reports_no_key_as_a_skipped_tier(tmp_path: Path) -> None:
    """No key is a SKIPPED tier now, not the end of the job (ADR 0175, VU1.4).

    This used to be a bare ``reason='no_api_key'`` returned from an early short circuit
    that ran nothing at all — the reason a default install indexed nothing and the agent
    never called a footage surface. Tier 0 needs no key, so the job proceeds and the key
    only decides which of the other two tiers run.
    """
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    body = client.post("/brain/visual/index", json={"projectId": "p1"}).json()
    assert body["available"] is True
    assert body["tiers"]["measured"] == "ok"
    assert body["tiers"]["labelled"] == "skipped: no_api_key"
    # NOT in `reason`: the host loop treats any reason as terminal and stops re-posting.
    assert body["reason"] is None
    assert body["indexed"] == 0


# --- Happy path -----------------------------------------------------------------


def test_index_embeds_and_stores_spans(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    body = _index(client, assetIds=["vid"]).json()
    assert body["available"] is True
    assert body["done"] is True
    assert body["cursor"] == 1 and body["total"] == 1
    assert body["indexed"] == 1
    item = body["items"][0]
    assert {k: item[k] for k in ("assetId", "ok", "indexed", "captioned", "reason")} == {
        "assetId": "vid",
        "ok": True,
        "indexed": 1,
        "captioned": 0,
        "reason": None,
    }
    # Tier 0 runs alongside tier 1 here; the fixture's bytes are not decodable media, so
    # the measured tier reports its own failure without touching the embedding outcome.
    assert set(item["tiers"]) == {"measured", "labelled", "described"}
    assert item["tiers"]["labelled"] == "ok"
    with open_brain(tmp_path, "p1") as store:
        assert store.visual_index_counts()["spans"] == 1
        assert store.visual_index_counts()["vectors"] == 1


def test_index_describes_shots_when_provider_supplied(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Tier 2 writes BOTH halves: the structured document and the FTS summary (VU6.3)."""
    describer = _FakeDescriber()
    client = _client(tmp_path, monkeypatch, describer=describer)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 3.0)])
    body = _index(
        client,
        assetIds=["vid"],
        captionProvider={"kind": "anthropic", "model": "claude-x", "apiKey": "sk"},
    ).json()
    assert body["captioned"] == 1
    assert body["items"][0]["tiers"]["described"] == "ok"
    # First / middle / last of the span: a single keyframe cannot show what a shot does.
    assert describer.calls == [3]
    with open_brain(tmp_path, "p1") as store:
        captions = store.list_visual_captions("vid")
        assert len(captions) == 1
        assert captions[0].model == "claude-x"
        # Keyed by the SHOT, and carrying only the summary.
        assert (captions[0].scene_index, captions[0].t0, captions[0].t1) == (0, 0.0, 3.0)
        assert captions[0].text == "A person speaks to camera in a bright room."
        shots = store.list_shots(["vid"])
        assert shots[0].described is not None
        assert shots[0].described.subject == "person"
        assert shots[0].described.camera.shot_size is not None
        assert shots[0].described.p == 0.7


def test_index_without_provider_reports_captions_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    body = _index(client, assetIds=["vid"]).json()
    assert body["captioned"] == 0
    assert body["captionsReason"] == "no_vision_provider"


def test_image_asset_indexes_single_span(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "pic", "photo.png", _image_probe())
    body = _index(client, assetIds=["pic"]).json()
    assert body["indexed"] == 1 and body["done"] is True


# --- Pacing + resume/idempotency ------------------------------------------------


def test_index_paces_across_calls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Two passes, each paced at ``maxAssets`` (plan VU8 §8.2).

    Tier 0 sweeps the whole worklist before anything is embedded anywhere, so a
    two-asset job at one asset per slice is: measure a, measure b (and, the tier-0 pass
    having just finished the worklist, continue straight into embedding a), embed b.
    """
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "a", "a.mp4", _video_probe())
    _seed_asset(tmp_path, "p1", "b", "b.mp4", _video_probe())
    first = _index(client, assetIds=["a", "b"], maxAssets=1).json()
    assert first["done"] is False and first["cursor"] == 1 and first["total"] == 2
    assert first["indexed"] == 0  # nothing is embedded while any asset is unmeasured
    assert first["tiers"]["labelled"].startswith("skipped: tier 0 runs")
    second = _index(client, assetIds=["a", "b"], maxAssets=1, jobId=first["jobId"]).json()
    assert second["done"] is False and second["cursor"] == 1 and second["indexed"] == 1
    third = _index(client, assetIds=["a", "b"], maxAssets=1, jobId=first["jobId"]).json()
    assert third["done"] is True and third["cursor"] == 2 and third["indexed"] == 1


def test_reindex_skips_already_embedded_spans(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _index(client, assetIds=["vid"]).json()
    again = _index(client, assetIds=["vid"]).json()
    assert again["indexed"] == 0 and again["items"][0]["ok"] is True


def test_enumerates_visual_assets_from_brain(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    # An audio-only asset must be excluded from the worklist.
    with open_brain(tmp_path, "p1") as store:
        audio_probe = MediaInfo(
            path="/song.mp3",
            duration_seconds=5.0,
            format_name="mp3",
            streams=[StreamInfo(index=0, codec_type="audio", sample_rate=48000, channels=2)],
        ).model_dump(mode="json")
        store.upsert_asset("aud", path="song.mp3", content_sha256="h", probe=audio_probe)
    body = _index(client).json()
    assert body["total"] == 1 and body["indexed"] == 1


# --- Key exhaustion -------------------------------------------------------------


def test_key_exhaustion_stops_without_advancing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch, embedder=_ExhaustedEmbedder())
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    body = _index(client, assetIds=["vid"]).json()
    assert body["available"] is True
    assert body["reason"] == "all_keys_failing"
    assert body["cursor"] == 0 and body["done"] is False
    with open_brain(tmp_path, "p1") as store:
        assert store.visual_index_counts()["spans"] == 0
        job = next(j for j in store.list_jobs() if j.kind == "visual-index")
        assert job.error == "all_keys_failing"


def test_embed_error_stops_slice_instead_of_500(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-retryable NVIDIA response (VisualEmbedError) must degrade honestly.

    Regression: this used to propagate out of `_index_one_asset` uncaught,
    crashing the route with a raw 500 (and, in the browser, surfacing as a
    misleading CORS error since Starlette's CORSMiddleware never wraps a
    response for an unhandled exception).
    """
    client = _client(tmp_path, monkeypatch, embedder=_MalformedResponseEmbedder())
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    response = _index(client, assetIds=["vid"])
    assert response.status_code == 200
    body = response.json()
    # Same coarse reason as key exhaustion (mirrors existing convention — the
    # loop stops honestly either way); the specific message is logged server-side.
    assert body["available"] is True
    assert body["reason"] == "all_keys_failing"
    assert body["cursor"] == 0 and body["done"] is False


# --- Cancel ---------------------------------------------------------------------


def test_cancel_short_circuits_next_slice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "a", "a.mp4", _video_probe())
    _seed_asset(tmp_path, "p1", "b", "b.mp4", _video_probe())
    started = _index(client, assetIds=["a", "b"], maxAssets=1).json()
    cancel = client.post(
        "/brain/visual/index/cancel", json={"projectId": "p1", "jobId": started["jobId"]}
    ).json()
    assert cancel["available"] is True and cancel["state"] == "failed"
    resumed = _index(client, assetIds=["a", "b"], jobId=started["jobId"]).json()
    assert resumed["reason"] == "cancelled"


def test_cancel_unknown_job_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "a", "a.mp4", _video_probe())
    body = client.post(
        "/brain/visual/index/cancel", json={"projectId": "p1", "jobId": "nope"}
    ).json()
    assert body["available"] is False and "to cancel" in body["reason"]


# --- Per-asset branches ---------------------------------------------------------


def test_unknown_asset_is_reported_not_fatal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    body = _index(client, assetIds=["ghost"]).json()
    assert body["done"] is True and body["indexed"] == 0
    assert body["items"][0]["ok"] is False
    assert "not known" in body["items"][0]["reason"]


def test_frame_extraction_error_is_reported_not_fatal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One undecodable asset must fail only itself, not the whole slice.

    Regression: `sample_asset`/`extract_keyframe_jpeg` raising
    `FrameExtractionError` (e.g. ffmpeg producing no frame for a corrupt or
    unusual source) used to propagate out of `_index_one_asset` uncaught,
    crashing the route with a raw 500 — which permanently blocked indexing
    every OTHER asset too, since a retry always hits the same broken asset
    first (cursor order).
    """
    client = _client(tmp_path, monkeypatch)

    def _sample(media_path: Path, **kw: Any) -> list[VisualSpan]:
        if media_path.name == "corrupt.jpg":
            raise FrameExtractionError("Expected 72 grayscale bytes for a 9x8 dHash grid, got 0.")
        return [_span(0.0, 3.0)]

    monkeypatch.setattr(service_module, "sample_asset", _sample)
    _seed_asset(tmp_path, "p1", "bad", "corrupt.jpg", _image_probe())
    _seed_asset(tmp_path, "p1", "good", "clip.mp4", _video_probe())

    response = _index(client, assetIds=["bad", "good"], maxAssets=2)
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    bad_item, good_item = body["items"]
    assert bad_item["ok"] is False and "dHash grid" in bad_item["reason"]
    # The other asset in the same slice still indexes normally.
    assert good_item["ok"] is True


def test_ffmpeg_exit_failure_is_reported_not_fatal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same as above, but for a non-zero ffmpeg exit rather than empty output.

    Regression (found in independent review of the FrameExtractionError fix):
    `run_bytes` (`media/ffmpeg.py`) raises `FFmpegError` — not
    `FrameExtractionError` — on a non-zero exit, timeout, or missing binary.
    That path was NOT covered by the per-asset try/except, so a genuinely
    corrupt file (as opposed to one where ffmpeg exits 0 with no frame) still
    crashed the whole slice with an uncaught exception.
    """
    client = _client(tmp_path, monkeypatch)

    def _sample(media_path: Path, **kw: Any) -> list[VisualSpan]:
        if media_path.name == "corrupt.jpg":
            raise FFmpegError("ffmpeg exited with code 1: Invalid data found")
        return [_span(0.0, 3.0)]

    monkeypatch.setattr(service_module, "sample_asset", _sample)
    _seed_asset(tmp_path, "p1", "bad", "corrupt.jpg", _image_probe())
    _seed_asset(tmp_path, "p1", "good", "clip.mp4", _video_probe())

    response = _index(client, assetIds=["bad", "good"], maxAssets=2)
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    bad_item, good_item = body["items"]
    assert bad_item["ok"] is False and "Invalid data found" in bad_item["reason"]
    assert good_item["ok"] is True


def test_traversal_asset_path_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "esc", "../../etc/passwd", _video_probe())
    body = _index(client, assetIds=["esc"]).json()
    assert body["items"][0]["ok"] is False


def test_explicit_audio_asset_has_no_video(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    with open_brain(tmp_path, "p1") as store:
        audio = MediaInfo(
            path="/song.mp3",
            duration_seconds=5.0,
            format_name="mp3",
            streams=[StreamInfo(index=0, codec_type="audio", sample_rate=48000, channels=2)],
        ).model_dump(mode="json")
        store.upsert_asset("aud", path="song.mp3", content_sha256="h", probe=audio)
    body = _index(client, assetIds=["aud"]).json()
    assert body["items"][0]["ok"] is False
    assert "no video" in body["items"][0]["reason"]


def test_video_without_duration_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    # video + audio but no duration → not an image, but unplaceable.
    probe = MediaInfo(
        path="/x.mp4",
        format_name="mov,mp4",
        streams=[
            StreamInfo(index=0, codec_type="video", width=100, height=100, fps=30.0),
            StreamInfo(index=1, codec_type="audio", sample_rate=48000, channels=2),
        ],
    ).model_dump(mode="json")
    _seed_asset(tmp_path, "p1", "nod", "x.mp4", probe)
    body = _index(client, assetIds=["nod"]).json()
    assert body["items"][0]["ok"] is False
    assert "duration" in body["items"][0]["reason"]


def test_probe_missing_falls_back_to_inspect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    monkeypatch.setattr(
        service_module,
        "inspect_media",
        lambda path, *, timeout=None: MediaInfo.model_validate(_video_probe()),
    )
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("vid", path="clip.mp4", content_sha256="h")  # no probe
    body = _index(client, assetIds=["vid"]).json()
    assert body["indexed"] == 1


def test_content_change_reindexes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _index(client, assetIds=["vid"]).json()
    # Same asset id, new source bytes → the stale index is wiped and rebuilt.
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset("vid", path="clip.mp4", content_sha256="new-hash", probe=_video_probe())
    body = _index(client, assetIds=["vid"]).json()
    assert body["indexed"] == 1
    with open_brain(tmp_path, "p1") as store:
        spans = store.list_visual_spans("vid")
        assert len(spans) == 1 and spans[0].content_hash == "new-hash"


def test_a_provider_failure_leaves_the_shot_undescribed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch, describer=_FailingDescriber())
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 3.0)])
    body = _index(
        client,
        assetIds=["vid"],
        captionProvider={"kind": "openai", "model": "gpt-v", "apiKey": "sk"},
    ).json()
    assert body["indexed"] == 1 and body["captioned"] == 0
    # Reported as this asset's tier-2 failure, never as coverage and never as a dead job.
    assert body["items"][0]["tiers"]["described"].startswith("failed")
    with open_brain(tmp_path, "p1") as store:
        assert store.list_visual_captions("vid") == []
        assert store.list_shots(["vid"])[0].described is None


def test_caption_provider_backfills_an_already_embedded_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # First pass mirrors the old agent index_media path: vectors land, but there is
    # no caption credential. A later configured run must caption existing spans
    # without redundantly embedding them or returning early.
    first_client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    first = _index(first_client, assetIds=["vid"]).json()
    assert first["indexed"] == 1 and first["captioned"] == 0

    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 3.0)])
    second_client = _client(
        tmp_path, monkeypatch, describer=_FakeDescriber(model="vision-x")
    )
    second = _index(
        second_client,
        assetIds=["vid"],
        captionProvider={"kind": "openai", "model": "vision-x", "apiKey": "sk"},
    ).json()
    assert second["indexed"] == 0 and second["captioned"] == 1
    with open_brain(tmp_path, "p1") as store:
        assert store.list_visual_captions("vid")[0].text.startswith("A person speaks")

    # And a THIRD run describes nothing again: `existing_shot_tier_keys` is the resume
    # key, and re-describing costs either money or minutes.
    third = _index(
        _client(tmp_path, monkeypatch, describer=_FakeDescriber(model="vision-x")),
        assetIds=["vid"],
        captionProvider={"kind": "openai", "model": "vision-x", "apiKey": "sk"},
    ).json()
    assert third["captioned"] == 0


def test_caption_text_embeddings_rebuilt_with_project_doc(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from framepilot_engine.brain.embeddings import EmbedderResolution

    client = _client(tmp_path, monkeypatch, describer=_FakeDescriber())
    monkeypatch.setattr(
        service_module,
        "resolve_embedder",
        lambda model_dir: EmbedderResolution(embedder=_FakeTextEmbedder()),  # type: ignore[arg-type]
    )
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 3.0)])
    project = {"id": "p1", "name": "P", "timeline": {"tracks": []}, "assets": [], "transcript": []}
    body = _index(
        client,
        assetIds=["vid"],
        project=project,
        captionProvider={"kind": "anthropic", "model": "claude-x", "apiKey": "sk"},
    ).json()
    assert body["captioned"] == 1 and body["captionsReason"] is None
    with open_brain(tmp_path, "p1") as store:
        caption_embeddings = [
            e for e in store.list_embeddings("text-model") if e.owner_type == "caption"
        ]
        assert len(caption_embeddings) == 1


def test_jobid_reuse_across_kinds_conflicts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    with open_brain(tmp_path, "p1") as store:
        store.create_job("shared", kind="analyze-batch", payload={"assetIds": [], "cursor": 0})
    resp = _index(client, assetIds=["vid"], jobId="shared")
    assert resp.status_code == 409


def test_caller_supplied_jobid_is_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    body = _index(client, assetIds=["vid"], jobId="my-run").json()
    assert body["jobId"] == "my-run" and body["indexed"] == 1


def test_repoll_of_finished_job_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    done = _index(client, assetIds=["vid"]).json()
    repoll = _index(client, assetIds=["vid"], jobId=done["jobId"]).json()
    assert repoll["done"] is True and repoll["indexed"] == 0


def test_caption_without_text_embedder_still_stores_caption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # describer + project doc, but no ONNX text embedder → summary stored, not embedded.
    client = _client(tmp_path, monkeypatch, describer=_FakeDescriber())
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 3.0)])
    project = {"id": "p1", "name": "P", "timeline": {"tracks": []}, "assets": [], "transcript": []}
    body = _index(
        client,
        assetIds=["vid"],
        project=project,
        captionProvider={"kind": "anthropic", "model": "claude-x", "apiKey": "sk"},
    ).json()
    assert body["captioned"] == 1
    with open_brain(tmp_path, "p1") as store:
        assert store.list_embeddings("text-model") == []


def test_cancel_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings()))
    body = client.post(
        "/brain/visual/index/cancel", json={"projectId": "p1", "jobId": "j"}
    ).json()
    assert body["available"] is False and "projects_root" in body["reason"]


# --- GET /brain/visual/status ---------------------------------------------------


def test_status_unavailable_without_projects_root() -> None:
    client = TestClient(create_app(Settings()))
    body = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    assert body["available"] is False
    assert body["keyConfigured"] is False


def test_status_reports_coverage_and_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _index(client, assetIds=["vid"]).json()
    body = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    assert body["available"] is True
    assert body["keyConfigured"] is True
    assert body["backend"] in ("sqlite-vec", "brute-force")
    assert body["counts"]["spans"] == 1
    assert body["indexedAssets"] == 1
    assert body["totalAssets"] == 1
    assert body["lastJob"]["state"] == "done"
    assert body["lastJob"]["total"] == 1


def test_status_reports_no_jobs_before_indexing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    body = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    assert body["available"] is True
    assert body["lastJob"] is None
    assert body["totalAssets"] == 1 and body["indexedAssets"] == 0


def test_status_missing_brain_is_unavailable(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path, nvidia_embeddings_keys="k")))
    body = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    assert body["available"] is False
    assert body["keyConfigured"] is True


# --- MI7.2 failure drills -------------------------------------------------------
#
# Three properties the paced visual-index job must hold under failure:
#   1. A mid-job kill resumes from the on-disk journal and never re-embeds a
#      span that was already persisted.
#   2. Key exhaustion partway through a slice leaves no half-written span; the
#      resume covers exactly the remainder, each span embedded exactly once.
#   3. The brain is DERIVED: wiping it and rebuilding from sidecars reproduces
#      the SAME index decision by re-deriving vectors, never restoring them.
#
# The existing tests above prove the mechanics in isolation (single-asset
# exhaustion, single-slice resume-skip). These drills prove them as narratives
# across a simulated process kill, over multi-span batches, with exactly-once
# coverage asserted on the embedder itself.


class _ScriptedEmbedder:
    """Records every frame it embeds; optionally dies for one asset's batch.

    Each faked JPEG carries its own identity (see ``_drill_client``), so a test
    can assert exactly-once coverage across a kill/resume without a live model.
    A shared ``seen`` list lets two client instances (before/after the "kill")
    accumulate into one record, the way one process's key-ring would.
    """

    dim = 3

    def __init__(self, seen: list[bytes], *, fail_for: str | None = None) -> None:
        self._seen = seen
        self._fail_for = fail_for

    def embed_passages(self, images: list[bytes]) -> EmbedResult:
        if self._fail_for is not None and any(self._fail_for.encode() in img for img in images):
            # An asset's whole batch dies before any of its spans are persisted,
            # so the journal must show zero half-written spans for that asset.
            raise KeyRingExhaustedError(last_status=429, last_error="HTTP 429: rate limited")
        self._seen.extend(images)
        return EmbedResult(model=MODEL_ID, dim=self.dim, vectors=[[0.1, 0.2, 0.3]] * len(images))


def _drill_client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    embedder: object,
    *,
    spans_by_suffix: dict[str, list[float]],
) -> TestClient:
    """A sandboxed client whose sampler yields multiple, per-asset spans.

    Unlike ``_client`` (one span for every asset), this maps a media-path suffix
    to the span ``t0`` list for that asset, and encodes each frame's identity
    into its faked JPEG bytes so the embedder can prove exactly-once coverage.
    """
    monkeypatch.setattr(
        service_module,
        "resolve_visual_embedder",
        lambda keys=None, **_pack: VisualEmbedderResolution(client=embedder),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(service_module, "detect_scenes", lambda path, **kw: [])

    def _sample(media_path: str, **kw: Any) -> list[VisualSpan]:
        for suffix, t0s in spans_by_suffix.items():
            if str(media_path).endswith(suffix):
                return [_span(t, t + 1.0) for t in t0s]
        return [_span(0.0, 3.0)]

    monkeypatch.setattr(service_module, "sample_asset", _sample)
    monkeypatch.setattr(
        service_module,
        "extract_keyframe_jpeg",
        lambda media_path, t, **kw: f"jpeg::{media_path}@{t}".encode(),
    )
    settings = Settings(projects_root=tmp_path, nvidia_embeddings_keys="key-abc")
    return TestClient(create_app(settings))


def _index_decision(root: Path, project_id: str) -> dict[tuple[str, str, int, float], str]:
    """The index decision as span keys → content hash (the PK + source digest).

    Keyed on ``(asset_id, model, sampler_version, t0)`` with the span's
    ``content_hash`` — exactly the identity a re-index must reproduce.
    """
    with open_brain(root, project_id) as store:
        return {
            (s.asset_id, s.model, s.sampler_version, s.t0): s.content_hash
            for s in store.list_visual_spans()
        }


def test_kill_midjob_resumes_from_journal_without_reembedding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[bytes] = []
    spans_by_suffix = {"a.mp4": [0.0, 1.0, 2.0], "b.mp4": [0.0, 1.0]}
    client = _drill_client(
        tmp_path, monkeypatch, _ScriptedEmbedder(seen), spans_by_suffix=spans_by_suffix
    )
    _seed_asset(tmp_path, "p1", "a", "a.mp4", _video_probe())
    _seed_asset(tmp_path, "p1", "b", "b.mp4", _video_probe())

    # The tier-0 pass sweeps both assets first (plan VU8 §8.2); the slice that finishes
    # it continues into the embedding pass and indexes asset a (3 spans).
    started = _index(client, assetIds=["a", "b"], maxAssets=1).json()
    first = _index(client, assetIds=["a", "b"], maxAssets=1, jobId=started["jobId"]).json()
    assert first["done"] is False and first["cursor"] == 1
    a_frames = sorted(seen)
    assert len(a_frames) == 3  # a's three spans, embedded once

    # Simulate a process kill: drop the in-memory client, keep the on-disk
    # journal. A brand-new app resumes purely from the brain's cursor.
    resumed_client = _drill_client(
        tmp_path, monkeypatch, _ScriptedEmbedder(seen), spans_by_suffix=spans_by_suffix
    )
    resumed = _index(resumed_client, assetIds=["a", "b"], maxAssets=1, jobId=first["jobId"]).json()
    assert resumed["done"] is True and resumed["cursor"] == 2

    # a's frames were NOT re-embedded on resume; every span covered exactly once.
    assert len(seen) == 5 and len(set(seen)) == 5
    assert sorted(seen)[:3] == a_frames
    with open_brain(tmp_path, "p1") as store:
        assert len(store.list_visual_spans("a")) == 3
        assert len(store.list_visual_spans("b")) == 2
        assert store.visual_index_counts()["vectors"] == 5


def test_key_exhaustion_midslice_leaves_no_partial_span_and_resumes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[bytes] = []
    spans_by_suffix = {"a.mp4": [0.0, 1.0], "b.mp4": [0.0, 1.0, 2.0]}
    dying = _ScriptedEmbedder(seen, fail_for="b.mp4")
    client = _drill_client(tmp_path, monkeypatch, dying, spans_by_suffix=spans_by_suffix)
    _seed_asset(tmp_path, "p1", "a", "a.mp4", _video_probe())
    _seed_asset(tmp_path, "p1", "b", "b.mp4", _video_probe())

    # One slice covers BOTH assets: a is embedded + persisted, b's batch dies.
    body = _index(client, assetIds=["a", "b"], maxAssets=2).json()
    assert body["reason"] == "all_keys_failing" and body["done"] is False
    assert body["cursor"] == 1  # advanced past a only, never past the failed b

    with open_brain(tmp_path, "p1") as store:
        # a fully indexed; b has ZERO spans/vectors — no half-written span survives.
        assert len(store.list_visual_spans("a")) == 2
        assert store.list_visual_spans("b") == []
        assert store.list_visual_vectors("b") == []
        job = next(j for j in store.list_jobs() if j.kind == "visual-index")
        assert job.error == "all_keys_failing"
    assert len(seen) == 2  # only a's frames ever reached the embedder

    # A key returns: resume the SAME job → b finishes, each span embedded once.
    revived = _ScriptedEmbedder(seen)  # no fail_for → the key-ring recovered
    resumed_client = _drill_client(tmp_path, monkeypatch, revived, spans_by_suffix=spans_by_suffix)
    resumed = _index(resumed_client, assetIds=["a", "b"], maxAssets=2, jobId=body["jobId"]).json()
    assert resumed["done"] is True and resumed["cursor"] == 2 and resumed["indexed"] == 3

    with open_brain(tmp_path, "p1") as store:
        assert len(store.list_visual_spans("b")) == 3
        assert len(store.list_visual_spans("a")) == 2  # unchanged, not re-embedded
    # a's 2 + b's 3 = 5 embeds total, each exactly once (a not re-embedded).
    assert len(seen) == 5 and len(set(seen)) == 5


def test_brain_rebuild_from_sidecars_reproduces_index_decision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "a", "a.mp4", _video_probe())
    _seed_asset(tmp_path, "p1", "b", "b.mp4", _video_probe())
    assert _index(client, assetIds=["a", "b"], maxAssets=2).json()["done"] is True
    decision = _index_decision(tmp_path, "p1")
    assert len(decision) == 2  # one span per asset, each with a content hash

    # Export the sidecars (the portable, derived-source record), then WIPE the
    # brain db — it is a derived cache, so deleting it must lose nothing true.
    with open_brain(tmp_path, "p1") as store:
        brain_dir = store.path.parent
        db_file = store.path
        assert len(export_all_sidecars(store, brain_dir)) == 2
    db_file.unlink()

    # Rebuild from sidecars: the asset source (content hash + probe) returns, but
    # the DERIVED visual index does NOT — sidecars carry no spans/vectors.
    with open_brain(tmp_path, "p1") as store:
        assert import_sidecars(store, brain_dir) == 2
        assert store.visual_index_counts()["spans"] == 0  # nothing restored
        assert store.visual_index_counts()["vectors"] == 0

    # Re-index re-DERIVES the vectors from the sidecar-recorded source and must
    # reach the identical decision — re-index (indexed=2), not skip (indexed=0).
    rebuilt = _index(client, assetIds=["a", "b"], maxAssets=2).json()
    assert rebuilt["done"] is True and rebuilt["indexed"] == 2
    assert _index_decision(tmp_path, "p1") == decision


# --- Concurrency ------------------------------------------------------------


def test_concurrent_slices_for_the_same_job_do_not_double_process_or_clobber(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: two concurrent continuation calls for the SAME job used to
    each read the same starting cursor (three separate `open_brain` sessions
    per call, none of them serialized against each other), both pick up the
    same next asset, and leave the following one unprocessed even though the
    cursor advanced past it — losing progress while double-billing the
    embedder for the asset both happened to grab. `brain_visual_index_route`
    now holds a per-project lock across all three phases, so this is
    deterministic rather than a matter of timing luck.
    """

    class _SlowEmbedder:
        dim = 3

        def embed_passages(self, images: list[bytes]) -> EmbedResult:
            # Long enough that, without the fix, both requests' Phase 1 reads
            # land before either request's Phase 3 write.
            time.sleep(0.05)
            return EmbedResult(model=MODEL_ID, dim=3, vectors=[[0.1, 0.2, 0.3]] * len(images))

    client = _client(tmp_path, monkeypatch, embedder=_SlowEmbedder())
    _seed_asset(tmp_path, "p1", "a", "a.mp4", _video_probe())
    _seed_asset(tmp_path, "p1", "b", "b.mp4", _video_probe())
    _seed_asset(tmp_path, "p1", "c", "c.mp4", _video_probe())

    # Drive the tier-0 pass to its end first (plan VU8 §8.2) so the concurrent calls
    # below race on the EMBEDDING pass, which is where the clobber cost money.
    first = _index(client, assetIds=["a", "b", "c"], maxAssets=1).json()
    job_id = first["jobId"]
    while first["indexed"] == 0:
        first = _index(client, assetIds=["a", "b", "c"], maxAssets=1, jobId=job_id).json()
    assert first["done"] is False

    def worker() -> None:
        _index(client, assetIds=["a", "b", "c"], maxAssets=1, jobId=job_id)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    with open_brain(tmp_path, "p1") as store:
        job = next(j for j in store.list_jobs() if j.id == job_id)
        # Every asset advanced exactly once: the embedding cursor at the total, and one
        # span per asset — never an asset embedded twice while another was skipped.
        assert job.payload["deepCursor"] == 3
        assert store.visual_index_counts()["spans"] == 3


# --- Tier 2: the local Capability Pack arm (VU6) ---------------------------------


class _FakePackClient:
    """Stands in for ``LocalVisualDescribeClient`` at the service seam.

    Constructed with a handle exactly as the real one is, so the route's resolution order
    (pack beats hosted provider) is exercised rather than bypassed.
    """

    last: _FakePackClient | None = None

    def __init__(self, handle: Any, **_kw: Any) -> None:
        self.handle = handle
        self.pack_id = "framepilot.visual-describe"
        self.model_id = "framepilot/smolvlm2-2.2b-instruct-q4-k-m"
        self.requests: list[list[tuple[int, float, float]]] = []
        type(self).last = self

    def describe_shots(self, **kwargs: Any) -> list[Any]:
        from framepilot_engine.brain.local_visual_describe import ShotDescription

        spans = list(kwargs["shots"])
        self.requests.append(spans)
        return [
            ShotDescription(
                shot_index=index,
                facts=parse_described(
                    {
                        "summary": f"Shot {index}: a street at night.",
                        "subject": "street",
                        "action": "cars passing",
                        "setting": "city street at night",
                        "camera": {"shotSize": "WS", "angle": "eye-level", "movement": "static"},
                        "mood": "dark",
                        "onScreenText": [],
                        "quality": ["dim"],
                        "confidence": "low",
                    },
                    model=self.model_id,
                ),
            )
            for index, _t0, _t1 in spans
        ]


def _pack_handle(tmp_path: Path) -> str:
    """A host-resolved pack handle, as the desktop shell sends it on the request."""
    entrypoint = tmp_path / "framepilot-visual-describe"
    entrypoint.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    return json.dumps(
        {
            "packId": "framepilot.visual-describe",
            "version": "1.0.0",
            "releaseDigest": "a" * 64,
            "entrypoint": str(entrypoint),
            "capabilities": ["visual.describe"],
        }
    )


def _pack_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **kw: Any) -> TestClient:
    """A client whose tier-2 producer is a (faked) installed local pack."""
    monkeypatch.setattr(service_module, "LocalVisualDescribeClient", _FakePackClient)
    return _client(tmp_path, monkeypatch, **kw)


def test_a_keyless_machine_with_the_pack_describes_its_footage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The defect VU6 removes: tier 2 used to ride on the hosted embed pass.

    No embedding key and no vision provider — the shipped default plus one installed
    pack — and every measured shot still gets a structured description.
    """
    client = _pack_client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 1.5), (1.5, 3.0)])
    body = _index(
        client, assetIds=["vid"], visualDescribePack=_pack_handle(tmp_path)
    ).json()

    # No vision provider on the request at all: the pack is the whole producer.
    assert body["items"][0]["tiers"]["described"] == "ok"
    assert body["captioned"] == 2
    # No project document, so the summaries are stored and FTS-indexed but not
    # text-embedded — a different fact from "tier 2 could not run".
    assert body["captionsReason"] == (
        "no project document supplied; caption text-embeddings skipped"
    )
    assert _FakePackClient.last is not None
    assert _FakePackClient.last.requests == [[(0, 0.0, 1.5), (1, 1.5, 3.0)]]
    with open_brain(tmp_path, "p1") as store:
        shots = store.list_shots(["vid"])
        assert [s.described.summary for s in shots if s.described] == [
            "Shot 0: a street at night.",
            "Shot 1: a street at night.",
        ]
        # The measured tier is untouched by a tier-2 write.
        assert all(s.measured is not None for s in shots)
        assert [c.text for c in store.list_visual_captions("vid")] == [
            "Shot 0: a street at night.",
            "Shot 1: a street at night.",
        ]


def test_the_pack_is_preferred_over_a_configured_vision_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Same three reasons the tier-1 pack beats NVIDIA: no key, no frames leave the
    # machine, and the answer is free.
    describer = _FakeDescriber()
    client = _pack_client(tmp_path, monkeypatch, describer=describer)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 3.0)])
    _index(
        client,
        assetIds=["vid"],
        visualDescribePack=_pack_handle(tmp_path),
        captionProvider={"kind": "anthropic", "model": "claude-x", "apiKey": "sk"},
    ).json()
    assert describer.calls == []
    with open_brain(tmp_path, "p1") as store:
        described = store.list_shots(["vid"])[0].described
        assert described is not None and described.model.startswith("framepilot/smolvlm2")


def test_a_malformed_pack_handle_is_no_pack_not_a_failed_slice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 3.0)])
    body = _index(client, assetIds=["vid"], visualDescribePack="{not json").json()
    assert body["available"] is True
    assert body["tiers"]["described"].startswith("skipped:")
    assert body["reason"] is None


def test_tier2_stands_down_under_the_governors_low_memory_rule(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§8.3 is the ONLY scheduling mechanism tier 2 obeys — no second one was added."""
    from framepilot_engine.brain import governor as governor_module

    monkeypatch.setattr(governor_module, "free_memory_bytes", lambda: 100 * 1024 * 1024)
    client = _pack_client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 3.0)])
    body = _index(
        client, assetIds=["vid"], visualDescribePack=_pack_handle(tmp_path)
    ).json()
    assert body["items"][0]["tiers"]["described"] == "skipped: low_memory"
    with open_brain(tmp_path, "p1") as store:
        assert store.list_shots(["vid"])[0].described is None


def test_describing_is_resumed_not_repeated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = _pack_client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    _seed_measured_shots(tmp_path, "p1", "vid", [(0.0, 3.0)])
    handle = _pack_handle(tmp_path)
    assert _index(client, assetIds=["vid"], visualDescribePack=handle).json()["captioned"] == 1
    second = _index(
        _pack_client(tmp_path, monkeypatch), assetIds=["vid"], visualDescribePack=handle
    ).json()
    assert second["captioned"] == 0
    assert _FakePackClient.last is not None and _FakePackClient.last.requests == []


def test_an_asset_with_no_measured_shots_reports_a_hole(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Tier 0 is the floor under tier 2 as well. The fixture's bytes are not decodable, so
    # measurement fails and there is no shot list to describe — said plainly.
    client = _pack_client(tmp_path, monkeypatch)
    _seed_asset(tmp_path, "p1", "vid", "clip.mp4", _video_probe())
    body = _index(
        client, assetIds=["vid"], visualDescribePack=_pack_handle(tmp_path)
    ).json()
    assert (
        body["items"][0]["tiers"]["described"]
        == "skipped: no measured shots for the current bytes"
    )
