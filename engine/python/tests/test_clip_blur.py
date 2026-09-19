"""The clip ``blur`` picture effect and its mask limit (render/clip_blur.py, compiler)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest
from moviepy import VideoClip
from PIL import Image, ImageFilter

from framepilot_engine.render import compiler
from framepilot_engine.render.clip_blur import (
    MAX_CLIP_BLUR_AMOUNT,
    apply_clip_blur,
    clip_blur_amount,
    clip_blur_radius,
)
from framepilot_engine.render.frame_plan import picture_effects
from framepilot_engine.render.mask_stack import clip_mask_stacks
from framepilot_engine.timeline.models import Clip

_WIDTH, _HEIGHT = 64, 48


def _checker() -> np.ndarray:
    """Hard 4 px black/white squares: any blur changes nearly every pixel."""
    ys, xs = np.mgrid[0:_HEIGHT, 0:_WIDTH]
    cells = ((ys // 4) + (xs // 4)) % 2
    return np.repeat((cells * 255).astype(np.uint8)[:, :, None], 3, axis=2)


def _clip(effects: list[dict[str, Any]], masks: list[dict[str, Any]] | None = None) -> Clip:
    return Clip.model_validate(
        {
            "id": "c",
            "assetId": "a",
            "trackId": "v",
            "start": 0.0,
            "end": 1.0,
            "sourceStart": 0.0,
            "sourceEnd": 1.0,
            "effects": effects,
            **({"masks": masks} if masks else {}),
        }
    )


@pytest.mark.parametrize(
    ("params", "amount"),
    [
        ({"amount": 0.05}, 0.05),
        ({"amount": 3}, MAX_CLIP_BLUR_AMOUNT),
        ({"amount": -1}, 0.0),
        ({"amount": float("nan")}, 0.0),
        ({"amount": True}, 0.0),
        ({"amount": "0.1"}, 0.0),
        ({}, 0.0),
    ],
)
def test_amount_is_clamped_and_anything_else_is_no_blur(
    params: dict[str, Any], amount: float
) -> None:
    assert clip_blur_amount(params) == amount


def test_radius_is_a_fraction_of_the_smaller_side() -> None:
    # The same amount gives the same LOOK at any decode size (native or straight-to-placed).
    assert clip_blur_radius({"amount": 0.1}, 1920, 1080) == pytest.approx(108.0)
    assert clip_blur_radius({"amount": 0.1}, 640, 360) == pytest.approx(36.0)


def test_blur_is_pillows_gaussian_and_zero_is_a_no_op() -> None:
    frame = _checker()
    expected = np.asarray(Image.fromarray(frame).filter(ImageFilter.GaussianBlur(0.1 * _HEIGHT)))
    assert np.array_equal(apply_clip_blur(frame, {"amount": 0.1}), expected)
    assert apply_clip_blur(frame, {"amount": 0}) is frame


def test_blur_runs_after_the_grade_and_the_lut() -> None:
    clip = _clip(
        [
            {"id": "b", "type": "blur", "params": {"amount": 0.1}},
            {"id": "g", "type": "color_grade", "params": {"exposure": 1}},
        ]
    )
    assert [effect.type for effect in picture_effects(clip)] == ["color_grade", "blur"]


def test_a_mask_limits_the_blur_to_its_region(tmp_path: Path) -> None:
    frame = _checker()
    # A hard-edged rectangle over the left half, in source pixels (media == decode size here).
    clip = _clip(
        [{"id": "fx_blur", "type": "blur", "params": {"amount": 0.1}}],
        [
            {
                "id": "m",
                "kind": "rectangle",
                "cx": 16,
                "cy": 24,
                "width": 32,
                "height": 48,
                "target": {"kind": "effect", "effectId": "fx_blur"},
            }
        ],
    )
    stacks = clip_mask_stacks(clip, (_WIDTH, _HEIGHT))
    assert stacks is not None
    source = VideoClip(lambda _t: frame, duration=1.0)
    out = compiler._apply_color_grade(source, clip, tmp_path, stacks).get_frame(0.5)
    blurred = apply_clip_blur(frame, {"amount": 0.1})
    # Well inside the mask: the blur; well outside: the untouched picture, bit for bit.
    assert np.array_equal(out[:, :12], blurred[:, :12])
    assert np.array_equal(out[:, 40:], frame[:, 40:])
    assert not np.array_equal(out[:, :12], frame[:, :12])


def test_an_unmasked_blur_covers_the_clip_and_a_zero_one_is_skipped(tmp_path: Path) -> None:
    frame = _checker()
    source = VideoClip(lambda _t: frame, duration=1.0)
    whole = _clip([{"id": "b", "type": "blur", "params": {"amount": 0.1}}])
    assert np.array_equal(
        compiler._apply_color_grade(source, whole, tmp_path).get_frame(0.0),
        apply_clip_blur(frame, {"amount": 0.1}),
    )
    none = _clip([{"id": "b", "type": "blur", "params": {"amount": 0}}])
    assert compiler._apply_color_grade(source, none, tmp_path) is source
