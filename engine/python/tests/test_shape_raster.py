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

from framepilot_engine.render import shape_raster
from framepilot_engine.render.shape_catalog import preset_shape_params
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


@pytest.mark.parametrize(
    "params",
    [MARKER, {**HIGHLIGHT, "fill": "#FFD40033", "stroke": "#FF3B30CC"}],
    ids=["one-part", "two-parts"],
)
def test_the_composite_table_draws_what_blending_every_pixel_draws(
    params: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    # One or two coloured parts composite through a table of every coverage combination; it is
    # only a shortcut if each pixel's bytes depend on nothing but its own coverage.
    tabled, _ = rasterize_shape(params, 1920, 1080)
    monkeypatch.setattr(shape_raster, "BLEND_TABLE_PARTS", 0)
    blended, _ = rasterize_shape(params, 1920, 1080)
    assert tabled.tobytes() == blended.tobytes()


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


def test_a_curved_stroke_is_solid_across_its_width() -> None:
    # A curve is flattened to many short segments with a round join at each turn. Pillow's own
    # joins (a pieslice per vertex) left thin cracks through a wide stroke: 24 pixels of this ring
    # at 4K fell short of opaque. A disc per join leaves none.
    params = {**(preset_shape_params("icon/circle") or {}), "width": 90, "height": 90}
    width, height = 3840, 2160
    image, bounds = rasterize_shape(params, width, height)
    alpha = _alpha(image)
    # Lucide's circle: radius 10 in its 24-unit box, centred on the box (the frame's centre).
    radius = height * 0.9 * 10 / 24
    half_stroke = height * params["strokeWidth"] / 100 / 2
    centre_x, centre_y = width / 2 - bounds.x, height / 2 - bounds.y
    rows, cols = np.ogrid[: bounds.height, : bounds.width]
    from_centre = np.hypot(cols + 0.5 - centre_x, rows + 0.5 - centre_y)
    # A pixel's width inside either edge of the stroke, every pixel is fully covered.
    inside = np.abs(from_centre - radius) <= half_stroke - 1
    assert inside.sum() > 10_000
    assert alpha[inside].min() == 255


def test_the_same_params_draw_the_same_pixels() -> None:
    first, _ = rasterize_shape(HIGHLIGHT, 1920, 1080)
    second, _ = rasterize_shape(HIGHLIGHT, 1920, 1080)
    assert first.tobytes() == second.tobytes()


#: plan/elements 05 section 7: one shape raster at 1080p and at 4K, on the reference machine.
RASTER_BUDGET_MS = {"1080p": 15.0, "4k": 50.0}
#: CI runners are slower than the reference machine and run this suite under coverage on three
#: workers, so they are held to the budget x2 (docs/guides/performance-budgets.md).
CI_CEILING_FACTOR = 2.0
FRAME_SIZES = {"1080p": (1920, 1080), "4k": (3840, 2160)}
RASTER_RUNS = 20
#: The size the budget is set at (05 section 2.2): a box 60% x 30% of the frame height.
BUDGET_BOX = {"width": 60, "height": 30}
#: The case 05 section 2.2 budgeted: a translucent, stroked highlight box.
BUDGET_HIGHLIGHT = {**HIGHLIGHT, "fill": "#FFD40033", **BUDGET_BOX}
#: The slowest shape in the catalogue at the budget's size, found by timing every preset and all
#: 1,703 icons (2026-09-26, M1 Pro, the minimum of three runs, the slowest re-timed as a median of
#: 20 CPU): the "NEW" burst label, 3.8 ms at 1080p and 13.7 ms at 4K, where the budget's highlight
#: box takes 2.1 and 8.7 ms. Its time is its label, drawn as text at the supersampled size. Re-run
#: that scan when the catalogue or the rasteriser changes, and pin whatever is slowest here.
WORST_SHAPE = {**(preset_shape_params("burst-label/new") or {}), **BUDGET_BOX}
#: The heaviest stroke in the catalogue: the grape icon, whose ~40 circles flatten to ~740 round
#: joins. It was the slowest shape while each join was a Pillow pieslice (14.2 ms at 1080p, 36-41 ms
#: at 4K; 44.8 and 100.4 ms on the CI runner, over the 4K ceiling) and takes 3.0 and 8.7 ms with a
#: disc per join, so a slow join cannot come back unnoticed.
HEAVIEST_STROKE = {**(preset_shape_params("icon/grape") or {}), **BUDGET_BOX}


def _median_raster_ms(params: dict[str, Any], width: int, height: int) -> float:
    """Median CPU milliseconds of one raster, over RASTER_RUNS after a warm-up.

    CPU time, not wall time: the raster is single-threaded Pillow and numpy work, so on a quiet
    machine the two agree (measured to within 0.2 ms), while on a shared runner wall time also
    counts the other pytest workers and coverage's neighbours taking the core.
    """
    rasterize_shape(params, width, height)
    samples = []
    for _ in range(RASTER_RUNS):
        start = time.process_time()
        rasterize_shape(params, width, height)
        samples.append((time.process_time() - start) * 1000)
    return statistics.median(samples)


def test_the_guard_times_the_worst_shape_and_the_heaviest_stroke_at_the_budget_size() -> None:
    # The guard below is only as good as the shapes it times.
    assert (WORST_SHAPE["shape"], WORST_SHAPE["label"]) == ("burst-label", "NEW")
    assert HEAVIEST_STROKE["shape"] == "icon/grape"
    for params in (WORST_SHAPE, HEAVIEST_STROKE):
        assert (params["width"], params["height"]) == (60, 30)


# The budget is the app's, and the app rasterises without a coverage tracer: CI runs this suite
# under `--cov`, which on its own added a quarter to the grape icon's 1080p time (14.2 -> 17.9 ms
# on the M1 Pro), so the timed call runs with coverage paused (pytest-cov's own marker).
@pytest.mark.no_cover
@pytest.mark.parametrize("frame", sorted(FRAME_SIZES))
@pytest.mark.parametrize(
    "params",
    [BUDGET_HIGHLIGHT, WORST_SHAPE, HEAVIEST_STROKE],
    ids=["highlight-box", "worst-burst-label", "heaviest-stroke-grape-icon"],
)
def test_a_shape_rasters_inside_its_budget(params: dict[str, Any], frame: str) -> None:
    width, height = FRAME_SIZES[frame]
    median = _median_raster_ms(params, width, height)
    ceiling = RASTER_BUDGET_MS[frame] * CI_CEILING_FACTOR
    assert median < ceiling, (
        f"{params['shape']} at {frame}: {median:.1f} ms median CPU over {RASTER_RUNS} rasters; "
        f"budget {RASTER_BUDGET_MS[frame]:.0f} ms, CI ceiling {ceiling:.0f} ms"
    )
