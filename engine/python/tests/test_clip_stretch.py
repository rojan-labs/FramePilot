"""Non-uniform stretch (``scaleX``/``scaleY``) in the frame plan and on exported pixels.

The bounding box's Shift-drag squashes a layer freely, so the transform model carries a
per-axis stretch on top of the uniform ``scale``. ``grab_frame`` composites through the export
compiler, so the pixel tests here are what a user's file gets; the frame plan is what the
preview places layers by, and the two must agree on the stretched box.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from framepilot_engine.render.compiler import picture_placement_at
from framepilot_engine.render.frame_grab import grab_frame
from framepilot_engine.render.frame_plan import frame_plan_at
from framepilot_engine.timeline.models import SCHEMA_VERSION, Clip, Keyframe, Project
from framepilot_engine.timeline.synthetic_assets import SHAPE_ASSET_ID

WIDTH, HEIGHT = 640, 360
WHITE = (255, 255, 255)
RED = (255, 0, 0)

#: The 200x200 sticker fits the 640x360 frame at 1.8x; its red 100x100 centre covers 180x180.
STICKER_FIT = 1.8


def _kf(prop: str, value: float, time: float = 0.0) -> dict[str, Any]:
    return {"id": f"{prop}_{time}", "time": time, "property": prop, "value": value}


def _write_media(base: Path) -> None:
    Image.new("RGB", (WIDTH, HEIGHT), WHITE).save(base / "bg.png")
    sticker = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    sticker.paste((*RED, 255), (50, 50, 150, 150))
    sticker.save(base / "sticker.png")


def _clip(clip_id: str, asset_id: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": clip_id,
        "assetId": asset_id,
        "trackId": "top",
        "start": 0.0,
        "end": 2.0,
        "sourceStart": 0.0,
        "sourceEnd": 2.0,
        "effects": [],
        "keyframes": [],
        **extra,
    }


def _project(top_clip: dict[str, Any]) -> Project:
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
                },
                {
                    "id": "st",
                    "path": "sticker.png",
                    "kind": "image",
                    "media": {"width": 200, "height": 200},
                },
            ],
            "timeline": {
                "tracks": [
                    {"id": "top", "type": "overlay", "clips": [top_clip]},
                    {"id": "v", "type": "video", "clips": [{**_clip("b", "bg"), "trackId": "v"}]},
                ]
            },
        }
    )


def _sticker(*keyframes: dict[str, Any]) -> Project:
    return _project(_clip("s1", "st", keyframes=list(keyframes)))


def _title(*keyframes: dict[str, Any]) -> Project:
    text = {
        "id": "t1__text",
        "type": "text",
        "params": {"text": "HELLO", "color": "#ff0000", "fontSizePercent": 20},
    }
    return _project(_clip("t1", "__text__", effects=[text], keyframes=list(keyframes)))


def _shape(*keyframes: dict[str, Any]) -> Project:
    params = {
        "shape": "rounded-rect",
        "x": 40,
        "y": 40,
        "width": 20,
        "height": 20,
        "fill": "#FF0000",
        "stroke": None,
        "strokeWidth": 1,
        "strokeStyle": "solid",
        "cornerRadius": 0,
    }
    shape = {"id": "s1__shape", "type": "shape", "params": params}
    return _project(_clip("s1", SHAPE_ASSET_ID, effects=[shape], keyframes=list(keyframes)))


def _frame(project: Project, base: Path, t: float = 1.0) -> Image.Image:
    grabbed = grab_frame(project, base, t, image_format="png", lossless=True)
    return Image.open(io.BytesIO(grabbed.data)).convert("RGB")


def _red_box(image: Image.Image) -> tuple[int, int, int, int]:
    """``(left, top, right, bottom)`` of every clearly red pixel, exclusive right/bottom."""
    rgb = np.asarray(image, dtype=np.int16)
    rows, cols = np.nonzero((rgb[..., 0] > 200) & (rgb[..., 1] < 90) & (rgb[..., 2] < 90))
    assert rows.size > 0, "nothing red was drawn"
    return int(cols.min()), int(rows.min()), int(cols.max()) + 1, int(rows.max()) + 1


def _geometry(project: Project, clip_id: str, t: float = 1.0) -> Any:
    layer = next(layer for layer in frame_plan_at(project, t).layers if layer.clip_id == clip_id)
    assert layer.geometry is not None
    return layer.geometry


@pytest.fixture
def media(tmp_path: Path) -> Path:
    _write_media(tmp_path)
    return tmp_path


# --- the frame plan ------------------------------------------------------------------------


def test_an_unstretched_plan_carries_no_stretch_fields() -> None:
    geometry = _geometry(_sticker(_kf("scale", 1.5)), "s1").to_json()
    assert "stretchX" not in geometry and "stretchY" not in geometry


def test_a_stretched_picture_sizes_each_axis_by_scale_times_stretch() -> None:
    geometry = _geometry(_sticker(_kf("scale", 0.5), _kf("scaleX", 3.0), _kf("scaleY", 0.5)), "s1")
    assert geometry.scale == pytest.approx(STICKER_FIT * 0.5)
    assert (geometry.stretch_x, geometry.stretch_y) == (3.0, 0.5)
    assert geometry.width == pytest.approx(200 * STICKER_FIT * 0.5 * 3.0)
    assert geometry.height == pytest.approx(200 * STICKER_FIT * 0.5 * 0.5)
    # Position semantics are unchanged: the stretched box stays centred on the frame.
    assert (geometry.anchor_x, geometry.anchor_y) == pytest.approx((WIDTH / 2, HEIGHT / 2))
    assert geometry.left == pytest.approx(WIDTH / 2 - geometry.width / 2)
    json = geometry.to_json()
    assert (json["stretchX"], json["stretchY"]) == (3.0, 0.5)


def test_a_stretched_picture_keeps_its_offset_on_the_centre() -> None:
    geometry = _geometry(_sticker(_kf("scaleX", 2.0), _kf("x", 40.0), _kf("y", -20.0)), "s1")
    assert (geometry.anchor_x, geometry.anchor_y) == pytest.approx(
        (WIDTH / 2 + 40, HEIGHT / 2 - 20)
    )
    assert geometry.width == pytest.approx(2 * geometry.height)


def test_a_stretched_title_and_shape_carry_their_stretch() -> None:
    title = _geometry(_title(_kf("scaleX", 2.0)), "t1")
    assert (title.stretch_x, title.stretch_y) == (2.0, 1.0)
    plain = _geometry(_shape(), "s1")
    shape = _geometry(_shape(_kf("scaleY", 0.5)), "s1")
    assert shape.width == pytest.approx(plain.width)
    assert shape.height == pytest.approx(plain.height * 0.5)
    assert shape.anchor_y == pytest.approx(plain.anchor_y)


def test_picture_placement_resizes_each_axis() -> None:
    clip = Clip(
        id="c",
        asset_id="st",
        track_id="top",
        start=0.0,
        end=2.0,
        source_start=0.0,
        source_end=2.0,
        keyframes=[
            Keyframe(id="sx", time=0.0, property="scaleX", value=1.5),
            Keyframe(id="sy", time=0.0, property="scaleY", value=0.5),
        ],
    )
    placement = picture_placement_at(clip, 1.0, (200, 200), (WIDTH, HEIGHT), None)
    # MoviePy truncates the (w, h) it is handed: int(200 * 1.8 * 1.5), int(200 * 1.8 * 0.5).
    assert (placement.width, placement.height) == (540, 180)
    assert (placement.x, placement.y) == (int(320 - 270.0), int(180 - 90.0))


# --- exported pixels -----------------------------------------------------------------------


def test_an_exported_still_is_stretched_wider_than_tall(media: Path) -> None:
    plain = _red_box(_frame(_sticker(), media))
    stretched = _red_box(_frame(_sticker(_kf("scaleX", 1.5), _kf("scaleY", 0.5)), media))
    # Unstretched, the red square is 180x180 around the centre.
    assert plain == (230, 90, 410, 270)
    # Stretched: 270 wide, 90 tall, still centred (a Lanczos edge may bleed one pixel).
    left, top, right, bottom = stretched
    assert right - left == pytest.approx(270, abs=2)
    assert bottom - top == pytest.approx(90, abs=2)
    assert (left + right) / 2 == pytest.approx(320, abs=1)
    assert (top + bottom) / 2 == pytest.approx(180, abs=1)


def test_the_export_agrees_with_the_plans_stretched_box(media: Path) -> None:
    project = _sticker(_kf("scale", 0.8), _kf("scaleX", 0.5), _kf("scaleY", 1.25), _kf("x", 60.0))
    geometry = _geometry(project, "s1")
    left, top, right, bottom = _red_box(_frame(project, media))
    # The red square is the sticker's middle half, on both axes.
    assert right - left == pytest.approx(geometry.width / 2, abs=2)
    assert bottom - top == pytest.approx(geometry.height / 2, abs=2)
    assert (left + right) / 2 == pytest.approx(geometry.anchor_x, abs=1)


def test_a_stretched_title_exports_wider_at_the_same_height(media: Path) -> None:
    plain = _red_box(_frame(_title(), media))
    wide = _red_box(_frame(_title(_kf("scaleX", 2.0)), media))
    plain_w, plain_h = plain[2] - plain[0], plain[3] - plain[1]
    wide_w, wide_h = wide[2] - wide[0], wide[3] - wide[1]
    assert wide_w == pytest.approx(2 * plain_w, abs=3)
    assert wide_h == pytest.approx(plain_h, abs=2)


def test_a_stretched_shape_exports_twice_as_wide(media: Path) -> None:
    plain = _red_box(_frame(_shape(), media))
    wide = _red_box(_frame(_shape(_kf("scaleX", 2.0)), media))
    # The raster's bounds pad the fill a little; the fill itself doubles across, not down.
    assert wide[2] - wide[0] == pytest.approx(2 * (plain[2] - plain[0]), abs=3)
    assert wide[3] - wide[1] == pytest.approx(plain[3] - plain[1], abs=1)
    assert (wide[0] + wide[2]) / 2 == pytest.approx((plain[0] + plain[2]) / 2, abs=1)


def test_a_stretch_happens_before_rotation_about_the_centre(media: Path) -> None:
    # 1.5x across makes the red square 270x180; a quarter turn then stands it 180x270.
    project = _sticker(_kf("scaleX", 1.5), _kf("rotation", 90.0))
    left, top, right, bottom = _red_box(_frame(project, media))
    assert right - left == pytest.approx(180, abs=2)
    assert bottom - top == pytest.approx(270, abs=2)
    assert (left + right) / 2 == pytest.approx(320, abs=1)
    assert (top + bottom) / 2 == pytest.approx(180, abs=1)
