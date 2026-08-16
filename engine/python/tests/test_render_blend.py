"""Tests for the per-channel blend-mode math (schema v8, plan H1.2f).

Hand-computed expected values (worked in the module/PR description) for a
representative subset of the twelve supported modes, plus edge-case coverage
(division-guard boundaries in color-dodge/color-burn) and a sanity check that
every schema-supported mode is wired up.
"""

from __future__ import annotations

import numpy as np
import pytest

from framepilot_engine.render.blend import BLEND_MODE_FUNCS, apply_blend_mode
from framepilot_engine.timeline.models import BlendMode


def _px(r: float, g: float, b: float) -> np.ndarray:
    """A single-pixel ``(1, 1, 3)`` array so blend math is trivial to hand-check."""
    return np.array([[[r, g, b]]], dtype=np.float64)


def _value(arr: np.ndarray) -> tuple[float, float, float]:
    return (float(arr[0, 0, 0]), float(arr[0, 0, 1]), float(arr[0, 0, 2]))


# Pure red base, pure blue blend (and vice versa) — the simplest hand-checkable
# case, matching the multiply/screen worked examples from the task brief.
_BLUE = _px(0.0, 0.0, 1.0)
_RED = _px(1.0, 0.0, 0.0)


def test_multiply_red_over_blue_is_black() -> None:
    # multiply: a*b, channel by channel. base=blue=(0,0,1), blend=red=(1,0,0):
    # R=0*1=0, G=0*0=0, B=1*0=0 -> black.
    out = apply_blend_mode(_BLUE, _RED, "multiply")
    assert _value(out) == pytest.approx((0.0, 0.0, 0.0))


def test_screen_red_over_blue_is_magenta() -> None:
    # screen: 1-(1-a)(1-b). base=blue=(0,0,1), blend=red=(1,0,0):
    # R=1-(1-0)(1-1)=1, G=1-(1-0)(1-0)=0, B=1-(1-1)(1-0)=1 -> magenta.
    out = apply_blend_mode(_BLUE, _RED, "screen")
    assert _value(out) == pytest.approx((1.0, 0.0, 1.0))


def test_difference_and_exclusion_on_mixed_channels() -> None:
    # base=(0.5, 0.25, 0.125), blend=(0.25, 0.75, 0.5) chosen so no channel
    # value is exactly 0 or 1 (avoids every mode degenerating to the same
    # boolean-AND/OR result that pure primaries produce).
    base = _px(0.5, 0.25, 0.125)
    blend = _px(0.25, 0.75, 0.5)

    difference = apply_blend_mode(base, blend, "difference")
    assert _value(difference) == pytest.approx((0.25, 0.5, 0.375))

    # exclusion: a+b-2ab.
    exclusion = apply_blend_mode(base, blend, "exclusion")
    expected_exclusion = (
        0.5 + 0.25 - 2 * 0.5 * 0.25,
        0.25 + 0.75 - 2 * 0.25 * 0.75,
        0.125 + 0.5 - 2 * 0.125 * 0.5,
    )
    assert _value(exclusion) == pytest.approx(expected_exclusion)


def test_overlay_discriminates_on_the_blend_layer() -> None:
    base = _px(0.5, 0.5, 0.5)
    # blend < 0.5 on R, >= 0.5 on G -> two branches of the same call.
    blend = _px(0.25, 0.75, 0.5)
    out = apply_blend_mode(base, blend, "overlay")
    # R: b<0.5 -> 2ab = 2*0.5*0.25 = 0.25
    # G: b>=0.5 -> 1-2(1-a)(1-b) = 1-2*0.5*0.25 = 0.75
    # B: b>=0.5 (boundary) -> 1-2*0.5*0.5 = 0.5
    assert _value(out) == pytest.approx((0.25, 0.75, 0.5))


def test_hard_light_is_overlay_with_base_and_blend_swapped_in_discriminant() -> None:
    a = _px(0.25, 0.75, 0.5)
    b = _px(0.5, 0.5, 0.5)
    # hard-light(a, b) discriminates on `a` where overlay(a, b) discriminates on `b`.
    assert _value(apply_blend_mode(a, b, "hard-light")) == pytest.approx(
        _value(apply_blend_mode(b, a, "overlay"))
    )


def test_darken_and_lighten_are_elementwise_min_max() -> None:
    base = _px(0.2, 0.8, 0.5)
    blend = _px(0.7, 0.3, 0.5)
    assert _value(apply_blend_mode(base, blend, "darken")) == pytest.approx((0.2, 0.3, 0.5))
    assert _value(apply_blend_mode(base, blend, "lighten")) == pytest.approx((0.7, 0.8, 0.5))


def test_color_dodge_and_color_burn_handle_boundary_values() -> None:
    # color-dodge: b==1 -> 1 regardless of a.
    assert _value(apply_blend_mode(_px(0.3, 0.3, 0.3), _px(1.0, 1.0, 1.0), "color-dodge")) == (
        1.0,
        1.0,
        1.0,
    )
    # color-dodge: a==0 -> 0 (0 / anything non-zero is 0).
    assert _value(
        apply_blend_mode(_px(0.0, 0.0, 0.0), _px(0.5, 0.5, 0.5), "color-dodge")
    ) == pytest.approx((0.0, 0.0, 0.0))
    # color-burn: b==0 -> 0 regardless of a.
    assert _value(apply_blend_mode(_px(0.7, 0.7, 0.7), _px(0.0, 0.0, 0.0), "color-burn")) == (
        0.0,
        0.0,
        0.0,
    )
    # color-burn: a==1 -> 1 (1 - min(1, 0/b) = 1).
    assert _value(
        apply_blend_mode(_px(1.0, 1.0, 1.0), _px(0.4, 0.4, 0.4), "color-burn")
    ) == pytest.approx((1.0, 1.0, 1.0))


def test_soft_light_matches_the_w3c_formula_by_hand() -> None:
    # base=0.6 (> 0.25, so D(a) = sqrt(a)), blend=0.8 (> 0.5 branch).
    a, b = 0.6, 0.8
    d = a**0.5
    expected = a + (2 * b - 1) * (d - a)
    out = apply_blend_mode(_px(a, a, a), _px(b, b, b), "soft-light")
    assert _value(out) == pytest.approx((expected, expected, expected))


def test_output_is_clipped_to_unit_range() -> None:
    # exclusion/screen/etc. are all naturally bounded in [0, 1] for in-range
    # inputs, but the clip is still exercised end to end via apply_blend_mode.
    out = apply_blend_mode(_px(1.0, 1.0, 1.0), _px(1.0, 1.0, 1.0), "screen")
    assert out.min() >= 0.0
    assert out.max() <= 1.0


def test_every_schema_blend_mode_except_normal_has_a_formula() -> None:
    schema_modes = {mode.value for mode in BlendMode} - {"normal"}
    assert schema_modes == set(BLEND_MODE_FUNCS)


def test_unknown_mode_raises_key_error() -> None:
    with pytest.raises(KeyError):
        apply_blend_mode(_BLUE, _RED, "not-a-real-mode")
