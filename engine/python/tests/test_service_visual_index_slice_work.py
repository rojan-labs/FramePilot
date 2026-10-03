"""No ``/brain/visual/index`` slice waits on work that scales with the media.

The defect, measured: a 58:51, 1.05 GB interview held ONE index request open for its
tier-0 decode (72.7 s — which failed its flat 60 s ffmpeg bound, so the asset never got
a shot ledger) and then its TwelveLabs multipart upload (100 x 10 MB chunks, 5.3 min).
The host gave up at 300 s and the asset was never indexed.

Both steps now run on a ``SliceWork`` thread: a slice waits a bounded time, and while
the work is still running the asset keeps the job cursor and a later slice collects the
SAME work. These tests inject a ``SliceWork`` whose units run only when the test says
so, and set the waits to zero, so "still running" is a state the test controls and
nothing sleeps. The decode and the TwelveLabs client are faked at the service seam, the
same pattern ``test_service_shot_ledger.py`` and ``test_service_twelvelabs.py`` use;
every brain write is real SQLite.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.shot_stats import ShotStats
from framepilot_engine.brain.governor import IndexGovernor
from framepilot_engine.brain.slice_work import SliceWork
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.twelvelabs import (
    TaskStatus,
    TwelveLabsClientResolution,
    TwelveLabsError,
)
from framepilot_engine.brain.twelvelabs_index import read_video_mapping
from framepilot_engine.config import Settings
from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

#: The measured source: 58:51.
_LONG_SOURCE_SECONDS = 3531.0
_MEDIA_TIMEOUT_SECONDS = 60
#: Bounds a hang in the real-thread tests; never what a test waits for.
_SAFETY_BUDGET = 10.0


class _ManualSpawn:
    """A ``SliceWork`` spawn that queues each unit until :meth:`run_all`."""

    def __init__(self) -> None:
        self.queued: list[Callable[[], None]] = []

    def __call__(self, target: Callable[[], None], name: str) -> None:
        self.queued.append(target)

    def run_all(self) -> None:
        queued, self.queued = self.queued, []
        for target in queued:
            target()


class _FakeTL:
    """Only the calls the hosted index slice makes; counts uploads and polls."""

    #: The real client derives this from its key; a fixed value is one stable "account".
    key_fingerprint = "fp-current"

    def __init__(self, *, upload_error: Exception | None = None) -> None:
        self.upload_error = upload_error
        self.uploads: list[str] = []
        self.polls = 0

    def index_accessible(self, index_id: str) -> bool:
        return True

    def find_index(self, name: str) -> str | None:
        return None

    def create_index(self, name: str) -> str:
        return "idx-1"

    def create_index_task(self, index_id: str, media_path: Path) -> str:
        self.uploads.append(media_path.name)
        if self.upload_error is not None:
            raise self.upload_error
        return "task-1"

    def get_task(self, task_id: str) -> TaskStatus:
        self.polls += 1
        return TaskStatus(task_id, "ready", "video-xyz")


def _probe(duration: float, *, with_audio: bool = False) -> dict[str, Any]:
    streams = [StreamInfo(index=0, codec_type="video", width=1080, height=608, fps=30.0)]
    if with_audio:
        streams.append(StreamInfo(index=1, codec_type="audio"))
    return MediaInfo(
        path="/interview.mp4",
        duration_seconds=duration,
        format_name="mov,mp4,m4a",
        streams=streams,
    ).model_dump(mode="json")


@pytest.fixture
def root(tmp_path: Path) -> Path:
    """A sandbox of this test's own (the conftest ``projects_root`` is session-wide)."""
    path = tmp_path / "projects"
    path.mkdir()
    return path


def _seed_asset(
    root: Path, asset_id: str = "a0", *, duration: float = 12.0, with_audio: bool = False
) -> None:
    (root / f"{asset_id}.mp4").write_bytes(b"\x00\x00fake\x00\x00")
    with open_brain(root, "p1") as store:
        store.upsert_asset(
            asset_id,
            path=f"{asset_id}.mp4",
            content_sha256=f"sha-{asset_id}",
            probe=_probe(duration, with_audio=with_audio),
        )


def _stats(shot_index: int, t0: float, t1: float) -> ShotStats:
    return ShotStats(
        shot_index=shot_index,
        t0=t0,
        t1=t1,
        keyframe_t=(t0 + t1) / 2,
        luma_mean=0.4,
        luma_std=0.18,
        luma_p10=0.08,
        luma_p90=0.86,
        u_mean=124.1,
        v_mean=133.8,
        sat_mean=0.31,
        warmth=0.14,
        contrast_idx=0.62,
        si=41.2,
        ti=1.0,
        motion_class="static",
        cut_score=0.31,
        black=False,
        freeze=False,
        sharpness=0.71,
    )


def _fake_decodes(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """Fake tier 0's decodes; returns the list of paths ``measure_asset`` was run on."""
    measured: list[Path] = []

    def _measure(path: Path, **_kw: Any) -> list[ShotStats]:
        measured.append(path)
        return [_stats(0, 0.0, 6.0), _stats(1, 6.0, 12.0)]

    monkeypatch.setattr(service_module, "measure_asset", _measure)
    monkeypatch.setattr(service_module, "keyframe_dhashes", lambda *_a, **_kw: {})
    return measured


def _app(root: Path, spawn: _ManualSpawn, **settings: Any) -> TestClient:
    return TestClient(
        create_app(
            Settings(
                projects_root=root,
                asset_media_timeout_seconds=_MEDIA_TIMEOUT_SECONDS,
                **settings,
            ),
            slice_work=SliceWork(spawn=spawn),
        )
    )


def _post(client: TestClient, job_id: str | None = None, **body: Any) -> Any:
    payload: dict[str, Any] = {"projectId": "p1", **body}
    if job_id is not None:
        payload["jobId"] = job_id
    return client.post("/brain/visual/index", json=payload).json()


def _assert_still_working(body: dict[str, Any], *, reason: str) -> None:
    """Not done, NOT terminal, cursor kept, and the state on the item only.

    A response-level ``reason`` on a not-done slice is the host loop's TERMINAL signal
    (``visual-index-client.ts``: "keys-failing"), so a step that is merely still running
    must never put one there.
    """
    assert body["available"] is True
    assert body["done"] is False
    assert body["reason"] is None
    assert body["cursor"] == 0
    assert [(item["assetId"], item["ok"], item["reason"]) for item in body["items"]] == [
        ("a0", True, reason)
    ]


def _shot_count(root: Path, *asset_ids: str) -> int:
    with open_brain(root, "p1") as store:
        return len(store.list_shots(list(asset_ids or ("a0",))))


# --- Tier 0 -------------------------------------------------------------------------


def test_a_long_measurement_keeps_the_cursor_and_a_later_slice_collects_it(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(root)
    measured = _fake_decodes(monkeypatch)
    monkeypatch.setattr(service_module, "TIER0_SLICE_WAIT_SECONDS", 0.0)
    spawn = _ManualSpawn()
    client = _app(root, spawn)

    first = _post(client)
    _assert_still_working(first, reason="measuring")
    assert first["items"][0]["tiers"]["measured"] == "pending: measuring"
    assert _shot_count(root) == 0

    # Re-posted while the decode runs: the same decode, not a second one.
    again = _post(client, first["jobId"])
    _assert_still_working(again, reason="measuring")
    assert len(spawn.queued) == 1

    spawn.run_all()
    collected = _post(client, first["jobId"])

    assert measured == [root / "a0.mp4"]
    assert _shot_count(root) == 2
    assert collected["done"] is True
    assert collected["items"][0]["tiers"]["measured"] == "ok"
    assert collected["coverage"]["measured"] == 2


def test_a_measurement_that_failed_between_slices_fails_only_that_asset(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(root)
    monkeypatch.setattr(service_module, "keyframe_dhashes", lambda *_a, **_kw: {})

    def _measure(path: Path, **_kw: Any) -> list[ShotStats]:
        raise FFmpegError("Timed out after 3531.0s: ffmpeg")

    monkeypatch.setattr(service_module, "measure_asset", _measure)
    monkeypatch.setattr(service_module, "TIER0_SLICE_WAIT_SECONDS", 0.0)
    spawn = _ManualSpawn()
    client = _app(root, spawn)

    first = _post(client)
    _assert_still_working(first, reason="measuring")
    spawn.run_all()
    collected = _post(client, first["jobId"])

    item = collected["items"][0]
    assert item["ok"] is False
    assert item["tiers"]["measured"] == "failed: Timed out after 3531.0s: ffmpeg"
    assert _shot_count(root) == 0


@pytest.mark.parametrize(
    ("duration", "decode_bound"),
    [
        # The measured source: one second per media second, far past the flat 60 s.
        (_LONG_SOURCE_SECONDS, _LONG_SOURCE_SECONDS),
        # A short clip keeps the usual media timeout as its floor.
        (12.0, float(_MEDIA_TIMEOUT_SECONDS)),
    ],
)
def test_tier_zero_whole_file_passes_get_a_duration_scaled_timeout(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
    duration: float,
    decode_bound: float,
) -> None:
    _seed_asset(root, duration=duration, with_audio=True)
    seen: dict[str, float] = {}

    def _measure(path: Path, **kw: Any) -> list[ShotStats]:
        seen["measure"] = kw["timeout"]
        return [_stats(0, 0.0, duration)]

    def _hashes(path: Path, times: Any, **kw: Any) -> dict[int, str]:
        seen["keyframes"] = kw["timeout"]
        return {}

    def _loudness(path: Path, spans: Any, **kw: Any) -> dict[int, float]:
        seen["loudness"] = kw["timeout"]
        return {}

    monkeypatch.setattr(service_module, "measure_asset", _measure)
    monkeypatch.setattr(service_module, "keyframe_dhashes", _hashes)
    monkeypatch.setattr(service_module, "measure_shot_loudness", _loudness)
    # The real daemon-thread registry: the slice waits for the (instant) fake and
    # collects it in the same call.
    client = TestClient(
        create_app(
            Settings(projects_root=root, asset_media_timeout_seconds=_MEDIA_TIMEOUT_SECONDS),
        )
    )

    body = _post(client, tiers=["measured"])

    assert body["done"] is True
    assert seen == {
        "measure": decode_bound,
        "loudness": decode_bound,
        # One short seek per shot: the per-call bound stays the media timeout.
        "keyframes": float(_MEDIA_TIMEOUT_SECONDS),
    }


def test_background_decodes_keep_the_governors_tier_zero_bound(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A slice that moves on from a still-decoding asset must not stack another ffmpeg.

    Four cores is one tier-0 worker (``TIER0_CORES_PER_WORKER``). The decodes outlive
    the pool worker that started them, so only the decode gate can hold that bound.
    """
    _seed_asset(root, "a0")
    _seed_asset(root, "a1")
    monkeypatch.setattr(service_module, "keyframe_dhashes", lambda *_a, **_kw: {})
    monkeypatch.setattr(
        service_module, "IndexGovernor", lambda **kw: IndexGovernor(cpu_count=4, **kw)
    )
    release, first_in = threading.Event(), threading.Event()
    lock = threading.Lock()
    decoding = {"now": 0, "peak": 0, "runs": 0}

    def _measure(path: Path, **_kw: Any) -> list[ShotStats]:
        with lock:
            decoding["now"] += 1
            decoding["runs"] += 1
            decoding["peak"] = max(decoding["peak"], decoding["now"])
        first_in.set()
        release.wait(_SAFETY_BUDGET)
        with lock:
            decoding["now"] -= 1
        return [_stats(0, 0.0, 12.0)]

    monkeypatch.setattr(service_module, "measure_asset", _measure)
    monkeypatch.setattr(service_module, "TIER0_SLICE_WAIT_SECONDS", 0.0)
    client = TestClient(create_app(Settings(projects_root=root, asset_media_timeout_seconds=60)))

    first = _post(client, tiers=["measured"])
    _assert_still_working(first, reason="measuring")
    assert first_in.wait(_SAFETY_BUDGET)
    release.set()
    # Collected as soon as each decode ends; the budget only bounds a hang.
    monkeypatch.setattr(service_module, "TIER0_SLICE_WAIT_SECONDS", _SAFETY_BUDGET)
    collected = _post(client, first["jobId"], tiers=["measured"])

    assert collected["done"] is True
    assert _shot_count(root, "a0", "a1") == 2
    assert decoding["runs"] == 2
    assert decoding["peak"] == 1


# --- TwelveLabs ---------------------------------------------------------------------


def _tl_client(
    root: Path, spawn: _ManualSpawn, fake: _FakeTL, monkeypatch: pytest.MonkeyPatch
) -> TestClient:
    monkeypatch.setattr(
        service_module,
        "resolve_twelvelabs",
        lambda key=None: TwelveLabsClientResolution(client=fake),  # type: ignore[arg-type]
    )
    monkeypatch.setattr(service_module, "TIER0_SLICE_WAIT_SECONDS", 0.0)
    monkeypatch.setattr(service_module, "TL_SLICE_POLL_BUDGET_SECONDS", 0.0)
    return _app(root, spawn, twelvelabs_api_key="tl-key")


def test_twelvelabs_waits_for_tier_zero_then_collects_one_upload_across_slices(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(root)
    _fake_decodes(monkeypatch)
    spawn = _ManualSpawn()
    fake = _FakeTL()
    client = _tl_client(root, spawn, fake, monkeypatch)

    # Slice 1: tier 0 still decoding. TwelveLabs is not touched at all — a terminal
    # failure there would be re-uploaded on every re-post while the decode finishes.
    first = _post(client)
    _assert_still_working(first, reason="measuring")
    assert fake.uploads == [] and len(spawn.queued) == 1
    spawn.run_all()

    # Slice 2: tier 0 collected and written; the upload starts and outlives the wait.
    second = _post(client, first["jobId"])
    _assert_still_working(second, reason="uploading")
    assert second["items"][0]["tiers"]["measured"] == "ok"
    assert _shot_count(root) == 2

    # Slice 3: still uploading. The same upload, and still no mapping for it.
    third = _post(client, first["jobId"])
    _assert_still_working(third, reason="uploading")
    assert len(spawn.queued) == 1
    with open_brain(root, "p1") as store:
        assert read_video_mapping(store, "a0") is None

    spawn.run_all()
    collected = _post(client, first["jobId"])

    assert fake.uploads == ["a0.mp4"]
    assert fake.polls == 1
    assert collected["done"] is True and collected["reason"] is None
    assert collected["indexed"] == 1
    with open_brain(root, "p1") as store:
        mapping = read_video_mapping(store, "a0")
    assert mapping is not None and mapping.ready and mapping.video_id == "video-xyz"


def test_an_upload_that_failed_between_slices_takes_the_existing_failure_path(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_asset(root)
    spawn = _ManualSpawn()
    fake = _FakeTL(upload_error=TwelveLabsError("chunk 37 upload failed: HTTP 503"))
    client = _tl_client(root, spawn, fake, monkeypatch)

    first = _post(client, tiers=["labelled"])
    _assert_still_working(first, reason="uploading")
    spawn.run_all()
    collected = _post(client, first["jobId"], tiers=["labelled"])

    # Recorded `failed` so a later job retries it, and — the only asset having failed —
    # the job ends with the provider's sentence rather than `done` with nothing indexed.
    assert collected["done"] is False
    assert collected["reason"] == "chunk 37 upload failed: HTTP 503"
    assert collected["items"][0]["ok"] is False
    with open_brain(root, "p1") as store:
        mapping = read_video_mapping(store, "a0")
    assert mapping is not None and mapping.status == "failed"
    assert fake.uploads == ["a0.mp4"]
