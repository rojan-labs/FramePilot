"""The monitor tier of a matte artifact: its decontamination planes at the monitor's size (PX5.3).

WHY: the program monitor plays 540p proxies, but a matte artifact is written at the source's
display size (4K for 4K footage). To decontaminate a 540p picture the monitor needs only what
:func:`~framepilot_engine.render.matte_edges.to_frame` makes of the band weight and the
band-premultiplied foreground at the DECODED size - and to get that from the masters it had to
decode a 4K RGB foreground (69 ms a frame in the monitor's decoder, on flat colour; far more on
real footage) and resample it, every frame (``plan/background-removal-ai/PX5-BUDGETS.md``).

Those two planes do not depend on anything the user can change on the mask (edge shift, levels,
feathers, finesse, invert, opacity all act on the ALPHA, never on the decontamination), so they
can be made once, here, with the engine's own resample, and read by the monitor instead:

* ``weight = resample(band, W, H, 1)`` and ``colour = resample(foreground * band, W, H, 255)``,
  exactly as the export forms them (``decontaminate``), by :func:`resample_limited` - which
  computes only the outputs the band can reach and is value-for-value :func:`resample`;
* stored LOSSLESSLY as 16-bit integers: ``round(weight * 65535)`` and ``round(colour * 257)``
  (257 = 65535 / 255, so a byte-valued colour is exact). The one loss is that quantisation, at
  most half a step: 1/131070 of the weight and 1/514 of a colour level, three orders of magnitude
  under the parity oracle's 8/255 gate (the mix then rounds to bytes, so only a value within
  ~0.004 of a rounding tie can move, by one level);
* the four planes stacked into ONE ``gray16le`` frame (``W x 4H``: weight, R, G, B), intra-only
  FFV1 - the one 16-bit layout the monitor's FFV1 decoder already reads.

Where it lives, and why not in the artifact: ``.framepilot-derived/matte-tiers/<key>/``, beside
the artifact, never inside it. The artifact directory holds exactly the files the host verified
and the mask pins (BR4); a derived file there would be an undeclared file in a verified
artifact. ``tier.json`` names the digests of the masters it was made from, and the monitor uses
the tier only when those equal the digests its mask pins - so a re-processed artifact can never
be decontaminated with a stale tier; it falls back to the masters until a new tier is made.

The export never reads a tier: it always decontaminates from the masters.
"""

from __future__ import annotations

import json
import logging
import subprocess
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from framepilot_engine.media.ffmpeg import find_ffmpeg
from framepilot_engine.render.mask_raster import FloatArray
from framepilot_engine.render.matte_edges import resample_taps
from framepilot_engine.render.mattes import (
    FOREGROUND_FILE,
    FOREGROUND_PIXEL_FORMATS,
    FRAMES_FILE,
    MATTE_FILE,
    MATTE_PIXEL_FORMATS,
    MatteReader,
    PreparedMatte,
    artifact_directory,
    file_sha256,
    probe_stream,
    read_frames_file,
)
from framepilot_engine.safety import PathTraversalError, resolve_within
from framepilot_engine.subprocess_safety import validate_safe_argv

_log = logging.getLogger(__name__)

#: Project-relative home of every monitor tier (one per artifact key).
MATTE_TIERS_DIR = ".framepilot-derived/matte-tiers"
TIER_FILE = "tier.json"
PLANES_FILE = "planes.mkv"
TIER_VERSION = 1
TIER_KIND = "framepilot.matte-monitor-tier"
#: A band weight in [0, 1] stored as round(weight * WEIGHT_SCALE).
WEIGHT_SCALE = 65535
#: A premultiplied colour in [0, 255] stored as round(colour * COLOUR_SCALE) (65535 / 255).
COLOUR_SCALE = 257
#: Planes stacked top to bottom in the one gray16 frame.
PLANE_ORDER = ("weight", "r", "g", "b")


class MatteTierError(ValueError):
    """A tier cannot be made from this artifact (missing, changed, or not what it claims)."""


# --- The resample, limited to the band ---------------------------------------------------------


def _touching(indices: npt.NDArray[np.int64], low: int, high: int) -> npt.NDArray[np.intp]:
    """Output indices with at least one tap reading a source index in ``[low, high)``."""
    return np.flatnonzero(((indices >= low) & (indices < high)).any(axis=1))


def _axis_outputs(
    values: FloatArray,
    size: int,
    axis: int,
    ceiling: float,
    occupied: tuple[int, int],
) -> FloatArray:
    """``_resample_axis`` computed only for outputs whose taps reach ``occupied`` on ``axis``.

    Every other output reads only zeros, so it is zero; each computed output is the same taps
    summed in the same order as ``_resample_axis`` (``v0 * w0``, then ``+ v * w`` tap by tap),
    so the value is the same float. The only difference an output can show is the sign of a
    zero, which nothing downstream can see (a clamp at 0 and a quantisation follow).
    """
    source = values.shape[axis]
    if source == size:
        return values
    indices, weights = resample_taps(source, size)
    shape = list(values.shape)
    shape[axis] = size
    out: FloatArray = np.zeros(shape, dtype=np.float64)
    outputs = _touching(indices, occupied[0], occupied[1])
    if outputs.size == 0:
        return out
    picked = indices[outputs]
    scale = weights[outputs]
    # Gather from a contiguous copy of just the source span the taps read: the same values, so
    # the same products and sums, without strided reads across the whole plane.
    low, high = int(picked.min()), int(picked.max()) + 1
    span = [slice(None)] * values.ndim
    span[axis] = slice(low, high)
    moved = np.ascontiguousarray(np.moveaxis(values[tuple(span)], axis, 0))
    picked = picked - low
    broadcast = (outputs.size,) + (1,) * (moved.ndim - 1)
    result = moved[picked[:, 0]] * scale[:, 0].reshape(broadcast)
    for tap in range(1, indices.shape[1]):
        result = result + moved[picked[:, tap]] * scale[:, tap].reshape(broadcast)
    clamped = np.minimum(np.maximum(result, 0.0), ceiling)
    np.moveaxis(out, axis, 0)[outputs] = clamped
    return out


def _box(occupied: npt.NDArray[np.bool_]) -> tuple[tuple[int, int], tuple[int, int]] | None:
    """``((row0, row1), (col0, col1))`` holding every true cell, ``None`` when there is none."""
    rows = np.flatnonzero(occupied.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(occupied.any(axis=0))
    return (int(rows[0]), int(rows[-1]) + 1), (int(cols[0]), int(cols[-1]) + 1)


def resample_limited(
    values: FloatArray,
    width: int,
    height: int,
    ceiling: float,
    box: tuple[tuple[int, int], tuple[int, int]] | None = None,
) -> FloatArray:
    """:func:`~framepilot_engine.render.matte_edges.resample` for a plane that is zero outside a
    box (a matte's edge band): rows first, then columns, computing only the outputs the box can
    reach. Equal to ``resample`` value for value (signed zeros aside); the test says so on
    random planes with the box at every edge.

    :param box: ``((row0, row1), (col0, col1))`` outside which ``values`` is zero, when the
        caller knows it (saves a scan of the whole plane); found here otherwise.
    """
    out_shape = (height, width, *values.shape[2:])
    if box is None:
        box = _box(values != 0.0 if values.ndim == 2 else (values != 0.0).any(axis=2))
    if box is None:
        return np.zeros(out_shape, dtype=np.float64)
    row_box, col_box = box
    # Horizontal pass on the occupied rows only: every other row of its output is zero.
    horizontal_rows = _axis_outputs(values[row_box[0] : row_box[1]], width, 1, ceiling, col_box)
    horizontal: FloatArray = np.zeros((values.shape[0], width, *values.shape[2:]))
    horizontal[row_box[0] : row_box[1]] = horizontal_rows
    return _axis_outputs(horizontal, height, 0, ceiling, row_box)


# --- One frame's planes ------------------------------------------------------------------------


def tier_planes(
    alpha_int: npt.NDArray[Any],
    maximum: int,
    foreground: npt.NDArray[np.uint8],
    width: int,
    height: int,
) -> npt.NDArray[np.uint16]:
    """The decontamination planes of one matte frame at ``width x height``, quantised.

    :returns: ``(4 * height, width)`` uint16: weight, then premultiplied R, G, B.
    """
    in_band = (alpha_int > 0) & (alpha_int < maximum)
    box = _box(in_band)
    band = np.zeros(in_band.shape, dtype=np.float64)
    premultiplied = np.zeros((*in_band.shape, 3), dtype=np.float64)
    if box is not None:
        # Outside the band's box both planes are zero: only the box is converted.
        inside = (slice(*box[0]), slice(*box[1]))
        band[inside] = in_band[inside]
        premultiplied[inside] = foreground[inside].astype(np.float64) * band[inside][:, :, None]
    weight = resample_limited(band, width, height, 1.0, box)
    colour = resample_limited(premultiplied, width, height, 255.0, box)
    stacked = np.empty((4 * height, width), dtype=np.uint16)
    stacked[0:height] = np.rint(weight * WEIGHT_SCALE)
    for channel in range(3):
        rows = slice((channel + 1) * height, (channel + 2) * height)
        stacked[rows] = np.rint(colour[:, :, channel] * COLOUR_SCALE)
    return stacked


# --- Writing a tier ----------------------------------------------------------------------------


@dataclass(frozen=True)
class MonitorTier:
    """A written tier: where, at what size, over how many frames."""

    directory: Path
    width: int
    height: int
    frame_count: int


def tier_directory(base_dir: Path, key: str) -> Path | None:
    """``<project>/.framepilot-derived/matte-tiers/<key>``, or ``None`` for a bad key."""
    if artifact_directory(base_dir, key) is None:
        return None
    try:
        return resolve_within(base_dir, f"{MATTE_TIERS_DIR}/{key}")
    except PathTraversalError:
        return None


def encode_planes(
    path: Path, frames: Iterable[npt.NDArray[np.uint16]], width: int, height: int
) -> int:
    """Stream stacked planes into intra-only ``gray16le`` FFV1 (``-g 1``, slice CRCs), as the
    pack writes its masters; returns the frame count."""
    argv = validate_safe_argv(
        [
            find_ffmpeg(),
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray16le",
            "-s",
            f"{width}x{4 * height}",
            "-r",
            "30",
            "-i",
            "-",
            "-c:v",
            "ffv1",
            "-level",
            "3",
            "-g",
            "1",
            "-slicecrc",
            "1",
            "-pix_fmt",
            "gray16le",
            "-f",
            "matroska",
            str(path),
        ]
    )
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    count = 0
    try:
        assert process.stdin is not None
        for stacked in frames:
            if stacked.shape != (4 * height, width) or stacked.dtype != np.uint16:
                raise MatteTierError("A tier frame has the wrong shape.")
            process.stdin.write(np.ascontiguousarray(stacked, dtype="<u2").tobytes())
            count += 1
    finally:
        if process.stdin is not None:
            process.stdin.close()
    assert process.stderr is not None
    stderr = process.stderr.read()
    if process.wait(timeout=600) != 0:
        raise MatteTierError(f"The tier encode failed: {stderr.decode(errors='replace')[-300:]}")
    return count


def tier_manifest(
    width: int,
    height: int,
    frame_count: int,
    source: Mapping[str, Any],
    planes_bytes: int,
) -> dict[str, Any]:
    """``tier.json``: what the tier is, and exactly which masters it was made from."""
    return {
        "version": TIER_VERSION,
        "kind": TIER_KIND,
        "width": width,
        "height": height,
        "frameCount": frame_count,
        "planes": {
            "file": PLANES_FILE,
            "bytes": planes_bytes,
            "order": list(PLANE_ORDER),
            "weightScale": WEIGHT_SCALE,
            "colourScale": COLOUR_SCALE,
        },
        "resample": "swscale-bicubic-b0-c0.6-float64",
        "source": dict(source),
    }


def _verified_source(directory: Path, artifact: Mapping[str, Any]) -> dict[str, Any]:
    """The masters' pinned digests, after checking the files on disk still have them."""
    pinned = {str(entry["name"]): str(entry["sha256"]) for entry in artifact["files"]}
    for name in (MATTE_FILE, FOREGROUND_FILE, FRAMES_FILE):
        if name not in pinned or not (directory / name).is_file():
            raise MatteTierError(f"The artifact has no {name}; a tier needs the foreground.")
        if file_sha256(directory / name) != pinned[name]:
            raise MatteTierError(f"{name} changed since the mask pinned it.")
    return {
        "width": int(artifact["width"]),
        "height": int(artifact["height"]),
        "files": {name: pinned[name] for name in (MATTE_FILE, FOREGROUND_FILE, FRAMES_FILE)},
    }


def write_monitor_tier(
    base_dir: Path, artifact: Mapping[str, Any], size: tuple[int, int]
) -> MonitorTier:
    """Make the monitor tier of a pinned artifact at ``size`` (the monitor's decoded size).

    Digests before pixels: the masters are hashed against the artifact's pins first, so a tier
    is only ever made from the files a mask pins. The previous ``tier.json`` is removed before
    anything is written and the new one is written last, so a reader never sees a manifest
    beside planes it does not describe.

    :param artifact: The mask's pinned ``artifact`` (``key``, ``files``, ``width``, ``height``).
    :param size: ``(width, height)`` the monitor decodes the source at (the proxy's size).
    :raises MatteTierError: The artifact is missing, changed, or not readable as pinned.
    """
    key = str(artifact["key"])
    width, height = size
    if width <= 0 or height <= 0:
        raise MatteTierError("A tier needs a positive size.")
    directory = artifact_directory(base_dir, key)
    out_dir = tier_directory(base_dir, key)
    if directory is None or out_dir is None or not directory.is_dir():
        raise MatteTierError("The matte artifact is missing.")
    source = _verified_source(directory, artifact)
    frames = read_frames_file(directory / FRAMES_FILE)
    matte = probe_stream(directory / MATTE_FILE)
    foreground = probe_stream(directory / FOREGROUND_FILE)
    if matte.pixel_format not in MATTE_PIXEL_FORMATS or (
        foreground.pixel_format not in FOREGROUND_PIXEL_FORMATS
    ):
        raise MatteTierError("The artifact uses a pixel format the export does not read.")
    expected = (source["width"], source["height"])
    for stream in (matte, foreground):
        if (stream.width, stream.height) != expected or stream.frame_count != frames.count:
            raise MatteTierError("The artifact's files disagree with frames.json.")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / TIER_FILE).unlink(missing_ok=True)
    reader = MatteReader(
        PreparedMatte(
            mask_id="monitor-tier",
            clip_id="monitor-tier",
            directory=directory,
            frames=frames,
            width=expected[0],
            height=expected[1],
            matte_pixel_format=matte.pixel_format,
            matte_maximum=MATTE_PIXEL_FORMATS[matte.pixel_format][1],
            has_foreground=True,
        ),
        want_foreground=True,
        lru_frames=1,
    )
    partial = out_dir / f"{PLANES_FILE}.partial"
    try:

        def stacked() -> Iterable[npt.NDArray[np.uint16]]:
            for index in range(frames.count):
                frame = reader.frame(index)
                assert frame.foreground is not None
                yield tier_planes(frame.alpha, frame.maximum, frame.foreground, width, height)

        count = encode_planes(partial, stacked(), width, height)
    finally:
        reader.close()
    partial.replace(out_dir / PLANES_FILE)
    manifest = tier_manifest(width, height, count, source, (out_dir / PLANES_FILE).stat().st_size)
    pending = out_dir / f"{TIER_FILE}.partial"
    pending.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    pending.replace(out_dir / TIER_FILE)
    _log.info("matte tier %s: %d frames at %dx%d", key[:12], count, width, height)
    return MonitorTier(directory=out_dir, width=width, height=height, frame_count=count)
