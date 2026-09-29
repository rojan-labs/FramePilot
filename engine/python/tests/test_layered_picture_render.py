"""Layered picture looks the agent builds, rendered through the export's own compositor.

``tests/fixtures/layered-picture/*.json`` are written by
``packages/ai-sdk/src/domain-tools/layered-picture-recipes.test.ts``, which builds each project
with the agent's real tool calls (validated, applied, undone). This file renders those exact
projects with :func:`grab_frame` — the frame the model looks at and the one the export
composites — and measures the pixels (ADR 0180 amendment 2026-09-29, plan AL34).

* **Blurred fill**: a 16:9 shot fitted whole (no upscale) over a cover-cropped, blurred copy of
  itself in a 9:16 frame. The bars must be picture, and soft; the band must be the sharp shot.
* **3-up split**: three shots cropped to 1080x640 panels and moved to the thirds of a 1080x1920
  frame. Each third must be its own shot, edge to edge.
"""

from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from framepilot_engine.render.frame_grab import grab_frame
from framepilot_engine.timeline.models import Project

REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "tests" / "fixtures" / "layered-picture"

#: The sources the fixtures declare (``media`` 640x360).
SOURCE_W, SOURCE_H = 640, 360
#: The grab's long edge: the model-facing path, 360x640 for the 1080x1920 frame.
GRAB = 640
#: Checkerboard cell size in source pixels: sharp edges every 20 px.
CELL = 20


def _fixture(name: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    return loaded


def _encode(ffmpeg: str, inputs: list[str], out: Path) -> None:
    subprocess.run(
        [ffmpeg, "-y", *inputs, "-t", "1", "-r", "30", "-pix_fmt", "yuv420p", str(out)],
        check=True,
        capture_output=True,
    )


def _checkerboard_video(ffmpeg: str, out: Path) -> None:
    ys, xs = np.mgrid[0:SOURCE_H, 0:SOURCE_W]
    board = (((xs // CELL) + (ys // CELL)) % 2 * 255).astype(np.uint8)
    still = out.with_suffix(".png")
    Image.fromarray(board, "L").convert("RGB").save(still)
    _encode(ffmpeg, ["-loop", "1", "-i", str(still)], out)


def _solid_video(ffmpeg: str, colour: str, out: Path) -> None:
    _encode(ffmpeg, ["-f", "lavfi", "-i", f"color=c={colour}:s={SOURCE_W}x{SOURCE_H}:r=30"], out)


def _grab(project: dict[str, Any], base: Path) -> np.ndarray:
    grabbed = grab_frame(
        Project.model_validate(project), base, 0.5, max_dimension=GRAB, image_format="png"
    )
    assert (grabbed.width, grabbed.height) == (360, 640)
    return np.asarray(Image.open(io.BytesIO(grabbed.data)).convert("L"), dtype=np.float64)


def _sharpness(gray: np.ndarray, rows: slice) -> float:
    """Mean absolute horizontal step between neighbouring pixels: high on hard edges."""
    band = gray[rows, :]
    return float(np.abs(np.diff(band, axis=1)).mean())


def _without_blur(project: dict[str, Any]) -> dict[str, Any]:
    control: dict[str, Any] = json.loads(json.dumps(project))
    for track in control["timeline"]["tracks"]:
        for clip in track["clips"]:
            clip["effects"] = [e for e in clip["effects"] if e["type"] != "blur"]
    return control


@pytest.fixture
def blurred_fill(ffmpeg_bin: str, tmp_path: Path) -> tuple[dict[str, Any], Path]:
    _checkerboard_video(ffmpeg_bin, tmp_path / "wide.mp4")
    return _fixture("blurred-fill"), tmp_path


def test_blurred_fill_bars_are_soft_picture_and_the_band_is_the_sharp_shot(
    blurred_fill: tuple[dict[str, Any], Path],
) -> None:
    project, base = blurred_fill
    gray = _grab(project, base)
    # 640x360 fitted to the 360-wide grab is 360x202.5, centred: rows 218.75..421.25.
    bars = [slice(20, 190), slice(450, 620)]
    band = slice(240, 400)
    band_sharpness = _sharpness(gray, band)
    for rows in bars:
        # Picture, not black: the checkerboard averages mid-grey however soft it is
        # (measured 126).
        assert gray[rows, :].mean() > 60
        # Soft: an order of magnitude fewer hard edges than the fitted shot (measured 0.16
        # against 21.9), and almost no contrast left in the cells (std measured 2.4).
        assert _sharpness(gray, rows) < band_sharpness / 10
        assert gray[rows, :].std() < 10
    assert band_sharpness > 20


def test_the_band_is_fitted_whole_without_upscaling(
    blurred_fill: tuple[dict[str, Any], Path],
) -> None:
    project, base = blurred_fill
    gray = _grab(project, base)
    # Rows with the shot's hard edges in them: exactly the fitted band, 202.5 rows tall.
    per_row = np.abs(np.diff(gray, axis=1)).mean(axis=1)
    sharp_rows = np.flatnonzero(per_row > 20)
    assert abs(int(sharp_rows.min()) - 219) <= 3
    assert abs(int(sharp_rows.max()) - 421) <= 3
    # The whole width of the source is there: the 11.25-px cells reach both sides of the grab.
    for columns in (slice(0, 16), slice(344, 360)):
        assert np.abs(np.diff(gray[240:400, columns], axis=1)).max() > 100


def test_the_blur_is_what_softens_the_bars(blurred_fill: tuple[dict[str, Any], Path]) -> None:
    project, base = blurred_fill
    blurred = _sharpness(_grab(project, base), slice(20, 190))
    sharp = _sharpness(_grab(_without_blur(project), base), slice(20, 190))
    # Without the blur the cover-cropped background is the checkerboard at 1.78x (35.5-px
    # cells, measured 8.3); with it, measured 0.16.
    assert sharp > 5
    assert blurred < sharp / 10


def test_three_up_split_fills_each_third_with_its_own_shot(ffmpeg_bin: str, tmp_path: Path) -> None:
    for asset_id, colour in (("top", "red"), ("middle", "green"), ("bottom", "blue")):
        _solid_video(ffmpeg_bin, colour, tmp_path / f"{asset_id}.mp4")
    project = Project.model_validate(_fixture("split-3up"))
    grabbed = grab_frame(project, tmp_path, 0.5, max_dimension=GRAB, image_format="png")
    rgb = np.asarray(Image.open(io.BytesIO(grabbed.data)).convert("RGB"), dtype=np.int16)
    assert rgb.shape[:2] == (640, 360)
    # Panels are 213.3 rows each at this size; sample well inside each, and near the frame's
    # own top and bottom edges, which a panel that missed its third would leave black.
    for rows, channel in ((slice(4, 200), 0), (slice(226, 414), 1), (slice(440, 636), 2)):
        region = rgb[rows, 4:356]
        dominant = region[..., channel]
        others = np.delete(region, channel, axis=-1)
        assert dominant.min() > 90, (rows, channel)
        assert (dominant - others.max(axis=-1)).min() > 60, (rows, channel)
