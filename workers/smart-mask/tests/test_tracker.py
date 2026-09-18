"""BR3.3: SAM orchestration rules, bounded memory, windows and two estimates per frame."""

from __future__ import annotations

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("cv2")
pytest.importorskip("PIL")

from fakes import FakeSam, square_frames, truth  # noqa: E402

from framepilot_smart_mask.embeddings import EmbeddingCache  # noqa: E402
from framepilot_smart_mask.segment import plan_windows, segment_window  # noqa: E402
from framepilot_smart_mask.tracker import (  # noqa: E402
    FEAT_TOKENS,
    MAX_OBJ_PTRS,
    NUM_MASKMEM,
    FrameOutput,
    MaskPrompt,
    MemoryBank,
    PointPrompt,
    SamTracker,
    emulate_bfloat16,
    preprocess,
    resize_antialias,
    sine_pe,
)


def tracker_for(
    frames: np.ndarray, sam: FakeSam | None = None
) -> tuple[SamTracker, FakeSam, EmbeddingCache]:
    fake = sam or FakeSam()
    cache = EmbeddingCache(
        lambda index: fake.encode_image(preprocess(frames[index])), max_ram_bytes=64 * 21 * 2**20
    )
    return SamTracker(fake, cache.get), fake, cache


def iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return 1.0 if union == 0 else float(np.logical_and(a, b).sum() / union)


def output(index: int) -> FrameOutput:
    out = FrameOutput(
        low_res=np.zeros((256, 256), np.float32),
        obj_ptr=np.full(256, float(index), np.float32),
        score=1.0,
        iou=0.9,
    )
    out.maskmem_features = np.full((FEAT_TOKENS, 64), float(index), np.float32)
    return out


def bank(cond: dict[int, FrameOutput]) -> MemoryBank:
    return MemoryBank(
        maskmem_pos=np.zeros((FEAT_TOKENS, 64), np.float32),
        constants_tpos=np.arange(7, dtype=np.float32).reshape(7, 1, 1, 1)
        * np.ones((1, 1, 1, 64), np.float32),
        proj_weight=np.eye(64, 256, dtype=np.float32),
        proj_bias=np.zeros(64, np.float32),
        cond=cond,
    )


def test_single_prompt_memory_matches_upstream_counts() -> None:
    memory_bank = bank({0: output(0)})
    for index in range(1, 40):
        memory_bank.remember(index, output(index), reverse=False)
    memory, memory_pos, valid = memory_bank.assemble(40, reverse=False, num_frames=100)
    spatial = valid[: 7 * FEAT_TOKENS].reshape(7, FEAT_TOKENS).all(axis=1)
    assert spatial.sum() == 7
    # Slot 0 is the conditioning frame (t_pos 0 -> tpos_enc[6]); the last slot is frame 39 (t_pos 6 -> tpos_enc[0]).
    assert memory[0, 0, 0] == 0.0 and memory_pos[0, 0, 0] == 6.0
    assert memory[6 * FEAT_TOKENS, 0, 0] == 39.0 and memory_pos[6 * FEAT_TOKENS, 0, 0] == 0.0
    # One conditioning pointer + 15 recent = 16 pointers = 64 tokens, exactly upstream's cap.
    assert int(valid[7 * FEAT_TOKENS :].sum()) == 64
    assert len(memory_bank.recent) <= max(NUM_MASKMEM - 1, MAX_OBJ_PTRS - 1) + 1


def test_memory_bank_is_bounded_however_long_the_window() -> None:
    memory_bank = bank({0: output(0)})
    for index in range(1, 2000):
        memory_bank.remember(index, output(index), reverse=False)
    assert len(memory_bank.recent) <= 16
    assert min(memory_bank.recent) == 1999 - 15


def test_many_conditioning_frames_fit_the_static_shapes() -> None:
    cond = {0: output(0), 20: output(20), 60: output(60), 90: output(90)}
    memory_bank = bank(cond)
    for index in range(21, 40):
        memory_bank.remember(index, output(index), reverse=False)
    _, _, valid = memory_bank.assemble(40, reverse=False, num_frames=100)
    spatial = valid[: 7 * FEAT_TOKENS].reshape(7, FEAT_TOKENS).all(axis=1)
    assert spatial.sum() == 7, "two closest conditioning frames + the five nearest recent frames"
    assert int(valid[7 * FEAT_TOKENS :].sum()) <= 64
    selected, unselected = memory_bank.select_cond(40)
    assert sorted(selected) == [20, 60] and sorted(unselected) == [0, 90]


def test_reverse_pointers_only_come_from_conditioning_frames_ahead() -> None:
    cond = {0: output(0), 50: output(50)}
    memory_bank = bank(cond)
    _, _memory_pos, valid = memory_bank.assemble(30, reverse=True, num_frames=60)
    assert int(valid[7 * FEAT_TOKENS :].sum()) == 4, (
        "only frame 50's pointer is 'in the past' when tracking backwards"
    )


def test_numeric_helpers() -> None:
    constant = np.full((1024, 1024), 3.0, np.float32)
    assert np.allclose(resize_antialias(constant, 256, 256), 3.0)
    checker = np.indices((8, 8)).sum(axis=0) % 2
    assert np.allclose(resize_antialias(checker.astype(np.float32), 2, 2), 0.5, atol=0.13)
    pe = sine_pe(np.array([0.0, 1.0], np.float32), 4)
    assert np.allclose(pe[0], [0, 0, 1, 1]) and np.isclose(pe[1, 0], np.sin(1.0))
    exact = np.array([1.0, 0.5, 1.25, -3.0], np.float32)
    assert np.array_equal(emulate_bfloat16(exact), exact)
    assert emulate_bfloat16(np.array([1 + 1 / 512], np.float32))[0] == 1.0  # tie rounds to even
    assert emulate_bfloat16(np.array([1 + 3 / 512], np.float32))[0] == np.float32(1 + 4 / 512)


def test_forward_tracking_follows_the_subject_from_a_box() -> None:
    frames = square_frames(24)
    tracker, fake, cache = tracker_for(frames)
    box = PointPrompt(coords=((10 / 160, 30 / 90), (34 / 160, 54 / 90)), labels=(2, 3))
    segmentation = segment_window(tracker, 24, 90, 160, {0: box})
    expected = truth(24)
    assert segmentation.has_fwd.all()
    assert min(iou(segmentation.logits("fwd", i) > 0, expected[i]) for i in range(24)) > 0.8
    assert segmentation.seeds["backward"] == 23
    assert segmentation.has_bwd.all()
    assert fake.attend_valid_slots and max(fake.attend_valid_slots) <= 7
    assert cache.encodes == 24, "the backward pass reuses cached embeddings"


def test_head_frames_before_the_prompt_get_two_estimates() -> None:
    frames = square_frames(30)
    tracker, _, _ = tracker_for(frames)
    click = PointPrompt(coords=(((10 + 12 * 2 + 12) / 160, 42 / 90),), labels=(1,))
    segmentation = segment_window(tracker, 30, 90, 160, {12: click})
    assert segmentation.has_bwd[:13].all()
    assert segmentation.seeds.get("head") == 0
    assert segmentation.has_fwd.all()
    expected = truth(30)
    assert iou(segmentation.logits("fwd", 3) > 0, expected[3]) > 0.8


def test_a_locked_frame_seeds_memory() -> None:
    # The square vanishes for frames 6-9 and comes back 60 px further right: tracking alone
    # cannot find it again; a lock on frame 12 re-seeds the memory and tracking resumes.
    layout = {"gap": range(6, 10), "jump_at": 10, "jump": 60}
    frames = square_frames(20, **layout)
    expected = truth(20, **layout)
    box = PointPrompt(coords=((10 / 160, 30 / 90), (34 / 160, 54 / 90)), labels=(2, 3))

    tracker, _, _ = tracker_for(frames)
    unlocked = segment_window(tracker, 20, 90, 160, {0: box})
    assert not (unlocked.logits("fwd", 15) > 0).any()

    tracker, _, _ = tracker_for(frames)
    locked = segment_window(tracker, 20, 90, 160, {0: box, 12: MaskPrompt(expected[12])})
    assert iou(locked.logits("fwd", 12) > 0, expected[12]) > 0.8, (
        "the locked frame's output is the lock"
    )
    assert all(iou(locked.logits("fwd", i) > 0, expected[i]) > 0.8 for i in range(13, 20))
    assert all(iou(locked.logits("bwd", i) > 0, expected[i]) > 0.8 for i in (10, 11))


def test_windows_commit_every_frame_exactly_once() -> None:
    plans = plan_windows(700)
    assert [(p.start, p.end) for p in plans] == [(0, 300), (240, 540), (400, 700)]
    committed = [frame for plan in plans for frame in range(plan.commit_start, plan.commit_end)]
    assert committed == list(range(700))
    for plan in plans:
        assert plan.start <= plan.commit_start < plan.commit_end <= plan.end
    assert plan_windows(299) == [plan_windows(299)[0]] and plan_windows(299)[0].count == 299
    assert all(plan.count <= 300 for plan in plan_windows(10_000))


def test_embedding_cache_is_bounded_and_spills(tmp_path: object) -> None:
    from pathlib import Path

    frames = square_frames(6)
    fake = FakeSam()
    per = fake.encode_image(preprocess(frames[0])).nbytes
    cache = EmbeddingCache(
        lambda index: fake.encode_image(preprocess(frames[index])),
        max_ram_bytes=2 * per,
        spill_directory=Path(str(tmp_path)),
        max_spill_bytes=2 * per,
    )
    for index in range(6):
        cache.get(index)
    assert cache.ram_bytes <= 2 * per
    assert cache.spill_bytes <= 2 * per
    before = fake.encodes
    cache.get(0)
    cache.get(5)
    assert fake.encodes == before, "recent frames come from RAM, older ones from the spill"
    cache.get(3)
    assert fake.encodes == before + 1, "past both budgets an embedding is recomputed, never kept"
    cache.clear()
    assert list(Path(str(tmp_path)).iterdir()) == []


def test_a_single_click_conditions_on_the_whole_subject_not_the_part() -> None:
    """BR7.4: SAM's best-IoU candidate for a click on a person is often a part (it0 one-click)."""
    from framepilot_smart_mask.tracker import LOW_RES, whole_object

    candidates = np.full((3, LOW_RES, LOW_RES), -8.0, np.float32)
    candidates[0, 100:120, 100:120] = 8.0  # the torso the click is on (SAM's pick)
    candidates[1, 60:200, 90:130] = 8.0  # the whole person
    candidates[2, :, :] = 8.0  # everything: never the subject
    click = np.array([110.0, 110.0])
    assert whole_object(candidates, np.array([0.95, 0.88, 0.9]), click) == 1
    assert whole_object(candidates, np.array([0.95, 0.70, 0.9]), click) is None, "too unsure"
    assert whole_object(candidates, np.array([0.80, 0.95, 0.5]), click) is None, "SAM's own pick"
    outside = np.array([10.0, 10.0])
    assert whole_object(candidates[:2], np.array([0.95, 0.9]), outside) is None
