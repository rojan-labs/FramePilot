"""Speed curves — playback rate as a function of source time (schema v15, ADR 0090).

The Python half of a parity pair; ``packages/editor-core/src/speed-curve.ts`` is the
other. **These two must produce the same numbers**, not merely the same shape,
because the preview and the export both derive a clip's duration and its
timeline<->source mapping from here. ``fixtures/speed-curve-parity.json`` pins that
to 1e-9 in both suites, exactly as ``bezier-parity.json`` does for the ADR 0089
solver.

## The one idea

A constant speed obeys ADR 0046's rule::

    end - start == (source_end - source_start) / speed

A ramp generalises it to that rule's integral form::

    end - start == integral of (1 / rate(s)) ds   over s in [0, source_span]

with the constant case falling out exactly when ``rate(s)`` is constant. That is the
whole module: :func:`integrate_rate` going source -> timeline, and
:func:`source_time_at` inverting it.

## Why the integration is fixed-step, not adaptive

The same lesson the ADR 0089 solver recorded, and it bites harder here. An adaptive
quadrature subdivides "until the error estimate is small enough", which means it
takes a *different number of steps* in the two languages the moment their
intermediate rounding differs by one ulp — and then the preview and the export
disagree about how long a clip is. A duration disagreement is not a cosmetic drift
like a slightly different ease: it desynchronises everything after the clip. So: a
fixed :data:`SIMPSON_INTERVALS` per curve segment, in both languages, forever.

Integration is also **piecewise** — split at every control point before integrating
— because the rate curve has a kink at each one. Simpson's rule is exact for cubics
on a smooth piece and badly wrong across a corner, so the split is what buys the
accuracy, not the step count.
"""

from __future__ import annotations

from collections.abc import Sequence
from itertools import pairwise
from typing import Any

from framepilot_engine.effects.keyframes import apply_easing

#: Sub-intervals per curve segment for Simpson's rule. **Must be even** (Simpson
#: pairs its intervals) and must match the TypeScript mirror.
#:
#: 128 rather than a cheaper 64 to buy margin against :data:`SPEED_EPSILON`. No fixed
#: quadrature is exactly additive across a split point, so splitting a ramped clip
#: moves each half's derived source range by the quadrature error; at 64 that error
#: is ~6e-8, uncomfortably close to the 1e-6 the validator enforces. Simpson is
#: O(h^4), so doubling the intervals cuts it ~16x to ~4e-9.
SIMPSON_INTERVALS = 128

#: Bisection steps when inverting the integral. Fixed, not convergence-tested, for
#: the reason in the module docstring.
INVERSION_STEPS = 60

#: Tolerance for "this duration matches the curve" — mirrors the validator's.
SPEED_EPSILON = 1e-6


def _points_of(ramp: Any) -> list[Any]:
    """Coerce a ramp to a list, treating ``None`` as absent."""
    if ramp is None:
        return []
    return list(ramp)


def _source_time(point: Any) -> float:
    return float(getattr(point, "source_time", None) or getattr(point, "sourceTime", 0.0) or 0.0)


def _rate(point: Any) -> float:
    return float(getattr(point, "rate", 1.0))


def _easing(point: Any) -> str:
    return str(getattr(point, "easing", "linear") or "linear")


def has_speed_ramp(clip: Any) -> bool:
    """True when the clip's rate varies, i.e. the curve governs its duration."""
    return len(_points_of(getattr(clip, "speed_ramp", None))) > 0


def normalize_ramp(points: Sequence[Any]) -> list[Any]:
    """The ramp's points in source-time order, with anything unusable dropped.

    Sorting here rather than trusting the stored order means a patch that appends a
    point does not have to know where it belongs, and two points at the same source
    time collapse to the first — a curve cannot have two rates at one instant, and
    keeping both would make the integral depend on list order.
    """
    usable = [p for p in points if _rate(p) > 0.0]
    ordered = sorted(usable, key=_source_time)
    result: list[Any] = []
    for point in ordered:
        if result and abs(_source_time(result[-1]) - _source_time(point)) < 1e-9:
            continue
        result.append(point)
    return result


def rate_at(points: Sequence[Any], s: float) -> float:
    """The playback rate at clip-relative source time ``s``.

    Outside the curve's own span the rate is **held** at the nearest end point rather
    than extrapolated. Extrapolating a curve whose last two points are accelerating
    would keep accelerating past the end of the footage and could cross zero, which
    the schema forbids for good reason — a held rate cannot.
    """
    ramp = normalize_ramp(points)
    if not ramp:
        return 1.0
    first, last = ramp[0], ramp[-1]
    if s <= _source_time(first):
        return _rate(first)
    if s >= _source_time(last):
        return _rate(last)
    for a, b in pairwise(ramp):
        if s > _source_time(b):
            continue
        span = _source_time(b) - _source_time(a)
        if span <= 0.0:
            return _rate(b)
        eased = apply_easing(_easing(a), (s - _source_time(a)) / span)
        return _rate(a) + (_rate(b) - _rate(a)) * eased
    return _rate(last)


def _integrate_piece(points: Sequence[Any], start: float, end: float) -> float:
    """Simpson's rule for ``1 / rate(s)`` over one smooth piece ``[start, end]``."""
    width = end - start
    if width <= 0.0:
        return 0.0
    h = width / SIMPSON_INTERVALS
    total = 1.0 / rate_at(points, start) + 1.0 / rate_at(points, end)
    for i in range(1, SIMPSON_INTERVALS):
        weight = 2.0 if i % 2 == 0 else 4.0
        total += weight * (1.0 / rate_at(points, start + i * h))
    return total * h / 3.0


def integrate_rate(points: Sequence[Any], start: float, end: float) -> float:
    """Timeline seconds consumed by source seconds ``[start, end]``.

    The integral form of ADR 0046's duration rule.
    """
    if end <= start:
        return 0.0
    ramp = normalize_ramp(points)
    if not ramp:
        return end - start
    # Split at every control point inside the range: the curve has a kink at each,
    # and Simpson is exact on a smooth piece but badly wrong across a corner.
    interior = [_source_time(p) for p in ramp if start < _source_time(p) < end]
    cuts = [start, *interior, end]
    return sum(_integrate_piece(ramp, a, b) for a, b in pairwise(cuts))


def source_time_at(
    points: Sequence[Any], start: float, timeline_offset: float, max_source: float
) -> float:
    """Invert :func:`integrate_rate`: the source time reached after ``timeline_offset``.

    This is the mapping the render needs — MoviePy's ``time_transform`` asks "which
    source frame belongs at this output time?" — and it is why rates must be
    positive: the integral is then strictly increasing and therefore invertible.

    ``max_source`` clamps the result, so asking past the end of the footage holds the
    last frame rather than reading off the end of the asset.
    """
    if timeline_offset <= 0.0:
        return start
    ramp = normalize_ramp(points)
    if not ramp:
        return min(max_source, start + timeline_offset)
    if integrate_rate(ramp, start, max_source) <= timeline_offset:
        return max_source
    lo, hi = start, max_source
    for _ in range(INVERSION_STEPS):
        mid = (lo + hi) / 2.0
        if integrate_rate(ramp, start, mid) < timeline_offset:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def clip_timeline_duration(clip: Any) -> float | None:
    """The timeline duration a clip's source range and speed settings imply.

    ``None`` for a **freeze frame** (``speed == 0``), where the source range names a
    held frame and any timeline duration is legitimate.

    One function, used by the validator, by every edge-changing operation and by the
    render — so they cannot disagree about what a clip's length should be, which is
    precisely how ADR 0046's known limitation arose.
    """
    source_span = float(clip.source_end) - float(clip.source_start)
    if has_speed_ramp(clip):
        return integrate_rate(_points_of(clip.speed_ramp), 0.0, source_span)
    speed = clip.speed if clip.speed is not None else 1.0
    if speed == 0.0:
        return None  # freeze: no duration is derivable, none is wrong
    # Magnitude: reverse consumes the same footage backwards, which still takes
    # positive timeline time.
    return source_span / abs(float(speed))


def source_span_for_duration(clip: Any, start: float, timeline_duration: float) -> float:
    """The source span filling ``timeline_duration`` seconds from clip-relative ``start``.

    The inverse of :func:`clip_timeline_duration`, and what every edge-changing
    operation needs to stay speed-aware. Returns ``0`` for a freeze frame: a held
    frame consumes no additional footage however long it is held.
    """
    if timeline_duration <= 0.0:
        return 0.0
    if has_speed_ramp(clip):
        available = float(clip.source_end) - float(clip.source_start)
        return (
            source_time_at(_points_of(clip.speed_ramp), start, timeline_duration, available) - start
        )
    speed = clip.speed if clip.speed is not None else 1.0
    if speed == 0.0:
        return 0.0
    return timeline_duration * abs(float(speed))
