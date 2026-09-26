"""Stills and titles go through the picture pipeline (plan/elements EL2a).

Before this, a still image took only its colour grade and its placement, and a title only its
placement: opacity keyframes, fades and a still's crop were ignored at export AND in the frame
plan, so the Inspector's opacity control on a photo did nothing, a title's In/Out animation
never rendered, and a reframed landscape photo showed the footage behind it through bars. These
tests pin the fixed behaviour on real composited pixels (``grab_frame``, the export path) and on
the frame plan the monitor draws from.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from framepilot_engine.render.frame_grab import grab_frame
from framepilot_engine.render.frame_plan import frame_plan_at
from framepilot_engine.timeline.models import Project

WIDTH, HEIGHT = 640, 360
WHITE = (255, 255, 255)
RED = (255, 0, 0)


def _write_media(base: Path) -> None:
    Image.new("RGB", (WIDTH, HEIGHT), WHITE).save(base / "bg.png")
    # A 200x200 transparent square with an opaque red 100x100 centre: a sticker.
    sticker = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    for x in range(50, 150):
        for y in range(50, 150):
            sticker.putpixel((x, y), (*RED, 255))
    sticker.save(base / "sticker.png")
    # A landscape photo: left half red, right half blue.
    photo = Image.new("RGB", (400, 100), (0, 0, 255))
    for x in range(200):
        for y in range(100):
            photo.putpixel((x, y), RED)
    photo.save(base / "photo.png")


def _image_asset(asset_id: str, path: str, width: int, height: int) -> dict[str, Any]:
    return {
        "id": asset_id,
        "path": path,
        "kind": "image",
        "media": {"width": width, "height": height},
    }


def _project(top_clip: dict[str, Any]) -> Project:
    return Project.model_validate(
        {
            "id": "p",
            "name": "p",
            "version": 1,
            "fps": 30,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [
                _image_asset("bg", "bg.png", WIDTH, HEIGHT),
                _image_asset("st", "sticker.png", 200, 200),
                _image_asset("ph", "photo.png", 400, 100),
            ],
            "timeline": {
                "tracks": [
                    {"id": "top", "type": "overlay", "clips": [{"trackId": "top", **top_clip}]},
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


def _still(asset_id: str = "st", **overrides: Any) -> dict[str, Any]:
    return {
        "id": "s1",
        "assetId": asset_id,
        "start": 0.0,
        "end": 2.0,
        "sourceStart": 0.0,
        "sourceEnd": 2.0,
        "effects": [],
        "keyframes": [],
        **overrides,
    }


def _title(params: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    return {
        "id": "t1",
        "assetId": "__text__",
        "start": 0.0,
        "end": 2.0,
        "sourceStart": 0.0,
        "sourceEnd": 2.0,
        "effects": [
            {
                "id": "t1__text",
                "type": "text",
                "params": {"text": "HELLO", "color": "#ff0000", "fontSizePercent": 30, **params},
                "keyframes": [],
            }
        ],
        "keyframes": [],
        **overrides,
    }


def _frame(project: Project, base: Path, t: float) -> Image.Image:
    grabbed = grab_frame(project, base, t, image_format="png", lossless=True)
    return Image.open(io.BytesIO(grabbed.data)).convert("RGB")


def _opacity(value: float) -> list[dict[str, Any]]:
    return [{"id": "o0", "time": 0.0, "property": "opacity", "value": value, "easing": "linear"}]


def _reds(image: Image.Image) -> int:
    """How many pure-ish red pixels (the unfaded text or sticker) the frame holds."""
    rgb = np.asarray(image, dtype=np.int16)
    return int(np.count_nonzero((rgb[..., 0] > 200) & (rgb[..., 1] < 90) & (rgb[..., 2] < 90)))


def _ink(image: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Row and column indices of every text pixel, faded or not: anything clearly off-white."""
    rgb = np.asarray(image, dtype=np.int16)
    rows, cols = np.nonzero(rgb[..., 1] < 200)
    return rows, cols


@pytest.fixture
def media(tmp_path: Path) -> Path:
    _write_media(tmp_path)
    return tmp_path


# --- stills --------------------------------------------------------------------------------


def test_a_still_honours_its_opacity_keyframe(media: Path) -> None:
    centre = _frame(_project(_still(keyframes=_opacity(0.25))), media, 1.0).getpixel((320, 180))
    assert isinstance(centre, tuple)
    # 25% red over white: (255, ~191, ~191).
    assert centre[0] >= 250 and 180 <= centre[1] <= 200 and 180 <= centre[2] <= 200


def test_a_still_keeps_its_own_transparency_when_it_fades(media: Path) -> None:
    frame = _frame(_project(_still(keyframes=_opacity(0.25))), media, 1.0)
    # The sticker's transparent margin stays transparent: white shows through, never a
    # black or red square around the art.
    assert frame.getpixel((170, 180)) == WHITE


def test_a_still_honours_a_fade_in_transition(media: Path) -> None:
    fade = {
        "id": "s1__transition",
        "type": "transition",
        "params": {"kind": "fade", "durationSeconds": 1.5},
        "keyframes": [],
    }
    centre = _frame(_project(_still(effects=[fade])), media, 0.3).getpixel((320, 180))
    assert isinstance(centre, tuple)
    # Part-way through the fade: neither the white it starts from nor the red it ends on.
    assert centre[0] >= 250 and 60 < centre[1] < 250


def test_a_still_honours_its_crop(media: Path) -> None:
    # Keep the photo's left (red) half only. Uncropped, the 400x100 photo fits as a 640x160
    # band whose right half is blue; cropped, the red 200x100 fits as a 640x320 band.
    crop = {"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0}
    uncropped = _frame(_project(_still("ph")), media, 1.0)
    cropped = _frame(_project(_still("ph", crop=crop)), media, 1.0)
    assert uncropped.getpixel((450, 180)) == (0, 0, 255)
    assert cropped.getpixel((450, 180)) == RED
    # The taller band reaches y=60, which the uncropped band (y 100..260) does not.
    assert uncropped.getpixel((450, 60)) == WHITE
    assert cropped.getpixel((450, 60)) == RED
    assert cropped.getpixel((320, 10)) == WHITE


def test_the_frame_plan_carries_a_stills_crop_and_opacity(media: Path) -> None:
    crop = {"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0}
    plan = frame_plan_at(_project(_still("ph", crop=crop, keyframes=_opacity(0.25))), 1.0)
    layer = next(layer for layer in plan.layers if layer.clip_id == "s1")
    assert layer.opacity == pytest.approx(0.25)
    assert layer.crop == crop
    assert layer.geometry is not None
    # The cropped 200x100 fits the 640x360 frame as 640x320 (uncropped, 400x100 is 640x160).
    assert layer.geometry.width == pytest.approx(640.0)
    assert layer.geometry.height == pytest.approx(320.0)


# --- EL2b: masks and edge styles on stills -------------------------------------------------
# The sticker fits the 640x360 frame at 1.8x, centred: sticker pixel (sx, sy) lands on frame
# (140 + 1.8 sx, 1.8 sy). Its red square (50..150) covers frame x 230..410, y 90..270.


def _circle_mask(**extra: Any) -> dict[str, Any]:
    # In the still's own pixels, like a mask on footage: radius 30 around the sticker's centre.
    return {"kind": "ellipse", "id": "m", "cx": 100, "cy": 100, "rx": 30, "ry": 30, **extra}


def _outline(width: float = 8.0) -> dict[str, Any]:
    return {
        "id": "s1__edge",
        "type": "edge_style",
        "params": {"kind": "stroke", "widthPx": width, "red": 0, "green": 0, "blue": 255},
        "keyframes": [],
    }


def _blue(pixel: Any) -> bool:
    """The outline's blue, allowing the few levels the still's Lanczos resize bleeds in."""
    return isinstance(pixel, tuple) and pixel[2] >= 245 and pixel[0] <= 20 and pixel[1] <= 20


def test_a_mask_cuts_a_still(media: Path) -> None:
    # Sticker pixel (60, 60): inside the red square, outside the circle.
    corner = (248, 108)
    plain = _frame(_project(_still()), media, 1.0)
    masked = _frame(_project(_still(masks=[_circle_mask()])), media, 1.0)
    assert plain.getpixel(corner) == RED
    assert masked.getpixel(corner) == WHITE
    assert masked.getpixel((320, 180)) == RED


def test_an_outline_traces_a_stills_own_alpha_when_it_has_no_mask(media: Path) -> None:
    # Eight source pixels = 14.4 frame pixels outside the red square's top edge (y = 90).
    frame = _frame(_project(_still(effects=[_outline()])), media, 1.0)
    assert _blue(frame.getpixel((320, 80)))
    assert frame.getpixel((320, 70)) == WHITE
    assert frame.getpixel((320, 180)) == RED


def test_an_outline_traces_what_the_mask_leaves_of_a_still(media: Path) -> None:
    # The circle (radius 54 frame px) is inside the red square: the outline follows the circle.
    frame = _frame(_project(_still(masks=[_circle_mask()], effects=[_outline()])), media, 1.0)
    assert _blue(frame.getpixel((320, 180 - 54 - 6)))
    assert frame.getpixel((248, 108)) == WHITE


def test_the_frame_plan_carries_a_stills_mask_and_edge_styles(media: Path) -> None:
    plan = frame_plan_at(_project(_still(masks=[_circle_mask()], effects=[_outline()])), 1.0)
    layer = next(layer for layer in plan.layers if layer.clip_id == "s1")
    assert layer.mask is not None
    assert [entry["id"] for entry in layer.mask["layers"]] == ["m"]
    assert [style["kind"] for style in layer.edge_styles] == ["stroke"]


# --- titles --------------------------------------------------------------------------------


def test_a_title_honours_its_opacity_keyframe(media: Path) -> None:
    solid = _frame(_project(_title({})), media, 1.0)
    faded = _frame(_project(_title({}, keyframes=_opacity(0.25))), media, 1.0)
    assert _reds(solid) > 500
    assert _reds(faded) == 0


def test_a_title_fades_in_with_its_in_animation(media: Path) -> None:
    project = _project(_title({"inAnimation": "fade", "animDurationSeconds": 0.4}))
    assert _reds(_frame(project, media, 0.05)) == 0
    assert _reds(_frame(project, media, 1.0)) > 500


def test_a_title_slides_up_into_place(media: Path) -> None:
    project = _project(_title({"inAnimation": "slide-up", "animDurationSeconds": 0.4}))

    def mean_y(image: Image.Image) -> float:
        rows, _ = _ink(image)
        return float(rows.mean())

    early = mean_y(_frame(project, media, 0.1))
    settled = mean_y(_frame(project, media, 1.0))
    # Starts below its place and rises into it.
    assert early > settled + 5


def test_a_title_pops_in_from_smaller(media: Path) -> None:
    project = _project(_title({"inAnimation": "pop", "animDurationSeconds": 0.4}))

    def ink_width(image: Image.Image) -> int:
        _, cols = _ink(image)
        return int(cols.max() - cols.min())

    assert ink_width(_frame(project, media, 0.1)) < ink_width(_frame(project, media, 1.0)) - 10


def test_the_frame_plan_carries_a_titles_animation(media: Path) -> None:
    project = _project(_title({"inAnimation": "pop", "animDurationSeconds": 0.4}))
    early = next(layer for layer in frame_plan_at(project, 0.1).layers if layer.clip_id == "t1")
    settled = next(layer for layer in frame_plan_at(project, 1.0).layers if layer.clip_id == "t1")
    assert early.opacity == pytest.approx(0.25)
    assert early.geometry is not None and settled.geometry is not None
    assert early.geometry.scale == pytest.approx(0.7 + 0.3 * 0.25)
    assert settled.opacity == pytest.approx(1.0)
    assert settled.geometry.scale == pytest.approx(1.0)
