"""Shapes on real exported pixels and in the frame plan (schema v25, plan/elements EL4a).

``grab_frame`` composites through the export compiler, so these are the pixels a user's file
gets. The frame plan is what the monitor places the engine's own raster by; both must agree on
where a shape is, how it is transformed, and how opaque it is.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from framepilot_engine.render.frame_grab import grab_frame
from framepilot_engine.render.frame_plan import frame_plan_at
from framepilot_engine.render.shape_geometry import shape_bounds
from framepilot_engine.timeline.models import SCHEMA_VERSION, Project
from framepilot_engine.timeline.synthetic_assets import SHAPE_ASSET_ID

WIDTH, HEIGHT = 640, 360
WHITE = (255, 255, 255)
YELLOW = (255, 212, 0)
BOX: dict[str, Any] = {
    "shape": "rounded-rect",
    "x": 50,
    "y": 50,
    "width": 60,
    "height": 40,
    "fill": None,
    "stroke": "#FFD400",
    "strokeWidth": 2,
    "strokeStyle": "solid",
    "cornerRadius": 0,
}


def _project(params: dict[str, Any], **clip: Any) -> Project:
    return Project.model_validate(
        {
            "id": "p",
            "name": "p",
            "version": SCHEMA_VERSION,
            "fps": 30,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [
                {
                    "id": "bg",
                    "path": "bg.png",
                    "kind": "image",
                    "media": {"width": WIDTH, "height": HEIGHT},
                }
            ],
            "timeline": {
                "tracks": [
                    {
                        "id": "top",
                        "type": "overlay",
                        "clips": [
                            {
                                "id": "s1",
                                "assetId": SHAPE_ASSET_ID,
                                "trackId": "top",
                                "start": 0.0,
                                "end": 2.0,
                                "sourceStart": 0.0,
                                "sourceEnd": 2.0,
                                "effects": [
                                    {
                                        "id": "s1__shape",
                                        "type": "shape",
                                        "params": params,
                                        "keyframes": [],
                                    }
                                ],
                                "keyframes": [],
                                **clip,
                            }
                        ],
                    },
                    {
                        "id": "v",
                        "type": "video",
                        "clips": [
                            {
                                "id": "b",
                                "assetId": "bg",
                                "trackId": "v",
                                "start": 0.0,
                                "end": 2.0,
                                "sourceStart": 0.0,
                                "sourceEnd": 2.0,
                            }
                        ],
                    },
                ]
            },
        }
    )


@pytest.fixture
def media(tmp_path: Path) -> Path:
    Image.new("RGB", (WIDTH, HEIGHT), WHITE).save(tmp_path / "bg.png")
    return tmp_path


def _frame(project: Project, base: Path, t: float = 1.0) -> Image.Image:
    grabbed = grab_frame(project, base, t, image_format="png", lossless=True)
    return Image.open(io.BytesIO(grabbed.data)).convert("RGB")


def test_a_highlight_box_exports_as_an_outline(media: Path) -> None:
    frame = _frame(_project(BOX), media)
    # The box: 60% x 40% of 360 = 216 x 144 around (320, 180) → left edge at x = 212.
    assert frame.getpixel((212, 180)) == YELLOW
    assert frame.getpixel((320, 180)) == WHITE
    assert frame.getpixel((100, 180)) == WHITE


def test_the_plan_places_the_engines_raster(media: Path) -> None:
    plan = frame_plan_at(_project(BOX), 1.0)
    layer = next(layer for layer in plan.layers if layer.clip_id == "s1")
    bounds = shape_bounds(BOX, WIDTH, HEIGHT)
    assert layer.kind == "shape"
    assert layer.shape == bounds
    assert layer.geometry is not None
    assert layer.geometry.anchor_x == pytest.approx(bounds.x + bounds.width / 2)
    assert layer.geometry.left == pytest.approx(bounds.x)
    assert layer.to_json()["shape"] == bounds.to_json()


def test_a_shape_takes_its_opacity_and_position_keyframes(media: Path) -> None:
    keyframes = [
        {"id": "o", "time": 0.0, "property": "opacity", "value": 0.5, "easing": "linear"},
        {"id": "x", "time": 0.0, "property": "x", "value": 40.0, "easing": "linear"},
    ]
    filled = {**BOX, "fill": "#FF0000", "stroke": None}
    project = _project(filled, keyframes=keyframes)
    layer = next(layer for layer in frame_plan_at(project, 1.0).layers if layer.clip_id == "s1")
    assert layer.opacity == pytest.approx(0.5)
    bounds = shape_bounds(filled, WIDTH, HEIGHT)
    assert layer.geometry is not None
    assert layer.geometry.anchor_x == pytest.approx(bounds.x + bounds.width / 2 + 40)
    frame = _frame(project, media)
    # Half-opaque red over white, moved 40 px right: (255, ~128, ~128) inside the moved box.
    red, green, blue = frame.getpixel((320 + 40, 180))  # type: ignore[misc]
    assert red >= 250 and 115 <= green <= 140 and 115 <= blue <= 140
    # The strip the box left behind is white again.
    assert frame.getpixel((214, 180)) == WHITE


def test_a_rotated_ellipse_carries_its_rotation(media: Path) -> None:
    ellipse = {
        "shape": "ellipse",
        "x": 50,
        "y": 50,
        "width": 80,
        "height": 20,
        "fill": "#0A84FF",
        "stroke": None,
        "strokeWidth": 0.8,
        "strokeStyle": "solid",
    }
    rotation = [{"id": "r", "time": 0.0, "property": "rotation", "value": 90.0, "easing": "linear"}]
    project = _project(ellipse, keyframes=rotation)
    layer = next(layer for layer in frame_plan_at(project, 1.0).layers if layer.clip_id == "s1")
    assert layer.geometry is not None and layer.geometry.rotation == pytest.approx(90.0)
    frame = _frame(project, media)
    # Wide ellipse turned upright: blue above the centre, white to its side.
    assert frame.getpixel((320, 180 - 100)) == (10, 132, 255)
    assert frame.getpixel((320 + 100, 180)) == WHITE


def test_a_shape_that_cannot_be_drawn_is_skipped_by_both(media: Path) -> None:
    broken = {**BOX, "stroke": None}
    project = _project(broken)
    assert all(layer.clip_id != "s1" for layer in frame_plan_at(project, 1.0).layers)
    assert _frame(project, media).getpixel((212, 180)) == WHITE


# --- render validation (PRD section 9.4) ---------------------------------------------------


def _preset() -> Any:
    from framepilot_engine.render.presets import ExportPreset

    return ExportPreset(id="t", label="t", width=WIDTH, height=HEIGHT, fps=30)


def test_the_export_expects_its_shapes_on_screen() -> None:
    from framepilot_engine.render.compiler import expected_render
    from framepilot_engine.validation.render_validation import _elements_on_screen_check

    on_screen = expected_render(_project(BOX), _preset())
    assert on_screen.element_count == 1
    assert on_screen.offscreen_elements == []
    assert _elements_on_screen_check(on_screen).status == "pass"


def test_a_shape_moved_entirely_off_frame_fails_the_export_with_a_remedy() -> None:
    from framepilot_engine.render.compiler import expected_render
    from framepilot_engine.validation.render_validation import _elements_on_screen_check

    away = [{"id": "x", "time": 0.0, "property": "x", "value": 5000.0, "easing": "linear"}]
    expected = expected_render(_project(BOX, keyframes=away), _preset())
    check = _elements_on_screen_check(expected)
    assert check.status == "fail"
    assert check.detail == (
        "A rounded rectangle is entirely outside the frame, so the export does not show it. "
        "Move it back in (Inspector, Shape) or delete it."
    )


def test_the_element_check_skips_a_timeline_without_shapes() -> None:
    from framepilot_engine.validation.render_validation import (
        ExpectedRender,
        _elements_on_screen_check,
    )

    assert _elements_on_screen_check(ExpectedRender()).status == "skip"
