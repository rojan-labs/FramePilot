"""PX2.3: the preview's text rasters are the export's own Pillow rasters, byte for byte."""

from __future__ import annotations

import base64
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from framepilot_engine.config import Settings
from framepilot_engine.render.captions import render_caption_image
from framepilot_engine.render.compiler import baseline_caption_position
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
