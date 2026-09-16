"""Tests for mask rasterization + spec resolution (PRD §6.5, plan Phase 5)."""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest

from framepilot_engine.render.masks import (
    MaskSpec,
    UnsupportedMaskStack,
    has_mask_keyframes,
    legacy_mask_for_clip,
    mask_frame_box,
    mask_spec_at,
    mask_spec_from_params,
    rasterize_mask,
)
from framepilot_engine.timeline.models import Clip, Effect, Keyframe

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


# --- Schema v22 mask stack → interim rasteriser (MK1.6) ------------------------------


_SIZE = (1920, 1080)


def _v22_clip(*masks: dict[str, object], **fields: object) -> Clip:
    return Clip.model_validate(
        {
            "id": "c",
            "assetId": "a",
            "trackId": "v",
            "start": 10.0,
            "end": 14.0,
            "sourceStart": 3.0,
            "sourceEnd": 7.0,
            "masks": list(masks),
            **fields,
        }
    )


def test_no_enabled_mask_means_nothing_to_draw() -> None:
    assert legacy_mask_for_clip(_v22_clip(), _SIZE) is None
    disabled = {"kind": "rectangle", "id": "m", "cx": 1, "cy": 1, "width": 1, "height": 1}
    assert legacy_mask_for_clip(_v22_clip({**disabled, "enabled": False}), _SIZE) is None


def test_a_migrated_rectangle_maps_back_to_the_v21_spec() -> None:
    """px → frame fractions and px feather → fraction of the smaller side, as v21 drew it."""
    clip = _v22_clip(
        {
            "kind": "rectangle",
            "id": "m",
            "cx": (0.25 + 0.25) * 1920,
            "cy": (0.1 + 0.2) * 1080,
            "width": 0.5 * 1920,
            "height": 0.4 * 1080,
            "featherOuterPx": 0.02 * 1080,
            "featherModel": "gaussian-legacy",
            "opacity": 0.8,
            "invert": True,
        }
    )
    legacy = legacy_mask_for_clip(clip, _SIZE)
    assert legacy is not None and legacy.animated is False
    spec = legacy.spec_at(0.0)
    assert spec.shape == "rectangle" and spec.invert is True
    assert (spec.x, spec.y, spec.width, spec.height) == pytest.approx((0.25, 0.1, 0.5, 0.4))
    assert spec.feather == pytest.approx(0.02) and spec.opacity == pytest.approx(0.8)
    # And it rasterises to the same pixels as the v21 spec it replaced.
    v21 = MaskSpec(shape="rectangle", x=0.25, y=0.1, width=0.5, height=0.4, feather=0.02)
    assert np.array_equal(
        rasterize_mask(replace(spec, opacity=1.0, invert=False), W, H), rasterize_mask(v21, W, H)
    )


def test_geometry_goes_through_the_crop_the_v21_mask_was_drawn_on() -> None:
    clip = _v22_clip(
        {"kind": "ellipse", "id": "m", "cx": 0.75 * 1920, "cy": 0.25 * 1080, "rx": 480, "ry": 270},
        crop={"x": 0.5, "y": 0.0, "width": 0.5, "height": 0.5},
    )
    spec = legacy_mask_for_clip(clip, _SIZE).spec_at(0.0)  # type: ignore[union-attr]
    assert (spec.x, spec.y, spec.width, spec.height) == pytest.approx((0.0, 0.0, 1.0, 1.0))


def test_source_time_keyframes_are_read_at_the_instant_the_clip_plays() -> None:
    """At 2x, clip time 1s plays source 3 + 2 = 5s; the cx keyframe there is honoured."""
    clip = _v22_clip(
        {
            "kind": "rectangle",
            "id": "m",
            "cx": 960,
            "cy": 540,
            "width": 192,
            "height": 108,
            "keyframes": [
                {"id": "a", "sourceTime": 3.0, "property": "cx", "value": 96.0},
                {"id": "b", "sourceTime": 5.0, "property": "cx", "value": 1824.0},
            ],
        },
        speed=2.0,
        end=12.0,
    )
    legacy = legacy_mask_for_clip(clip, _SIZE)
    assert legacy is not None and legacy.animated
    assert legacy.spec_at(0.0).x == pytest.approx(0.0)
    assert legacy.spec_at(1.0).x == pytest.approx(0.9)


def test_a_polygon_path_draws_as_the_v21_polygon() -> None:
    clip = _v22_clip(
        {
            "kind": "path",
            "id": "p",
            "pathKeyframes": [
                {
                    "id": "k",
                    "sourceTime": 3.0,
                    "points": [0, 0, 0, 0, 0, 0, 1920, 0, 0, 0, 0, 0, 960, 1080, 0, 0, 0, 0],
                    "vertexTypes": [0, 0, 0],
                }
            ],
        }
    )
    spec = legacy_mask_for_clip(clip, _SIZE).spec_at(0.0)  # type: ignore[union-attr]
    assert spec.shape == "polygon"
    assert [coordinate for point in spec.points for coordinate in point] == pytest.approx(
        [0.0, 0.0, 1.0, 0.0, 0.5, 1.0]
    )


def test_normalised_legacy_masks_need_no_media_size() -> None:
    clip = _v22_clip(
        {
            "kind": "rectangle",
            "id": "m",
            "units": "normalized",
            "cx": 0.5,
            "cy": 0.5,
            "width": 0.2,
            "height": 0.4,
        }
    )
    spec = legacy_mask_for_clip(clip, None).spec_at(0.0)  # type: ignore[union-attr]
    assert (spec.x, spec.y) == pytest.approx((0.4, 0.3))


@pytest.mark.parametrize(
    ("extra", "reason"),
    [
        ({"mode": "subtract"}, "mode 'subtract'"),
        ({"target": {"kind": "effect", "effectId": "blur"}}, "an effect target"),
        ({"space": "frame"}, "frame space"),
        ({"rotation": 15}, "rotation or roundness"),
        ({"expansionPx": 4}, "expansion or inner feather"),
        ({"featherOuterPx": 8}, "a distance feather"),
    ],
)
def test_the_interim_refuses_what_it_cannot_draw_faithfully(
    extra: dict[str, object], reason: str
) -> None:
    mask = {"kind": "rectangle", "id": "m", "cx": 1, "cy": 1, "width": 1, "height": 1, **extra}
    with pytest.raises(UnsupportedMaskStack, match=reason):
        legacy_mask_for_clip(_v22_clip(mask), _SIZE)


def test_the_interim_refuses_unmeasured_media_and_several_masks() -> None:
    mask = {"kind": "rectangle", "id": "m", "cx": 1, "cy": 1, "width": 1, "height": 1}
    with pytest.raises(UnsupportedMaskStack, match="Measure this media first"):
        legacy_mask_for_clip(_v22_clip(mask), None)
    with pytest.raises(UnsupportedMaskStack, match="more than one"):
        legacy_mask_for_clip(_v22_clip(mask, {**mask, "id": "n"}), _SIZE)
    with pytest.raises(UnsupportedMaskStack, match="kind 'key'"):
        legacy_mask_for_clip(_v22_clip({"kind": "key", "id": "k", "model": "luma"}), _SIZE)


def test_mask_frame_box_reads_fractions_at_a_source_instant() -> None:
    clip = _v22_clip({"kind": "ellipse", "id": "m", "cx": 960, "cy": 540, "rx": 480, "ry": 270})
    mask = clip.masks[0]  # type: ignore[index]
    assert mask_frame_box(mask, _SIZE, 3.0) == pytest.approx((0.25, 0.25, 0.5, 0.5))
    assert mask_frame_box(mask, None, 3.0) is None
