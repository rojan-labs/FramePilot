"""PX5.8: the tier's alpha plane stands in for a matte's source-size alpha only where it may.

* :func:`source_chain_is_identity` is true exactly where every source-resolution step of
  ``matte_alpha`` returns its input - and there ``matte_alpha`` computed from the plane (crop,
  frame resample, invert, opacity) is the export's within the plane's half step;
* where it is false the plane would draw a different edge (``sharp`` is the case in point), so
  the monitor must keep the source-size alpha;
* ``write_monitor_tier`` writes ``alpha.mkv`` with every frame's plane and names it in
  ``tier.json``.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.mask_raster import layer_alpha
from framepilot_engine.render.mask_stack import matte_alpha
from framepilot_engine.render.matte_edges import resample, to_frame
from framepilot_engine.render.matte_tier import (
    ALPHA_FILE,
    ALPHA_SCALE,
    TIER_FILE,
    alpha_plane,
    join_plane_bytes,
    source_chain_is_identity,
    split_plane_bytes,
    write_monitor_tier,
)
from framepilot_engine.render.mattes import MatteFrame
from framepilot_engine.timeline.models import MatteMask
from tests.matte_fixtures import write_artifact

#: Half of the plane's quantisation step: the most a stored value is off.
HALF_STEP = 0.5 / ALPHA_SCALE
#: Float noise on top of it (the crop resample sums a few taps of values in [0, 1]).
FLOAT_SLACK = 1e-12

ARTIFACT = {
    "key": "a" * 64,
    "files": [
        {"name": "matte.mkv", "sha256": "0" * 64},
        {"name": "foreground.mkv", "sha256": "1" * 64},
        {"name": "frames.json", "sha256": "2" * 64},
    ],
    "width": 96,
    "height": 54,
    "coverage": {"sourceStart": 0.0, "sourceEnd": 10.0},
    "packId": "framepilot.smart-mask",
    "packVersion": "1.0.0",
    "modelDigests": [],
}


def _mask(**fields: Any) -> MatteMask:
    return MatteMask.model_validate({"id": "m", "kind": "matte", "artifact": ARTIFACT, **fields})


def _soft_disc(width: int, height: int, maximum: int = 255, shift: int = 0) -> np.ndarray:
    y, x = np.mgrid[0:height, 0:width]
    distance = np.hypot(x - width * 0.45 - shift, y - height * 0.5)
    soft = np.clip((min(width, height) * 0.3 - distance) / 6.0, 0.0, 1.0)
    dtype = np.uint16 if maximum > 255 else np.uint8
    rounded: np.ndarray = np.round(soft * maximum).astype(dtype)
    return rounded


def _from_plane(
    plane: np.ndarray, clip: Any, width: int, height: int, *, invert: bool, opacity: float
) -> np.ndarray:
    """What the monitor does with the plane: dequantise, the crop and frame resample of
    ``to_frame`` (its decoded-size resample is the identity), then invert and opacity."""
    decoded = plane.astype(np.float64) / ALPHA_SCALE
    placed = to_frame(decoded, clip, width, height, (plane.shape[1], plane.shape[0]))
    return layer_alpha(placed, invert=invert, opacity=opacity)


# --- The rule -------------------------------------------------------------------------------


def test_the_default_soft_matte_takes_the_plane() -> None:
    assert source_chain_is_identity(_mask(), 0.0)
    # Invert, opacity and decontamination act after the resample (or not on the alpha at all).
    assert source_chain_is_identity(_mask(invert=True, opacity=0.4, decontaminate=False), 0.0)
    # A feather clamped at 0 is no feather.
    assert source_chain_is_identity(_mask(featherInnerPx=-3, featherOuterPx=-1), 0.0)


@pytest.mark.parametrize(
    "fields",
    [
        {"edgeMode": "sharp"},
        {"edgeShiftPx": 1.5},
        {"edgeShiftPx": -0.25},
        {"expansionPx": 2},
        {"featherInnerPx": 1},
        {"featherOuterPx": 0.5},
        {"finesse": {"denoise": 0.2}},
        {"finesse": {"cleanBlack": 0.1}},
        {"finesse": {"cleanWhite": 0.9}},
        {"finesse": {"morphOpenPx": 1}},
        {"finesse": {"morphClosePx": 1}},
        {"finesse": {"shrinkGrowPx": -1}},
        {"finesse": {"blurPx": 0.5}},
        {"finesse": {"inOutRatio": 0.1}},
    ],
)
def test_any_source_resolution_control_keeps_the_source_alpha(fields: dict[str, Any]) -> None:
    assert not source_chain_is_identity(_mask(**fields), 0.0)


def test_a_keyframed_edge_control_takes_the_plane_only_where_it_is_zero() -> None:
    mask = _mask(
        keyframes=[
            {"id": "k0", "sourceTime": 0.0, "property": "edgeShiftPx", "value": 0.0},
            {"id": "k1", "sourceTime": 1.0, "property": "edgeShiftPx", "value": 0.0},
            {"id": "k2", "sourceTime": 2.0, "property": "edgeShiftPx", "value": 3.0},
        ]
    )
    assert source_chain_is_identity(mask, 0.5)
    assert source_chain_is_identity(mask, 1.0)
    assert not source_chain_is_identity(mask, 1.5)


# --- The plane is the export's alpha where the rule holds -----------------------------------


def test_alpha_plane_is_the_rounded_resample() -> None:
    alpha = _soft_disc(96, 54)
    plane = alpha_plane(alpha, 255, 32, 18)
    expected = np.rint(resample(alpha.astype(np.float64) / 255.0, 32, 18, 1.0) * ALPHA_SCALE)
    assert plane.dtype == np.uint16 and plane.shape == (18, 32)
    assert np.array_equal(plane, expected)
    assert np.array_equal(join_plane_bytes(split_plane_bytes(plane)), plane)


@pytest.mark.parametrize("maximum", [255, 65535])
@pytest.mark.parametrize(
    "crop",
    [None, SimpleNamespace(x=0.05, y=0.1, width=0.85, height=0.8)],
    ids=["uncropped", "cropped"],
)
@pytest.mark.parametrize(
    "fields",
    [{}, {"invert": True, "opacity": 0.6}, {"featherOuterPx": -2}],
    ids=["default", "inverted", "clamped-feather"],
)
def test_matte_alpha_from_the_plane_is_the_exports(
    maximum: int, crop: Any, fields: dict[str, Any]
) -> None:
    mask = _mask(**fields)
    assert source_chain_is_identity(mask, 0.0)
    decoded = (40, 22)  # the size the picture was decoded at (a proxy of the 96x54 source)
    clip = SimpleNamespace(crop=crop)
    alpha = _soft_disc(96, 54, maximum)
    width = int((crop.x + crop.width) * decoded[0]) - int(crop.x * decoded[0]) if crop else 40
    height = int((crop.y + crop.height) * decoded[1]) - int(crop.y * decoded[1]) if crop else 22
    frame = MatteFrame(index=0, alpha=alpha, maximum=maximum, foreground=None)
    export = matte_alpha(mask, clip, frame, width, height, 0.0, decoded)
    plane = alpha_plane(alpha, maximum, *decoded)
    monitor = _from_plane(
        plane, clip, width, height, invert=bool(fields.get("invert")), opacity=mask.opacity
    )
    assert monitor.shape == export.shape
    assert np.abs(monitor - export).max() <= HALF_STEP + FLOAT_SLACK


def test_sharp_would_draw_a_different_edge_from_the_plane() -> None:
    """Why the rule excludes it: clean levels are not linear, so they cannot follow the resample."""
    mask = _mask(edgeMode="sharp")
    alpha = _soft_disc(96, 54)
    frame = MatteFrame(index=0, alpha=alpha, maximum=255, foreground=None)
    clip = SimpleNamespace(crop=None)
    export = matte_alpha(mask, clip, frame, 40, 22, 0.0, (40, 22))
    monitor = _from_plane(alpha_plane(alpha, 255, 40, 22), clip, 40, 22, invert=False, opacity=1)
    assert np.abs(monitor - export).max() > 0.05


# --- Written beside the planes --------------------------------------------------------------


def _decode_alpha(path: Path, width: int, height: int) -> np.ndarray:
    raw = subprocess.run(
        [find_ffmpeg(), "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True,
        check=True,
    ).stdout
    frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 2 * height, width)
    return np.stack([join_plane_bytes(frame) for frame in frames])


def test_write_monitor_tier_writes_the_alpha_plane(tmp_path: Path) -> None:
    rng = np.random.default_rng(7)
    mattes = [_soft_disc(64, 36, shift=shift) for shift in range(3)]
    foregrounds = [rng.integers(0, 256, size=(36, 64, 3), dtype=np.uint8) for _ in range(3)]
    artifact = write_artifact(tmp_path, pts=[0, 1, 2], mattes=mattes, foregrounds=foregrounds)
    tier = write_monitor_tier(tmp_path, artifact, (16, 9))
    manifest = json.loads((tier.directory / TIER_FILE).read_text(encoding="utf-8"))
    assert manifest["alpha"] == {
        "file": ALPHA_FILE,
        "bytes": (tier.directory / ALPHA_FILE).stat().st_size,
        "layout": "u16-hi-lo-bytes",
        "scale": ALPHA_SCALE,
    }
    decoded = _decode_alpha(tier.directory / ALPHA_FILE, 16, 9)
    assert decoded.shape == (3, 9, 16)
    for index, alpha in enumerate(mattes):
        assert np.array_equal(decoded[index], alpha_plane(alpha, 255, 16, 9))
    assert not list(tier.directory.glob("*.partial"))
