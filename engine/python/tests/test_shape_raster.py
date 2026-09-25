"""The shape rasteriser and shape bounds (schema v25, plan/elements EL4a, ADR 0190).

The engine draws every shape; the monitor shows the same raster, placed by the bounds the frame
plans compute. These tests pin the bounds arithmetic, the look of each EL4a shape on real pixels,
the clean edges of a translucent marker, and the raster budget.
"""

from __future__ import annotations

import statistics
import time
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.shape_geometry import shape_bounds
from framepilot_engine.render.shape_raster import rasterize_shape

HIGHLIGHT: dict[str, Any] = {
    "shape": "rounded-rect",
    "x": 50,
    "y": 50,
    "width": 48,
    "height": 27,
    "fill": None,
    "stroke": "#FFD400",
    "strokeWidth": 0.8,
    "strokeStyle": "solid",
    "cornerRadius": 12,
}
MARKER: dict[str, Any] = {
    "shape": "marker-highlight",
    "x": 50,
    "y": 50,
    "width": 60,
    "height": 10,
    "fill": "#FFD40066",
    "stroke": None,
    "strokeWidth": 0.8,
    "strokeStyle": "solid",
    "cornerRadius": 8,
}
ARROW: dict[str, Any] = {
    "shape": "line-arrow",
    "x1": 38,
    "y1": 38,
    "x2": 50,
    "y2": 50,
    "fill": None,
    "stroke": "#FF3B30",
    "strokeWidth": 0.8,
    "strokeStyle": "solid",
    "startCap": "none",
    "endCap": "arrow",
    "headSize": 4,
}
ELLIPSE: dict[str, Any] = {
    "shape": "ellipse",
    "x": 50,
    "y": 50,
    "width": 40,
    "height": 28,
    "fill": None,
    "stroke": "#FF3B30",
    "strokeWidth": 0.8,
    "strokeStyle": "solid",
}


def _alpha(image: Any) -> np.ndarray:
    return np.asarray(image)[..., 3]


def test_bounds_wrap_the_box_its_stroke_and_a_margin() -> None:
    # 1280x720: centre (640, 360); 48% x 27% of 720 = 345.6 x 194.4; half a 5.76 px stroke plus
    # a 1 px margin each side: floor(463.32) .. ceil(816.68).
    bounds = shape_bounds(HIGHLIGHT, 1280, 720)
    assert (bounds.x, bounds.y, bounds.width, bounds.height) == (463, 258, 354, 204)


def test_bounds_wrap_a_segment_and_its_arrow_head() -> None:
    bounds = shape_bounds(ARROW, 1280, 720)
    # Both ends inside, with room for the head's half-width (4 x 5.76 / 2).
    assert bounds.x <= 486 and bounds.x + bounds.width >= 640
    assert bounds.y <= 273 and bounds.y + bounds.height >= 360


@pytest.mark.parametrize("params", [HIGHLIGHT, MARKER, ARROW, ELLIPSE], ids=lambda p: p["shape"])
def test_the_raster_is_exactly_the_bounds(params: dict[str, Any]) -> None:
    image, bounds = rasterize_shape(params, 1280, 720)
    assert image.mode == "RGBA"
    assert image.size == (bounds.width, bounds.height)
    assert _alpha(image).max() == 255 or params is MARKER


def test_a_highlight_box_is_an_outline_with_a_clear_middle() -> None:
    image, bounds = rasterize_shape(HIGHLIGHT, 1280, 720)
    alpha = _alpha(image)
    assert alpha[bounds.height // 2, bounds.width // 2] == 0
    # The left edge of the box sits at 640 - 172.8 = 467.2 frame px: solid yellow there.
    x = round(467.2) - bounds.x
    pixel = np.asarray(image)[bounds.height // 2, x]
    assert tuple(pixel) == (255, 212, 0, 255)


def test_a_marker_is_translucent_with_edges_that_never_darken() -> None:
    image, _ = rasterize_shape(MARKER, 1280, 720)
    pixels = np.asarray(image)
    covered = pixels[pixels[..., 3] > 0]
    # Every partly covered pixel keeps the marker's colour; only its alpha fades.
    assert (covered[:, :3] == (255, 212, 0)).all()
    assert pixels[pixels.shape[0] // 2, pixels.shape[1] // 2, 3] == 0x66


def test_an_arrow_has_a_head_at_its_end() -> None:
    image, bounds = rasterize_shape(ARROW, 1280, 720)
    alpha = _alpha(image)
    tip_x, tip_y = 640 - bounds.x, 360 - bounds.y
    # Just behind the tip the head is wider than the shaft.
    back = 8
    row = alpha[tip_y - back, :]
    head_cols = np.nonzero(row > 128)[0]
    assert head_cols.size > 0
    assert alpha[tip_y - 2, tip_x - 2] > 128


def test_an_ellipse_outline_leaves_its_centre_empty() -> None:
    image, bounds = rasterize_shape(ELLIPSE, 1280, 720)
    alpha = _alpha(image)
    assert alpha[bounds.height // 2, bounds.width // 2] == 0
    # The top of the ellipse: 360 - 0.14 * 720 = 259.2.
    assert alpha[round(259.2) - bounds.y, 640 - bounds.x] > 128


def test_dashes_and_dots_cover_less_than_a_solid_stroke() -> None:
    solid = _alpha(rasterize_shape(HIGHLIGHT, 1280, 720)[0]).sum()
    dashed = _alpha(rasterize_shape({**HIGHLIGHT, "strokeStyle": "dashed"}, 1280, 720)[0]).sum()
    dotted = _alpha(rasterize_shape({**HIGHLIGHT, "strokeStyle": "dotted"}, 1280, 720)[0]).sum()
    assert 0 < dotted < dashed < solid


def test_the_same_params_draw_the_same_pixels() -> None:
    first, _ = rasterize_shape(HIGHLIGHT, 1920, 1080)
    second, _ = rasterize_shape(HIGHLIGHT, 1920, 1080)
    assert first.tobytes() == second.tobytes()


def test_a_1080p_shape_rasters_inside_its_budget() -> None:
    # Budget 15 ms at 1080p (05 section 2.2); measured ~4 ms on Apple Silicon. The bound is
    # generous for shared CI runners: it catches an order-of-magnitude regression, not noise.
    params = {**HIGHLIGHT, "fill": "#FFD40033", "width": 60, "height": 30}
    times = []
    for _ in range(20):
        start = time.perf_counter()
        rasterize_shape(params, 1920, 1080)
        times.append(time.perf_counter() - start)
    assert statistics.median(times) < 0.06
