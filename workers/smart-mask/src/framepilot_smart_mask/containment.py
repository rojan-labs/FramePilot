"""BR3.17: a correction changes what it reaches, and nothing else (partial re-runs only).

**Why.** A partial re-run (``previousArtifact``) recomputes every frame within the affect radius
of a new prompt under the new conditioning. SAM then re-decides everything in those frames, not
only what the prompt was about. The BR7.4 correction replays measured what that costs: on the
crossing clip the third action made the corrected frame exact (IoU 0.998) while 14 of its 30
neighbours within a second lost up to 0.025 IoU to edge re-decisions nowhere near the fix; on
low light, action 2 lowered the corrected frame's BF@2px (0.974 → 0.940) and action 3 stopped
at 0.994 / 0.971 although it brushed every wrong pixel, because the re-run re-decided the
frame's *unbrushed* pixels.

**Rule.** After the re-run, per recomputed frame, against the previous matte:

* a **locked** frame, or one prompted with points or a box, takes the re-run's alpha (only
  prompts the previous matte does not already satisfy count: ``pipeline._prompt_satisfied``);
* a **brushed** frame takes it only on the brushed pixels (keep, remove and edge strokes): the
  editor painted what was wrong, everything unpainted keeps its previous alpha bit for bit;
* **every other frame** keeps its previous alpha except where the correction *reaches* it: the
  changed region of the frame next to it (towards the prompt) is carried over by optical flow
  and grown by ``REACH_MARGIN`` edge radii. If the re-run repeats that change on at least
  ``REPEAT_FRACTION`` of where it lands, the frame takes the re-run's changed decisions inside
  the reach (with a band of ``edge_radius`` around them, so their soft edge comes
  along). What it takes becomes the reach for the next frame; reach that finds no change stops.

Locks and brushed pixels are applied before this and are never undone by it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

from .consensus import disk, edge_radius
from .flow import warp
from .prompts import FramePrompts

#: How far (in edge radii) a carried-over change region is grown to absorb flow error.
REACH_MARGIN: Final = 2
#: A neighbour is reached only if the re-run repeats the correction's change on at least this
#: fraction of where it lands. Set a priori (half of the change), not fitted: the pilot has
#: correction replays on scored clips only.
REPEAT_FRACTION: Final = 0.5

U8 = npt.NDArray[np.uint8]
Bool = npt.NDArray[np.bool_]
FlowFn = Callable[[int, int], npt.NDArray[Any]]


def _changed(previous: U8, new: U8) -> Bool:
    changed: Bool = (previous >= 128) != (new >= 128)
    return changed


def _prompt_frame(previous: U8, new: U8, prompt: FramePrompts) -> tuple[U8, Bool]:
    """What a prompted frame keeps of the re-run, and the region that changed."""
    if prompt.keep is None or prompt.lock is not None or prompt.has_points:
        return new, _changed(previous, new)
    painted = prompt.keep.copy()
    for stroke in (prompt.remove, prompt.edge):
        if stroke is not None:
            painted |= stroke
    out = np.where(painted, new, previous).astype(np.uint8)
    return out, _changed(previous, out)


def _reached(
    previous: U8, new: U8, landed: Bool, grow: npt.NDArray[Any], radius: int
) -> tuple[U8, Bool]:
    """The re-run's change on a frame the correction did not prompt, limited to its reach.

    ``landed`` is where the next frame's change lands after the flow. The frame takes the
    re-run's changes near it only if it repeats that change on at least ``REPEAT_FRACTION`` of
    it; edge re-decisions that merely touch it are not the correction's doing.
    """
    changed = _changed(previous, new)
    if not landed.any() or float((changed & landed).sum()) < REPEAT_FRACTION * float(landed.sum()):
        return previous, np.zeros_like(changed)
    reach = cv2.dilate(landed.astype(np.uint8), grow).astype(bool)
    taken: Bool = changed & reach
    region = cv2.dilate(taken.astype(np.uint8), disk(radius)).astype(bool) & reach
    out = np.where(region, new, previous).astype(np.uint8)
    return out, taken


def contain(
    previous: list[U8 | None],
    new: list[U8],
    prompts: dict[int, FramePrompts],
    flow: FlowFn,
) -> tuple[list[U8], list[bool]]:
    """Limit a partial re-run's frames to what its prompts reach.

    ``previous[i]`` is frame ``i``'s alpha in the previous artifact (None: nothing to keep, the
    re-run's alpha stands), ``new[i]`` the re-run's, ``prompts`` the frames the request prompts
    (indices into the lists), ``flow(source, target)`` motion with
    ``target(x) ≈ source(x + flow(x))``. Returns the contained alphas and, per frame, whether
    any of the re-run's alpha was taken.
    """
    count = len(new)
    if count == 0:
        return [], []
    height = new[0].shape[0]
    radius = edge_radius(height)
    grow = disk(REACH_MARGIN * radius)
    out: list[U8] = [
        new[i] if previous[i] is None else previous[i]  # type: ignore[misc]
        for i in range(count)
    ]
    reach: list[Bool | None] = [None] * count
    for index, prompt in prompts.items():
        prior = previous[index]
        if prior is None:
            continue
        out[index], reach[index] = _prompt_frame(prior, new[index], prompt)
    for index in sorted(prompts):
        for step in (1, -1):
            carried = reach[index]
            neighbour = index + step
            while carried is not None and carried.any() and 0 <= neighbour < count:
                prior = previous[neighbour]
                if prior is None or neighbour in prompts:
                    break
                landed = warp(carried.astype(np.float32), flow(neighbour - step, neighbour)) >= 0.5
                kept, taken = _reached(prior, new[neighbour], landed, grow, radius)
                if reach[neighbour] is None:
                    out[neighbour], reach[neighbour] = kept, taken
                else:
                    region = kept != prior
                    out[neighbour] = np.where(region, kept, out[neighbour]).astype(np.uint8)
                    reach[neighbour] = reach[neighbour] | taken  # type: ignore[operator]
                carried = taken
                neighbour += step
    taken_any = [
        previous[i] is None or not np.array_equal(out[i], previous[i])  # type: ignore[arg-type]
        for i in range(count)
    ]
    return out, taken_any


__all__ = ["REACH_MARGIN", "REPEAT_FRACTION", "contain"]
