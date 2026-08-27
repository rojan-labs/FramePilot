"""The project's frame grid, mirroring ``packages/editor-core/src/frame-grid.ts``.

The TypeScript side OWNS the grid: it is what snaps an edit point when a patch is
committed, from either author (ADR 0146). This module exists so the render engine can
**assert** the grid rather than re-implement it — a second rounding rule on this side is
precisely how a preview and an export come to disagree about which frame a cut is on.

The contract, stated once and pinned by ``tests/fixtures/frame_grid_parity.json``:

* A frame rate resolves to a **rational** rate. 23.976 is 24000/1001, not a float, and
  29.97 is 30000/1001 — rounding against the float approximation drifts by a frame over a
  long timeline.
* ``seconds_to_frame`` rounds to the **nearest frame, ties away from zero**. Timeline
  times are non-negative, so ``math.floor(x + 0.5)`` here and ``Math.round`` there agree
  by construction. Python's built-in ``round`` is banker's rounding and would NOT agree —
  it is deliberately not used.

The same parity pattern as ``captionStyle.ts`` ↔ ``captions.py``: one fixture, both
runtimes, and a test that fails if either drifts.
"""

from __future__ import annotations

import math
from fractions import Fraction

#: Largest denominator considered when resolving a float rate to a rational one. 1001 is
#: the NTSC denominator; anything past it is a rate nobody shoots.
_MAX_RATE_DENOMINATOR = 1001

_RATE_EPSILON = 1e-6

#: Rates whose rational form is a standard, not a best fit. Mirrors COMMON_RATES in the
#: TypeScript module.
_COMMON_RATES: tuple[tuple[float, Fraction], ...] = (
    (23.976, Fraction(24_000, 1001)),
    (29.97, Fraction(30_000, 1001)),
    (47.952, Fraction(48_000, 1001)),
    (59.94, Fraction(60_000, 1001)),
    (119.88, Fraction(120_000, 1001)),
)


def rational_frame_rate(fps: float) -> Fraction:
    """Resolve a frame rate to the rational the TypeScript grid uses."""
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError(f"Frame rate must be a positive finite number, got {fps!r}.")
    for candidate, rate in _COMMON_RATES:
        if abs(candidate - fps) <= _RATE_EPSILON:
            return rate
    return Fraction(fps).limit_denominator(_MAX_RATE_DENOMINATOR)


def seconds_to_frame(seconds: float, fps: float) -> int:
    """Nearest frame, ties away from zero — never Python's banker's ``round``."""
    if not math.isfinite(seconds):
        raise ValueError(f"Time must be finite, got {seconds!r}.")
    rate = rational_frame_rate(fps)
    frame = seconds * rate.numerator / rate.denominator
    return math.floor(frame + 0.5) if frame >= 0 else math.ceil(frame - 0.5)


def frame_to_seconds(frame: int, fps: float) -> float:
    """Convert an integer frame back to seconds at the same rational rate."""
    rate = rational_frame_rate(fps)
    return frame * rate.denominator / rate.numerator


def snap_seconds_to_frame(seconds: float, fps: float) -> float:
    """Snap a sequence time to the nearest project frame."""
    return frame_to_seconds(seconds_to_frame(seconds, fps), fps)


def is_on_frame_grid(seconds: float, fps: float, tolerance: float = 1e-9) -> bool:
    """Whether ``seconds`` is already a frame boundary.

    Used to ASSERT the grid, not to enforce it. A project authored before ADR 0146 keeps
    its off-grid times until an edit touches them, so a False here is a legacy project,
    not a bug — which is why the compiler reports rather than refuses.
    """
    return abs(snap_seconds_to_frame(seconds, fps) - seconds) <= tolerance
