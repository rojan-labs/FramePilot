"""Stage 3: two independent SAM 2.1 estimates per frame, window by window.

For each window (300 frames, 60 overlap, plan 02 Runtime):

* **Conditioning frames** are the editor's prompts (points/boxes), locked frames (mask prompts:
  hard constraints that also seed the memory), and — for every window after the first — the
  previous window's verified alpha at this window's first frame.
* **Pass A (forward)** tracks from the first conditioning frame to the window's end.
* **Pass B (backward)** tracks from the last conditioning frame back to the window's start.
  When pass A reached frames after the last conditioning frame, the last frame pass A was
  confident about becomes an extra conditioning frame for pass B, so frames after the last
  prompt still get a second, independent estimate instead of none.
* **Pass C (forward, head)** gives frames before the first conditioning frame their second
  estimate the same way, seeded from pass B's earliest confident frame.

Each pass starts from an empty recent-memory bank, so the estimates are independent apart from
their shared conditioning frames. Frames a pass never reached are marked absent, never filled.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final

import numpy as np
import numpy.typing as npt

from .tracker import LOW_RES, CondPrompt, MaskPrompt, PassResult, SamTracker, video_logits

_log = logging.getLogger(__name__)

WINDOW_FRAMES: Final = 300
WINDOW_OVERLAP: Final = 60
#: A pass result is a usable seed only when SAM says the object is present with this IoU.
SEED_MIN_IOU: Final = 0.5
#: ... and the low-res mask holds at least this many pixels (256² grid).
SEED_MIN_PIXELS: Final = 8


@dataclass(frozen=True, slots=True)
class WindowPlan:
    index: int
    start: int
    end: int  # exclusive
    commit_start: int
    commit_end: int  # exclusive

    @property
    def count(self) -> int:
        return self.end - self.start


def plan_windows(
    count: int, size: int = WINDOW_FRAMES, overlap: int = WINDOW_OVERLAP
) -> list[WindowPlan]:
    """Overlapping windows covering ``[0, count)``; each frame is committed by exactly one.

    The seam between two windows is the middle of their overlap, so each committed frame has at
    least ``overlap / 2`` frames of context on its own window's side.
    """
    if count <= 0:
        return []
    if size <= overlap:
        raise ValueError("a window must be longer than its overlap")
    if count <= size:
        return [WindowPlan(0, 0, count, 0, count)]
    step = size - overlap
    starts = list(range(0, count - size, step))
    starts.append(count - size if count - size > starts[-1] else starts[-1])
    starts = sorted(set(starts))
    ends = [min(start + size, count) for start in starts]
    plans: list[WindowPlan] = []
    for index, (start, end) in enumerate(zip(starts, ends, strict=True)):
        commit_start = 0 if index == 0 else (start + ends[index - 1]) // 2
        commit_end = count if index == len(starts) - 1 else (starts[index + 1] + end) // 2
        plans.append(WindowPlan(index, start, end, commit_start, commit_end))
    return plans


@dataclass
class Segmentation:
    """Both estimates for one window, at SAM's 256² logit resolution."""

    count: int
    height: int
    width: int
    fwd: npt.NDArray[np.float32]
    bwd: npt.NDArray[np.float32]
    has_fwd: npt.NDArray[np.bool_]
    has_bwd: npt.NDArray[np.bool_]
    fwd_score: npt.NDArray[np.float32]
    bwd_score: npt.NDArray[np.float32]
    fwd_iou: npt.NDArray[np.float32]
    bwd_iou: npt.NDArray[np.float32]
    seeds: dict[str, int] = field(default_factory=dict)

    @classmethod
    def empty(cls, count: int, height: int, width: int) -> Segmentation:
        def logits() -> npt.NDArray[np.float32]:
            return np.full((count, LOW_RES, LOW_RES), -1024.0, np.float32)

        def scores() -> npt.NDArray[np.float32]:
            return np.full(count, np.nan, np.float32)

        return cls(
            count, height, width, logits(), logits(),
            np.zeros(count, np.bool_), np.zeros(count, np.bool_),
            scores(), scores(), scores(), scores(),
        )  # fmt: skip

    def logits(self, which: str, index: int) -> npt.NDArray[np.float32]:
        source = self.fwd if which == "fwd" else self.bwd
        out: npt.NDArray[np.float32] = video_logits(source[index], self.height, self.width)
        return out

    def masks(self, index: int) -> list[npt.NDArray[np.bool_]]:
        """The binary SAM estimates available for a frame (0, 1 or 2 of them)."""
        found: list[npt.NDArray[np.bool_]] = []
        if self.has_fwd[index]:
            found.append(self.logits("fwd", index) > 0)
        if self.has_bwd[index]:
            found.append(self.logits("bwd", index) > 0)
        return found

    def mean_logits(self, index: int) -> npt.NDArray[np.float32] | None:
        parts = [
            self.logits(which, index)
            for which, has in (("fwd", self.has_fwd), ("bwd", self.has_bwd))
            if has[index]
        ]
        if not parts:
            return None
        mean: npt.NDArray[np.float32] = np.mean(parts, axis=0).astype(np.float32)
        return mean


def _store(target: Segmentation, which: str, result: PassResult, only: range | None = None) -> None:
    logits = target.fwd if which == "fwd" else target.bwd
    has = target.has_fwd if which == "fwd" else target.has_bwd
    scores = target.fwd_score if which == "fwd" else target.bwd_score
    ious = target.fwd_iou if which == "fwd" else target.bwd_iou
    for index, low_res in result.low_res.items():
        if only is not None and index not in only:
            continue
        logits[index] = low_res
        has[index] = True
        scores[index] = result.scores[index]
        ious[index] = result.ious[index]


def _confident(result: PassResult, index: int) -> bool:
    if index not in result.low_res:
        return False
    return (
        result.scores[index] > 0
        and result.ious[index] >= SEED_MIN_IOU
        and int((result.low_res[index] > 0).sum()) >= SEED_MIN_PIXELS
    )


def segment_window(
    tracker: SamTracker,
    count: int,
    height: int,
    width: int,
    prompts: dict[int, CondPrompt],
    on_frame: Callable[[str, int], None] | None = None,
) -> Segmentation:
    """Run passes A, B and C over one window (indices local to the window)."""
    if not prompts:
        raise ValueError("a window needs at least one conditioning frame")
    segmentation = Segmentation.empty(count, height, width)
    cond = {index: tracker.condition(index, prompt) for index, prompt in sorted(prompts.items())}
    first, last = min(cond), max(cond)

    def notify(which: str) -> Callable[[int], None]:
        return lambda index: on_frame(which, index) if on_frame is not None else None

    forward = tracker.propagate(
        cond, count, reverse=False, start=first, stop=count - 1, on_frame=notify("fwd")
    )
    _store(segmentation, "fwd", forward)

    backward_cond = dict(cond)
    seed_b = next(
        (index for index in range(count - 1, last, -1) if _confident(forward, index)), None
    )
    if seed_b is not None:
        mask = video_logits(forward.low_res[seed_b], height, width) > 0
        backward_cond[seed_b] = tracker.condition(seed_b, MaskPrompt(mask))
        segmentation.seeds["backward"] = seed_b
    backward = tracker.propagate(
        backward_cond, count, reverse=True, start=max(backward_cond), stop=0, on_frame=notify("bwd")
    )
    _store(segmentation, "bwd", backward)

    if first > 0:
        seed_c = next((index for index in range(0, first) if _confident(backward, index)), None)
        if seed_c is not None:
            head_cond = dict(cond)
            mask = video_logits(backward.low_res[seed_c], height, width) > 0
            head_cond[seed_c] = tracker.condition(seed_c, MaskPrompt(mask))
            head = tracker.propagate(
                head_cond,
                count,
                reverse=False,
                start=seed_c,
                stop=first - 1,
                on_frame=notify("fwd"),
            )
            _store(segmentation, "fwd", head, only=range(seed_c, first))
            segmentation.seeds["head"] = seed_c
    _log.debug("window of %d frames segmented; seeds %s", count, segmentation.seeds)
    return segmentation


__all__ = [
    "WINDOW_FRAMES",
    "WINDOW_OVERLAP",
    "Segmentation",
    "WindowPlan",
    "plan_windows",
    "segment_window",
]
