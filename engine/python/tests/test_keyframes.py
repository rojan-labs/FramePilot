"""Tests for the keyframe evaluation engine (PRD §6.3, plan Phase 5).

These mirror the TS ``editor-core`` keyframe tests; the two engines must agree on
the easing curves and segment semantics.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from framepilot_engine.effects.keyframes import (
    Easing,
    apply_easing,
    evaluate_keyframes,
    interpolate,
    punch_in_keyframes,
    segment_progress,
    solve_cubic_bezier,
)
from framepilot_engine.timeline.models import BezierHandles, Keyframe


def _kf(time: float, value: float, *, easing: str = "linear", prop: str = "scale") -> Keyframe:
    return Keyframe(id=f"kf_{prop}_{time}", time=time, property=prop, value=value, easing=easing)


# ---------------------------------------------------------------------------
# Easing curves
# ---------------------------------------------------------------------------


def test_easing_members_are_canonical_hyphenated() -> None:
    assert {e.value for e in Easing} == {
        "linear",
        "ease-in",
        "ease-out",
        "ease-in-out",
        "hold",
        "bezier",
    }


@pytest.mark.parametrize("easing", list(Easing))
def test_easing_endpoints_are_fixed(easing: Easing) -> None:
    # Every curve maps 0 -> 0 and 1 -> 1 so segment endpoints hit the keyframes.
    assert apply_easing(easing, 0.0) == 0.0
    assert apply_easing(easing, 1.0) == 1.0


def test_apply_easing_clamps_out_of_range() -> None:
    assert apply_easing(Easing.LINEAR, -5.0) == 0.0
    assert apply_easing(Easing.LINEAR, 5.0) == 1.0


def test_easing_midpoints() -> None:
    assert apply_easing(Easing.LINEAR, 0.5) == pytest.approx(0.5)
    assert apply_easing(Easing.EASE_IN, 0.5) == pytest.approx(0.25)
    assert apply_easing(Easing.EASE_OUT, 0.5) == pytest.approx(0.75)
    assert apply_easing(Easing.EASE_IN_OUT, 0.5) == pytest.approx(0.5)
    assert apply_easing(Easing.EASE_IN_OUT, 0.25) == pytest.approx(0.125)
    assert apply_easing(Easing.EASE_IN_OUT, 0.75) == pytest.approx(0.875)
    assert apply_easing(Easing.BEZIER, 0.5) == pytest.approx(0.5)


def test_hold_holds_until_the_end() -> None:
    assert apply_easing(Easing.HOLD, 0.0) == 0.0
    assert apply_easing(Easing.HOLD, 0.99) == 0.0
    assert apply_easing(Easing.HOLD, 1.0) == 1.0


def test_unknown_easing_falls_back_to_linear() -> None:
    assert apply_easing("wobble", 0.5) == pytest.approx(0.5)


def test_easing_accepts_enum_directly() -> None:
    assert apply_easing(Easing.EASE_IN, 0.5) == apply_easing("ease-in", 0.5)


# ---------------------------------------------------------------------------
# interpolate
# ---------------------------------------------------------------------------


def test_interpolate_linear_default() -> None:
    assert interpolate(0.0, 10.0, 0.5) == pytest.approx(5.0)


def test_interpolate_applies_easing() -> None:
    assert interpolate(0.0, 100.0, 0.5, Easing.EASE_IN) == pytest.approx(25.0)


def test_interpolate_hold_returns_start_then_end() -> None:
    assert interpolate(2.0, 8.0, 0.5, Easing.HOLD) == pytest.approx(2.0)
    assert interpolate(2.0, 8.0, 1.0, Easing.HOLD) == pytest.approx(8.0)


# ---------------------------------------------------------------------------
# evaluate_keyframes
# ---------------------------------------------------------------------------


def test_evaluate_returns_none_when_property_not_animated() -> None:
    assert evaluate_keyframes([], "scale", 1.0) is None
    assert evaluate_keyframes([_kf(0.0, 1.0, prop="opacity")], "scale", 1.0) is None


def test_evaluate_holds_before_first_and_after_last() -> None:
    frames = [_kf(1.0, 1.0), _kf(3.0, 2.0)]
    assert evaluate_keyframes(frames, "scale", 0.0) == pytest.approx(1.0)
    assert evaluate_keyframes(frames, "scale", 1.0) == pytest.approx(1.0)
    assert evaluate_keyframes(frames, "scale", 5.0) == pytest.approx(2.0)


def test_evaluate_interpolates_between_keyframes() -> None:
    frames = [_kf(0.0, 0.0), _kf(2.0, 10.0)]
    assert evaluate_keyframes(frames, "scale", 1.0) == pytest.approx(5.0)


def test_evaluate_uses_earlier_keyframe_easing_for_the_segment() -> None:
    # Segment 0->2 is eased by the FIRST keyframe's curve ("into the next").
    frames = [_kf(0.0, 0.0, easing="ease-in"), _kf(2.0, 100.0, easing="linear")]
    assert evaluate_keyframes(frames, "scale", 1.0) == pytest.approx(25.0)


def test_evaluate_sorts_unordered_keyframes() -> None:
    frames = [_kf(2.0, 10.0), _kf(0.0, 0.0)]
    assert evaluate_keyframes(frames, "scale", 1.0) == pytest.approx(5.0)


def test_evaluate_handles_three_keyframe_chain() -> None:
    frames = [_kf(0.0, 0.0), _kf(1.0, 10.0), _kf(2.0, 0.0)]
    assert evaluate_keyframes(frames, "scale", 0.5) == pytest.approx(5.0)
    assert evaluate_keyframes(frames, "scale", 1.0) == pytest.approx(10.0)
    assert evaluate_keyframes(frames, "scale", 1.5) == pytest.approx(5.0)


def test_evaluate_zero_span_duplicate_times_returns_later_value() -> None:
    # Two keyframes at the same time: a query strictly between bounds is impossible,
    # but a degenerate equal-time pair must not divide by zero.
    frames = [_kf(1.0, 1.0), _kf(1.0, 2.0), _kf(3.0, 2.0)]
    # At t=2 we are in the [1, 3] segment from the second keyframe.
    assert evaluate_keyframes(frames, "scale", 2.0) == pytest.approx(2.0)


def test_evaluate_ignores_other_properties() -> None:
    frames = [_kf(0.0, 0.0, prop="x"), _kf(2.0, 10.0, prop="x"), _kf(0.0, 100.0, prop="opacity")]
    assert evaluate_keyframes(frames, "x", 1.0) == pytest.approx(5.0)


# ---------------------------------------------------------------------------
# punch_in_keyframes
# ---------------------------------------------------------------------------


def test_punch_in_builds_two_scale_keyframes() -> None:
    frames = punch_in_keyframes(id_prefix="clip1", start_time=1.0, end_time=3.0)
    assert [k.property for k in frames] == ["scale", "scale"]
    assert frames[0].value == pytest.approx(1.0)
    assert frames[1].value == pytest.approx(1.2)
    assert frames[0].time == 1.0 and frames[1].time == 3.0
    assert frames[0].easing == "ease-in-out"
    # Deterministic, unique ids.
    assert frames[0].id != frames[1].id


def test_punch_in_respects_custom_scales_and_easing() -> None:
    frames = punch_in_keyframes(
        id_prefix="c",
        start_time=0.0,
        end_time=2.0,
        from_scale=1.2,
        to_scale=1.0,
        easing="ease-out",
        property_name="zoom",
    )
    assert frames[0].value == pytest.approx(1.2)
    assert frames[1].value == pytest.approx(1.0)
    assert all(k.property == "zoom" for k in frames)
    assert frames[0].easing == "ease-out"


def test_punch_in_keyframes_evaluate_to_a_ramp() -> None:
    frames = punch_in_keyframes(id_prefix="c", start_time=0.0, end_time=2.0)
    mid = evaluate_keyframes(frames, "scale", 1.0)
    assert mid is not None
    assert 1.0 < mid < 1.2  # eased ramp passes through the middle
    assert math.isclose(mid, 1.1, rel_tol=0.0, abs_tol=0.01)


def test_punch_in_rejects_non_positive_span() -> None:
    with pytest.raises(ValueError, match="end_time > start_time"):
        punch_in_keyframes(id_prefix="c", start_time=2.0, end_time=2.0)


# ---------------------------------------------------------------------------
# Custom bezier handles (schema v14, ADR 0089)
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[3]
_BEZIER_PARITY = _REPO_ROOT / "packages" / "editor-core" / "fixtures" / "bezier-parity.json"

_STRAIGHT = BezierHandles(out=(1.0 / 3.0, 1.0 / 3.0), **{"in": (2.0 / 3.0, 2.0 / 3.0)})


def _bez(
    time: float,
    value: float,
    handles: BezierHandles | None = None,
    *,
    prop: str = "scale",
) -> Keyframe:
    """A keyframe with ``bezier`` easing, optionally carrying handles."""
    return Keyframe(
        id=f"kf_{prop}_{time}",
        time=time,
        property=prop,
        value=value,
        easing="bezier",
        handles=handles,
    )


def test_solve_cubic_bezier_is_identity_for_straight_handles() -> None:
    for x in (0.0, 0.25, 0.5, 0.75, 1.0):
        assert solve_cubic_bezier((1 / 3, 1 / 3), (2 / 3, 2 / 3), x) == pytest.approx(x, abs=1e-10)


def test_solve_cubic_bezier_pins_both_endpoints_exactly() -> None:
    # A curve that does not reach its own keyframes' values would make an animation
    # jump at every segment boundary.
    assert solve_cubic_bezier((0.25, 0.1), (0.25, 1.0), 0.0) == 0.0
    assert solve_cubic_bezier((0.25, 0.1), (0.25, 1.0), 1.0) == 1.0


def test_solve_cubic_bezier_allows_overshoot_and_anticipation() -> None:
    # The whole reason to draw a custom curve; clamping would flatten exactly the
    # effect the user asked for.
    peak = max(solve_cubic_bezier((0.34, 1.56), (0.64, 1.0), x) for x in (0.5, 0.6, 0.7, 0.8))
    assert peak > 1.0
    dip = min(solve_cubic_bezier((0.36, -0.4), (0.66, 1.0), x) for x in (0.1, 0.2, 0.3))
    assert dip < 0.0


def test_solve_cubic_bezier_survives_a_near_vertical_curve() -> None:
    # Newton stalls where the slope vanishes; without the bisection fallback the
    # solver would leave the domain and return nonsense.
    previous = -math.inf
    for step in range(21):
        y = solve_cubic_bezier((0.0, 0.0), (0.0, 1.0), step / 20.0)
        assert math.isfinite(y)
        assert y >= previous - 1e-9
        previous = y


def test_segment_progress_defers_to_apply_easing_for_non_bezier() -> None:
    for easing in ("linear", "ease-in", "ease-out", "ease-in-out", "hold"):
        left = _kf(0, 0, easing=easing)
        assert segment_progress(left, _kf(1, 1), 0.3) == apply_easing(easing, 0.3)


def test_segment_progress_falls_back_to_smoothstep_when_handles_absent() -> None:
    # THE compatibility rule (ADR 0089): absent must not mean linear and must not
    # mean some default curve, or the v14 migration would silently rewrite every
    # animation a v13 project already had.
    assert segment_progress(_bez(0, 0), _bez(1, 1), 0.3) == apply_easing(Easing.BEZIER, 0.3)


def test_segment_progress_falls_back_when_only_one_side_has_a_handle() -> None:
    # A segment needs both control points; half a curve is not a curve.
    expected = apply_easing(Easing.BEZIER, 0.3)
    assert segment_progress(_bez(0, 0, _STRAIGHT), _bez(1, 1), 0.3) == expected
    assert segment_progress(_bez(0, 0), _bez(1, 1, _STRAIGHT), 0.3) == expected


def test_segment_progress_uses_left_out_and_right_in() -> None:
    # Proven by asymmetry: swapping which keyframe holds which handle changes the
    # curve, so the function cannot be reading only one side.
    forward = segment_progress(
        _bez(0, 0, BezierHandles(out=(0.9, 0.0), **{"in": (0.1, 1.0)})),
        _bez(1, 1, BezierHandles(out=(0.1, 1.0), **{"in": (0.9, 0.0)})),
        0.5,
    )
    swapped = segment_progress(
        _bez(0, 0, BezierHandles(out=(0.1, 1.0), **{"in": (0.9, 0.0)})),
        _bez(1, 1, BezierHandles(out=(0.9, 0.0), **{"in": (0.1, 1.0)})),
        0.5,
    )
    assert forward != pytest.approx(swapped, abs=1e-6)


def test_evaluate_keyframes_drives_interpolation_through_the_custom_curve() -> None:
    points = [
        _bez(0, 0, BezierHandles(out=(0.9, 0.0), **{"in": (0.1, 1.0)})),
        _bez(2, 100, BezierHandles(out=(0.1, 1.0), **{"in": (0.9, 0.0)})),
    ]
    value = evaluate_keyframes(points, "scale", 1.0)
    assert value is not None and value < 50.0


def test_v13_handleless_bezier_animation_evaluates_unchanged() -> None:
    v13 = [_bez(0, 0), _bez(2, 100)]
    assert evaluate_keyframes(v13, "scale", 0.5) == 100.0 * apply_easing(Easing.BEZIER, 0.25)


def test_bezier_parity_with_typescript() -> None:
    """The committed fixture is the cross-language contract (ADR 0089).

    ``packages/editor-core/src/keyframes.test.ts`` asserts the SAME numbers, so a
    change to the curve math on one side fails on the other. Regenerating the
    fixture is a deliberate act, never a way to make a test pass.
    """
    fixture = json.loads(_BEZIER_PARITY.read_text(encoding="utf-8"))
    assert len(fixture["cases"]) > 50
    tolerance = fixture["tolerance"]
    for case in fixture["cases"]:
        actual = solve_cubic_bezier(tuple(case["out"]), tuple(case["in"]), case["x"])
        assert abs(actual - case["y"]) <= tolerance, f"{case['curve']} @ x={case['x']}"
