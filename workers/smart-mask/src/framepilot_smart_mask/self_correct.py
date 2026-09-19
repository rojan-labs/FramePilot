"""Stage 6: re-prompt SAM on frames the estimates disagree about, from confident neighbours.

For up to ``K = 3`` rounds:

1. Frames whose consensus score is above ``flag_threshold`` (and that are not locked) are
   grouped into runs.
2. For each run, the nearest confident frames on each side (score at or below
   ``confident_threshold``) are found. Their consensus masks are warped by optical flow onto the
   run's middle frame and intersected (or the one side used): the region both neighbours agree
   the subject moved to.
3. Auto prompts are sampled from that region: positive points at interior maxima of its
   distance transform, negative points where the current estimate claims foreground but the
   neighbours do not (the drift or the swapped subject), else on a ring just outside it.
4. SAM is re-run over the run with the confident neighbours as mask prompts and the auto
   points on the middle frame, forward and backward, giving two new estimates per frame.
5. A frame takes the new estimates only if its re-computed score is lower. Frames still above
   the threshold after the last round stay flagged for verification.

The loop is expressed over callables (``warp``, ``resegment``, ``rescore``) so its rules are
unit-tested with fakes; the pipeline binds them to SAM, DIS flow and consensus.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

from .tracker import CondPrompt, MaskPrompt, PointPrompt

_log = logging.getLogger(__name__)

MAX_ROUNDS: Final = 3
FLAG_THRESHOLD: Final = 0.05
CONFIDENT_THRESHOLD: Final = 0.02
#: How far (frames) to look for a confident neighbour on each side of a run.
NEIGHBOUR_REACH: Final = 30
MAX_POSITIVE_POINTS: Final = 3
MAX_NEGATIVE_POINTS: Final = 2
#: Positive points must be at least this far inside the region (px) to survive small warp error.
MIN_INTERIOR_PX: Final = 3.0
RING_PX: Final = 12
MIN_REGION_PX: Final = 32

Bool = npt.NDArray[np.bool_]


@dataclass(frozen=True, slots=True)
class Run:
    start: int
    end: int  # inclusive

    @property
    def middle(self) -> int:
        return (self.start + self.end) // 2


def flagged_runs(scores: list[float], flag_threshold: float, locked: set[int]) -> list[Run]:
    runs: list[Run] = []
    start: int | None = None
    for index, score in enumerate([*scores, 0.0]):
        flagged = (
            index < len(scores)
            and index not in locked
            and (np.isnan(score) or score > flag_threshold)
        )
        if flagged and start is None:
            start = index
        elif not flagged and start is not None:
            runs.append(Run(start, index - 1))
            start = None
    return runs


def confident_neighbours(
    run: Run, scores: list[float], confident_threshold: float, reach: int = NEIGHBOUR_REACH
) -> tuple[int | None, int | None]:
    def ok(index: int) -> bool:
        return not np.isnan(scores[index]) and scores[index] <= confident_threshold

    before = next(
        (i for i in range(run.start - 1, max(run.start - 1 - reach, -1), -1) if ok(i)), None
    )
    after = next(
        (i for i in range(run.end + 1, min(run.end + 1 + reach, len(scores))) if ok(i)), None
    )
    return before, after


def sample_points(region: Bool, current: Bool, width: int, height: int) -> PointPrompt | None:
    """Positive interior points of ``region``; negatives where ``current`` over-reaches it."""
    if int(region.sum()) < MIN_REGION_PX:
        return None
    distance: Any = cv2.distanceTransform(region.astype(np.uint8), cv2.DIST_L2, 5)
    coords: list[tuple[float, float]] = []
    labels: list[int] = []
    work = distance.copy()
    for _ in range(MAX_POSITIVE_POINTS):
        y, x = np.unravel_index(int(np.argmax(work)), work.shape)
        if work[y, x] < MIN_INTERIOR_PX:
            break
        coords.append(((x + 0.5) / width, (y + 0.5) / height))
        labels.append(1)
        # Spread points out: suppress a disk the size of this point's clearance.
        radius = max(int(distance[y, x]), 1)
        cv2.circle(work, (int(x), int(y)), radius * 2, 0.0, -1)
    if not coords:
        return None
    grown = cv2.dilate(
        region.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=RING_PX
    ).astype(bool)
    overreach = current & ~grown
    candidates = overreach if int(overreach.sum()) >= MIN_REGION_PX else None
    if candidates is None:
        ring = (
            cv2.dilate(
                grown.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=RING_PX
            ).astype(bool)
            & ~grown
        )
        candidates = ring
    outside: Any = cv2.distanceTransform(candidates.astype(np.uint8), cv2.DIST_L2, 5)
    for _ in range(MAX_NEGATIVE_POINTS):
        y, x = np.unravel_index(int(np.argmax(outside)), outside.shape)
        if outside[y, x] <= 0:
            break
        coords.append(((x + 0.5) / width, (y + 0.5) / height))
        labels.append(0)
        cv2.circle(outside, (int(x), int(y)), max(int(outside[y, x]), 1) * 3, 0.0, -1)
    return PointPrompt(coords=tuple(coords), labels=tuple(labels))


@dataclass
class CorrectionReport:
    rounds: int = 0
    attempted: dict[int, int] = field(default_factory=dict)
    accepted: dict[int, int] = field(default_factory=dict)

    def as_json(self) -> dict[str, Any]:
        return {
            "rounds": self.rounds,
            "framesAttempted": len(self.attempted),
            "framesAccepted": len(self.accepted),
        }


Resegment = Callable[[Run, dict[int, CondPrompt]], dict[int, list[Bool]]]
Rescore = Callable[[int, list[Bool]], float]
Accept = Callable[[int, list[Bool]], None]
Warp = Callable[[int, int, Bool], Bool]


def self_correct(
    masks: list[Bool],
    scores: list[float],
    locked: set[int],
    *,
    warp: Warp,
    resegment: Resegment,
    rescore: Rescore,
    accept: Accept,
    max_rounds: int = MAX_ROUNDS,
    flag_threshold: float = FLAG_THRESHOLD,
    confident_threshold: float = CONFIDENT_THRESHOLD,
    on_round: Callable[[int, int, int], None] | None = None,
    should_stop: Callable[[], None] | None = None,
) -> CorrectionReport:
    """Mutates ``masks`` and ``scores`` in place for accepted frames; returns what happened."""
    report = CorrectionReport()
    if not masks:
        return report
    height, width = masks[0].shape
    for round_number in range(1, max_rounds + 1):
        runs = flagged_runs(scores, flag_threshold, locked)
        work: list[tuple[Run, dict[int, CondPrompt]]] = []
        for run in runs:
            before, after = confident_neighbours(run, scores, confident_threshold)
            if before is None and after is None:
                continue
            target = run.middle
            warped = [
                warp(side, target, masks[side]) for side in (before, after) if side is not None
            ]
            region = np.logical_and.reduce(warped) if len(warped) > 1 else warped[0]
            prompt = sample_points(region, masks[target], width, height)
            if prompt is None:
                continue
            cond: dict[int, CondPrompt] = {target: prompt}
            for side in (before, after):
                if side is not None:
                    cond[side] = MaskPrompt(masks[side])
            work.append((run, cond))
        if not work:
            break
        report.rounds = round_number
        changed = 0
        for position, (run, cond) in enumerate(work):
            if should_stop is not None:
                should_stop()
            if on_round is not None:
                on_round(round_number, position, len(work))
            estimates = resegment(run, cond)
            for index in range(run.start, run.end + 1):
                report.attempted[index] = round_number
                candidate = estimates.get(index)
                if not candidate:
                    continue
                new_score = rescore(index, candidate)
                if new_score < scores[index] or np.isnan(scores[index]):
                    accept(index, candidate)
                    scores[index] = new_score
                    masks[index] = (
                        np.logical_or.reduce(candidate) if len(candidate) > 1 else candidate[0]
                    )
                    report.accepted[index] = round_number
                    changed += 1
        _log.debug(
            "self-correction round %d: %d runs, %d frames improved",
            round_number,
            len(work),
            changed,
        )
        if changed == 0:
            break
    return report


__all__ = [
    "MAX_ROUNDS",
    "CorrectionReport",
    "Run",
    "confident_neighbours",
    "flagged_runs",
    "sample_points",
    "self_correct",
]
