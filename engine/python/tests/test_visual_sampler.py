"""Tests for the adaptive visual sampler (analysis.visual_sampler, plan MI1.1/MI1.3)."""

from __future__ import annotations

import json
import random
from itertools import pairwise

import pytest

from framepilot_engine.analysis.visual_sampler import (
    DEFAULT_HAMMING_THRESHOLD,
    SAMPLER_VERSION,
    FrameCandidate,
    build_candidates,
    build_spans,
    candidate_timestamps,
    dhash,
    hamming,
    image_span,
    plan_spans,
)

# Two hashes farther apart than the default threshold, and a near-twin of HASH_A.
HASH_A = 0
HASH_B = (1 << 64) - 1  # Hamming distance 64 from HASH_A
HASH_A_NEAR = (1 << DEFAULT_HAMMING_THRESHOLD) - 1  # exactly at the threshold

# --- dhash ---------------------------------------------------------------------


def test_dhash_all_flat_grid_is_zero() -> None:
    assert dhash([[128] * 9 for _ in range(8)]) == 0


def test_dhash_descending_rows_set_every_bit() -> None:
    grid = [[9, 8, 7, 6, 5, 4, 3, 2, 1] for _ in range(8)]
    assert dhash(grid) == (1 << 64) - 1


def test_dhash_bit_order_is_msb_first_row_major() -> None:
    # Only the first gradient of the first row is descending → only the MSB set.
    first = [1, 0, 0, 0, 0, 0, 0, 0, 0]
    rest = [[0] * 9 for _ in range(7)]
    assert dhash([first, *rest]) == 1 << 63


def test_dhash_rejects_wrong_row_count() -> None:
    with pytest.raises(ValueError, match="8 rows"):
        dhash([[0] * 9 for _ in range(7)])


def test_dhash_rejects_wrong_row_width() -> None:
    with pytest.raises(ValueError, match="9 values"):
        dhash([[0] * 8 for _ in range(8)])


# --- hamming ---------------------------------------------------------------------


def test_hamming_counts_differing_bits() -> None:
    assert hamming(HASH_A, HASH_B) == 64
    assert hamming(HASH_A, HASH_A) == 0
    assert hamming(0b1010, 0b0110) == 2


# --- candidate_timestamps ---------------------------------------------------------


def test_candidates_sample_1fps_from_each_scene_start() -> None:
    # Scenes: [0, 2.5) and [2.5, 5.0) → 0,1,2 then 2.5,3.5,4.5.
    assert candidate_timestamps(5.0, [2.5]) == [0.0, 1.0, 2.0, 2.5, 3.5, 4.5]


def test_candidates_no_cuts_is_a_plain_1fps_grid() -> None:
    assert candidate_timestamps(3.0, []) == [0.0, 1.0, 2.0]


def test_candidates_zero_duration_yields_nothing() -> None:
    assert candidate_timestamps(0.0, [1.0]) == []


def test_candidates_negative_duration_raises() -> None:
    with pytest.raises(ValueError, match="duration_seconds"):
        candidate_timestamps(-1.0, [])


def test_candidates_sub_second_duration_gets_exactly_one() -> None:
    assert candidate_timestamps(0.4, []) == [0.0]


def test_candidates_sub_second_scene_still_gets_its_start() -> None:
    # Scene [2.0, 2.3) is shorter than the 1s cadence but must not vanish.
    assert candidate_timestamps(2.3, [2.0]) == [0.0, 1.0, 2.0]


def test_candidates_ignore_cuts_outside_the_duration() -> None:
    # Cuts at/below 0 and at/beyond the duration cannot start scenes; dupes collapse.
    assert candidate_timestamps(2.0, [-1.0, 0.0, 5.0, 2.0, 1.0, 1.0]) == [0.0, 1.0]


# --- build_candidates ----------------------------------------------------------------


def test_build_candidates_assigns_scene_indices_and_hashes() -> None:
    hashes = {0.0: HASH_A, 1.0: HASH_A, 1.5: HASH_B}
    candidates = build_candidates(2.5, [1.5], hashes)
    assert [(c.t, c.scene_index, c.hash) for c in candidates] == [
        (0.0, 0, HASH_A),
        (1.0, 0, HASH_A),
        (1.5, 1, HASH_B),
    ]


def test_build_candidates_accepts_a_callable_lookup() -> None:
    candidates = build_candidates(2.0, [], lambda t: int(t) + 7)
    assert [c.hash for c in candidates] == [7, 8]


def test_build_candidates_mapping_missing_a_timestamp_raises() -> None:
    with pytest.raises(KeyError):
        build_candidates(2.0, [], {0.0: HASH_A})


# --- build_spans -----------------------------------------------------------------


def _candidate(t: float, scene: int, h: int) -> FrameCandidate:
    return FrameCandidate(t=t, scene_index=scene, hash=h)


def test_static_shot_collapses_to_one_span_per_scene() -> None:
    spans = plan_spans(
        duration_seconds=6.0, scene_cuts=[3.0], frame_hashes=lambda t: HASH_A
    )
    assert [(s.t0, s.t1, s.scene_index, s.frame_count) for s in spans] == [
        (0.0, 3.0, 0, 3),
        (3.0, 6.0, 1, 3),
    ]
    assert all(s.keyframe_t == s.t0 for s in spans)


def test_alternating_hashes_split_every_candidate() -> None:
    spans = plan_spans(
        duration_seconds=4.0,
        scene_cuts=[],
        frame_hashes=lambda t: HASH_A if int(t) % 2 == 0 else HASH_B,
    )
    assert [(s.t0, s.t1) for s in spans] == [(0.0, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 4.0)]
    assert [s.frame_count for s in spans] == [1, 1, 1, 1]


def test_scene_cut_forces_a_split_despite_identical_hash() -> None:
    spans = plan_spans(duration_seconds=4.0, scene_cuts=[2.0], frame_hashes=lambda t: HASH_A)
    assert [(s.t0, s.t1, s.scene_index) for s in spans] == [(0.0, 2.0, 0), (2.0, 4.0, 1)]


def test_near_duplicate_within_threshold_extends_the_span() -> None:
    spans = plan_spans(
        duration_seconds=2.0,
        scene_cuts=[],
        frame_hashes={0.0: HASH_A, 1.0: HASH_A_NEAR},
    )
    assert len(spans) == 1
    assert spans[0].frame_count == 2
    assert spans[0].phash == HASH_A  # the keyframe's hash, not the extender's


def test_drift_is_measured_against_the_span_keyframe_not_the_previous_frame() -> None:
    # Each step drifts ≤ threshold from its neighbour, but t=2 is 12 bits from
    # the keyframe at t=0 — the span must split there.
    step = (1 << DEFAULT_HAMMING_THRESHOLD) - 1  # 6 low bits
    drifted = step | (step << DEFAULT_HAMMING_THRESHOLD)  # 12 bits total
    spans = plan_spans(
        duration_seconds=3.0,
        scene_cuts=[],
        frame_hashes={0.0: HASH_A, 1.0: step, 2.0: drifted},
    )
    assert [(s.t0, s.t1) for s in spans] == [(0.0, 2.0), (2.0, 3.0)]


def test_custom_threshold_zero_splits_on_any_difference() -> None:
    spans = plan_spans(
        duration_seconds=2.0,
        scene_cuts=[],
        frame_hashes={0.0: HASH_A, 1.0: 1},
        hamming_threshold=0,
    )
    assert len(spans) == 2


def test_no_candidates_yield_no_spans() -> None:
    assert build_spans([], duration_seconds=0.0) == []
    assert plan_spans(duration_seconds=0.0, scene_cuts=[], frame_hashes={}) == []


def test_single_candidate_spans_the_whole_duration() -> None:
    spans = build_spans([_candidate(0.0, 0, HASH_A)], duration_seconds=0.5)
    assert [(s.t0, s.t1, s.frame_count) for s in spans] == [(0.0, 0.5, 1)]


def test_build_spans_rejects_out_of_order_candidates() -> None:
    with pytest.raises(ValueError, match="strictly ascending"):
        build_spans(
            [_candidate(1.0, 0, HASH_A), _candidate(0.5, 0, HASH_A)],
            duration_seconds=2.0,
        )


def test_build_spans_rejects_duplicate_timestamps() -> None:
    with pytest.raises(ValueError, match="strictly ascending"):
        build_spans(
            [_candidate(1.0, 0, HASH_A), _candidate(1.0, 0, HASH_B)],
            duration_seconds=2.0,
        )


def test_build_spans_rejects_candidates_at_or_past_the_duration() -> None:
    with pytest.raises(ValueError, match="at/past duration"):
        build_spans([_candidate(2.0, 0, HASH_A)], duration_seconds=2.0)


# --- coverage property: contiguous, non-overlapping, covering [0, duration) --------


def test_spans_partition_the_duration_over_randomized_inputs() -> None:
    rng = random.Random(0)
    hash_pool = [HASH_A, HASH_B, HASH_A_NEAR, 0xDEADBEEF, 1 << 40]
    for _ in range(50):
        duration = rng.uniform(0.1, 120.0)
        cuts = [rng.uniform(-5.0, duration + 5.0) for _ in range(rng.randrange(0, 8))]
        spans = plan_spans(
            duration_seconds=duration,
            scene_cuts=cuts,
            frame_hashes=lambda t: rng.choice(hash_pool),
        )
        assert spans, f"non-empty duration {duration} must be covered"
        assert spans[0].t0 == 0.0
        assert spans[-1].t1 == duration
        for left, right in pairwise(spans):
            assert left.t1 == right.t0  # contiguous, non-overlapping
            assert left.t0 < left.t1  # every span is non-empty
        assert spans[-1].t0 < spans[-1].t1
        # Scene indices never decrease, and every span sits inside one scene.
        indices = [s.scene_index for s in spans]
        assert indices == sorted(indices)


# --- serialization ------------------------------------------------------------------


def test_visual_span_serializes_phash_as_string_with_camel_case_aliases() -> None:
    span = plan_spans(duration_seconds=1.0, scene_cuts=[], frame_hashes={0.0: HASH_B})[0]
    payload = json.loads(span.model_dump_json(by_alias=True))
    assert payload == {
        "t0": 0.0,
        "t1": 1.0,
        "sceneIndex": 0,
        "keyframeT": 0.0,
        "phash": str(HASH_B),  # 64-bit value → string for JS Number safety
        "frameCount": 1,
    }


def test_image_span_is_the_degenerate_zero_span() -> None:
    span = image_span(phash=42)
    assert (span.t0, span.t1, span.scene_index, span.keyframe_t) == (0.0, 0.0, 0, 0.0)
    assert span.phash == 42
    assert span.frame_count == 1
    assert image_span().phash == 0


def test_sampler_version_is_pinned() -> None:
    # Bump this assertion together with SAMPLER_VERSION — the idempotency key
    # (content_hash, model_id, SAMPLER_VERSION, t0) depends on it (MI1.3).
    assert SAMPLER_VERSION == 1
