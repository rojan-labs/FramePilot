"""Tests for the TwelveLabs route-side glue (brain.twelvelabs_index).

Real SQLite brain (migration-free storage over the existing tables), a fake
TwelveLabs client, and an injected clock/sleep so the paced polling is exercised
deterministically without the live API.
"""

from __future__ import annotations

from pathlib import Path

from framepilot_engine.brain.described import described_from_summary
from framepilot_engine.brain.ledger_models import ShotRecord
from framepilot_engine.brain.store import open_brain
from framepilot_engine.brain.twelvelabs import TaskStatus, TLChapter, TLClip
from framepilot_engine.brain.twelvelabs_index import (
    TL_DESCRIBED_MODEL,
    chapters_to_packets,
    clips_to_packets,
    describe_shots_from_chapters,
    is_twelvelabs_description,
    poll_index_asset,
    read_index_id,
    read_video_mapping,
    store_index_id,
    store_video_mapping,
    video_to_asset_map,
)


def _seed_asset(root: Path, asset_id: str = "vid", project_id: str = "p1") -> None:
    with open_brain(root, project_id) as store:
        store.upsert_asset(asset_id, path=f"{asset_id}.mp4", content_sha256=f"sha-{asset_id}")


class _FakeTL:
    """A TwelveLabs client whose task becomes ready after ``ready_after`` polls."""

    def __init__(self, *, ready_after: int = 0, fail: bool = False) -> None:
        self.ready_after = ready_after
        self.fail = fail
        self.polls = 0
        self.uploads = 0

    def create_index_task(self, index_id: str, media_path: Path) -> str:
        self.uploads += 1
        return "task-1"

    def get_task(self, task_id: str) -> TaskStatus:
        self.polls += 1
        if self.fail:
            return TaskStatus(task_id, "failed", None)
        if self.polls > self.ready_after:
            return TaskStatus(task_id, "ready", "video-xyz")
        return TaskStatus(task_id, "indexing", None)


class _AdvancingTaskTL(_FakeTL):
    """Models the asset-upload token advancing to an indexed-asset token."""

    def get_task(self, task_id: str) -> TaskStatus:
        self.polls += 1
        return TaskStatus("indexed-asset-v1:idx:remote", "indexing", None)


# --- persistence round-trips -----------------------------------------------------


def test_index_id_round_trip(tmp_path: Path) -> None:
    with open_brain(tmp_path, "p1") as store:
        assert read_index_id(store) is None
        store_index_id(store, "idx-99")
        assert read_index_id(store) == "idx-99"
        store_index_id(store, "idx-100")  # overwrites (one per project)
        assert read_index_id(store) == "idx-100"


def test_video_mapping_round_trip_and_reverse_map(tmp_path: Path) -> None:
    _seed_asset(tmp_path, "vid")
    with open_brain(tmp_path, "p1") as store:
        assert read_video_mapping(store, "vid") is None
        store_video_mapping(
            store, "vid", content_hash="sha-vid", status="ready", task_id="t1", video_id="v1"
        )
        mapping = read_video_mapping(store, "vid")
        assert mapping is not None and mapping.ready and mapping.video_id == "v1"
        assert video_to_asset_map(store) == {"v1": "vid"}
        # A pending mapping (no video yet) is not in the reverse map.
        store_video_mapping(store, "vid", content_hash="sha-vid2", status="indexing", task_id="t2")
        assert video_to_asset_map(store) == {}


# --- paced per-asset indexing ----------------------------------------------------


def test_poll_uploads_and_completes_when_ready(tmp_path: Path) -> None:
    _seed_asset(tmp_path)
    fake = _FakeTL(ready_after=0)
    with open_brain(tmp_path, "p1") as store:
        outcome = poll_index_asset(
            fake,
            store,
            "idx",
            "vid",
            "vid.mp4",
            upload=lambda: fake.create_index_task("idx", Path("vid.mp4")),
            content_hash="sha-vid",
        )
        assert outcome.advanced and outcome.ok and outcome.newly_indexed == 1
        assert fake.uploads == 1
        assert read_video_mapping(store, "vid").video_id == "video-xyz"  # type: ignore[union-attr]


def test_poll_already_ready_is_noop(tmp_path: Path) -> None:
    _seed_asset(tmp_path)
    fake = _FakeTL(ready_after=0)
    with open_brain(tmp_path, "p1") as store:
        store_video_mapping(
            store, "vid", content_hash="sha-vid", status="ready", task_id="t", video_id="v"
        )
        outcome = poll_index_asset(
            fake,
            store,
            "idx",
            "vid",
            "vid.mp4",
            upload=lambda: fake.create_index_task("idx", Path("vid.mp4")),
            content_hash="sha-vid",
        )
        assert outcome.advanced and outcome.newly_indexed == 0
        assert fake.uploads == 0  # no re-upload for unchanged bytes


def test_poll_yields_slice_while_still_indexing(tmp_path: Path) -> None:
    _seed_asset(tmp_path)
    fake = _FakeTL(ready_after=99)  # never ready within the budget
    times = iter([0.0, 100.0])  # first call sets deadline=30; second is past it
    with open_brain(tmp_path, "p1") as store:
        outcome = poll_index_asset(
            fake,
            store,
            "idx",
            "vid",
            "vid.mp4",
            upload=lambda: fake.create_index_task("idx", Path("vid.mp4")),
            content_hash="sha-vid",
            sleep=lambda _s: None,
            now=lambda: next(times),
        )
        assert not outcome.advanced and outcome.reason == "indexing"
        # progress persisted so the re-posted slice resumes the same task
        assert read_video_mapping(store, "vid").task_id == "task-1"  # type: ignore[union-attr]


def test_poll_persists_advanced_asset_workflow_token(tmp_path: Path) -> None:
    _seed_asset(tmp_path)
    fake = _AdvancingTaskTL()
    times = iter([0.0, 100.0])
    with open_brain(tmp_path, "p1") as store:
        poll_index_asset(
            fake,
            store,
            "idx",
            "vid",
            "vid.mp4",
            upload=lambda: "asset-v1:idx:upload",
            content_hash="sha-vid",
            sleep=lambda _s: None,
            now=lambda: next(times),
        )
        mapping = read_video_mapping(store, "vid")
        assert mapping is not None
        assert mapping.task_id == "indexed-asset-v1:idx:remote"


def test_poll_failed_task_advances_but_not_ok(tmp_path: Path) -> None:
    _seed_asset(tmp_path)
    fake = _FakeTL(fail=True)
    with open_brain(tmp_path, "p1") as store:
        outcome = poll_index_asset(
            fake,
            store,
            "idx",
            "vid",
            "vid.mp4",
            upload=lambda: fake.create_index_task("idx", Path("vid.mp4")),
            content_hash="sha-vid",
        )
        assert outcome.advanced and not outcome.ok and outcome.newly_indexed == 0


def test_retry_after_failed_mapping_starts_fresh_upload(tmp_path: Path) -> None:
    _seed_asset(tmp_path)
    fake = _FakeTL(ready_after=0)
    with open_brain(tmp_path, "p1") as store:
        store_video_mapping(
            store,
            "vid",
            content_hash="sha-vid",
            status="failed",
            task_id="failed-task",
        )
        outcome = poll_index_asset(
            fake,
            store,
            "idx",
            "vid",
            "vid.mp4",
            upload=lambda: fake.create_index_task("idx", Path("vid.mp4")),
            content_hash="sha-vid",
        )

        assert outcome.advanced and outcome.ok
        assert fake.uploads == 1
        mapping = read_video_mapping(store, "vid")
        assert mapping is not None and mapping.video_id == "video-xyz"


# --- clip → packet mapping -------------------------------------------------------


class _Clip:
    """Minimal SupportsClip for the timeline projection (identity clip)."""

    def __init__(self, asset_id: str) -> None:
        self.asset_id = asset_id
        self.start = 0.0
        self.end = 3.0
        self.source_start = 0.0
        self.source_end = 3.0
        self.speed = 1.0


class _Word:
    """Shaped like ``timeline.models.TranscriptWord`` (the ``SupportsWord`` protocol)."""

    def __init__(self, word: str, start: float, end: float) -> None:
        self.word = word
        self.start = start
        self.end = end


def test_clips_map_to_packets_with_transcript_overlap() -> None:
    clips = [TLClip("v1", 0.5, 1.5, 84.0, "high", "spoken words")]
    packets = clips_to_packets(
        clips,
        video_to_asset={"v1": "vid"},
        clips_by_asset={"vid": [_Clip("vid")]},
        words=[_Word("app", 0.6, 0.9)],
        k=8,
    )
    assert len(packets) == 1
    p = packets[0]
    assert p.asset_id == "vid" and p.t0 == 0.5 and p.t1 == 1.5 and p.score == 84.0
    assert p.sources == ["twelvelabs"]
    assert "app" in p.transcript_overlap  # from the project transcript


def test_clips_fall_back_to_clip_transcription_without_project() -> None:
    clips = [TLClip("v1", 0.5, 1.5, 10.0, None, "hello there")]
    packets = clips_to_packets(
        clips, video_to_asset={"v1": "vid"}, clips_by_asset={}, words=[], k=8
    )
    assert packets[0].transcript_overlap == "hello there"


def test_clips_skip_unknown_video_and_respect_filters() -> None:
    clips = [
        TLClip("unknown", 0.0, 1.0, 5.0),  # not one of our videos → skipped
        TLClip("v1", 0.0, 1.0, 9.0),
        TLClip("v2", 0.0, 1.0, 8.0),
    ]
    v2a = {"v1": "vid1", "v2": "vid2"}
    # k caps output
    capped = clips_to_packets(clips, video_to_asset=v2a, clips_by_asset={}, words=[], k=1)
    assert len(capped) == 1
    # asset_ids restricts to vid2
    packets = clips_to_packets(
        clips, video_to_asset=v2a, clips_by_asset={}, words=[], k=8, asset_ids=["vid2"]
    )
    assert [p.asset_id for p in packets] == ["vid2"]


def test_chapter_packets_carry_only_the_words_under_the_placement() -> None:
    """A chapter of a stock clip on screen for 1.1 s reads back 1.1 s of narration.

    The captured run: every silent stock clip described over a talking head came back
    with the whole 50-second monologue as its transcript overlap.
    """
    words = [_Word(f"w{i}", i * 0.3, i * 0.3 + 0.22) for i in range(166)]
    stock = _Clip("vid")
    stock.start, stock.end, stock.source_start, stock.source_end = 20.0, 21.1, 0.5, 1.6
    packets = chapters_to_packets(
        [TLChapter(start=0.0, end=3.0, title="Skyline", summary="a city at dusk")],
        asset_id="vid",
        clips_by_asset={"vid": [stock]},
        words=words,
    )
    assert packets[0].caption == "Skyline — a city at dusk"
    assert packets[0].transcript_overlap == "w66 w67 w68 w69 w70"


# -- Pegasus chapters → shot ledger -----------------------------------------------


def _shot(index: int, t0: float, t1: float, *, keyframe: float | None = None) -> ShotRecord:
    return ShotRecord(
        asset_id="vid",
        content_hash="sha-vid",
        shot_index=index,
        t0=t0,
        t1=t1,
        keyframe_t=(t0 + t1) / 2.0 if keyframe is None else keyframe,
    )


def _summaries(rows: list[ShotRecord]) -> dict[int, str]:
    return {row.shot_index: row.described.summary for row in rows if row.described is not None}


def test_chapters_describe_the_shots_they_cover() -> None:
    chapters = [
        TLChapter(start=0.0, end=4.0, title="Intro", summary="a host at a desk"),
        TLChapter(start=4.0, end=10.0, title="Demo"),
    ]
    shots = [_shot(0, 0.0, 3.0), _shot(1, 3.0, 9.0), _shot(2, 9.0, 20.0)]
    rows = describe_shots_from_chapters(chapters, shots)
    # Shot 2 ([9, 20), keyframe 14.5) is 1/11 covered by "Demo" and its keyframe lies past
    # every chapter: no chapter honestly describes it, so it stays undescribed.
    assert _summaries(rows) == {0: "Intro — a host at a desk", 1: "Demo"}
    facts = rows[0].described
    assert facts is not None
    assert facts.model == TL_DESCRIBED_MODEL
    # Prose only: TwelveLabs said a sentence, not a shot size.
    assert facts.subject == "" and facts.camera.shot_size is None and facts.on_screen_text == []
    # Geometry is the measured shot's, untouched.
    assert (rows[1].t0, rows[1].t1, rows[1].keyframe_t) == (3.0, 9.0, 6.0)


def test_chapters_never_overwrite_an_existing_description() -> None:
    real = described_from_summary("A structured description.", model="local-pack")
    shots = [_shot(0, 0.0, 2.0).model_copy(update={"described": real}), _shot(1, 2.0, 4.0)]
    rows = describe_shots_from_chapters([TLChapter(start=0.0, end=4.0, title="All")], shots)
    assert [row.shot_index for row in rows] == [1]


def test_a_chapter_holding_the_keyframe_describes_a_shot_it_barely_covers() -> None:
    # "Wide" covers 40% of the shot but misses its keyframe; "Close" covers 3% and holds
    # it. The keyframe is the frame the row stands for, so "Close" is the honest answer.
    chapters = [
        TLChapter(start=0.0, end=4.0, title="Wide"),
        TLChapter(start=4.9, end=5.2, title="Close"),
    ]
    rows = describe_shots_from_chapters(chapters, [_shot(0, 0.0, 10.0, keyframe=5.0)])
    assert _summaries(rows) == {0: "Close"}


def test_most_coverage_wins_among_qualifying_chapters() -> None:
    chapters = [
        TLChapter(start=0.0, end=3.0, title="Early"),
        TLChapter(start=3.0, end=10.0, title="Late"),
    ]
    # Keyframe at 1.0 is held by "Early", but "Late" covers 70% of the shot.
    rows = describe_shots_from_chapters(chapters, [_shot(0, 0.0, 10.0, keyframe=1.0)])
    assert _summaries(rows) == {0: "Late"}


def test_a_zero_length_shot_is_matched_by_its_keyframe_alone() -> None:
    chapters = [TLChapter(start=0.0, end=2.0, title="Still")]
    assert _summaries(describe_shots_from_chapters(chapters, [_shot(0, 1.0, 1.0)])) == {0: "Still"}
    assert describe_shots_from_chapters(chapters, [_shot(0, 3.0, 3.0)]) == []


def test_a_chapter_with_no_words_describes_nothing() -> None:
    rows = describe_shots_from_chapters(
        [TLChapter(start=0.0, end=4.0, title="  ")], [_shot(0, 0.0, 4.0)]
    )
    assert rows == []


def test_is_twelvelabs_description_names_only_summary_only_rows() -> None:
    assert is_twelvelabs_description(described_from_summary("x", model=TL_DESCRIBED_MODEL))
    assert not is_twelvelabs_description(described_from_summary("x", model="local-pack"))
    assert not is_twelvelabs_description(None)
