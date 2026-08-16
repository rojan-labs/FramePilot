"""Tests for mask rasterization + spec resolution (PRD §6.5, plan Phase 5)."""

from __future__ import annotations

import pytest

from framepilot_engine.render.masks import (
    MaskSpec,
    has_mask_keyframes,
    mask_spec_at,
    mask_spec_from_params,
    rasterize_mask,
)
from framepilot_engine.timeline.models import Effect, Keyframe

W, H = 40, 40


def test_rectangle_full_frame_is_all_visible() -> None:
    alpha = rasterize_mask(MaskSpec(shape="rectangle"), W, H)
    assert alpha.shape == (H, W)
    assert alpha.min() == pytest.approx(1.0)


def test_rectangle_partial_bounds_hides_outside() -> None:
    spec = MaskSpec(shape="rectangle", x=0.25, y=0.25, width=0.5, height=0.5)
    alpha = rasterize_mask(spec, W, H)
    assert alpha[H // 2, W // 2] == pytest.approx(1.0)  # centre visible
    assert alpha[0, 0] == pytest.approx(0.0)  # corner hidden


def test_ellipse_keeps_centre_hides_corners() -> None:
    alpha = rasterize_mask(MaskSpec(shape="ellipse"), W, H)
    assert alpha[H // 2, W // 2] == pytest.approx(1.0)
    assert alpha[0, 0] == pytest.approx(0.0)


def test_polygon_triangle() -> None:
    spec = MaskSpec(shape="polygon", points=((0.5, 0.0), (1.0, 1.0), (0.0, 1.0)))
    alpha = rasterize_mask(spec, W, H)
    assert alpha[H - 2, W // 2] == pytest.approx(1.0)  # inside near base
    assert alpha[1, 1] == pytest.approx(0.0)  # outside near apex corner


def test_polygon_with_too_few_points_falls_back_to_rectangle() -> None:
    spec = MaskSpec(shape="polygon", points=((0.0, 0.0),))
    alpha = rasterize_mask(spec, W, H)
    assert alpha.min() == pytest.approx(1.0)  # degenerate → full-frame rectangle


def test_feather_softens_the_edge() -> None:
    sharp = rasterize_mask(MaskSpec(shape="rectangle", x=0.25, y=0.25, width=0.5, height=0.5), W, H)
    soft = rasterize_mask(
        MaskSpec(shape="rectangle", x=0.25, y=0.25, width=0.5, height=0.5, feather=0.1), W, H
    )
    # Feather introduces intermediate alpha values absent from the sharp mask.
    assert ((soft > 0.01) & (soft < 0.99)).sum() > ((sharp > 0.01) & (sharp < 0.99)).sum()


def test_invert_keeps_the_outside() -> None:
    spec = MaskSpec(shape="rectangle", x=0.25, y=0.25, width=0.5, height=0.5, invert=True)
    alpha = rasterize_mask(spec, W, H)
    assert alpha[H // 2, W // 2] == pytest.approx(0.0)  # centre now hidden
    assert alpha[0, 0] == pytest.approx(1.0)  # corner now visible


def test_opacity_scales_the_kept_region() -> None:
    alpha = rasterize_mask(MaskSpec(shape="rectangle", opacity=0.5), W, H)
    assert alpha.max() == pytest.approx(0.5)


def test_mask_spec_from_params_reads_geometry() -> None:
    spec = mask_spec_from_params(
        {
            "shape": "ellipse",
            "bounds": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4},
            "points": [[0.0, 0.0], [1.0, 1.0]],
            "feather": 0.05,
            "opacity": 0.7,
            "invert": True,
        }
    )
    assert spec.shape == "ellipse"
    assert (spec.x, spec.y, spec.width, spec.height) == (0.1, 0.2, 0.3, 0.4)
    assert spec.points == ((0.0, 0.0), (1.0, 1.0))
    assert spec.feather == 0.05 and spec.opacity == 0.7 and spec.invert is True


def test_mask_spec_from_params_defaults() -> None:
    spec = mask_spec_from_params({})
    assert spec == MaskSpec()


def _mask_effect(*keyframes: Keyframe, **params: object) -> Effect:
    return Effect(
        id="m",
        type="mask",
        params={"shape": "rectangle", **params},
        keyframes=list(keyframes),
    )


def test_mask_spec_at_without_keyframes_is_static() -> None:
    effect = _mask_effect(bounds={"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0})
    assert mask_spec_at(effect, 1.0).width == 0.5


def test_mask_spec_at_animates_a_param() -> None:
    effect = _mask_effect(
        Keyframe(id="x0", time=0.0, property="x", value=0.0),
        Keyframe(id="x1", time=2.0, property="x", value=1.0),
    )
    assert mask_spec_at(effect, 1.0).x == pytest.approx(0.5)


def test_mask_spec_at_ignores_non_mask_keyframes() -> None:
    effect = _mask_effect(Keyframe(id="s", time=0.0, property="scale", value=2.0))
    # 'scale' is not a mask param → spec is unchanged from its static base.
    assert mask_spec_at(effect, 1.0) == mask_spec_from_params(effect.params)


def test_has_mask_keyframes() -> None:
    assert has_mask_keyframes(_mask_effect(Keyframe(id="x", time=0.0, property="x", value=0.0)))
    assert not has_mask_keyframes(_mask_effect())
    assert not has_mask_keyframes(
        _mask_effect(Keyframe(id="s", time=0.0, property="scale", value=1.0))
    )
