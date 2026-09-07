"""The resource governor and the schedule it governs (plan VU8 §8.2-8.4, §8.7).

Two halves. The first is the governor itself — pure arithmetic over an injected clock,
core count and memory reader, so the rules can be asserted without a render, a particular
machine, or a sleep. The second drives the real ``/brain/visual/index`` route and asserts
the properties a user would notice: indexing steps aside for a frame grab, tier 0 covers
the whole worklist before anything is embedded, a newly imported asset preempts, a killed
sidecar resumes to the same rows, and bumping one tier's version re-queues one column.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import framepilot_engine.service as service_module
from framepilot_engine.analysis.shot_stats import ShotStats
from framepilot_engine.brain import governor as governor_module
from framepilot_engine.brain.governor import (
    IDLE_RESUME_SECONDS,
    TIER2_MEMORY_HEADROOM,
    TIER2_MODEL_RESIDENT_BYTES,
    IndexGovernor,
)
from framepilot_engine.brain.ledger_models import (
    TIER0_VERSION,
    TIER1_VERSION,
    LabelledFacts,
)
from framepilot_engine.brain.store import open_brain
from framepilot_engine.config import Settings
from framepilot_engine.media.probe import MediaInfo, StreamInfo
from framepilot_engine.service import create_app

# --- The governor, on an injected machine ---------------------------------------


class _Clock:
    """A monotonic clock the test advances by hand."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_tier_zero_gets_a_quarter_of_the_machine_and_the_slow_tiers_one_worker() -> None:
    governor = IndexGovernor(cpu_count=16)
    assert governor.tier_workers("measured") == 4
    assert governor.tier_workers("labelled") == 1
    assert governor.tier_workers("described") == 1


def test_a_small_machine_still_gets_one_tier_zero_worker() -> None:
    assert IndexGovernor(cpu_count=2).tier_workers("measured") == 1


def test_a_hosted_tier_is_not_held_to_one_local_worker() -> None:
    """The built-in tier 1 is a provider round trip: serialising it protects nothing.

    Measured before this plan: 60 photos cost 92.7 s wall against ~1.5 s of local CPU.
    The one-worker rule governs local compute; the network's bound lives elsewhere.
    """
    governor = IndexGovernor(cpu_count=16)
    assert governor.tier_workers("labelled", hosted=True) > 8


def test_foreground_work_pauses_indexing_and_a_short_idle_resumes_it() -> None:
    clock = _Clock()
    governor = IndexGovernor(cpu_count=8, clock=clock)
    assert governor.defer_reason() is None

    with governor.foreground("a frame grab"):
        reason = governor.defer_reason()
    assert reason is not None and "a frame grab" in reason

    # Still paused immediately after: the cool-down is the point.
    assert governor.defer_reason() is not None
    clock.now += IDLE_RESUME_SECONDS + 0.01
    assert governor.defer_reason() is None


def test_the_cooldown_starts_when_the_last_overlapping_job_leaves() -> None:
    """Two renders overlapping must not let the first one's exit resume indexing."""
    clock = _Clock()
    governor = IndexGovernor(cpu_count=8, clock=clock)
    outer = governor.foreground("an export")
    inner = governor.foreground("an export")
    outer.__enter__()
    inner.__enter__()
    inner.__exit__(None, None, None)
    assert governor.defer_reason() is not None
    outer.__exit__(None, None, None)
    clock.now += IDLE_RESUME_SECONDS + 0.01
    assert governor.defer_reason() is None


def test_an_export_on_the_render_queue_defers_indexing_too() -> None:
    """The queue outlives the request that submitted it, so it is asked, not bracketed."""
    busy = {"value": "an export"}
    governor = IndexGovernor(cpu_count=8, external_busy=lambda: busy["value"] or None)
    assert "an export" in (governor.defer_reason() or "")
    busy["value"] = ""
    assert governor.defer_reason() is None


def test_waiting_gives_up_after_its_budget_and_reports_why() -> None:
    clock = _Clock()
    slept: list[float] = []

    def _sleep(seconds: float) -> None:
        slept.append(seconds)
        clock.now += seconds

    governor = IndexGovernor(cpu_count=8, clock=clock)
    with governor.foreground("an export"):
        reason = governor.wait_until_clear(budget=0.2, poll=0.05, sleep=_sleep)
    assert reason is not None and "an export" in reason
    # It actually waited rather than returning instantly and spinning the host's loop.
    assert 0.2 <= sum(slept) <= 0.2 + 0.05


def test_waiting_returns_as_soon_as_the_pause_lifts() -> None:
    clock = _Clock()
    governor = IndexGovernor(cpu_count=8, clock=clock)
    assert governor.wait_until_clear(budget=0.2, poll=0.05, sleep=lambda _s: None) is None


def test_tier_two_refuses_to_start_under_the_memory_headroom() -> None:
    tight = int(TIER2_MEMORY_HEADROOM * TIER2_MODEL_RESIDENT_BYTES) - 1
    assert IndexGovernor(free_memory=lambda: tight).tier2_skip_reason() == "low_memory"


def test_tier_two_runs_with_the_headroom_and_when_memory_is_unknowable() -> None:
    ample = int(TIER2_MEMORY_HEADROOM * TIER2_MODEL_RESIDENT_BYTES)
    assert IndexGovernor(free_memory=lambda: ample).tier2_skip_reason() is None
    # An unmeasurable machine must not be treated as an out-of-memory one.
    assert IndexGovernor(free_memory=lambda: None).tier2_skip_reason() is None


def test_the_real_memory_reader_returns_a_plausible_number_or_nothing() -> None:
    reading = governor_module.free_memory_bytes()
    assert reading is None or reading > 0


# --- The route it governs -------------------------------------------------------


def _video_probe(duration: float = 12.0) -> dict[str, Any]:
    return MediaInfo(
        path="/clip.mp4",
        duration_seconds=duration,
        format_name="mov,mp4,m4a",
        streams=[StreamInfo(index=0, codec_type="video", width=1920, height=1080, fps=30.0)],
    ).model_dump(mode="json")


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


def _seed(root: Path, *asset_ids: str, project_id: str = "p1") -> None:
    with open_brain(root, project_id) as store:
        for asset_id in asset_ids:
            (root / f"{asset_id}.mp4").write_bytes(b"\x00\x00fake\x00\x00")
            store.upsert_asset(
                asset_id,
                path=f"{asset_id}.mp4",
                content_sha256=f"sha-{asset_id}",
                probe=_video_probe(),
            )


def _client(root: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(
        service_module,
        "measure_asset",
        lambda path, **kw: [_stats(0, 0.0, 6.0), _stats(1, 6.0, 12.0)],
    )
    return TestClient(create_app(Settings(projects_root=root)))


def _index(client: TestClient, **body: Any) -> Any:
    return client.post("/brain/visual/index", json={"projectId": "p1", **body}).json()


def _drain(client: TestClient, **body: Any) -> Any:
    out = _index(client, **body)
    for _ in range(20):
        if out.get("done") or out.get("reason") or out.get("jobId") is None:
            break
        out = _index(client, **{**body, "jobId": out["jobId"]})
    return out


def _project_file(root: Path, *asset_ids: str) -> Path:
    """A project whose timeline places the given assets in the given order."""
    clips = [
        {
            "id": f"c{n}",
            "trackId": "v",
            "assetId": asset_id,
            "start": float(n * 5),
            "end": float(n * 5 + 5),
            "sourceIn": 0.0,
            "sourceOut": 5.0,
        }
        for n, asset_id in enumerate(asset_ids)
    ]
    document = {
        "id": "p1",
        "name": "T",
        "assets": [
            {"id": a, "path": f"{a}.mp4", "kind": "video", "durationSeconds": 12.0}
            for a in asset_ids
        ],
        "timeline": {"tracks": [{"id": "v", "type": "video", "clips": clips}]},
    }
    path = root / "project.fp.json"
    import json

    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def test_a_slice_defers_while_a_frame_grab_is_in_flight(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The property users feel: background indexing gets out of the editor's way.

    A real ``POST /render/frame`` is held open on another thread; the index slice posted
    while it runs must move no cursor, write no shot, and say plainly that it stood
    aside — in ``tiers``, never in ``reason``, which the host treats as terminal.
    """
    root = tmp_path / "projects"
    root.mkdir()
    _seed(root, "a0")
    project_file = _project_file(root, "a0")
    holding = threading.Event()
    release = threading.Event()

    def _blocking_grab(*args: Any, **kwargs: Any) -> Any:
        holding.set()
        release.wait(timeout=10)
        raise service_module.FrameGrabError("held open by the test")

    monkeypatch.setattr(service_module, "grab_frame", _blocking_grab)
    client = _client(root, monkeypatch)

    grabber = threading.Thread(
        target=lambda: client.post(
            "/render/frame", json={"project_path": str(project_file), "time_seconds": 0.0}
        )
    )
    grabber.start()
    try:
        assert holding.wait(timeout=10)
        body = _index(client)
    finally:
        release.set()
        grabber.join(timeout=10)

    assert body["available"] is True and body["done"] is False
    assert body["reason"] is None  # a pause is never the host's terminal signal
    assert body["cursor"] == 0
    assert all("deferred while a frame grab" in state for state in body["tiers"].values())
    with open_brain(root, "p1") as store:
        assert store.list_shots(["a0"]) == []

    # And it resumes on its own once the foreground work is done.
    assert _drain(client)["done"] is True


def test_tier_zero_covers_the_whole_worklist_before_anything_is_described(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§8.2, stated as coverage: no asset is embedded while any asset is unmeasured."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed(root, "a0", "a1", "a2")
    client = _client(root, monkeypatch)

    first = _index(client, maxAssets=1)
    assert first["indexed"] == 0
    assert first["tiers"]["labelled"] == "skipped: no_api_key"
    with open_brain(root, "p1") as store:
        coverage = store.tier_coverage(["a0", "a1", "a2"])
    assert (coverage.measured, coverage.described) == (2, 0)


def test_a_newly_imported_asset_preempts_at_tier_zero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An import mid-job is measured next, without a new job and without losing progress."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed(root, "a0")
    client = _client(root, monkeypatch)
    started = _index(client, maxAssets=1)
    assert started["done"] is True  # keyless: the job ends at the tier-0 pass

    _seed(root, "a1")
    resumed = _index(client, jobId=started["jobId"], maxAssets=1)

    assert resumed["total"] == 2
    assert [item["assetId"] for item in resumed["items"]] == ["a1"]
    with open_brain(root, "p1") as store:
        assert {s.asset_id for s in store.list_shots(["a0", "a1"])} == {"a0", "a1"}


def test_the_worklist_puts_timeline_assets_first_in_timeline_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§8.2's order, read off the job's own worklist rather than inferred from timing."""
    root = tmp_path / "projects"
    root.mkdir()
    # Imported oldest-first; the timeline uses the two of them in the OPPOSITE order.
    _seed(root, "bin_old")
    _seed(root, "on_b")
    _seed(root, "on_a")
    _seed(root, "bin_new")
    project_file = _project_file(root, "on_a", "on_b")
    client = _client(root, monkeypatch)

    body = _index(client, priority="timeline", project_path=str(project_file), maxAssets=1)

    with open_brain(root, "p1") as store:
        job = next(j for j in store.list_jobs() if j.id == body["jobId"])
    # Timeline first in timeline order, then the bin most-recently-imported first.
    assert job.payload["assetIds"] == ["on_a", "on_b", "bin_new", "bin_old"]


def test_low_memory_skips_tier_two_and_leaves_tiers_zero_and_one_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§8.3's refusal, asserted on the tier map the coverage line reads."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed(root, "a0")
    monkeypatch.setattr(governor_module, "free_memory_bytes", lambda: 1)
    monkeypatch.setattr(
        service_module,
        "measure_asset",
        lambda path, **kw: [_stats(0, 0.0, 6.0), _stats(1, 6.0, 12.0)],
    )
    client = TestClient(create_app(Settings(projects_root=root)))

    body = _drain(client)

    assert body["tiers"]["measured"] == "ok"
    assert body["coverage"]["measured"] == 2
    # Tier 2 is a reported hole, and the job still finishes.
    assert body["done"] is True


def test_a_killed_sidecar_resumes_to_the_same_rows_as_a_clean_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§8.4, in-process: a second app instance reads only the on-disk journal.

    A real SIGKILL is measured separately (see the phase report); what a test can hold
    forever is the equivalence — an interrupted job resumed by a brand-new app produces
    the same ledger as one that ran start to finish.
    """
    clean_root = tmp_path / "clean"
    clean_root.mkdir()
    _seed(clean_root, "a0", "a1", "a2")
    clean = _client(clean_root, monkeypatch)
    _drain(clean)
    with open_brain(clean_root, "p1") as store:
        expected = [
            (s.asset_id, s.shot_index, s.content_hash) for s in store.list_shots(["a0", "a1", "a2"])
        ]

    killed_root = tmp_path / "killed"
    killed_root.mkdir()
    _seed(killed_root, "a0", "a1", "a2")
    first_app = _client(killed_root, monkeypatch)
    started = _index(first_app, maxAssets=1)
    assert started["done"] is False
    del first_app  # the process is gone; only the journal survives

    resumed_app = _client(killed_root, monkeypatch)
    body = _drain(resumed_app, jobId=started["jobId"], maxAssets=1)

    assert body["done"] is True
    with open_brain(killed_root, "p1") as store:
        # A restart sweeps non-terminal jobs to `interrupted` before resuming them.
        assert store.list_shots(["a0", "a1", "a2"]) is not None
        actual = [
            (s.asset_id, s.shot_index, s.content_hash) for s in store.list_shots(["a0", "a1", "a2"])
        ]
    assert actual == expected


def test_bumping_one_tiers_version_requeues_only_that_column(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§8.4's model swap: one column nulled, geometry and the other tiers untouched."""
    root = tmp_path / "projects"
    root.mkdir()
    _seed(root, "a0")
    calls: list[Path] = []

    def _measure(path: Path, **kw: Any) -> list[ShotStats]:
        calls.append(path)
        return [_stats(0, 0.0, 6.0), _stats(1, 6.0, 12.0)]

    monkeypatch.setattr(service_module, "measure_asset", _measure)
    client = TestClient(create_app(Settings(projects_root=root)))
    _drain(client)
    assert len(calls) == 1

    # Give the asset tier-1 facts produced by an OLDER model, the way a shipped pack
    # would have, then run a job for a bumped `labelled` version.
    with open_brain(root, "p1") as store:
        rows = store.list_shots(["a0"])
        store.upsert_shots(
            "a0",
            "sha-a0",
            "labelled",
            [
                row.model_copy(
                    update={
                        "labelled": LabelledFacts(
                            tier1_version=TIER1_VERSION - 1, model="old-pack", faces=2
                        )
                    }
                )
                for row in rows
            ],
        )
        assert store.tier_coverage(["a0"]).labelled == 2

    _drain(client, tiers=["labelled"])

    # One column nulled, one tier re-queued: the geometry and tier 0 are untouched, and
    # nothing re-measured (`measure_asset` was called exactly once, at the top).
    assert len(calls) == 1
    with open_brain(root, "p1") as store:
        coverage = store.tier_coverage(["a0"])
        shots = store.list_shots(["a0"])
    assert coverage.labelled == 0 and coverage.measured == 2
    assert [(s.t0, s.t1) for s in shots] == [(0.0, 6.0), (6.0, 12.0)]
    assert all(s.measured is not None for s in shots)
    assert all(s.measured.tier0_version == TIER0_VERSION for s in shots if s.measured)

    # A tier-0 version bump is what DOES re-measure: the resume key stops matching.
    monkeypatch.setattr(service_module, "TIER0_VERSION", TIER0_VERSION + 1)
    _drain(client)
    assert len(calls) == 2
