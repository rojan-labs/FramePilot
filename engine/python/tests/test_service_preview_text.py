"""PX2.3: the preview's text rasters are the export's own Pillow rasters, byte for byte."""

from __future__ import annotations

import base64
from collections.abc import Mapping
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from framepilot_engine.config import Settings
from framepilot_engine.render.captions import render_caption_image
from framepilot_engine.render.compiler import baseline_caption_position
from framepilot_engine.render.shape_raster import rasterize_shape
from framepilot_engine.render.text_overlay import rasterize_text_overlay
from framepilot_engine.service import create_app


def _pixels(body: dict[str, object]) -> np.ndarray:
    raw = base64.b64decode(str(body["rgba_base64"]))
    return np.frombuffer(raw, dtype=np.uint8).reshape(int(body["height"]), int(body["width"]), 4)  # type: ignore[call-overload]


def test_text_raster_is_the_compilers_raster(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    params = {"text": "Title card", "color": "#ffcc00", "xPercent": 25}
    response = client.post(
        "/preview/text-raster",
        json={"kind": "text", "params": params, "frame_width": 1280, "frame_height": 720},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    expected = rasterize_text_overlay("Title card", params, 1280, 720)
    assert np.array_equal(_pixels(body), expected)
    assert body["x"] is None and body["y"] is None


def test_a_turning_titles_raster_is_the_rotation_safe_square(tmp_path: Path) -> None:
    """EL2b.4: the monitor asks for, and gets, the square the export turns a title inside."""
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    params = {"text": "Title card", "color": "#ffcc00"}
    response = client.post(
        "/preview/text-raster",
        json={
            "kind": "text",
            "params": params,
            "rotates": True,
            "frame_width": 1280,
            "frame_height": 720,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    expected = rasterize_text_overlay("Title card", params, 1280, 720, rotates=True)
    assert np.array_equal(_pixels(body), expected)
    tight = rasterize_text_overlay("Title card", params, 1280, 720)
    assert expected.shape[0] == expected.shape[1] > max(tight.shape[:2])
    # The glyphs sit in the middle: the square's centre is the tight raster's centre.
    top = (expected.shape[0] - tight.shape[0]) // 2
    left = (expected.shape[1] - tight.shape[1]) // 2
    assert np.array_equal(expected[top : top + tight.shape[0], left : left + tight.shape[1]], tight)


def test_caption_raster_carries_the_exports_paste_position(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    response = client.post(
        "/preview/text-raster",
        json={"kind": "caption", "text": "hello there", "frame_width": 1280, "frame_height": 720},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    expected = render_caption_image("hello there", 1280, 720)
    assert np.array_equal(_pixels(body), expected)
    x, y = baseline_caption_position(1280, 720, expected.shape[1], expected.shape[0])
    assert (body["x"], body["y"]) == (x, y)


_SHAPE = {
    "shape": "rounded-rect",
    "x": 40,
    "y": 60,
    "width": 30,
    "height": 20,
    "fill": "#FFD40066",
    "stroke": "#FFD400",
    "strokeWidth": 0.8,
    "strokeStyle": "solid",
    "cornerRadius": 12,
}


def test_shape_raster_is_the_exports_raster_and_bounds(tmp_path: Path) -> None:
    # The monitor draws exactly what the export composites (plan/elements EL4a, ADR 0190).
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    for rotates in (False, True):
        response = client.post(
            "/preview/text-raster",
            json={
                "kind": "shape",
                "params": _SHAPE,
                "frame_width": 1280,
                "frame_height": 720,
                "rotates": rotates,
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        image, bounds = rasterize_shape(_SHAPE, 1280, 720, rotates=rotates)
        assert np.array_equal(_pixels(body), np.asarray(image))
        assert (body["x"], body["y"]) == (bounds.x, bounds.y)
        assert (body["width"], body["height"]) == (bounds.width, bounds.height)


def test_refuses_a_shape_that_cannot_be_drawn_with_the_validators_words(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    response = client.post(
        "/preview/text-raster",
        json={
            "kind": "shape",
            "params": {**_SHAPE, "fill": None, "stroke": None},
            "frame_width": 1280,
            "frame_height": 720,
        },
    )
    assert response.status_code == 422
    assert "draws nothing" in response.text


def test_refuses_empty_text_and_bad_sizes(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    empty = client.post(
        "/preview/text-raster",
        json={"kind": "caption", "text": "  ", "frame_width": 1280, "frame_height": 720},
    )
    assert empty.status_code == 422
    huge = client.post(
        "/preview/text-raster",
        json={"kind": "text", "params": {"text": "x"}, "frame_width": 9000, "frame_height": 720},
    )
    assert huge.status_code == 422


# --- styled captions: the export's own caption layer, sampled at one frame -----------------------

_WORDS = [
    {"word": "top", "start": 1.0, "end": 1.3},
    {"word": "1%", "start": 1.3, "end": 1.6},
    {"word": "of", "start": 1.6, "end": 1.8},
    {"word": "motion", "start": 1.8, "end": 2.4},
]


def _export_caption(style: Mapping[str, object], at: float, size: tuple[int, int]) -> np.ndarray:
    """What the export burns for one styled cue at ``at``, over black."""
    from framepilot_engine.render.compiler import caption_overlay_frames
    from framepilot_engine.timeline.models import Project

    cue = {
        "id": "cue",
        "assetId": "__caption__",
        "trackId": "captions",
        "start": 1.0,
        "end": 2.5,
        "sourceStart": 0,
        "sourceEnd": 1.5,
        "effects": [],
        "captionCue": {"text": "top 1% of motion", "words": _WORDS},
    }
    project = Project.model_validate(
        {
            "id": "p",
            "name": "p",
            "fps": 30,
            "resolution": {"width": size[0], "height": size[1]},
            "assets": [],
            "timeline": {
                "tracks": [
                    {"id": "captions", "type": "caption", "clips": [cue], "captionStyle": style}
                ]
            },
            "transcript": [],
        }
    )
    (frame,) = caption_overlay_frames(project, size, [at])
    return frame


def _preview_caption(
    client: TestClient, style: Mapping[str, object], at: float, size: tuple[int, int]
) -> tuple[dict[str, object], np.ndarray]:
    """The monitor's raster for the same cue, composited over black as the preview does."""
    response = client.post(
        "/preview/text-raster",
        json={
            "kind": "caption",
            "text": "top 1% of motion",
            "track_style": style,
            "words": _WORDS,
            "clip_start": 1.0,
            "clip_end": 2.5,
            "frame_time": at,
            "frame_width": size[0],
            "frame_height": size[1],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    rgba = _pixels(body).astype(np.float64)
    frame = np.zeros((size[1], size[0], 3), dtype=np.float64)
    x, y = int(body["x"]), int(body["y"])
    h, w = rgba.shape[:2]
    # Clip the raster to the frame, as a GPU draw at a negative or overhanging offset does.
    fx0, fy0 = max(0, x), max(0, y)
    fx1, fy1 = min(size[0], x + w), min(size[1], y + h)
    part = rgba[fy0 - y : fy1 - y, fx0 - x : fx1 - x]
    frame[fy0:fy1, fx0:fx1] = part[:, :, :3] * (part[:, :, 3:4] / 255.0)
    return body, frame


def _assert_matches_export(
    client: TestClient, style: Mapping[str, object], at: float, size: tuple[int, int]
) -> dict[str, object]:
    body, preview = _preview_caption(client, style, at, size)
    exported = _export_caption(style, at, size).astype(np.float64)
    # MoviePy truncates the blend to uint8; the preview composites in float. One level apart.
    assert np.abs(preview - exported).max() <= 1.0
    assert (exported > 0).sum() > 200  # the caption was actually drawn
    return body


def test_styled_caption_is_the_exports_caption_at_that_frame(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    # Run fb90e58d's style: placed, shadowed, accented, per-word slide-up.
    style = {
        "fontFamily": "Anton",
        "fontScale": 2.2,
        "xPercent": 50,
        "yPercent": 64,
        "maxWidthPercent": 80,
        "shadow": {"color": "#00000099", "blur": 0.3, "offsetX": 0, "offsetY": 0.06},
        "accent": {"mode": "keywords", "keywords": ["1%"], "color": "#e8b64a", "fontScale": 1.15},
        "animation": {"in": {"type": "slide-up", "duration": 0.25}, "perWord": True},
    }
    # Mid-entrance of "1%" and at rest: the motion is the export's, frame for frame.
    body = _assert_matches_export(client, style, 1.4, (288, 512))
    assert body["animated"] is True
    _assert_matches_export(client, style, 2.2, (288, 512))


def test_static_and_rotated_styles_match_and_say_they_are_static(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    static = {"fontFamily": "Inter", "fontWeight": 800, "position": "bottom"}
    body = _assert_matches_export(client, static, 1.5, (640, 360))
    assert body["animated"] is False
    _assert_matches_export(
        client, {"fontFamily": "Inter", "rotation": -8, "yPercent": 40}, 1.5, (640, 360)
    )


def test_a_frosted_chip_carries_its_coverage_and_sigma(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    style = {"templateId": "glass"}
    body, _ = _preview_caption(client, style, 1.5, (640, 360))
    assert body["backdrop_base64"] is not None
    assert float(body["backdrop_sigma_px"]) > 0  # type: ignore[arg-type]
    coverage = np.frombuffer(base64.b64decode(str(body["backdrop_base64"])), dtype=np.uint8)
    assert coverage.size == int(body["width"]) * int(body["height"])  # type: ignore[call-overload]
    assert coverage.max() == 255


def test_a_styled_caption_without_its_span_is_refused(tmp_path: Path) -> None:
    client = TestClient(create_app(Settings(projects_root=tmp_path)))
    response = client.post(
        "/preview/text-raster",
        json={
            "kind": "caption",
            "text": "hi",
            "track_style": {"fontFamily": "Inter"},
            "frame_width": 640,
            "frame_height": 360,
        },
    )
    assert response.status_code == 422
