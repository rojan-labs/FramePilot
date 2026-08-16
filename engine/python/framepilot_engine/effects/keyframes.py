"""Keyframe easing and interpolation (PRD §6.3, plan Phase 5).

WHY: motion (zoom/punch-in, position, opacity, etc.) is driven by keyframes with
easing. This module is the deterministic **evaluation engine** that turns a
clip's stored :class:`~framepilot_engine.timeline.models.Keyframe` list into a
concrete property value at any time — the foundation the render compiler and the
UI both consume. It is pure (no MoviePy, no I/O), so it is 100% unit-testable and
golden-stable.

It is the Python mirror of the TS ``@framepilot/editor-core`` ``keyframes.ts``
module; the two MUST stay in sync (same easing curves, same segment semantics).

Segment semantics (matches the data model and the TS mirror): a keyframe's
``easing`` describes the curve **into the next keyframe**, so segment ``a -> b``
is eased by ``a``'s curve. Before the first keyframe the value holds at the
first; after the last it holds at the last.
"""

from __future__ import annotations

from collections.abc import Callable
from enum import StrEnum
from itertools import pairwise

from framepilot_engine.timeline.models import Keyframe


class Easing(StrEnum):
    """Supported easing curves for keyframe interpolation (PRD §6.3).

    Values are the **canonical hyphenated names** shared with the Zod/JSON
    schema and the AI tool registry — keyframe ``easing`` strings stored in a
    project use exactly these spellings.
    """

    LINEAR = "linear"
    EASE_IN = "ease-in"
    EASE_OUT = "ease-out"
    EASE_IN_OUT = "ease-in-out"
    HOLD = "hold"
    BEZIER = "bezier"


def _ease_in_out(t: float) -> float:
    """Quadratic ease-in-out: accelerate then decelerate."""
    if t < 0.5:
        return 2.0 * t * t
    return 1.0 - (-2.0 * t + 2.0) ** 2 / 2.0


# Easing curves map normalized progress t in [0, 1] -> eased progress in [0, 1].
# HOLD keeps the start value across the whole segment and only snaps to the end
# exactly at t == 1 (so an interior keyframe still reads its own value).
# BEZIER is the smoothstep cubic (3t^2 - 2t^3); per-keyframe bezier handles are a
# future schema addition (Keyframe has no control points today).
_EASING_FUNCTIONS: dict[Easing, Callable[[float], float]] = {
    Easing.LINEAR: lambda t: t,
    Easing.EASE_IN: lambda t: t * t,
    Easing.EASE_OUT: lambda t: t * (2.0 - t),
    Easing.EASE_IN_OUT: _ease_in_out,
    Easing.HOLD: lambda t: 1.0 if t >= 1.0 else 0.0,
    Easing.BEZIER: lambda t: t * t * (3.0 - 2.0 * t),
}


def _resolve_easing(easing: str | Easing) -> Easing:
    """Coerce a (possibly unknown) easing name to an :class:`Easing`.

    Unknown names fall back to :attr:`Easing.LINEAR` rather than raising — the
    evaluation engine must never crash a render on a stray easing string.
    """
    if isinstance(easing, Easing):
        return easing
    try:
        return Easing(easing)
    except ValueError:
        return Easing.LINEAR


def apply_easing(easing: str | Easing, t: float) -> float:
    """Apply an easing curve to normalized progress ``t`` (clamped to [0, 1])."""
    clamped = 0.0 if t <= 0.0 else 1.0 if t >= 1.0 else t
    return _EASING_FUNCTIONS[_resolve_easing(easing)](clamped)


# ---------------------------------------------------------------------------
# Custom bezier curves (schema v14, ADR 0089)
# ---------------------------------------------------------------------------

#: Newton-Raphson iterations used to invert the curve's x(s).
#:
#: A **fixed** count, not "iterate until converged": the TS mirror must produce
#: bit-identical output, and a convergence test with any epsilon would make the
#: iteration count depend on rounding. Eight is comfortably enough on [0, 1].
_BEZIER_NEWTON_ITERATIONS = 8

#: Below this slope Newton stalls, so the solver falls back to bisection.
_BEZIER_MIN_SLOPE = 1e-6

#: Bisection steps for the fallback. Fixed, for the same reason as above.
_BEZIER_BISECTION_ITERATIONS = 20


def _bezier_component(a: float, b: float, s: float) -> float:
    """Cubic Bezier component with endpoints pinned at 0 and 1."""
    inv = 1.0 - s
    return 3.0 * inv * inv * s * a + 3.0 * inv * s * s * b + s * s * s


def _bezier_component_slope(a: float, b: float, s: float) -> float:
    """d/ds of :func:`_bezier_component`."""
    inv = 1.0 - s
    return 3.0 * inv * inv * a + 6.0 * inv * s * (b - a) + 3.0 * s * s * (1.0 - b)


def solve_cubic_bezier(
    out: tuple[float, float], into: tuple[float, float], x: float
) -> float:
    """Solve a cubic-bezier curve ``y`` at progress ``x``, given two control points.

    Mirrors the TS ``solveCubicBezier`` operation for operation — the two MUST stay
    identical, or the preview and the export would draw different motion.

    The curve runs from ``(0, 0)`` to ``(1, 1)``; ``out`` and ``into`` are the
    control points (the CSS ``cubic-bezier(x1, y1, x2, y2)`` parametrisation).
    Because the curve is parametric, ``y`` is not a direct function of ``x`` — the
    parameter ``s`` satisfying ``x(s) = x`` is found first.

    ``y`` is intentionally **not clamped**: overshoot and anticipation are the whole
    reason to draw a custom curve. Consumers needing a bounded value clamp at the
    point of use, as they already do.
    """
    x1, y1 = out
    x2, y2 = into
    # A curve whose x-control points are the identity is linear in x, so s == x
    # exactly — worth short-circuiting because it is the common "straight line"
    # handle configuration and the solver would only approximate it.
    if x1 == 1.0 / 3.0 and x2 == 2.0 / 3.0:
        return _bezier_component(y1, y2, x)

    s = x
    for _ in range(_BEZIER_NEWTON_ITERATIONS):
        slope = _bezier_component_slope(x1, x2, s)
        if abs(slope) < _BEZIER_MIN_SLOPE:
            break
        s -= (_bezier_component(x1, x2, s) - x) / slope
    # Newton can leave the domain on a near-vertical curve; bisection is slower but
    # cannot, so it both rescues and bounds the answer.
    if not 0.0 <= s <= 1.0:
        low, high = 0.0, 1.0
        s = x
        for _ in range(_BEZIER_BISECTION_ITERATIONS):
            s = (low + high) / 2.0
            if _bezier_component(x1, x2, s) < x:
                low = s
            else:
                high = s
    return _bezier_component(y1, y2, s)


def segment_progress(left: Keyframe, right: Keyframe, t: float) -> float:
    """The eased progress for the segment ``left -> right``.

    For every easing but ``bezier`` this is just :func:`apply_easing`. For
    ``bezier`` it is the two-sided curve the schema describes: ``left.handles.out``
    and ``right.handles.in``, matching CSS and every animation tool.

    **When either handle is missing the result is the hardcoded smoothstep**
    (``3t^2 - 2t^3``) that ``bezier`` has always meant, so a v13 project evaluates
    identically after the v14 migration. Falling back to linear, or to some default
    curve, would silently rewrite every existing animation.
    """
    if _resolve_easing(left.easing) is not Easing.BEZIER:
        return apply_easing(left.easing, t)
    out = left.handles.out if left.handles is not None else None
    into = right.handles.in_ if right.handles is not None else None
    if out is None or into is None:
        return apply_easing(Easing.BEZIER, t)
    clamped = 0.0 if t <= 0.0 else 1.0 if t >= 1.0 else t
    return solve_cubic_bezier(out, into, clamped)


def interpolate(
    start: float, end: float, t: float, easing: str | Easing = Easing.LINEAR
) -> float:
    """Interpolate between ``start`` and ``end`` using ``easing``.

    :param start: Value at ``t == 0``.
    :param end: Value at ``t == 1``.
    :param t: Normalized progress; values outside ``[0, 1]`` are clamped.
    :param easing: The easing curve (enum or its canonical string name).
    :returns: The eased interpolated value.
    """
    return start + (end - start) * apply_easing(easing, t)


def evaluate_keyframes(
    keyframes: list[Keyframe], property_name: str, time: float
) -> float | None:
    """Evaluate the animated value of ``property_name`` at ``time``.

    Considers only keyframes for ``property_name`` (sorted by time). Returns
    ``None`` when the property has no keyframes — callers treat that as "use the
    static value". Before the first keyframe the value holds at the first; after
    the last it holds at the last; between two keyframes it is eased by the
    **earlier** keyframe's curve (easing is "into the next keyframe").

    :param keyframes: A clip's (or effect's) keyframe list.
    :param property_name: The property to evaluate (e.g. ``"scale"``).
    :param time: Clip-relative time in seconds.
    :returns: The interpolated value, or ``None`` if the property is not animated.
    """
    points = sorted(
        (k for k in keyframes if k.property == property_name), key=lambda k: k.time
    )
    if not points:
        return None
    if time <= points[0].time:
        return points[0].value
    last = points[-1]
    if time >= last.time:
        return last.value
    for left, right in pairwise(points):
        if left.time <= time <= right.time:
            # The earliest bracketing pair always has left.time < right.time here:
            # a zero-span pair would require left.time == right.time == time, but
            # that time equals an earlier keyframe's (bracketed first) or the first
            # keyframe (returned above). So the divisor is strictly positive.
            local_t = (time - left.time) / (right.time - left.time)
            # Through `segment_progress`, not `interpolate`, because a custom bezier
            # needs BOTH keyframes' handles — `interpolate` only ever sees the
            # earlier one's easing name and cannot express the two-sided curve.
            return left.value + (right.value - left.value) * segment_progress(
                left, right, local_t
            )
    return last.value  # pragma: no cover - bracket always found above


def punch_in_keyframes(
    *,
    id_prefix: str,
    start_time: float,
    end_time: float,
    from_scale: float = 1.0,
    to_scale: float = 1.2,
    easing: str | Easing = Easing.EASE_IN_OUT,
    property_name: str = "scale",
) -> list[Keyframe]:
    """Build a two-keyframe zoom/punch-in animation on ``property_name`` (pure).

    A punch-in is the canonical "subtle zoom to add energy" move (PRD §5.3):
    ramp ``property_name`` from ``from_scale`` at ``start_time`` to ``to_scale``
    at ``end_time`` with the given easing. Deterministic ids are derived from
    ``id_prefix`` so the same request always yields the same keyframes.

    :raises ValueError: If ``end_time`` is not strictly after ``start_time``.
    """
    if end_time <= start_time:
        raise ValueError(
            f"punch_in_keyframes needs end_time > start_time ({start_time} -> {end_time})"
        )
    curve = _resolve_easing(easing).value
    return [
        Keyframe(
            id=f"{id_prefix}__{property_name}__{round(start_time * 1000)}",
            time=start_time,
            property=property_name,
            value=from_scale,
            easing=curve,
        ),
        Keyframe(
            id=f"{id_prefix}__{property_name}__{round(end_time * 1000)}",
            time=end_time,
            property=property_name,
            value=to_scale,
            easing=curve,
        ),
    ]
