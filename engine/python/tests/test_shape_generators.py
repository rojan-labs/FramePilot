"""Every shape generator on real pixels (plan/elements EL5.1, ADR 0190).

The catalogue names a generator per shape; the engine is the only thing that draws them, so each
one is pinned here by what a viewer would see: a star has its points, a ring its hole, a bubble
its tail, corner marks leave the middle empty, a curved arrow bows the way its sign says. And
every preset in the catalogue draws something inside its own bounds.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from framepilot_engine.render import shape_geometry
from framepilot_engine.render.shape_catalog import preset_shape_params, shape_preset_ids
from framepilot_engine.render.shape_geometry import shape_bounds
from framepilot_engine.render.shape_raster import rasterize_shape

W, H = 1280, 720


def _preset(preset_id: str, **overrides: Any) -> dict[str, Any]:
    params = preset_shape_params(preset_id)
    assert params is not None, preset_id
    return {**params, **overrides}


def _alpha(params: dict[str, Any]) -> np.ndarray:
    image, bounds = rasterize_shape(params, W, H)
    assert image.size == (bounds.width, bounds.height)
    return np.asarray(image)[..., 3]


def _centre(alpha: np.ndarray) -> int:
    rows, cols = alpha.shape
    return int(alpha[rows // 2, cols // 2])


@pytest.mark.parametrize("preset_id", shape_preset_ids())
def test_every_preset_draws_all_of_itself_inside_its_bounds(
    preset_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    params = _preset(preset_id)
    image, _ = rasterize_shape(params, W, H)
    drawn = float(np.asarray(image, dtype=np.float64)[..., 3].sum())
    assert drawn > 0, f"{preset_id} drew nothing"
    # Drawn again with a wide margin, the shape covers no more: the bounds clipped nothing.
    monkeypatch.setattr(shape_geometry, "BOUNDS_MARGIN", 12)
    roomy, _ = rasterize_shape(params, W, H)
    assert float(np.asarray(roomy, dtype=np.float64)[..., 3].sum()) == pytest.approx(
        drawn, rel=0.01
    ), preset_id


def test_a_star_has_its_points() -> None:
    five = _alpha(_preset("star-5/white", width=40, height=40))
    eight = _alpha(_preset("star-5/white", width=40, height=40, points=8))
    # The top point of a five-point star is on the vertical centre line; its shoulders are not.
    top = five[: five.shape[0] // 6]
    assert top[:, top.shape[1] // 2].max() == 255
    assert top[:, top.shape[1] // 5].max() == 0
    # More points cover more of the box.
    assert (eight > 128).sum() > (five > 128).sum()


def test_a_deeper_star_covers_less() -> None:
    fat = _alpha(_preset("star-5/white", width=40, height=40, innerRadius=80))
    thin = _alpha(_preset("star-5/white", width=40, height=40, innerRadius=20))
    assert (thin > 128).sum() < (fat > 128).sum()


def test_a_polygon_has_its_sides() -> None:
    hexagon = _alpha(_preset("hexagon/white", width=40, height=40))
    triangle = _alpha(_preset("triangle/white", width=40, height=40))
    # A triangle's top corners are empty, a hexagon's middle row is full edge to edge.
    assert triangle[2, 2] == 0 and _centre(triangle) == 255
    row = hexagon[hexagon.shape[0] // 2]
    assert row[2] > 128 and row[-3] > 128


def test_a_ring_has_a_hole_the_thickness_sets() -> None:
    ring = _alpha(_preset("circle-frame/white", width=40, height=40))
    assert _centre(ring) == 0
    row = ring[ring.shape[0] // 2]
    thin = _alpha(_preset("circle-frame/white", width=40, height=40, thickness=4))
    assert (thin > 128).sum() < (ring > 128).sum()
    assert row.max() == 255


def test_a_rectangular_frame_is_hollow() -> None:
    frame = _alpha(_preset("frame/white"))
    assert _centre(frame) == 0
    assert frame[frame.shape[0] // 2, 3] == 255


def test_a_bubble_has_its_tail_where_tail_x_says() -> None:
    left = _alpha(_preset("speech-bubble/white", tailX=15))
    right = _alpha(_preset("speech-bubble/white", tailX=85))
    bottom = -3
    cols = left.shape[1]
    assert left[bottom, : cols // 3].max() > 128 and left[bottom, 2 * cols // 3 :].max() == 0
    assert right[bottom, 2 * cols // 3 :].max() > 128 and right[bottom, : cols // 3].max() == 0


def test_corner_marks_leave_the_middle_and_the_edges_empty() -> None:
    corners = _alpha(_preset("viewfinder-corners/yellow"))
    rows = corners.shape[0]
    assert _centre(corners) == 0
    assert corners[rows // 2, 1:4].max() == 0  # the middle of the left edge
    assert corners[1:6, 1:6].max() > 128  # the top-left corner


def test_a_curved_arrow_bows_the_way_its_sign_says() -> None:
    ends = {"x1": 30, "y1": 50, "x2": 70, "y2": 50}
    up = _preset("curved-arrow/white", **ends, curvature=-60)
    down = _preset("curved-arrow/white", **ends, curvature=60)
    straight_top = 360
    assert shape_bounds(up, W, H).y < straight_top - 50
    assert shape_bounds(down, W, H).y + shape_bounds(down, W, H).height > straight_top + 50
    for params in (up, down):
        assert _alpha(params).max() == 255


def test_a_path_shape_and_an_icon_are_drawn_from_their_outline() -> None:
    loop = _alpha(_preset("hand-drawn-circle/yellow"))
    assert _centre(loop) == 0 and loop.max() == 255
    check = _alpha(_preset("icon/check", width=40, height=40))
    assert check.max() == 255
    # Lucide's check: the short stroke is lower left, the corner of the box stays empty.
    assert check[2:10, 2:10].max() == 0


def test_even_odd_paths_cut_their_inner_pieces_out() -> None:
    photo = _alpha(_preset("polaroid-frame/white"))
    rows, cols = photo.shape
    # The picture window is empty; the thick bottom border is not.
    assert photo[rows // 3, cols // 2] == 0
    assert photo[rows - rows // 10, cols // 2] == 255


def test_a_dashed_and_a_dotted_line_leave_gaps() -> None:
    for preset_id in ("dashed-line/white", "dotted-line/white"):
        alpha = _alpha(_preset(preset_id))
        middle = alpha[alpha.shape[0] // 2]
        drawn = middle > 128
        # Several separate runs along the line, not one solid stroke.
        runs = int(np.count_nonzero(drawn[1:] & ~drawn[:-1]))
        assert runs >= 4, preset_id


def _label_pixels(params: dict[str, Any]) -> np.ndarray:
    """Where the raster is near white: a white label on a coloured badge."""
    image, _ = rasterize_shape(params, W, H)
    rgba = np.asarray(image).astype(int)
    return (rgba[..., 3] > 200) & (rgba[..., 1] > 220) & (rgba[..., 2] > 220)


def test_a_badge_draws_its_number_centred_in_its_label_colour() -> None:
    badge = _preset("numbered-circle/red-1", width=20, height=20)
    white = _label_pixels(badge)
    rows, cols = np.nonzero(white)
    assert white.sum() > 50
    # Centred on its ink, both ways.
    height, width = white.shape
    assert abs((rows.min() + rows.max()) / 2 - height / 2) < height * 0.05
    assert abs((cols.min() + cols.max()) / 2 - width / 2) < width * 0.05
    # The label colour is honoured, and without a label nothing white is drawn.
    assert _label_pixels({**badge, "labelColor": "#111111"}).sum() == 0
    assert _label_pixels({**badge, "label": None}).sum() == 0


def test_a_long_label_shrinks_to_fit_its_box() -> None:
    pill = _preset("numbered-pill/red-1", label="STEP 10!")
    white = _label_pixels(pill)
    _, cols = np.nonzero(white)
    image, bounds = rasterize_shape(pill, W, H)
    box_width = pill["width"] / 100 * H
    assert cols.max() - cols.min() <= box_width * 0.8
    assert image.size == (bounds.width, bounds.height)
