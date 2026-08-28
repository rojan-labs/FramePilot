"""Preparing a slice concurrently must change only how long it takes.

Preparation was strictly serial and, measured on real projects, about 98% of its wall
clock was waiting on the understanding provider — 60 photos cost 92.7s against roughly
1.5s of local CPU. The assets are independent, so a slice now prepares them together.

These are the guards that make that safe rather than merely fast:

- the same worklist produces the same spans and the same cursor at any concurrency;
- the cursor only ever advances over a PREFIX, so resume stays unambiguous;
- N assets cost exactly N provider calls — concurrency changes the rate, not the count;
- and the wait actually overlaps, asserted against a stubbed provider latency so the
  thing being measured is our concurrency and not the network.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.visual_sampler import VisualSpan
from framepilot_engine.brain.keyring import KeyRingExhaustedError
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.visual_embed import MODEL_ID, EmbedResult, VisualEmbedderResolution
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

ASSET_COUNT = 8
#: Stands in for the provider round-trip that dominates real wall clock.
CALL_LATENCY_SECONDS = 0.05


class _CountingEmbedder:
    """Counts calls, records peak concurrency, and sleeps like a network call."""

    dim = 3

    def __init__(self, latency: float = CALL_LATENCY_SECONDS) -> None:
        self.calls = 0
        self.frames = 0
        self.peak_in_flight = 0
        self._in_flight = 0
        self._lock = threading.Lock()
        self._latency = latency

    def embed_passages(self, images: list[bytes]) -> EmbedResult:
        with self._lock:
            self.calls += 1
            self.frames += len(images)
            self._in_flight += 1
            self.peak_in_flight = max(self.peak_in_flight, self._in_flight)
        try:
            time.sleep(self._latency)
            return EmbedResult(model=MODEL_ID, dim=3, vectors=[[0.1, 0.2, 0.3]] * len(images))
        finally:
            with self._lock:
                self._in_flight -= 1


class _FailsOnAsset:
    """Embeds everything except one asset's frame, which exhausts the key ring."""

    dim = 3

    def __init__(self, doomed_marker: bytes) -> None:
        self.doomed = doomed_marker

    def embed_passages(self, images: list[bytes]) -> EmbedResult:
        if any(self.doomed in image for image in images):
            raise KeyRingExhaustedError(last_status=429, last_error="HTTP 429: rate limited")
        return EmbedResult(model=MODEL_ID, dim=3, vectors=[[0.1, 0.2, 0.3]] * len(images))


def _image_probe(name: str) -> dict[str, Any]:
    return MediaInfo(
        path=f"/{name}",
        duration_seconds=0.04,
        format_name="image2",
        streams=[StreamInfo(index=0, codec_type="video", width=1200, height=1600)],
    ).model_dump(mode="json")


def _seed(root: Path, count: int = ASSET_COUNT) -> list[str]:
    ids = [f"img{i:02d}" for i in range(count)]
    for asset_id in ids:
        (root / f"{asset_id}.jpg").write_bytes(b"\x00fake\x00")
    with open_brain(root, "p1") as store:
        for asset_id in ids:
            store.upsert_asset(
                asset_id,
                path=f"{asset_id}.jpg",
                content_sha256=f"sha-{asset_id}",
                probe=_image_probe(f"{asset_id}.jpg"),
            )
    return ids


def _client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    embedder: object,
    *,
    concurrency: int,
) -> TestClient:
    monkeypatch.setattr(
        service_module,
        "resolve_visual_embedder",
        lambda keys=None: VisualEmbedderResolution(client=embedder),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(service_module, "detect_scenes", lambda path, **kw: [])
    monkeypatch.setattr(
        service_module,
        "sample_asset",
        lambda media_path, **kw: [
            VisualSpan(t0=0.0, t1=0.0, scene_index=0, keyframe_t=0.0, phash=1, frame_count=1)
        ],
    )
    # The keyframe carries its asset's name so a fake can single one out.
    monkeypatch.setattr(
        service_module,
        "extract_keyframe_jpeg",
        lambda media_path, t, **kw: b"\xff\xd8" + Path(media_path).stem.encode(),
    )
    return TestClient(
        create_app(
            Settings(
                projects_root=tmp_path,
                nvidia_embeddings_keys="nv-key",
                visual_index_concurrency=concurrency,
            )
        )
    )


def _run(client: TestClient, *, max_assets: int = ASSET_COUNT) -> Any:
    body: dict[str, Any] = {"projectId": "p1", "maxAssets": max_assets}
    last: Any = None
    for _ in range(50):
        last = client.post("/brain/visual/index", json=body).json()
        if not last["available"] or last["done"] or last.get("reason"):
            return last
        body["jobId"] = last["jobId"]
    return last


def _spans(root: Path) -> list[tuple[str, float, int]]:
    with open_brain(root, "p1") as store:
        return sorted((s.asset_id, s.t0, s.phash) for s in store.list_visual_spans(model=MODEL_ID))


# --- determinism ----------------------------------------------------------------


@pytest.mark.parametrize("concurrency", [1, 2, 8])
def test_the_result_is_identical_at_every_concurrency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, concurrency: int
) -> None:
    """Concurrency may change the timing and nothing else."""
    ids = _seed(tmp_path)
    embedder = _CountingEmbedder(latency=0.0)
    last = _run(_client(tmp_path, monkeypatch, embedder, concurrency=concurrency))
    assert last["done"] is True
    assert last["cursor"] == len(ids)
    assert [asset for asset, _, _ in _spans(tmp_path)] == sorted(ids)
    assert [i["assetId"] for i in last["items"]] == ids  # worklist order, always


def test_the_cursor_advances_over_a_prefix_even_when_a_later_asset_succeeded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Resume reads one cursor, so the completed set must be a prefix — never a hole.

    Asset 2 fails while 3..7 are in flight and may well finish first. The cursor must
    still stop at 2: their work is persisted and re-running them is a cheap no-op, but
    a cursor that skipped a failure would lose it silently.
    """
    _seed(tmp_path)
    client = _client(tmp_path, monkeypatch, _FailsOnAsset(b"img02"), concurrency=8)
    last = _run(client)
    assert last["done"] is False
    assert last["cursor"] == 2
    assert [i["assetId"] for i in last["items"]] == ["img00", "img01"]


# --- cost -----------------------------------------------------------------------


def test_concurrency_changes_the_rate_not_the_bill(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """N assets cost N provider calls, whatever the concurrency."""
    ids = _seed(tmp_path)
    embedder = _CountingEmbedder(latency=0.0)
    _run(_client(tmp_path, monkeypatch, embedder, concurrency=8))
    assert embedder.calls == len(ids)
    assert embedder.frames == len(ids)


# --- the wait actually overlaps -------------------------------------------------


def test_the_provider_wait_overlaps_instead_of_queueing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard against silently regressing to serial preparation.

    Latency is stubbed so what is measured is our concurrency, not a network. Asserted
    on observed in-flight overlap rather than wall clock, which is the property that
    matters and does not flake on a loaded CI box.
    """
    _seed(tmp_path)
    embedder = _CountingEmbedder()
    _run(_client(tmp_path, monkeypatch, embedder, concurrency=4))
    assert embedder.peak_in_flight > 1


def test_concurrency_one_restores_strictly_serial_preparation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The escape hatch has to actually be one."""
    _seed(tmp_path)
    embedder = _CountingEmbedder()
    _run(_client(tmp_path, monkeypatch, embedder, concurrency=1))
    assert embedder.peak_in_flight == 1
