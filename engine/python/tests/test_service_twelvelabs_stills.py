"""Still photos must be prepared and mapped even while TwelveLabs is the backend.

Regression cover for the reported defect: a 61-photo project sat at
``0/61 assets prepared · 0%`` with a blue "running" badge and never produced a
footage map. TwelveLabs' index is a video/audio index — a still uploads but
cannot be attached to it, and the resulting ``404 resource_not_exists`` broke the
slice *without advancing the cursor*, so every retry re-hit photo #1 forever.

Three separate behaviours are pinned here:

1. stills are routed to the built-in on-device embedder instead of the hosted
   index, so a photo project is understood and mappable;
2. one asset the provider refuses advances the cursor instead of freezing the
   assets behind it;
3. a run of refusals stops the slice AND marks the job failed, so the panel can
   never show "running" for work that has given up.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.visual_sampler import VisualSpan
from framepilot_engine.brain.described import parse_described
from framepilot_engine.brain.ledger_models import (
    TIER0_VERSION,
    ChromaStats,
    LumaStats,
    MeasuredFacts,
    MotionClass,
    MotionStats,
    ShotRecord,
)
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.twelvelabs import (
    TaskStatus,
    TwelveLabsClientResolution,
    TwelveLabsError,
)
from framepilot_engine.brain.visual_embed import (
    MODEL_ID,
    EmbedResult,
    VisualEmbedderResolution,
)
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

# --- fakes ----------------------------------------------------------------------


class _FakeEmbedder:
    dim = 3

    def __init__(self) -> None:
        self.frames = 0

    def embed_passages(self, images: list[bytes]) -> EmbedResult:
        self.frames += len(images)
        return EmbedResult(model=MODEL_ID, dim=3, vectors=[[0.1, 0.2, 0.3]] * len(images))


class _FakeDescriber:
    """A hosted tier-2 describer, answering the structured schema (VU6.3)."""

    model = "vision-x"

    def describe_scene(self, frames_jpeg: list[bytes]) -> Any:
        return parse_described(
            {
                "summary": "Hikers on a ridge at golden hour.",
                "subject": "two hikers",
                "action": "walking along a ridge",
                "setting": "mountain ridge at sunset",
                "camera": {"shotSize": "WS", "angle": "eye-level", "movement": "static"},
                "mood": "warm",
                "onScreenText": [],
                "quality": ["backlit"],
                "confidence": "medium",
            },
            model=self.model,
        )


class _RecordingTL:
    """A TwelveLabs client that records uploads and can refuse chosen assets.

    ``refuse`` holds the file names the hosted backend rejects (the real 404 the
    defect produced). Anything not listed indexes normally.
    """

    def __init__(self, refuse: set[str] | None = None) -> None:
        self.refuse = refuse or set()
        self.uploads: list[str] = []

    def create_index(self, name: str) -> str:
        return "idx-1"

    def create_index_task(self, index_id: str, media_path: Path) -> str:
        self.uploads.append(media_path.name)
        if media_path.name in self.refuse:
            raise TwelveLabsError("TwelveLabs API error (HTTP 404) (resource_not_exists).")
        return f"task-{media_path.name}"

    def get_task(self, task_id: str) -> TaskStatus:
        return TaskStatus(task_id, "ready", f"video-{task_id}")


# --- fixtures -------------------------------------------------------------------


def _image_probe(name: str) -> dict[str, Any]:
    """A WhatsApp-style photo: one video stream, `image2`, bogus 0.04s duration."""
    return MediaInfo(
        path=f"/{name}",
        duration_seconds=0.04,
        format_name="image2",
        streams=[StreamInfo(index=0, codec_type="video", width=1200, height=1600)],
    ).model_dump(mode="json")


def _video_probe(name: str) -> dict[str, Any]:
    return MediaInfo(
        path=f"/{name}",
        duration_seconds=6.0,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0)],
    ).model_dump(mode="json")


def _seed_measured_shot(root: Path, asset_id: str, t0: float, t1: float) -> None:
    """Give an asset a tier-0 shot without decoding anything."""
    with open_brain(root, "p1") as store:
        store.upsert_shots(
            asset_id,
            f"sha-{asset_id}",
            "measured",
            [
                ShotRecord(
                    asset_id=asset_id,
                    content_hash=f"sha-{asset_id}",
                    shot_index=0,
                    t0=t0,
                    t1=t1,
                    keyframe_t=t0,
                    measured=MeasuredFacts(
                        tier0_version=TIER0_VERSION,
                        luma=LumaStats(mean=0.5, std=0.1, p10=0.2, p90=0.8),
                        chroma=ChromaStats(u_mean=128.0, v_mean=128.0, sat_mean=0.2),
                        warmth=0.0,
                        contrast_idx=0.6,
                        motion=MotionStats(si=10.0, ti=0.0, motion_class=MotionClass.STATIC),
                        cut_score=0.0,
                        black=False,
                        freeze=False,
                        sharpness=0.8,
                    ),
                )
            ],
        )


def _seed(root: Path, assets: list[tuple[str, str, dict[str, Any]]]) -> None:
    for _asset_id, name, _probe in assets:
        (root / name).write_bytes(b"\x00\x00fake\x00\x00")
    with open_brain(root, "p1") as store:
        for asset_id, name, probe in assets:
            store.upsert_asset(asset_id, path=name, content_sha256=f"sha-{asset_id}", probe=probe)


def _client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    tl: _RecordingTL,
    *,
    embedder: _FakeEmbedder | None,
    describer: object | None = None,
) -> TestClient:
    monkeypatch.setattr(
        service_module,
        "resolve_twelvelabs",
        lambda key=None: TwelveLabsClientResolution(client=tl),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(
        service_module,
        "resolve_visual_embedder",
        lambda keys=None, **_pack: (
            VisualEmbedderResolution(client=embedder)  # type: ignore[arg-type]
            if embedder is not None
            else VisualEmbedderResolution(client=None, reason="no_api_key")
        ),
    )
    if describer is not None:
        from framepilot_engine.brain.captioner import DescriberResolution

        monkeypatch.setattr(
            service_module,
            "resolve_describer",
            lambda cfg, **kw: DescriberResolution(describer=describer),  # type: ignore[arg-type]
        )
    monkeypatch.setattr(service_module, "detect_scenes", lambda path, **kw: [])
    monkeypatch.setattr(
        service_module,
        "sample_asset",
        lambda media_path, **kw: [
            VisualSpan(t0=0.0, t1=0.0, scene_index=0, keyframe_t=0.0, phash=1, frame_count=1)
        ],
    )
    monkeypatch.setattr(
        service_module, "extract_keyframe_jpeg", lambda media_path, t, **kw: b"\xff\xd8jpeg"
    )
    settings = Settings(
        projects_root=tmp_path,
        twelvelabs_api_key="tl-key",
        nvidia_embeddings_keys="nv-key" if embedder is not None else None,
    )
    return TestClient(create_app(settings))


def _run_to_completion(client: TestClient, *, max_slices: int = 20) -> Any:
    """Drive the paced job the way the host loop does, and return the last slice."""
    body: dict[str, Any] = {"projectId": "p1", "maxAssets": 2}
    last: Any = None
    for _ in range(max_slices):
        last = client.post("/brain/visual/index", json=body).json()
        if not last["available"] or last["done"] or last.get("reason"):
            return last
        body["jobId"] = last["jobId"]
    return last


# --- stills are understood, not dropped -----------------------------------------


def test_photo_project_is_prepared_on_device_while_twelvelabs_is_active(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The reported defect, end to end: photos only, both keys, hosted backend."""
    _seed(tmp_path, [(f"img{i}", f"photo{i}.jpg", _image_probe(f"photo{i}.jpg")) for i in range(5)])
    tl = _RecordingTL()
    embedder = _FakeEmbedder()
    client = _client(tmp_path, monkeypatch, tl, embedder=embedder)

    last = _run_to_completion(client)
    assert last["available"] is True
    assert last["done"] is True, last
    assert last["cursor"] == 5

    # No photo was ever offered to the hosted index — that is the 404 that froze it.
    assert tl.uploads == []
    assert embedder.frames == 5

    status = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    assert status["indexedAssets"] == 5
    assert status["totalAssets"] == 5
    assert status["lastJob"]["state"] == "done"

    # And the footage map exists, which is what the user actually asked for.
    map_body = client.post(
        "/brain/visual/footage-map", json={"projectId": "p1", "assetTime": True}
    ).json()
    assert map_body["available"] is True
    assert map_body.get("reason") is None
    assert len(map_body["chapters"]) == 5
    assert {c["assetId"] for c in map_body["chapters"]} == {f"img{i}" for i in range(5)}


def test_mixed_project_routes_footage_to_twelvelabs_and_stills_on_device(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(
        tmp_path,
        [
            ("img1", "photo1.jpg", _image_probe("photo1.jpg")),
            ("vid1", "clip1.mp4", _video_probe("clip1.mp4")),
            ("img2", "photo2.jpg", _image_probe("photo2.jpg")),
        ],
    )
    tl = _RecordingTL()
    embedder = _FakeEmbedder()
    client = _client(tmp_path, monkeypatch, tl, embedder=embedder)

    last = _run_to_completion(client)
    assert last["done"] is True and last["cursor"] == 3
    assert tl.uploads == ["clip1.mp4"]  # only the moving footage
    assert embedder.frames == 2  # only the stills

    status = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    # Coverage is the union of both backends; counting only the hosted mappings
    # reported 1/3 for a fully prepared project.
    assert status["indexedAssets"] == 3
    assert status["totalAssets"] == 3


def test_still_without_an_on_device_key_is_reported_and_never_blocks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(
        tmp_path,
        [
            ("img1", "photo1.jpg", _image_probe("photo1.jpg")),
            ("vid1", "clip1.mp4", _video_probe("clip1.mp4")),
        ],
    )
    tl = _RecordingTL()
    client = _client(tmp_path, monkeypatch, tl, embedder=None)

    last = _run_to_completion(client)
    assert last["done"] is True and last["cursor"] == 2
    still = next(i for i in last["items"] if i["assetId"] == "img1")
    assert still["ok"] is False
    assert "still images are not indexable by TwelveLabs" in still["reason"]
    # The video behind it was still prepared — no head-of-line block.
    assert tl.uploads == ["clip1.mp4"]


# --- one bad asset must not freeze the project ----------------------------------


def test_one_refused_asset_advances_the_cursor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(
        tmp_path,
        [
            ("vid1", "clip1.mp4", _video_probe("clip1.mp4")),
            ("vid2", "clip2.mp4", _video_probe("clip2.mp4")),
        ],
    )
    tl = _RecordingTL(refuse={"clip1.mp4"})
    client = _client(tmp_path, monkeypatch, tl, embedder=_FakeEmbedder())

    last = _run_to_completion(client)
    assert last["done"] is True, last
    assert last["cursor"] == 2
    refused = next(i for i in last["items"] if i["assetId"] == "vid1")
    assert refused["ok"] is False and "resource_not_exists" in refused["reason"]
    # A slice prepares its assets concurrently, so upload ORDER is not a property worth
    # asserting; that both were attempted, and that the cursor walked both in worklist
    # order, is.
    assert sorted(tl.uploads) == ["clip1.mp4", "clip2.mp4"]
    assert [i["assetId"] for i in last["items"]] == ["vid1", "vid2"]

    status = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    assert status["indexedAssets"] == 1  # only the asset that really indexed
    assert status["lastJob"]["state"] == "done"


def test_a_run_of_refusals_stops_the_slice_and_fails_the_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A broken index/account must stop, not upload (and bill for) every asset."""
    names = [f"clip{i}.mp4" for i in range(6)]
    _seed(tmp_path, [(f"vid{i}", n, _video_probe(n)) for i, n in enumerate(names)])
    tl = _RecordingTL(refuse=set(names))
    client = _client(tmp_path, monkeypatch, tl, embedder=_FakeEmbedder())

    last = _run_to_completion(client)
    assert last["done"] is False
    assert "resource_not_exists" in last["reason"]
    # Stopped near the consecutive-failure bound instead of burning all six. The assets
    # already in flight when the bound trips still complete, so the ceiling is the limit
    # plus concurrency - 1 — bounded and small, against a project that would otherwise be
    # uploaded in full.
    assert len(tl.uploads) < len(names)
    assert len(tl.uploads) <= service_module.TL_CONSECUTIVE_FAILURE_LIMIT + 1

    status = client.get("/brain/visual/status", params={"projectId": "p1"}).json()
    # The defect's most misleading symptom: a job that had given up still read
    # "running" at 0%. It must read failed, with its reason.
    assert status["lastJob"]["state"] == "failed"
    assert "resource_not_exists" in status["lastJob"]["error"]


def test_a_still_is_described_so_its_chapter_has_a_real_title(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A map of sixty identical "Scene 1" rows is not a map the model can use.

    A still is the one asset TwelveLabs cannot describe at all, so tier 2 runs locally for
    it — writing the same `shots.described` row and the same `visual_captions.summary` the
    built-in route writes.
    """
    _seed(tmp_path, [("img1", "photo1.jpg", _image_probe("photo1.jpg"))])
    # Tier 2 describes SHOTS, so the tier-0 floor has to exist. The fixture's bytes are
    # not decodable media, so it is seeded rather than measured.
    _seed_measured_shot(tmp_path, "img1", 0.0, 0.04)
    client = _client(
        tmp_path,
        monkeypatch,
        _RecordingTL(),
        embedder=_FakeEmbedder(),
        describer=_FakeDescriber(),
    )
    last = _run_to_completion(client)
    assert last["done"] is True
    assert last["items"][0]["captioned"] == 1

    map_body = client.post(
        "/brain/visual/footage-map", json={"projectId": "p1", "assetTime": True}
    ).json()
    assert [c["title"] for c in map_body["chapters"]] == ["Hikers on a ridge at golden hour."]
