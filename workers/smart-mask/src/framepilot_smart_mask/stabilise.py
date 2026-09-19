"""Stage 9: temporal stabilisation — a motion-compensated vote on the silhouette, then the band.

**BR7.4 finding.** The first stabilisation averaged band alpha with the neighbours warped by the
half-resolution DIS flow (centre weight 2, ±24 levels). On the construction-true pilot it
removed at most 8% of dtSSD and then *added* error on 7 of 10 categories once the soft edge
existed: warping the ground truth's own alpha with that flow misses by 11-51 levels in the band,
more than the per-frame estimate's error (10-18), so every average moved a good edge towards a
worse one.

**BR7.5.** Two changes, both fitted on the BR7.4 it6 calibration split by replaying the dumped
estimates offline (no model) and frozen for the scored split:

1. **Temporal vote before the silhouette decision** (:func:`temporal_vote`). Each frame's SAM
   estimate (the mean of its forward/backward masks) is fused with those of the frames within
   ``RADIUS``, warped onto it by the fine flow (``flow.fine_flow``) and weighted per pixel by
   ``flow.reliability`` (photometric residual × forward-backward consistency) at
   ``NEIGHBOUR_WEIGHT`` each. Where the warp cannot be trusted the frame's own estimate decides.
   The silhouette is the fused estimate ≥ ½ (ties: the frame's own).
2. **Band smoothing with trusted neighbours only** (:func:`stabilise`): band alpha becomes the
   reliability-weighted mean of this frame (weight 1) and the warped neighbours within
   ``RADIUS``. No clamp is needed: an unreliable neighbour has no weight.

Calibration result (it6 dumps, dtSSD reduction against stabilisation off, 10 categories): mean
+2.6% (worst -4%, best +13%), worse than off on 2 of 10, against BR7.4's mean -3.4% and worse
on 6 of 10; mean IoU +0.0007, BF@2px +0.003. 06's ≥ 30% is not reached: see BR0-FINDINGS BR7.5.

Hard constraints hold throughout: locked frames and brush-constrained pixels never change, and
only band pixels are smoothed. Every frame is computed from unsmoothed inputs (Jacobi order), so
a resumed window reproduces it exactly.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

import numpy as np
import numpy.typing as npt

from .flow import warp

#: Frames on each side that vote and smooth.
RADIUS: Final = 2
#: A neighbour's vote relative to the frame's own (times its per-pixel reliability).
NEIGHBOUR_WEIGHT: Final = 0.5
CENTRE_WEIGHT: Final = 1.0

Bool = npt.NDArray[np.bool_]
Float = npt.NDArray[Any]
#: ``motion(source, target)`` → (flow with ``target(x) ≈ source(x + flow(x))``, reliability 0-1).
MotionFn = Callable[[int, int], tuple[Float, Float]]


def _neighbours(index: int, count: int) -> list[int]:
    return [
        n
        for offset in range(1, RADIUS + 1)
        for n in (index - offset, index + offset)
        if 0 <= n < count
    ]


def temporal_vote(
    index: int, count: int, estimate: Callable[[int], Float | None], motion: MotionFn
) -> Bool | None:
    """The fused silhouette of frame ``index``; None when the frame has no SAM estimate.

    ``estimate(i)`` is frame ``i``'s SAM estimate in [0, 1] (mean of its binary masks) or None.
    """
    own = estimate(index)
    if own is None:
        return None
    total = own.astype(np.float32).copy()
    weight = np.ones(own.shape, np.float32)
    for neighbour in _neighbours(index, count):
        other = estimate(neighbour)
        if other is None:
            continue
        forward, trust = motion(neighbour, index)
        trust = trust * NEIGHBOUR_WEIGHT
        total += trust * warp(other.astype(np.float32), forward)
        weight += trust
    fused = total / weight
    silhouette: Bool = (fused > 0.5) | ((fused == 0.5) & (own > 0.5))
    return silhouette


def stabilise(
    alphas: list[npt.NDArray[np.uint8]],
    bands: list[Bool],
    fixed: list[Bool],
    motion: MotionFn,
) -> tuple[list[npt.NDArray[np.uint8]], list[int]]:
    """Return band-smoothed alphas and the number of changed pixels per frame.

    ``fixed[t]`` marks pixels that must not change (locks, brush keep/remove).
    """
    count = len(alphas)
    out: list[npt.NDArray[np.uint8]] = []
    changed: list[int] = []
    for index in range(count):
        editable = bands[index] & ~fixed[index]
        if count < 2 or not editable.any():
            out.append(alphas[index])
            changed.append(0)
            continue
        total = alphas[index].astype(np.float32) * CENTRE_WEIGHT
        weight = np.full(total.shape, CENTRE_WEIGHT, np.float32)
        for neighbour in _neighbours(index, count):
            forward, trust = motion(neighbour, index)
            total += trust * warp(alphas[neighbour].astype(np.float32), forward)
            weight += trust
        values = np.clip(np.round(total / weight), 0, 255).astype(np.uint8)
        result = alphas[index].copy()
        result[editable] = values[editable]
        out.append(result)
        changed.append(int((result != alphas[index]).sum()))
    return out, changed


__all__ = ["NEIGHBOUR_WEIGHT", "RADIUS", "stabilise", "temporal_vote"]
