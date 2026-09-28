"""A text overlay's frosted-glass chip blurs the picture beneath it (``background.blur``).

The chip's coverage comes out of the same rasterizer call as the letters
(:func:`rasterize_text_overlay_layers`, also the desktop monitor's raster route), is placed
through the text overlay's own opacity, fade, wipe and transform, and the picture composited
beneath the text overlay is replaced by its Gaussian blur inside it. These tests read real
composited pixels from the export path (``grab_frame``).
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from framepilot_engine.render.frame_grab import grab_frame
from framepilot_engine.render.preview_text import text_overlay_raster
from framepilot_engine.render.text_overlay import rasterize_text_overlay_layers
from framepilot_engine.timeline.models import Project

WIDTH, HEIGHT = 640, 360
FROSTED: dict[str, Any] = {
    "text": "FROST",
    "fontFamily": "Inter",
    "fontWeight": 800,
    "color": "#ffffff",
    "fontSizePercent": 14,
    "background": "#ffffff29",
    "typography": {"background": {"radius": 0.3, "paddingX": 0.6, "paddingY": 0.3, "blur": 0.4}},
}


def _stripes(base: Path) -> None:
    """Hard black/white stripes 4 px wide: any blur turns them grey."""
    stripes = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    for x in range(0, WIDTH, 8):
        stripes[:, x : x + 4] = 255
    Image.fromarray(stripes).save(base / "stripes.png")


def _project(params: dict[str, Any], **clip: Any) -> Project:
    return Project.model_validate(
        {
            "id": "p",
            "name": "p",
            "version": 1,
            "fps": 30,
            "resolution": {"width": WIDTH, "height": HEIGHT},
            "assets": [
                {
                    "id": "bg",
                    "path": "stripes.png",
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
                                "id": "t1",
                                "assetId": "__text__",
                                "trackId": "top",
                                "start": 0.0,
                                "end": 2.0,
                                "sourceStart": 0.0,
                                "sourceEnd": 2.0,
                                "effects": [
                                    {
                                        "id": "t1__text",
                                        "type": "text",
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


def _frame(project: Project, base: Path, t: float = 1.0) -> np.ndarray:
    grabbed = grab_frame(project, base, t, image_format="png", lossless=True)
    return np.asarray(Image.open(io.BytesIO(grabbed.data)).convert("RGB"), dtype=np.int16)


def _greys(frame: np.ndarray) -> int:
    """Pixels that are neither the stripes' black nor white: the blur's grey (or the letters')."""
    luma = frame.mean(axis=2)
    return int(np.count_nonzero((luma > 40) & (luma < 215)))


@pytest.fixture
def media(tmp_path: Path) -> Path:
    _stripes(tmp_path)
    return tmp_path


def test_a_frosted_chip_comes_with_its_coverage_the_size_of_the_raster() -> None:
    drawn = rasterize_text_overlay_layers("FROST", FROSTED, WIDTH, HEIGHT)
    assert drawn.backdrop is not None
    assert drawn.backdrop.shape == drawn.image.shape[:2]
    assert drawn.backdrop_sigma_px > 0
    turning = rasterize_text_overlay_layers("FROST", FROSTED, WIDTH, HEIGHT, rotates=True)
    assert turning.backdrop is not None
    assert turning.backdrop.shape == turning.image.shape[:2]
    assert turning.image.shape[0] == turning.image.shape[1]


def test_a_chip_without_blur_has_no_backdrop() -> None:
    clear = {**FROSTED, "typography": {"background": {"radius": 0.3}}}
    assert rasterize_text_overlay_layers("FROST", clear, WIDTH, HEIGHT).backdrop is None


def test_the_monitors_raster_route_returns_the_same_coverage() -> None:
    raster = text_overlay_raster(FROSTED, WIDTH, HEIGHT)
    drawn = rasterize_text_overlay_layers("FROST", FROSTED, WIDTH, HEIGHT)
    assert raster.backdrop is not None and drawn.backdrop is not None
    assert np.array_equal(raster.backdrop, drawn.backdrop)
    assert raster.backdrop_sigma_px == drawn.backdrop_sigma_px


def test_the_export_blurs_the_picture_beneath_the_chip(media: Path) -> None:
    frosted = _frame(_project(FROSTED), media)
    clear_params = {**FROSTED, "typography": {"background": {"radius": 0.3, "paddingX": 0.6}}}
    clear = _frame(_project(clear_params), media)
    # The chip turns the stripes behind it grey; the clear chip leaves them black and white.
    assert _greys(frosted) > _greys(clear) + 2000
    # Far from the chip the picture is untouched.
    assert np.array_equal(frosted[:20], clear[:20])


def test_the_frost_fades_with_its_text_overlay(media: Path) -> None:
    hidden = [{"id": "o0", "time": 0.0, "property": "opacity", "value": 0.0, "easing": "linear"}]
    faded = _frame(_project(FROSTED, keyframes=hidden), media)
    background = np.asarray(Image.open(media / "stripes.png").convert("RGB"), dtype=np.int16)
    assert np.array_equal(faded, background)


def test_the_frost_moves_with_its_text_overlay(media: Path) -> None:
    left = _frame(_project({**FROSTED, "xPercent": 30}), media)
    right = _frame(_project({**FROSTED, "xPercent": 70}), media)

    def grey_centre(frame: np.ndarray) -> float:
        luma = frame.mean(axis=2)
        cols = np.nonzero((luma > 40) & (luma < 215))[1]
        return float(cols.mean())

    assert grey_centre(left) < WIDTH / 2 < grey_centre(right)
