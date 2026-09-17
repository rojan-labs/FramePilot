"""BR3.5: the self-correction loop re-prompts disputed runs from confident neighbours."""

from __future__ import annotations

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("cv2")

from fakes import truth  # noqa: E402

from framepilot_smart_mask.self_correct import (  # noqa: E402
    MAX_ROUNDS,
    Run,
    confident_neighbours,
    flagged_runs,
    sample_points,
    self_correct,
)
from framepilot_smart_mask.tracker import MaskPrompt, PointPrompt  # noqa: E402


def test_runs_skip_locked_frames_and_treat_nan_as_flagged() -> None:
    scores = [0.0, 0.2, 0.3, 0.0, float("nan"), 0.01, 0.4]
    assert flagged_runs(scores, 0.05, locked={2}) == [Run(1, 1), Run(4, 4), Run(6, 6)]
    assert confident_neighbours(Run(1, 2), [0.0, 0.2, 0.3, 0.01], 0.02) == (0, 3)
    assert confident_neighbours(Run(0, 1), [0.3, 0.3], 0.02) == (None, None)


def test_sampled_points_are_inside_and_negatives_hit_the_overreach() -> None:
    region = np.zeros((90, 160), bool)
    region[30:54, 40:64] = True
    current = region.copy()
    current[30:54, 110:134] = True  # the estimate also grabbed a second object
    prompt = sample_points(region, current, 160, 90)
    assert prompt is not None
    positives = [c for c, label in zip(prompt.coords, prompt.labels, strict=True) if label == 1]
    negatives = [c for c, label in zip(prompt.coords, prompt.labels, strict=True) if label == 0]
    assert positives and all(region[int(y * 90), int(x * 160)] for x, y in positives)
    assert negatives and all(
        current[int(y * 90), int(x * 160)] and not region[int(y * 90), int(x * 160)]
        for x, y in negatives
    )
    assert sample_points(np.zeros((90, 160), bool), current, 160, 90) is None


def test_loop_fixes_a_drifted_run_and_rejects_worse_candidates() -> None:
    count = 12
    expected = truth(count)
    masks = [m.copy() for m in expected]
    scores = [0.0] * count
    for index in (5, 6, 7):  # drifted onto nothing
        masks[index] = np.zeros_like(expected[index])
        scores[index] = 0.9
    scores[9] = 0.5
    locked: set[int] = {9}
    calls: list[tuple[Run, dict]] = []
    accepted: list[int] = []

    def warp(source: int, target: int, mask: np.ndarray) -> np.ndarray:
        return np.roll(mask, 2 * (target - source), axis=1)

    def resegment(run: Run, cond: dict) -> dict[int, list[np.ndarray]]:
        calls.append((run, cond))
        return {i: [expected[i], expected[i]] for i in range(run.start, run.end + 1)}

    def rescore(index: int, candidate: list[np.ndarray]) -> float:
        return 0.0 if np.array_equal(candidate[0], expected[index]) else 1.0

    report = self_correct(
        masks,
        scores,
        locked,
        warp=warp,
        resegment=resegment,
        rescore=rescore,
        accept=lambda i, c: accepted.append(i),
    )
    assert report.rounds == 1
    assert sorted(accepted) == [5, 6, 7] and 9 not in report.attempted
    run, cond = calls[0]
    assert run == Run(5, 7)
    assert (
        isinstance(cond[6], PointPrompt)
        and isinstance(cond[4], MaskPrompt)
        and isinstance(cond[8], MaskPrompt)
    )
    assert all(np.array_equal(masks[i], expected[i]) for i in (5, 6, 7))
    assert scores[5] == 0.0


def test_loop_stops_after_k_rounds_when_nothing_converges() -> None:
    count = 8
    expected = truth(count)
    masks = [m.copy() for m in expected]
    scores = [0.0] * count
    scores[4] = 0.9
    improving = iter([0.8, 0.7, 0.6, 0.5, 0.4])

    report = self_correct(
        masks, scores, set(),
        warp=lambda s, t, m: m,
        resegment=lambda run, cond: {4: [expected[4]]},
        rescore=lambda index, candidate: next(improving),
        accept=lambda i, c: None,
    )  # fmt: skip
    assert report.rounds == MAX_ROUNDS
    assert scores[4] == 0.6, "still above the threshold after K rounds: stays flagged"
