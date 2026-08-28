"""A preparation that prepared nothing must not report a clean success.

The evidence this exists for is a real project: `project_new_proj_mtbeyu802xjq` holds
55 assets, about 100 `visual-index` jobs all `state='done'`, and zero visual spans and
zero hosted mappings. Every job completed having prepared nothing, the project is
silently unsearchable, and the reason no longer exists anywhere — `VisualIndexItem` was
returned once over HTTP and dropped.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.visual_sampler import VisualSpan
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.visual_embed import MODEL_ID, EmbedResult, VisualEmbedderResolution
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app
from framepilot_engine.visual_indexing import FrameExtractionError


class _Embedder:
    dim = 3

    def embed_passages(self, images: list[bytes]) -> EmbedResult:
        return EmbedResult(model=MODEL_ID, dim=3, vectors=[[0.1, 0.2, 0.3]] * len(images))


def _probe(name: str) -> dict[str, Any]:
    return MediaInfo(
        path=f"/{name}",
        duration_seconds=0.04,
        format_name="image2",
        streams=[StreamInfo(index=0, codec_type="video", width=1200, height=1600)],
    ).model_dump(mode="json")


def _seed(root: Path, ids: list[str]) -> None:
    for asset_id in ids:
        (root / f"{asset_id}.jpg").write_bytes(b"\x00fake\x00")
    with open_brain(root, "p1") as store:
        for asset_id in ids:
            store.upsert_asset(
                asset_id,
                path=f"{asset_id}.jpg",
                content_sha256=f"sha-{asset_id}",
                probe=_probe(f"{asset_id}.jpg"),
            )


def _client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, doomed: set[str] | None = None
) -> TestClient:
    monkeypatch.setattr(
        service_module,
        "resolve_visual_embedder",
        lambda keys=None: VisualEmbedderResolution(client=_Embedder()),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(service_module, "detect_scenes", lambda path, **kw: [])
    monkeypatch.setattr(
        service_module,
        "sample_asset",
        lambda media_path, **kw: [
            VisualSpan(t0=0.0, t1=0.0, scene_index=0, keyframe_t=0.0, phash=1, frame_count=1)
        ],
    )

    def extract(media_path: Any, t: float, **kw: Any) -> bytes:
        # A per-asset failure the engine already isolates: the file is there, the frame
        # will not decode. It must leave a trace the user can read.
        if doomed and Path(media_path).stem in doomed:
            raise FrameExtractionError(f"ffmpeg produced no frame for {Path(media_path).name}")
        return b"\xff\xd8jpeg"

    monkeypatch.setattr(service_module, "extract_keyframe_jpeg", extract)
    return TestClient(create_app(Settings(projects_root=tmp_path, nvidia_embeddings_keys="nv-key")))


def _run(client: TestClient) -> Any:
    body: dict[str, Any] = {"projectId": "p1", "maxAssets": 4}
    last: Any = None
    for _ in range(30):
        last = client.post("/brain/visual/index", json=body).json()
        if not last["available"] or last["done"] or last.get("reason"):
            return last
        body["jobId"] = last["jobId"]
    return last


def _status(client: TestClient) -> Any:
    return client.get("/brain/visual/status", params={"projectId": "p1"}).json()


def test_a_failed_asset_is_still_explained_after_the_response_is_gone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(tmp_path, ["good1", "bad1", "good2"])
    client = _client(tmp_path, monkeypatch, doomed={"bad1"})
    assert _run(client)["done"] is True

    status = _status(client)
    assert [f["assetId"] for f in status["failures"]] == ["bad1"]
    assert "no frame" in status["failures"][0]["reason"]
    # The successes leave no noise behind.
    assert status["indexedAssets"] == 2
    assert status["totalAssets"] == 3


def test_a_job_that_prepared_nothing_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`done` used to be the only signal, and it meant "we stopped", not "it worked"."""
    ids = ["a", "b", "c"]
    _seed(tmp_path, ids)
    client = _client(tmp_path, monkeypatch, doomed=set(ids))
    assert _run(client)["done"] is True  # the job really did finish its worklist

    status = _status(client)
    assert status["indexedAssets"] == 0
    assert [f["assetId"] for f in status["failures"]] == ids


def test_a_recovered_asset_stops_being_reported_as_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(tmp_path, ["flaky"])
    failing = _client(tmp_path, monkeypatch, doomed={"flaky"})
    _run(failing)
    assert len(_status(failing)["failures"]) == 1

    recovered = _client(tmp_path, monkeypatch)
    _run(recovered)
    assert _status(recovered)["failures"] == []


def test_a_failure_recorded_against_other_bytes_is_not_carried_forward(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Re-importing or re-encoding an asset must not inherit its old failure.

    The outcome is keyed on the content hash, which is the same invalidation the
    hosted-mapping and Pegasus-cache rows already use.
    """
    _seed(tmp_path, ["shot"])
    _run(_client(tmp_path, monkeypatch, doomed={"shot"}))
    with open_brain(tmp_path, "p1") as store:
        store.upsert_asset(
            "shot", path="shot.jpg", content_sha256="sha-different", probe=_probe("shot.jpg")
        )
    client = _client(tmp_path, monkeypatch, doomed={"shot"})
    assert _status(client)["failures"] == []
