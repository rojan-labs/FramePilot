"""Cut-out edge styles (MK9.2): the distance field is exact, and each style draws where it says."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.edge_styles import (
    EdgeStyle,
    EdgeStyleRefusal,
    apply_edge_styles,
    clip_edge_styles,
    distance_field,
    shifted,
    style_alpha,
)
from framepilot_engine.render.effect_catalog import clamp_edge_style_params
from framepilot_engine.timeline.models import Clip


def _brute_force(inside: np.ndarray, reach: int) -> np.ndarray:
    height, width = inside.shape
    points = np.argwhere(inside)
    out = np.full((height, width), np.inf)
    for y in range(height):
        for x in range(width):
            if points.size == 0:
                continue
            best = float(np.min((points[:, 0] - y) ** 2 + (points[:, 1] - x) ** 2))
            if best <= reach * reach:
                out[y, x] = math.sqrt(best)
    return out


@pytest.mark.parametrize("reach", [1, 4, 40])
def test_distance_field_is_exact_within_its_reach(reach: int) -> None:
    rng = np.random.default_rng(7)
    inside = rng.random((23, 31)) > 0.93
    np.testing.assert_array_equal(distance_field(inside, reach), _brute_force(inside, reach))


def test_distance_field_of_nothing_is_far_everywhere() -> None:
    assert np.isinf(distance_field(np.zeros((5, 7), dtype=bool), 3)).all()


def test_shifted_moves_right_and_down_and_drops_what_leaves() -> None:
    inside = np.zeros((4, 4), dtype=bool)
    inside[0, 0] = inside[3, 3] = True
    moved = shifted(inside, 1, 2)
    assert moved[2, 1]
    assert moved.sum() == 1


def _style(kind: str, **params: float) -> EdgeStyle:
    return EdgeStyle(kind, clamp_edge_style_params(kind, params))


def test_style_alpha_shapes() -> None:
    distance = np.array([0.0, 2.0, 8.0, 8.5, 9.0, np.inf])
    stroke = style_alpha(_style("stroke", widthPx=8.0), distance, 1.0)
    np.testing.assert_allclose(stroke, [1.0, 1.0, 0.5, 0.0, 0.0, 0.0])
    glow = style_alpha(_style("glow", radiusPx=9.0, opacity=1.0), distance, 1.0)
    np.testing.assert_allclose(glow, [1.0, 0.64, 0.04, 0.0225, 0.01, 0.0])


def _square_stack(size: int = 40, lo: int = 15, hi: int = 25) -> np.ndarray:
    stack = np.zeros((size, size))
    stack[lo:hi, lo:hi] = 1.0
    return stack


def test_an_outline_draws_outside_the_cut_out_and_never_over_the_picture() -> None:
    stack = _square_stack()
    rgb = np.zeros((40, 40, 3), dtype=np.uint8)
    rgb[..., 0] = 200
    out_rgb, out_alpha = apply_edge_styles(
        rgb, stack, stack, (_style("stroke", widthPx=3.0, red=0, green=0, blue=255),), 1.0, 1.0
    )
    assert tuple(out_rgb[20, 20]) == (200, 0, 0), "the subject keeps its own pixels"
    assert tuple(out_rgb[20, 26]) == (0, 0, 255) and out_alpha[20, 26] == 1.0
    assert out_alpha[20, 29] == 0.0, "past the width nothing is drawn"
    assert out_alpha[5, 5] == 0.0


def test_a_shadow_is_offset_and_fades_with_the_clip() -> None:
    stack = _square_stack()
    rgb = np.full((40, 40, 3), 255, dtype=np.uint8)
    shadow = _style("shadow", offsetXPx=6.0, offsetYPx=6.0, softnessPx=0.0, opacity=1.0)
    _, full = apply_edge_styles(rgb, stack, stack, (shadow,), 1.0, 1.0)
    assert full[28, 28] == 1.0 and full[12, 12] == 0.0
    _, faded = apply_edge_styles(rgb, stack * 0.5, stack, (shadow,), 1.0, 0.5)
    assert faded[28, 28] == 0.5


def test_lengths_follow_the_raster_scale() -> None:
    stack = _square_stack()
    rgb = np.zeros((40, 40, 3), dtype=np.uint8)
    style = (_style("stroke", widthPx=6.0),)
    _, half = apply_edge_styles(rgb, stack, stack, style, 0.5, 1.0)
    assert half[20, 26] == 1.0 and half[20, 29] == 0.0


def _clip(effects: list[dict[str, Any]]) -> Clip:
    return Clip.model_validate(
        {
            "id": "c1",
            "assetId": "a1",
            "trackId": "v",
            "start": 0.0,
            "end": 1.0,
            "sourceStart": 0.0,
            "sourceEnd": 1.0,
            "effects": effects,
            "keyframes": [],
        }
    )


def test_clip_styles_stack_shadow_glow_stroke_and_the_first_of_a_kind_counts() -> None:
    clip = _clip(
        [
            {"id": "s", "type": "edge_style", "params": {"kind": "stroke", "widthPx": 4}},
            {"id": "g", "type": "color_grade", "params": {}},
            {"id": "h", "type": "edge_style", "params": {"kind": "shadow"}},
            {"id": "s2", "type": "edge_style", "params": {"kind": "stroke", "widthPx": 9}},
        ]
    )
    styles = clip_edge_styles(clip)
    assert [style.kind for style in styles] == ["shadow", "stroke"]
    assert styles[1].params["widthPx"] == 4.0


def test_a_malformed_style_is_refused_without_numbers() -> None:
    clip = _clip([{"id": "s", "type": "edge_style", "params": {"kind": "stroke", "widthPx": 999}}])
    with pytest.raises(EdgeStyleRefusal, match="outside its range") as caught:
        clip_edge_styles(clip)
    assert "999" not in str(caught.value)
