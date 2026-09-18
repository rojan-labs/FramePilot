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
* each 16-bit plane split into its high and low BYTES, the eight byte planes stacked into ONE
  ``gray`` frame (``W x 8H``: weight high, weight low, R high, R low, G..., B...), intra-only
  FFV1 like the pack's masters. The values are the 16-bit ones exactly; the split is only the
  container. WHY: ffmpeg codes 16-bit FFV1 with the range coder, which pays a symbol per sample
  even across the zeros that are most of a band; an 8-bit plane gets Golomb-Rice run mode, and
  the monitor's decoder reads the same frame in 12.4 ms instead of 28.6 ms (M1 Pro, PX5.3).

Where it lives, and why not in the artifact: ``.framepilot-derived/matte-tiers/<key>/``, beside
the artifact, never inside it. The artifact directory holds exactly the files the host verified
and the mask pins (BR4); a derived file there would be an undeclared file in a verified
artifact. ``tier.json`` names the digests of the masters it was made from, and the monitor uses
the tier only when those equal the digests its mask pins - so a re-processed artifact can never
be decontaminated with a stale tier; it falls back to the masters until a new tier is made.

The export never reads a tier: it always decontaminates from the masters.

**The alpha plane (PX5.8).** ``alpha.mkv`` beside the planes holds ``resample(samples /
maximum, W, H, 1)`` for every frame, rounded to 16 bits and split into high then low byte rows
(``W x 2H`` gray). That is exactly what ``to_frame`` makes of a matte layer's alpha when every
step ``matte_alpha`` runs at SOURCE resolution is the identity at that instant
(:func:`source_chain_is_identity`): no edge shift, no finesse (``edgeMode: 'sharp'`` supplies
clean levels, so it is excluded), no expansion or feather. Every other control acts before the
resample and cannot be moved after it (clean levels and morphology are not linear, the feather
redraws the 50 % contour at source resolution), so for those the monitor keeps decoding the
source-size alpha. Invert and opacity act after the resample, on the frame, and are applied by
the monitor as always. The loss is the same half step as the weight's: 1/131070.
"""

from __future__ import annotations

import json
import logging
import subprocess
import threading
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from framepilot_engine.media.ffmpeg import find_export_ffmpeg, find_ffmpeg, find_ffprobe
from framepilot_engine.media.untrusted import FORMAT_WHITELIST
from framepilot_engine.render.mask_raster import FloatArray
from framepilot_engine.render.masks import mask_scalar_at
from framepilot_engine.render.matte_edges import clean_levels, resample_taps
from framepilot_engine.render.mattes import (
    FOREGROUND_FILE,
    FOREGROUND_PIXEL_FORMATS,
    FRAMES_FILE,
    MATTE_FILE,
    MATTE_PIXEL_FORMATS,
    StreamInfo,
    artifact_directory,
    file_sha256,
    read_frames_file,
)
from framepilot_engine.safety import PathTraversalError, resolve_within
from framepilot_engine.subprocess_safety import validate_safe_argv

_log = logging.getLogger(__name__)

#: Project-relative home of every monitor tier (one per artifact key).
MATTE_TIERS_DIR = ".framepilot-derived/matte-tiers"
TIER_FILE = "tier.json"
PLANES_FILE = "planes.mkv"
#: PX5.8: the resampled alpha, for mattes whose source-pixel chain is the identity.
ALPHA_FILE = "alpha.mkv"
#: A resampled alpha in [0, 1] stored as round(alpha * ALPHA_SCALE).
ALPHA_SCALE = 65535
TIER_VERSION = 1
TIER_KIND = "framepilot.matte-monitor-tier"
#: A band weight in [0, 1] stored as round(weight * WEIGHT_SCALE).
WEIGHT_SCALE = 65535
#: A premultiplied colour in [0, 255] stored as round(colour * COLOUR_SCALE) (65535 / 255).
COLOUR_SCALE = 257
#: Planes stacked top to bottom, each as its high-byte then its low-byte rows.
PLANE_ORDER = ("weight", "r", "g", "b")
#: How a 16-bit value is laid out in the 8-bit frame: high byte rows, then low byte rows.
PLANE_LAYOUT = "u16-hi-lo-bytes"


#: Largest picture a decoder may allocate while a tier is made (8K x 8K; a lying header cannot
#: exhaust memory), and decoder threads per ffmpeg call (BR4.12 M3, as ``frame_hashes``).
MAX_PIXELS = 8192 * 8192
DECODE_THREADS = 2
#: Wall-clock bound for one probe.
PROBE_TIMEOUT_SECONDS = 60


class MatteTierError(ValueError):
    """A tier cannot be made from this artifact (missing, changed, or not what it claims)."""


class MatteTierChanged(MatteTierError):
    """A master's digest is not the one the mask pins (PX5.9: the route refuses with 409)."""


class MatteTierDeadline(MatteTierError):
    """The tier's deadline passed before every frame was written (PX5.9)."""


# --- Reading the masters as untrusted media (BR4.12 M3) ----------------------------------------


def _master_input_args() -> list[str]:
    """Hardened input options for an artifact master: the ``file`` protocol only, the media
    demuxer whitelist, the Matroska demuxer forced (the contract's container), bounded
    pictures and threads. A playlist or ffconcat file named ``matte.mkv`` cannot open another
    file on the engine's behalf."""
    return [
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        FORMAT_WHITELIST,
        "-max_pixels",
        str(MAX_PIXELS),
        "-threads",
        str(DECODE_THREADS),
        "-f",
        "matroska",
    ]


def probe_master(path: Path) -> StreamInfo:
    """``mattes.probe_stream`` of a master, with the hardened input options.

    :raises MatteTierError: The file is not a readable Matroska video stream.
    """
    argv = validate_safe_argv(
        [
            find_ffprobe(),
            "-v",
            "error",
            *_master_input_args(),
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=width,height,pix_fmt,nb_read_packets",
            "-of",
            "json",
            "-i",
            str(path),
        ]
    )
    try:
        completed = subprocess.run(
            argv, capture_output=True, check=False, timeout=PROBE_TIMEOUT_SECONDS
        )
        streams = json.loads(completed.stdout or b"{}").get("streams") or []
        stream = streams[0]
        return StreamInfo(
            width=int(stream["width"]),
            height=int(stream["height"]),
            pixel_format=str(stream["pix_fmt"]),
            frame_count=int(stream.get("nb_read_packets") or 0),
        )
    except (subprocess.SubprocessError, ValueError, IndexError, KeyError, TypeError) as exc:
        raise MatteTierError(f"{path.name} is not a readable matte file.") from exc


class _MasterFrames:
    """Every frame of one master, forward, as raw pixels from one hardened ffmpeg pipe."""

    def __init__(self, path: Path, pixel_format: str, shape: tuple[int, ...], dtype: Any) -> None:
        argv = validate_safe_argv(
            [
                # The export's binary: the tier must hold what the export makes of the masters.
                find_export_ffmpeg(),
                "-nostdin",
                "-v",
                "error",
                *_master_input_args(),
                "-i",
                str(path),
                "-map",
                "0:v:0",
                "-fps_mode",
                "passthrough",
                "-f",
                "rawvideo",
                "-pix_fmt",
                pixel_format,
                "-",
            ]
        )
        self.name = path.name
        self._shape = shape
        self._dtype = np.dtype(dtype)
        self._bytes = int(np.prod(shape)) * self._dtype.itemsize
        self._process = subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL
        )

    def next(self) -> npt.NDArray[Any]:
        assert self._process.stdout is not None
        data = self._process.stdout.read(self._bytes)
        if len(data) != self._bytes:
            raise MatteTierError(f"{self.name} ended before its last frame.")
        return np.frombuffer(data, dtype=self._dtype).reshape(self._shape)

    def kill(self) -> None:
        if self._process.poll() is None:
            self._process.kill()

    def close(self) -> None:
        self.kill()
        if self._process.stdout is not None:
            self._process.stdout.close()
        self._process.wait(timeout=60)


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


# --- When the alpha plane stands in for the source-size alpha (PX5.8) --------------------------


def _scalar(mask: Any, name: str, source_time: float) -> float:
    value = mask_scalar_at(mask, name, source_time)
    return 0.0 if value is None else value


def source_chain_is_identity(mask: Any, source_time: float) -> bool:
    """Whether every step ``matte_alpha`` runs at SOURCE resolution leaves the alpha unchanged
    at ``source_time``, so its ``to_frame`` is ``to_frame(samples / maximum)`` - the tier's
    alpha plane at the decoded size.

    Each condition is the one under which that step returns its input (``render/matte_edges``):
    ``edge_shift`` for a shift of exactly 0; ``denoise``, ``morph_open``, ``morph_close`` and
    ``blur`` for an amount or radius <= 0; ``apply_clean_levels`` for levels (0, 1) - after
    :func:`~framepilot_engine.render.matte_edges.clean_levels`, so ``edgeMode: 'sharp'`` (which
    supplies 0.25 / 0.75) is never the identity; ``shrink_grow`` and ``in_out_ratio`` for
    exactly 0; ``distance_feather`` for expansion 0 and both feathers (clamped at 0) 0. The
    scalars are read at the instant, so a keyframed edge control uses the plane only where it
    is 0.
    """
    finesse = mask.finesse
    return (
        _scalar(mask, "edgeShiftPx", source_time) == 0.0
        and float(finesse.denoise) <= 0.0
        and clean_levels(mask) == (0.0, 1.0)
        and float(finesse.morph_open_px) <= 0.0
        and float(finesse.morph_close_px) <= 0.0
        and float(finesse.shrink_grow_px) == 0.0
        and float(finesse.blur_px) <= 0.0
        and float(finesse.in_out_ratio) == 0.0
        and _scalar(mask, "expansionPx", source_time) == 0.0
        and max(_scalar(mask, "featherInnerPx", source_time), 0.0) == 0.0
        and max(_scalar(mask, "featherOuterPx", source_time), 0.0) == 0.0
    )


def alpha_plane(
    alpha_int: npt.NDArray[Any], maximum: int, width: int, height: int
) -> npt.NDArray[np.uint16]:
    """One matte frame's alpha at ``width x height``, quantised: ``round(resample(samples /
    maximum, width, height, 1) * ALPHA_SCALE)``. ``samples / maximum`` is ``edge_shift`` by 0
    (the integer samples as float64 divided by the maximum), and :func:`resample_limited` is
    ``resample`` value for value.

    :returns: ``(height, width)`` uint16.
    """
    alpha = alpha_int.astype(np.float64) / float(maximum)
    resampled = resample_limited(alpha, width, height, 1.0, _box(alpha_int > 0))
    return np.rint(resampled * ALPHA_SCALE).astype(np.uint16)


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


def split_bytes(stacked: npt.NDArray[np.uint16]) -> npt.NDArray[np.uint8]:
    """``(4H, W)`` 16-bit planes as the ``(8H, W)`` byte frame the tier stores (see the module)."""
    height = stacked.shape[0] // 4
    out = np.empty((8 * height, stacked.shape[1]), dtype=np.uint8)
    for plane in range(4):
        values = stacked[plane * height : (plane + 1) * height]
        out[(2 * plane) * height : (2 * plane + 1) * height] = values >> 8
        out[(2 * plane + 1) * height : (2 * plane + 2) * height] = values & 0xFF
    return out


def split_plane_bytes(values: npt.NDArray[np.uint16]) -> npt.NDArray[np.uint8]:
    """One ``(H, W)`` 16-bit plane as the ``(2H, W)`` byte frame ``alpha.mkv`` stores: high-byte
    rows, then low-byte rows (the planes' layout, for one plane)."""
    height = values.shape[0]
    out = np.empty((2 * height, values.shape[1]), dtype=np.uint8)
    out[0:height] = values >> 8
    out[height:] = values & 0xFF
    return out


def join_plane_bytes(frame: npt.NDArray[np.uint8]) -> npt.NDArray[np.uint16]:
    """The inverse of :func:`split_plane_bytes`."""
    height = frame.shape[0] // 2
    out = np.empty((height, frame.shape[1]), dtype=np.uint16)
    out[:] = (frame[0:height].astype(np.uint16) << 8) | frame[height:].astype(np.uint16)
    return out


def join_bytes(frame: npt.NDArray[np.uint8]) -> npt.NDArray[np.uint16]:
    """The inverse of :func:`split_bytes`."""
    height = frame.shape[0] // 8
    out = np.empty((4 * height, frame.shape[1]), dtype=np.uint16)
    for plane in range(4):
        high = frame[(2 * plane) * height : (2 * plane + 1) * height].astype(np.uint16)
        low = frame[(2 * plane + 1) * height : (2 * plane + 2) * height].astype(np.uint16)
        out[plane * height : (plane + 1) * height] = (high << 8) | low
    return out


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


class GrayEncoder:
    """One intra-only ``gray`` FFV1 stream (``-g 1``, slice CRCs), as the pack writes its
    masters, fed raw ``rows x width`` byte frames on stdin."""

    def __init__(self, path: Path, width: int, rows: int) -> None:
        argv = validate_safe_argv(
            [
                find_ffmpeg(),
                "-nostdin",
                "-v",
                "error",
                "-y",
                # The input is this process's own bytes on stdin (``pipe``; ffmpeg 8 names it
                # ``fd``) as raw video: nothing else can be opened on that side either.
                "-protocol_whitelist",
                "pipe,fd",
                "-format_whitelist",
                "rawvideo",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
                "-s",
                f"{width}x{rows}",
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
                "gray",
                "-f",
                "matroska",
                str(path),
            ]
        )
        self.shape = (rows, width)
        self.count = 0
        self._process = subprocess.Popen(argv, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, frame: npt.NDArray[np.uint8]) -> None:
        if frame.shape != self.shape or frame.dtype != np.uint8:
            raise MatteTierError("A tier frame has the wrong shape.")
        assert self._process.stdin is not None
        self._process.stdin.write(np.ascontiguousarray(frame).tobytes())
        self.count += 1

    def finish(self) -> int:
        """Close the stream and wait for ffmpeg; returns the frame count."""
        if self._process.stdin is not None and not self._process.stdin.closed:
            self._process.stdin.close()
        assert self._process.stderr is not None
        stderr = self._process.stderr.read()
        if self._process.wait(timeout=600) != 0:
            raise MatteTierError(
                f"The tier encode failed: {stderr.decode(errors='replace')[-300:]}"
            )
        return self.count

    def kill(self) -> None:
        """Stop ffmpeg now (a deadline passed); :meth:`abort` then reaps it."""
        if self._process.poll() is None:
            self._process.kill()

    def abort(self) -> None:
        """Stop ffmpeg after a failure elsewhere (the partial file is discarded by the caller)."""
        if self._process.stdin is not None and not self._process.stdin.closed:
            self._process.stdin.close()
        if self._process.poll() is None:
            self._process.kill()
        self._process.wait(timeout=60)


def encode_planes(
    path: Path, frames: Iterable[npt.NDArray[np.uint16]], width: int, height: int
) -> int:
    """Stream stacked 16-bit planes, split to bytes (:func:`split_bytes`), into intra-only
    ``gray`` FFV1 (``-g 1``, slice CRCs) as the pack writes its masters; returns the count."""
    encoder = GrayEncoder(path, width, 8 * height)
    try:
        for stacked in frames:
            if stacked.shape != (4 * height, width) or stacked.dtype != np.uint16:
                raise MatteTierError("A tier frame has the wrong shape.")
            encoder.write(split_bytes(stacked))
    except BaseException:
        encoder.abort()
        raise
    return encoder.finish()


def encode_alpha(
    path: Path, frames: Iterable[npt.NDArray[np.uint16]], width: int, height: int
) -> int:
    """Stream 16-bit alpha planes (:func:`alpha_plane`), split to bytes
    (:func:`split_plane_bytes`), into intra-only ``gray`` FFV1; returns the count."""
    encoder = GrayEncoder(path, width, 2 * height)
    try:
        for values in frames:
            if values.shape != (height, width) or values.dtype != np.uint16:
                raise MatteTierError("A tier alpha frame has the wrong shape.")
            encoder.write(split_plane_bytes(values))
    except BaseException:
        encoder.abort()
        raise
    return encoder.finish()


def tier_manifest(
    width: int,
    height: int,
    frame_count: int,
    source: Mapping[str, Any],
    planes_bytes: int,
    alpha_bytes: int | None = None,
) -> dict[str, Any]:
    """``tier.json``: what the tier is, and exactly which masters it was made from.

    :param alpha_bytes: The size of ``alpha.mkv`` (PX5.8), or ``None`` for a tier without it,
        whose ``tier.json`` then has no ``alpha`` entry (a reader treats that as no plane).
    """
    alpha = (
        {}
        if alpha_bytes is None
        else {
            "alpha": {
                "file": ALPHA_FILE,
                "bytes": alpha_bytes,
                "layout": PLANE_LAYOUT,
                "scale": ALPHA_SCALE,
            }
        }
    )
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
            "layout": PLANE_LAYOUT,
            "weightScale": WEIGHT_SCALE,
            "colourScale": COLOUR_SCALE,
        },
        **alpha,
        "resample": "swscale-bicubic-b0-c0.6-float64",
        "source": dict(source),
    }


def verified_source(directory: Path, artifact: Mapping[str, Any]) -> dict[str, Any]:
    """The masters' pinned digests, after checking the files on disk still have them."""
    pinned = {str(entry["name"]): str(entry["sha256"]) for entry in artifact["files"]}
    for name in (MATTE_FILE, FOREGROUND_FILE, FRAMES_FILE):
        if name not in pinned or not (directory / name).is_file():
            raise MatteTierError(f"The artifact has no {name}; a tier needs the foreground.")
        if file_sha256(directory / name) != pinned[name]:
            raise MatteTierChanged(f"{name} changed since the mask pinned it.")
    return {
        "width": int(artifact["width"]),
        "height": int(artifact["height"]),
        "files": {name: pinned[name] for name in (MATTE_FILE, FOREGROUND_FILE, FRAMES_FILE)},
    }


def write_monitor_tier(
    base_dir: Path,
    artifact: Mapping[str, Any],
    size: tuple[int, int],
    *,
    artifact_dir: Path | None = None,
    tier_dir: Path | None = None,
    deadline: float | None = None,
) -> MonitorTier:
    """Make the monitor tier of a pinned artifact at ``size`` (the monitor's decoded size).

    Digests before pixels: the masters are hashed against the artifact's pins first, so a tier
    is only ever made from the files a mask pins. The previous ``tier.json`` is removed before
    anything is written and the new one is written last, so a reader never sees a manifest
    beside planes it does not describe.

    :param artifact: The mask's pinned ``artifact`` (``key``, ``files``, ``width``, ``height``).
    :param size: ``(width, height)`` the monitor decodes the source at (the proxy's size).
    :param artifact_dir: Read the masters from here instead of the project's artifact directory
        (a test harness serving a copy); the digests are checked all the same.
    :param tier_dir: Write the tier here instead of the project's tier directory.
    :param deadline: ``time.monotonic()`` by which it must be done; every ffmpeg it started is
        killed then, and :class:`MatteTierDeadline` raised (PX5.9: the sidecar route's bound).
    :raises MatteTierError: The artifact is missing, changed, or not readable as pinned.
    """
    key = str(artifact["key"])
    width, height = size
    if width <= 0 or height <= 0:
        raise MatteTierError("A tier needs a positive size.")
    directory = artifact_dir if artifact_dir is not None else artifact_directory(base_dir, key)
    out_dir = tier_dir if tier_dir is not None else tier_directory(base_dir, key)
    if directory is None or out_dir is None or not directory.is_dir():
        raise MatteTierError("The matte artifact is missing.")
    source = verified_source(directory, artifact)
    frames = read_frames_file(directory / FRAMES_FILE)
    matte = probe_master(directory / MATTE_FILE)
    foreground = probe_master(directory / FOREGROUND_FILE)
    if matte.pixel_format not in MATTE_PIXEL_FORMATS or (
        foreground.pixel_format not in FOREGROUND_PIXEL_FORMATS
    ):
        raise MatteTierError("The artifact uses a pixel format the export does not read.")
    expected = (source["width"], source["height"])
    for stream in (matte, foreground):
        if (stream.width, stream.height) != expected or stream.frame_count != frames.count:
            raise MatteTierError("The artifact's files disagree with frames.json.")
    if deadline is not None and time.monotonic() >= deadline:
        raise MatteTierDeadline("The monitor tier ran out of time.")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / TIER_FILE).unlink(missing_ok=True)
    matte_format, maximum = MATTE_PIXEL_FORMATS[matte.pixel_format]
    samples = _MasterFrames(
        directory / MATTE_FILE,
        matte_format,
        (expected[1], expected[0]),
        np.dtype("<u2") if maximum > 255 else np.uint8,
    )
    colours = _MasterFrames(
        directory / FOREGROUND_FILE, "rgb24", (expected[1], expected[0], 3), np.uint8
    )
    partial = out_dir / f"{PLANES_FILE}.partial"
    alpha_partial = out_dir / f"{ALPHA_FILE}.partial"
    # One pass over the masters feeds both streams: the planes and (PX5.8) the alpha plane.
    planes = GrayEncoder(partial, width, 8 * height)
    alphas = GrayEncoder(alpha_partial, width, 2 * height)
    expired = threading.Event()

    def expire() -> None:
        # A pipe read or write can block; killing the processes is what bounds the wait.
        expired.set()
        for process in (samples, colours, planes, alphas):
            process.kill()

    timer = (
        None if deadline is None else threading.Timer(max(0.0, deadline - time.monotonic()), expire)
    )
    if timer is not None:
        timer.daemon = True
        timer.start()
    try:
        for _index in range(frames.count):
            if expired.is_set():
                raise MatteTierDeadline("The monitor tier ran out of time.")
            alpha = samples.next()
            foreground_frame = colours.next()
            planes.write(split_bytes(tier_planes(alpha, maximum, foreground_frame, width, height)))
            alphas.write(split_plane_bytes(alpha_plane(alpha, maximum, width, height)))
        count = planes.finish()
        if alphas.finish() != count:
            raise MatteTierError("The tier alpha has a different frame count.")
    except BaseException as exc:
        planes.abort()
        alphas.abort()
        partial.unlink(missing_ok=True)
        alpha_partial.unlink(missing_ok=True)
        if expired.is_set() and not isinstance(exc, MatteTierDeadline):
            raise MatteTierDeadline("The monitor tier ran out of time.") from None
        raise
    finally:
        if timer is not None:
            timer.cancel()
        samples.close()
        colours.close()
    if expired.is_set():
        partial.unlink(missing_ok=True)
        alpha_partial.unlink(missing_ok=True)
        raise MatteTierDeadline("The monitor tier ran out of time.")
    partial.replace(out_dir / PLANES_FILE)
    alpha_partial.replace(out_dir / ALPHA_FILE)
    manifest = tier_manifest(
        width,
        height,
        count,
        source,
        (out_dir / PLANES_FILE).stat().st_size,
        (out_dir / ALPHA_FILE).stat().st_size,
    )
    pending = out_dir / f"{TIER_FILE}.partial"
    pending.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    pending.replace(out_dir / TIER_FILE)
    _log.info("matte tier %s: %d frames at %dx%d", key[:12], count, width, height)
    return MonitorTier(directory=out_dir, width=width, height=height, frame_count=count)
