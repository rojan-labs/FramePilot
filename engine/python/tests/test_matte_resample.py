"""Matte resampling on reduced-size decodes (BR2.7).

The export decodes a source smaller than its artifact whenever the clip is fitted into a smaller
frame, capped for memory, or anamorphic. The matte then takes the picture's path: swscale's
bicubic geometry (B = 0, C = 0.6) to the decoded size, then the clip's integer crop. The reference
below is an independent scalar implementation of that rule with the same evaluation order, and
the engine must match it bit for bit, including every soft-edge pixel.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render import matte_edges
from framepilot_engine.render.compiler import compile_timeline
from framepilot_engine.render.mask_stack import clip_mask_stacks
from framepilot_engine.render.mattes import MatteFrame
from framepilot_engine.render.presets import frame_target
from framepilot_engine.render.resources import close_clip_tree
from framepilot_engine.timeline.models import Clip
from tests import matte_fixtures as fx
from tests.matte_render_goldens import project_for

B, C = 0.0, 0.6


def _cubic(x: float) -> float:
    ax = abs(x)
    near = (
        ((12.0 - 9.0 * B - 6.0 * C) * ax + (-18.0 + 12.0 * B + 6.0 * C)) * ax * ax + (6.0 - 2.0 * B)
    ) / 6.0
    far = (
        (((-B - 6.0 * C) * ax + (6.0 * B + 30.0 * C)) * ax + (-12.0 * B - 48.0 * C)) * ax
        + (8.0 * B + 24.0 * C)
    ) / 6.0
    return near if ax < 1.0 else far if ax < 2.0 else 0.0


def _reference_line(line: list[float], size: int, ceiling: float) -> list[float]:
    source = len(line)
    if source == size:
        return list(line)
    scale = source / size
    stretch = max(scale, 1.0)
    taps = 2 * math.ceil(2.0 * stretch)
    out = []
    for i in range(size):
        centre = (i + 0.5) * scale - 0.5
        first = math.floor(centre - 2.0 * stretch) + 1
        weights = [_cubic((float(first + k) - centre) / stretch) for k in range(taps)]
        total = weights[0]
        for k in range(1, taps):
            total = total + weights[k]
        value = line[min(max(first, 0), source - 1)] * (weights[0] / total)
        for k in range(1, taps):
            value = value + line[min(max(first + k, 0), source - 1)] * (weights[k] / total)
        out.append(min(max(value, 0.0), ceiling))
    return out


def _reference(plane: np.ndarray, width: int, height: int, ceiling: float) -> np.ndarray:
    rows = [_reference_line([float(v) for v in row], width, ceiling) for row in plane]
    columns = [
        _reference_line([rows[y][x] for y in range(len(rows))], height, ceiling)
        for x in range(width)
    ]
    return np.asarray([[columns[x][y] for x in range(width)] for y in range(height)])


def _soft_disc(width: int, height: int) -> np.ndarray:
    ys, xs = np.mgrid[0:height, 0:width]
    distance = np.sqrt((xs + 0.5 - width * 0.45) ** 2 + (ys + 0.5 - height * 0.5) ** 2)
    disc: np.ndarray = np.clip(np.rint((height * 0.3 + 1.5 - distance) * 85.0), 0, 255)
    return disc.astype(np.uint8)


@pytest.mark.parametrize(("width", "height"), [(24, 14), (40, 22), (100, 57), (64, 18)])
def test_resample_is_bit_exact_against_the_reference(width: int, height: int) -> None:
    alpha = _soft_disc(64, 36).astype(np.float64) / 255.0
    actual = matte_edges.resample(alpha, width, height, 1.0)
    expected = _reference(alpha, width, height, 1.0)
    band = (expected > 0.0) & (expected < 1.0)
    assert band.sum() > 10, "the case must have soft-edge pixels"
    assert np.array_equal(actual[band], expected[band])
    assert np.array_equal(actual, expected)


def test_taps_are_normalised_and_identity_is_untouched() -> None:
    plane = np.linspace(0.0, 1.0, 64 * 36).reshape(36, 64)
    assert matte_edges.resample(plane, 64, 36, 1.0) is plane
    indices, weights = matte_edges.resample_taps(64, 24)
    assert indices.shape == weights.shape and weights.shape[1] == 12
    assert np.allclose(weights.sum(axis=1), 1.0)
    assert matte_edges.resample_taps(24, 64)[1].shape[1] == 4


def test_cropped_reduced_decode_matches_the_reference_bit_for_bit() -> None:
    """Decoded at 40x22, cropped: resample the whole artifact, then take the picture's slices."""
    raw = _soft_disc(64, 36)
    clip = Clip.model_validate(
        {
            "id": "c",
            "assetId": "a",
            "trackId": "v",
            "start": 0.0,
            "end": 1.0,
            "sourceStart": 0.0,
            "sourceEnd": 1.0,
            "crop": {"x": 0.1, "y": 0.2, "width": 0.7, "height": 0.6},
            "masks": [
                fx.matte_mask(
                    "m",
                    {**_artifact(), "width": 64, "height": 36},
                    decontaminate=False,
                )
            ],
        }
    )
    stacks = clip_mask_stacks(
        clip, (64, 36), {"m": lambda _t: MatteFrame(0, raw, 255, None)}, decoded_size=(40, 22)
    )
    assert stacks is not None
    # MoviePy's crop arithmetic, float for float: (0.1 + 0.7) * 40 is 31.999..., so 31.
    rows = slice(int(0.2 * 22), int((0.2 + 0.6) * 22))
    cols = slice(int(0.1 * 40), int((0.1 + 0.7) * 40))
    height, width = rows.stop - rows.start, cols.stop - cols.start
    actual = stacks.alpha_at(0.0, width, height)
    assert actual is not None
    reference = _reference(raw.astype(np.float64) / 255.0, 40, 22, 1.0)[rows, cols]
    expected = np.rint(reference * 255.0).astype(np.uint8)
    assert np.array_equal(np.rint(actual * 255.0).astype(np.uint8), expected)


def _artifact() -> dict[str, Any]:
    return {
        "key": "e" * 64,
        "files": [],
        "width": 64,
        "height": 36,
        "coverage": {"sourceStart": 0.0, "sourceEnd": 1.0},
        "packId": "p",
        "packVersion": "1",
        "modelDigests": [],
    }


@pytest.mark.usefixtures("require_ffprobe")
def test_export_fitted_into_a_smaller_frame_uses_the_resampled_matte(tmp_path: Path) -> None:
    """A static fit decodes the 64x36 source straight to 24x14; the matte follows it."""
    alpha = [_soft_disc(64, 36)] * 6
    fx.write_source(tmp_path / "src.mkv", [np.full((36, 64, 3), 255, dtype=np.uint8)] * 6)
    artifact = fx.write_artifact(tmp_path, pts=list(range(6)), time_base=(1, 30), mattes=alpha)
    tracks = [
        {
            "id": "v",
            "type": "video",
            "clips": [
                {
                    "id": "c",
                    "assetId": "a",
                    "trackId": "v",
                    "start": 0.0,
                    "end": 0.2,
                    "sourceStart": 0.0,
                    "sourceEnd": 0.2,
                    "masks": [fx.matte_mask("m", artifact, decontaminate=False)],
                }
            ],
        }
    ]
    project = project_for(tracks)
    project.assets[0].media.width, project.assets[0].media.height = 64, 36  # type: ignore[union-attr]
    project.resolution.width, project.resolution.height = 24, 14
    index = index_assets([a.model_dump(by_alias=True) for a in project.assets], tmp_path)
    composite = compile_timeline(project, index, frame_target(24, 14, 30))
    try:
        frame = np.asarray(composite.get_frame(0.0), dtype=np.float64)[:, :, 0]
    finally:
        close_clip_tree(composite)
    reference = _reference(alpha[0].astype(np.float64) / 255.0, 24, 14, 1.0)
    expected = np.rint(reference * 255.0)
    assert frame.shape == (14, 24)
    assert float(np.abs(frame - expected).max()) <= 1.0
