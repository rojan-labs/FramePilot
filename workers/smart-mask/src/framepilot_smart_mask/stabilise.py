"""Stage 9: kill edge shimmer by temporal smoothing inside the band only.

For each frame, the neighbouring frames' alpha is warped onto it by DIS flow; where the flow is
forward-backward consistent, band alpha becomes a weighted mean of this frame (weight 2) and
the warped neighbours (weight 1 each). Three bounds keep it from smearing motion or rewriting
decisions:

* only **band** pixels change — pixels stage 5 fixed at 0 or 255 are untouched;
* a pixel moves by at most ``MAX_DELTA`` levels, so a real edge motion the flow missed cannot
  be averaged away;
* **locked frames and brush-constrained pixels never change** (hard constraints).

All frames are smoothed from the unsmoothed values (Jacobi order), so the result does not
depend on processing order and a resumed window reproduces it exactly.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

import numpy as np
import numpy.typing as npt

from .flow import consistent, warp

MAX_DELTA: Final = 24
CENTRE_WEIGHT: Final = 2.0

Bool = npt.NDArray[np.bool_]
FlowFn = Callable[[int, int], npt.NDArray[Any]]


def stabilise(
    alphas: list[npt.NDArray[np.uint8]],
    bands: list[Bool],
    fixed: list[Bool],
    flow: FlowFn,
) -> tuple[list[npt.NDArray[np.uint8]], list[int]]:
    """Return smoothed alphas and the number of changed pixels per frame.

    ``flow(source, target)`` gives ``f`` with ``target(x) ≈ source(x + f(x))``.
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
        centre = alphas[index].astype(np.float32)
        total = centre * CENTRE_WEIGHT
        weight = np.full(centre.shape, CENTRE_WEIGHT, np.float32)
        for neighbour in (index - 1, index + 1):
            if not 0 <= neighbour < count:
                continue
            forward = flow(neighbour, index)
            backward = flow(index, neighbour)
            trusted = consistent(forward, backward)
            warped = warp(alphas[neighbour].astype(np.float32), forward)
            total += np.where(trusted, warped, 0.0)
            weight += trusted.astype(np.float32)
        smoothed = total / weight
        delta = np.clip(smoothed - centre, -MAX_DELTA, MAX_DELTA)
        result = alphas[index].copy()
        values = np.clip(np.round(centre + delta), 0, 255).astype(np.uint8)
        result[editable] = values[editable]
        out.append(result)
        changed.append(int((result != alphas[index]).sum()))
    return out, changed


__all__ = ["MAX_DELTA", "stabilise"]
