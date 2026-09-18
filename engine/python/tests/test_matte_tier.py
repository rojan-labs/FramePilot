"""PX5.3: the monitor tier is the export's own decontamination planes, stored losslessly.

* ``resample_limited`` is ``resample`` value for value (it only skips outputs that read zeros);
* ``tier_planes`` is those planes, rounded to the documented 16-bit steps;
* ``write_monitor_tier`` makes them only from the masters the mask pins, writes ``tier.json``
  last, and names those masters' digests in it;
* decontaminating with the tier moves no byte by more than one level from the export's
  ``decontaminate`` at the same decoded size.
"""

from __future__ import annotations

import json
import subprocess
import zlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.matte_edges import decontaminate_dense, resample
from framepilot_engine.render.matte_tier import (
    COLOUR_SCALE,
    PLANES_FILE,
    TIER_FILE,
    WEIGHT_SCALE,
    MatteTierError,
    resample_limited,
    tier_directory,
    tier_planes,
    write_monitor_tier,
)
from framepilot_engine.render.mattes import FOREGROUND_FILE, MATTES_DIR
from tests.matte_fixtures import write_artifact


def _positive_zero(values: np.ndarray) -> np.ndarray:
    # `-0.0 + 0.0` is `0.0`: the one difference a skipped all-zero output may show.
    return values + 0.0


def _boxed(shape: tuple[int, ...], box: tuple[slice, slice], seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    values = np.zeros(shape)
    values[box] = rng.random(values[box].shape) * (255.0 if len(shape) == 3 else 1.0)
    return values


BOXES = {
    "centre": (slice(10, 20), slice(20, 40)),
    "top-left": (slice(0, 3), slice(0, 5)),
    "bottom-right": (slice(33, 36), slice(58, 64)),
    "one-pixel": (slice(17, 18), slice(31, 32)),
    "full": (slice(0, 36), slice(0, 64)),
}
SIZES = [(16, 9), (13, 7), (64, 36), (64, 9), (100, 50), (5, 3)]


@pytest.mark.parametrize("box_name", list(BOXES))
@pytest.mark.parametrize("size", SIZES)
@pytest.mark.parametrize("channels", [1, 3])
def test_resample_limited_is_resample(box_name: str, size: tuple[int, int], channels: int) -> None:
    shape = (36, 64) if channels == 1 else (36, 64, 3)
    values = _boxed(
        shape, BOXES[box_name], seed=zlib.crc32(repr((box_name, size, channels)).encode())
    )
    ceiling = 1.0 if channels == 1 else 255.0
    expected = resample(values, size[0], size[1], ceiling)
    actual = resample_limited(values, size[0], size[1], ceiling)
    assert actual.shape == expected.shape
    assert np.array_equal(_positive_zero(actual), _positive_zero(expected))


def test_resample_limited_of_nothing_is_zero() -> None:
    assert not resample_limited(np.zeros((36, 64)), 16, 9, 1.0).any()


def _ring(width: int, height: int, maximum: int = 255) -> np.ndarray:
    y, x = np.mgrid[0:height, 0:width]
    distance = np.hypot(x - width * 0.45, y - height * 0.5)
    ring = np.clip((min(width, height) * 0.3 - distance) / 3.0, 0.0, 1.0)
    return np.round(ring * maximum).astype(np.uint16 if maximum > 255 else np.uint8)


def test_tier_planes_are_the_rounded_export_planes() -> None:
    rng = np.random.default_rng(3)
    alpha = _ring(64, 36)
    foreground = rng.integers(0, 256, size=(36, 64, 3), dtype=np.uint8)
    stacked = tier_planes(alpha, 255, foreground, 16, 9)
    band = ((alpha > 0) & (alpha < 255)).astype(np.float64)
    weight = resample(band, 16, 9, 1.0)
    colour = resample(foreground.astype(np.float64) * band[:, :, None], 16, 9, 255.0)
    assert stacked.shape == (36, 16)
    assert np.array_equal(stacked[0:9], np.rint(weight * WEIGHT_SCALE))
    for channel in range(3):
        rows = slice((channel + 1) * 9, (channel + 2) * 9)
        assert np.array_equal(stacked[rows], np.rint(colour[:, :, channel] * COLOUR_SCALE))


@pytest.mark.parametrize("maximum", [255, 65535])
def test_decontaminating_with_the_tier_moves_no_byte_more_than_one_level(maximum: int) -> None:
    rng = np.random.default_rng(11)
    source_w, source_h, width, height = 96, 54, 32, 18
    alpha = _ring(source_w, source_h, maximum)
    foreground = rng.integers(0, 256, size=(source_h, source_w, 3), dtype=np.uint8)
    picture = rng.integers(0, 256, size=(height, width, 3), dtype=np.uint8)
    clip = SimpleNamespace(crop=None)
    expected = decontaminate_dense(picture, alpha, maximum, foreground, clip, (width, height))
    stacked = tier_planes(alpha, maximum, foreground, width, height)
    weight = stacked[0:height] / WEIGHT_SCALE
    colour = np.stack(
        [stacked[(c + 1) * height : (c + 2) * height] / COLOUR_SCALE for c in range(3)], axis=2
    )
    base = picture.astype(np.float64)
    mixed = np.clip(np.rint(base + (colour - base * weight[:, :, None])), 0, 255)
    difference = np.abs(mixed - expected.astype(np.float64))
    assert difference.max() <= 1.0
    assert (difference == 0).mean() >= 0.99


def _decode_planes(path: Path, width: int, height: int) -> np.ndarray:
    raw = subprocess.run(
        [
            find_ffmpeg(),
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray16le",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype="<u2").reshape(-1, 4 * height, width)


def _artifact(project: Path, count: int = 3) -> dict[str, Any]:
    rng = np.random.default_rng(5)
    mattes = [np.roll(_ring(64, 36), shift, axis=1) for shift in range(count)]
    foregrounds = [rng.integers(0, 256, size=(36, 64, 3), dtype=np.uint8) for _ in range(count)]
    return write_artifact(project, pts=list(range(count)), mattes=mattes, foregrounds=foregrounds)


def test_write_monitor_tier_encodes_every_frame_and_names_the_masters(tmp_path: Path) -> None:
    artifact = _artifact(tmp_path)
    tier = write_monitor_tier(tmp_path, artifact, (16, 9))
    assert tier.frame_count == 3
    manifest = json.loads((tier.directory / TIER_FILE).read_text(encoding="utf-8"))
    assert manifest["width"] == 16 and manifest["height"] == 9 and manifest["frameCount"] == 3
    assert manifest["source"]["files"] == {
        entry["name"]: entry["sha256"] for entry in artifact["files"]
    }
    decoded = _decode_planes(tier.directory / PLANES_FILE, 16, 9)
    rng = np.random.default_rng(5)
    for index in range(3):
        alpha = np.roll(_ring(64, 36), index, axis=1)
        foreground = rng.integers(0, 256, size=(36, 64, 3), dtype=np.uint8)
        assert np.array_equal(decoded[index], tier_planes(alpha, 255, foreground, 16, 9))
    # Beside the artifact, never inside it: the verified directory keeps only its own files.
    assert tier.directory == tier_directory(tmp_path, artifact["key"])
    assert not (tmp_path / MATTES_DIR / artifact["key"] / TIER_FILE).exists()


def test_a_changed_master_makes_no_tier(tmp_path: Path) -> None:
    artifact = _artifact(tmp_path)
    tier = write_monitor_tier(tmp_path, artifact, (16, 9))
    foreground = tmp_path / MATTES_DIR / artifact["key"] / FOREGROUND_FILE
    foreground.write_bytes(foreground.read_bytes() + b"\0")
    with pytest.raises(MatteTierError, match="changed"):
        write_monitor_tier(tmp_path, artifact, (16, 9))
    # The old manifest names the old digests; the monitor only uses a tier whose digests are the
    # ones its mask pins, so it is left for the next successful write to replace.
    manifest = json.loads((tier.directory / TIER_FILE).read_text(encoding="utf-8"))
    assert manifest["source"]["files"][FOREGROUND_FILE] == next(
        e["sha256"] for e in artifact["files"] if e["name"] == FOREGROUND_FILE
    )


def test_a_tier_needs_a_foreground(tmp_path: Path) -> None:
    artifact = _artifact(tmp_path)
    artifact["files"] = [e for e in artifact["files"] if e["name"] != FOREGROUND_FILE]
    with pytest.raises(MatteTierError, match="foreground"):
        write_monitor_tier(tmp_path, artifact, (16, 9))
