"""Mask stack evaluation for the export (MK2.2): keyframes on the source clock, targets,
refusals, legacy routing, and effect mixing."""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from framepilot_engine.effects.keyframes import apply_easing
from framepilot_engine.render import mask_raster as mr
from framepilot_engine.render.mask_stack import (
    MaskStackRefusal,
    clip_mask_stacks,
    mask_path_at,
    mix_by_alpha,
    path_keyframe_at,
    stack_alpha,
)
from framepilot_engine.timeline.models import Clip

_SIZE = (64, 48)


def _clip(*masks: dict[str, Any], **fields: Any) -> Clip:
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


def _rect(mask_id: str = "r", **extra: Any) -> dict[str, Any]:
    return {
        "kind": "rectangle",
        "id": mask_id,
        "cx": 32,
        "cy": 24,
        "width": 30,
        "height": 20,
        **extra,
    }


def _path(**extra: Any) -> dict[str, Any]:
    return {
        "kind": "path",
        "id": "p",
        "pathKeyframes": [
            {
                "id": "k0",
                "sourceTime": 3.0,
                "easing": "ease-in-out",
                "points": [10, 10, 0, 0, 2, 0, 50, 10, -2, 0, 0, 0, 30, 40, 0, 0, 0, 0],
                "vertexTypes": [1, 1, 0],
                "featherPx": [0, 2, 4],
            },
            {
                "id": "k1",
                "sourceTime": 5.0,
                "points": [14, 12, 0, 0, 3, 1, 54, 8, -1, 0, 0, 0, 26, 44, 0, 0, 0, 0],
                "vertexTypes": [1, 1, 0],
                "featherPx": [2, 2, 0],
            },
        ],
        **extra,
    }


def test_nothing_enabled_means_no_stack() -> None:
    assert clip_mask_stacks(_clip(), _SIZE) is None
    assert clip_mask_stacks(_clip(_rect(enabled=False)), _SIZE) is None


@pytest.mark.parametrize(
    ("mask", "reason"),
    [
        ({"kind": "key", "id": "k", "model": "luma"}, "colour key masks"),
        ({"kind": "linear", "id": "l", "originX": 1, "originY": 1, "angle": 0}, "split masks"),
        ({"kind": "band", "id": "b", "originX": 1, "originY": 1, "angle": 0, "widthPx": 4}, "band"),
        (
            {
                "kind": "gradient",
                "id": "g",
                "shape": "linear",
                "startX": 0,
                "startY": 0,
                "endX": 1,
                "endY": 1,
            },
            "gradient",
        ),
        ({"kind": "layer", "id": "y", "source": {"kind": "track", "trackId": "v2"}}, "track matte"),
        (_rect(space="frame"), "frame-space"),
        (
            _rect(
                tracking={
                    "artifact": {"key": "k", "sha256": "0" * 64},
                    "method": "position",
                    "referenceSourceTime": 3.0,
                }
            ),
            "tracked masks",
        ),
        (_rect(target={"kind": "effect", "effectId": "missing"}), "not on the clip"),
        (_rect(featherModel="gaussian-legacy", rotation=10), "Switch the mask's feather model"),
    ],
)
def test_masks_export_cannot_draw_yet_are_refused_with_a_remedy(
    mask: dict[str, Any], reason: str
) -> None:
    with pytest.raises(MaskStackRefusal, match=reason) as caught:
        clip_mask_stacks(_clip(mask), _SIZE)
    # Guard-key rule: no measured magnitudes in the text (ids are the only variable part).
    assert "0.0" not in str(caught.value)


def test_unmeasured_pixel_masks_ask_for_measurement() -> None:
    with pytest.raises(MaskStackRefusal, match="Measure this media first"):
        clip_mask_stacks(_clip(_rect()), None)


def test_targets_split_into_the_alpha_stack_and_per_effect_stacks() -> None:
    clip = _clip(
        _rect("a"),
        _rect("g1", target={"kind": "effect", "effectId": "grade"}),
        _rect("g2", target={"kind": "effect", "effectId": "grade"}, mode="subtract"),
        effects=[{"id": "grade", "type": "color_grade", "params": {"exposure": 1}}],
    )
    stacks = clip_mask_stacks(clip, _SIZE)
    assert stacks is not None
    assert [m.id for m in stacks.alpha] == ["a"]
    assert [m.id for m in stacks.by_effect["grade"]] == ["g1", "g2"]
    assert stacks.effect_alpha_at("other", 0.0, 64, 48) is None


def test_path_keyframes_interpolate_vertex_to_vertex_with_the_easing() -> None:
    mask: Any = _clip(_path()).masks[0]  # type: ignore[index]
    for source_time in (3.0, 3.3, 4.0, 4.71, 5.0, 6.0):
        points, feathers = path_keyframe_at(mask, source_time)
        progress = apply_easing("ease-in-out", min(max((source_time - 3.0) / 2.0, 0.0), 1.0))
        a = mask.path_keyframes[0].points
        b = mask.path_keyframes[1].points
        expected = [a[i] + (b[i] - a[i]) * progress for i in range(len(a))]
        assert max(abs(p - e) for p, e in zip(points, expected, strict=True)) <= 1e-6
        assert feathers is not None
        assert feathers[2] == pytest.approx(4.0 + (0.0 - 4.0) * progress, abs=1e-6)


def test_mismatched_vertex_counts_are_refused() -> None:
    bad = _path()
    bad["pathKeyframes"][1]["points"] = bad["pathKeyframes"][1]["points"][:12]
    bad["pathKeyframes"][1]["vertexTypes"] = [1, 1]
    bad["pathKeyframes"][1]["featherPx"] = [2, 2]
    with pytest.raises(MaskStackRefusal, match="different vertex counts"):
        clip_mask_stacks(_clip(bad), _SIZE)


def test_rectangle_and_ellipse_scalars_follow_source_time_keyframes() -> None:
    clip = _clip(
        _rect(
            keyframes=[
                {"id": "a", "sourceTime": 3.0, "property": "cx", "value": 10.0},
                {"id": "b", "sourceTime": 5.0, "property": "cx", "value": 50.0},
                {"id": "c", "sourceTime": 3.0, "property": "rotation", "value": 0.0},
                {"id": "d", "sourceTime": 5.0, "property": "rotation", "value": 90.0},
            ]
        )
    )
    path = mask_path_at(clip.masks[0], 4.0)  # type: ignore[index]
    xs = [v.x for v in path.vertices]
    assert sum(xs) / len(xs) == pytest.approx(30.0)


def test_source_time_anchoring_survives_split_and_speed() -> None:
    """The same SOURCE instant draws the same alpha, however the clip reaches it."""
    mask = _rect(
        featherOuterPx=3,
        keyframes=[
            {"id": "a", "sourceTime": 3.0, "property": "cx", "value": 12.0},
            {"id": "b", "sourceTime": 7.0, "property": "cx", "value": 52.0},
        ],
    )
    original = clip_mask_stacks(_clip(mask), _SIZE)
    split_tail = clip_mask_stacks(_clip(mask, start=12.0, sourceStart=4.5), _SIZE)
    doubled = clip_mask_stacks(_clip(mask, end=12.0, speed=2.0), _SIZE)
    reversed_clip = clip_mask_stacks(_clip(mask, speed=-1.0), _SIZE)
    assert original and split_tail and doubled and reversed_clip
    reference = original.alpha_at(2.0, 64, 48)  # source 5.0
    assert reference is not None
    for stacks, t in ((split_tail, 0.5), (doubled, 1.0), (reversed_clip, 2.0)):
        other = stacks.alpha_at(t, 64, 48)
        assert other is not None and other.tobytes() == reference.tobytes()


def test_stack_combines_in_order_and_quantises_once() -> None:
    clip = _clip(
        _rect("outer", width=40, height=30, featherOuterPx=2.5),
        {"kind": "ellipse", "id": "hole", "cx": 32, "cy": 24, "rx": 8, "ry": 6, "mode": "subtract"},
    )
    stacks = clip_mask_stacks(clip, _SIZE)
    assert stacks is not None
    alpha = stacks.alpha_at(0.0, 64, 48)
    assert alpha is not None
    assert alpha[24, 32] == 0.0 and alpha[24, 16] == 1.0
    assert np.array_equal(np.rint(alpha * 255.0) / 255.0, alpha)


def test_geometry_goes_through_crop_and_decode_scale() -> None:
    """A mask stored in source pixels lands on the same picture at any decoded size."""
    mask = _rect(cx=48, cy=24, width=16, height=16)  # centred in the right half
    cropped = _clip(mask, crop={"x": 0.5, "y": 0.0, "width": 0.5, "height": 1.0})
    full = stack_alpha(cropped.masks, cropped, _SIZE, 32, 48, 3.0)  # type: ignore[arg-type]
    half = stack_alpha(cropped.masks, cropped, _SIZE, 16, 24, 3.0)  # type: ignore[arg-type]
    assert full[24, 16] == 1.0 and full[24, 2] == 0.0
    assert half[12, 8] == 1.0 and half[12, 1] == 0.0


def test_a_lone_legacy_mask_is_the_v21_float_alpha() -> None:
    clip = _clip(_rect(featherModel="gaussian-legacy", featherOuterPx=2.0, opacity=0.3))
    stacks = clip_mask_stacks(clip, _SIZE)
    assert stacks is not None
    alpha = stacks.alpha_at(0.0, 64, 48)
    assert alpha is not None
    assert not np.array_equal(np.rint(alpha * 255.0) / 255.0, alpha)  # not re-quantised


def test_per_vertex_feather_scales_with_the_decode_size() -> None:
    clip = _clip(_path())
    full = stack_alpha(clip.masks, clip, _SIZE, 64, 48, 4.0)  # type: ignore[arg-type]
    assert 0.0 < full.max() <= 1.0
    poly = mr.flatten_path(mask_path_at(clip.masks[0], 4.0))  # type: ignore[index]
    assert poly.feathers is not None


def test_mix_by_alpha_keeps_the_input_outside_the_mask() -> None:
    original = np.full((2, 2, 3), 100, dtype=np.uint8)
    effected = np.full((2, 2, 3), 200, dtype=np.uint8)
    alpha = np.array([[0.0, 1.0], [0.5, 0.25]])
    mixed = mix_by_alpha(original, effected, alpha)
    assert mixed.dtype == np.uint8
    assert mixed[:, :, 0].tolist() == [[100, 200], [150, 125]]
