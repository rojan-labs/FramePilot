"""The colour of a detection crop, measured from its pixels (AM2.7, plan 11 target resolution).

WHY THIS EXISTS: "the white car" with a white and a silver car on screen is a question SigLIP
answers badly. Its text-image similarity barely separates white, grey, silver and black (on real
weights every flat silver crop read as white or grey), so the AM2.6 re-ranker asked on most
neutral-colour requests. Lightness and chroma are not a matter of opinion for a measurement,
though: CIELAB separates a white body from a mid-grey one by 30+ L* units. This module measures
exactly that, and ``packages/ai-sdk/src/masking/colour-measure.ts`` decides with it, next to
SigLIP, never instead of it.

WHAT IS MEASURED: the candidate's own pixels, not its background. A detector box holds the object
plus corners of whatever is behind it, so every pixel is weighted by a centre-weighted kernel
that is 1 at the box centre and 0 on the inscribed ellipse and outside it (the corners). No
matte is used: at ``find_mask_targets`` time none exists for a candidate, and starting a
segmentation job only to read a colour would cost a model run per candidate.

WHICH RGB: the one the export composites. Frames are decoded exactly as MoviePy's reader decodes
them (``render/pts_reader.py``): the export's own ffmpeg binary
(:func:`~framepilot_engine.media.ffmpeg.find_export_ffmpeg`, BR2.8), ``scale`` with ``bicubic``,
``rgb24``, so the source's tagged matrix (BT.601/BT.709) and range (limited/full) are applied by
the same libswscale call. That R'G'B' is read as sRGB (BT.709 primaries, D65 white; the sRGB
transfer is how a monitor shows it) and converted to CIELAB with the standard formulas.

THE NUMBERS (:class:`CropColour`): the weighted share of near-neutral pixels (C* below
:data:`NEUTRAL_PIXEL_CHROMA`), the dominant lightness of those pixels (:func:`dominant_tone`: the
weighted median L* around the densest tone, so a white car's windows and tyres do not drag it
towards grey), and the weighted median L* and C* of the whole region. The thresholds that turn
them into "white", "grey", "silver" or "black" live in TypeScript, where the resolver decides;
they were fitted on a calibration crop set and frozen
(``workers/visual-embed/tools/colour_rerank_eval.py``, ``reports/ai-masking/colour-rerank.json``).

The inputs are untrusted media (BR4.12 M3): only the ``file`` protocol, whitelisted containers, a
pixel-count bound, bounded threads and one deadline for the whole request.
"""

from __future__ import annotations

import logging
import subprocess
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import numpy.typing as npt

from framepilot_engine.media.ffmpeg import find_export_ffmpeg
from framepilot_engine.media.untrusted import bounded_decode_input_options
from framepilot_engine.subprocess_safety import validate_safe_argv

_log = logging.getLogger(__name__)

#: A pixel with CIELAB chroma below this reads as neutral (white, grey, black). Warm or cool
#: light puts a white surface at C* 10-15, which a person still calls white; a pale chromatic
#: paint (a pastel pink) is above 25.
NEUTRAL_PIXEL_CHROMA = 16.0
#: Most crops one request may measure: the host's per-request crop bound (``MAX_RERANK_CROPS``).
MAX_CROPS = 64
#: The object's dominant neutral tone is the weighted median of neutral pixels within this many
#: L* units of the densest lightness: glass and tyres do not pull a white body towards grey.
DOMINANT_TONE_BAND = 12.0
#: Bin width of the lightness histogram the densest tone is found on, in L* units.
_TONE_BIN = 2.0
#: A crop smaller than this many weighted pixels is not measured: too few to be the object.
MIN_WEIGHTED_PIXELS = 16
#: Per-decode wall-clock bound, seconds (also capped by the request deadline).
DECODE_TIMEOUT_SECONDS = 30
#: sRGB (BT.709 primaries) linear RGB -> CIE XYZ, and the D65 white point.
_RGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)
_D65 = np.array([0.95047, 1.0, 1.08883])
_LAB_EPSILON = (6.0 / 29.0) ** 3
_PPM_MAGIC = b"P6"

FloatArray = npt.NDArray[np.float64]


class CropColourError(RuntimeError):
    """A frame could not be decoded for measurement."""


class CropColourDeadline(CropColourError):
    """The request's deadline passed before every frame was decoded."""


@dataclass(frozen=True)
class CropBox:
    """A detection box on one frame: normalised ``x, y, width, height`` at ``time_seconds``."""

    time_seconds: float
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class CropColour:
    """What one crop's centre-weighted pixels measure.

    ``neutral_lightness`` is ``None`` when no weighted pixel is neutral.
    """

    neutral_share: float
    neutral_lightness: float | None
    lightness: float
    chroma: float
    pixels: int


def srgb_to_lab(rgb: npt.NDArray[np.uint8]) -> tuple[FloatArray, FloatArray, FloatArray]:
    """CIELAB (D65) of 8-bit sRGB pixels: ``(L*, a*, b*)`` arrays shaped like ``rgb[..., 0]``."""
    unit = rgb.astype(np.float64) / 255.0
    linear = np.where(unit <= 0.04045, unit / 12.92, ((unit + 0.055) / 1.055) ** 2.4)
    xyz = (linear @ _RGB_TO_XYZ.T) / _D65
    f = np.where(xyz > _LAB_EPSILON, np.cbrt(xyz), xyz / (3 * (6.0 / 29.0) ** 2) + 4.0 / 29.0)
    lightness = 116.0 * f[..., 1] - 16.0
    return lightness, 500.0 * (f[..., 0] - f[..., 1]), 200.0 * (f[..., 1] - f[..., 2])


def centre_weights(height: int, width: int) -> FloatArray:
    """``(1 - (u² + v²))²`` over the box (u, v in -1..1 at pixel centres), 0 outside the ellipse.

    1 at the centre, 0 on the inscribed ellipse and in the corners, where a box holds background;
    squared so the middle of the object outweighs its rim.
    """
    v = (np.arange(height) + 0.5) / height * 2.0 - 1.0
    u = (np.arange(width) + 0.5) / width * 2.0 - 1.0
    weights: FloatArray = np.clip(1.0 - (u[None, :] ** 2 + v[:, None] ** 2), 0.0, None) ** 2
    return weights


def _weighted_median(values: FloatArray, weights: FloatArray) -> float:
    order = np.argsort(values, kind="stable")
    cumulative = np.cumsum(weights[order])
    return float(values[order][np.searchsorted(cumulative, cumulative[-1] / 2.0)])


def dominant_tone(lightness: FloatArray, weights: FloatArray) -> float:
    """The object's dominant neutral lightness: the weighted median L* of the pixels within
    :data:`DOMINANT_TONE_BAND` of the densest tone.

    The densest tone is the weighted median of the heaviest window of ``2 x`` the band on a
    lightness histogram, so it is always a lightness some pixel has.
    """
    edges = np.arange(0.0, 100.0 + 2 * _TONE_BIN, _TONE_BIN)
    histogram, _ = np.histogram(np.clip(lightness, 0.0, 100.0), bins=edges, weights=weights)
    reach = int(DOMINANT_TONE_BAND / _TONE_BIN)
    density = np.convolve(histogram, np.ones(2 * reach + 1), mode="same")
    centre = float(edges[int(np.argmax(density))] + _TONE_BIN / 2)
    window = np.abs(lightness - centre) <= DOMINANT_TONE_BAND + _TONE_BIN
    peak = _weighted_median(lightness[window], weights[window])
    near = np.abs(lightness - peak) <= DOMINANT_TONE_BAND
    return _weighted_median(lightness[near], weights[near])


def _pixel_bounds(extent: int, start: float, size: float) -> tuple[int, int]:
    first = min(max(round(start * extent), 0), extent)
    last = min(max(round((start + size) * extent), first), extent)
    return first, last


def measure_crop(frame: npt.NDArray[np.uint8], box: CropBox) -> CropColour | None:
    """Measure one box on a decoded ``H x W x 3`` rgb24 frame, or ``None`` when it is too small.

    :param frame: The frame as the export decodes it.
    :param box: The detection box, normalised to the frame.
    """
    height, width = frame.shape[:2]
    top, bottom = _pixel_bounds(height, box.y, box.height)
    left, right = _pixel_bounds(width, box.x, box.width)
    crop = frame[top:bottom, left:right]
    if crop.size == 0:
        return None
    weights = centre_weights(*crop.shape[:2]).ravel()
    inside = weights > 0
    if int(inside.sum()) < MIN_WEIGHTED_PIXELS:
        return None
    lightness, a, b = (channel.ravel()[inside] for channel in srgb_to_lab(crop))
    weights = weights[inside]
    chroma = np.hypot(a, b)
    neutral = chroma < NEUTRAL_PIXEL_CHROMA
    return CropColour(
        neutral_share=float(weights[neutral].sum() / weights.sum()),
        neutral_lightness=(
            dominant_tone(lightness[neutral], weights[neutral]) if neutral.any() else None
        ),
        lightness=_weighted_median(lightness, weights),
        chroma=_weighted_median(chroma, weights),
        pixels=int(inside.sum()),
    )


def _remaining(deadline: float | None) -> float:
    if deadline is None:
        return DECODE_TIMEOUT_SECONDS
    left = deadline - time.monotonic()
    if left <= 0:
        raise CropColourDeadline("The colour measurement ran out of time.")
    return min(DECODE_TIMEOUT_SECONDS, left)


def _parse_ppm(data: bytes) -> npt.NDArray[np.uint8]:
    """A binary PPM (``P6``, maxval 255) as ``H x W x 3``: the header carries the decoded size,
    so an autorotated or anamorphic source needs no separate probe."""
    fields: list[bytes] = []
    position = 0
    while len(fields) < 4:
        while position < len(data) and data[position : position + 1].isspace():
            position += 1
        end = position
        while end < len(data) and not data[end : end + 1].isspace():
            end += 1
        if end == position:
            raise CropColourError("The decoded frame has no picture header.")
        fields.append(data[position:end])
        position = end
    magic, width, height, maxval = fields
    if magic != _PPM_MAGIC or maxval != b"255" or not width.isdigit() or not height.isdigit():
        raise CropColourError("The decoded frame is not 8-bit RGB.")
    columns, rows = int(width), int(height)
    pixels = data[position + 1 : position + 1 + columns * rows * 3]
    if len(pixels) != columns * rows * 3:
        raise CropColourError("The decoded frame is truncated.")
    return np.frombuffer(pixels, dtype=np.uint8).reshape(rows, columns, 3)


def decode_frame(
    path: Path, time_seconds: float, fps: float, deadline: float | None = None
) -> npt.NDArray[np.uint8]:
    """The frame shown at source second ``time_seconds``, as the export decodes it.

    Input seeking discards every frame before the seek point, so the seek goes half a frame
    early: the frame whose pts is ``time_seconds`` is the first one kept.

    :raises CropColourError: When ffmpeg returns no frame.
    """
    seek = max(0.0, time_seconds - 0.5 / fps)
    argv = validate_safe_argv(
        [
            find_export_ffmpeg(),
            "-nostdin",
            "-loglevel",
            "error",
            "-ss",
            f"{seek:.6f}",
            *bounded_decode_input_options(),
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vf",
            "scale=iw:ih",
            "-sws_flags",
            "bicubic",
            "-pix_fmt",
            "rgb24",
            "-vcodec",
            "ppm",
            "-",
        ]
    )
    try:
        completed = subprocess.run(
            argv, capture_output=True, check=False, timeout=_remaining(deadline)
        )
    except subprocess.TimeoutExpired as exc:
        raise CropColourDeadline(f"Decoding {path.name} ran out of time.") from exc
    if completed.returncode != 0 or not completed.stdout:
        raise CropColourError(f"{path.name} has no frame at {time_seconds:.3f}s.")
    return _parse_ppm(completed.stdout)


def measure_crops(
    path: Path, fps: float, boxes: Sequence[CropBox], deadline: float | None = None
) -> list[CropColour | None]:
    """Measure every box, decoding each distinct frame once.

    :param path: The source media, already inside the sandbox.
    :param fps: The asset's frame rate (for the half-frame seek).
    :param boxes: At most :data:`MAX_CROPS` boxes.
    :returns: One measurement per box, in order; ``None`` for a box too small to measure.
    :raises ValueError: For too many boxes or a non-positive frame rate.
    :raises CropColourError: When a frame cannot be decoded.
    """
    if len(boxes) > MAX_CROPS:
        raise ValueError(f"At most {MAX_CROPS} crops are measured per request.")
    if not fps > 0:
        raise ValueError("The frame rate must be positive.")
    frames: dict[float, npt.NDArray[np.uint8]] = {}
    measured: list[CropColour | None] = []
    for box in boxes:
        if box.time_seconds not in frames:
            frames[box.time_seconds] = decode_frame(path, box.time_seconds, fps, deadline)
        measured.append(measure_crop(frames[box.time_seconds], box))
    _log.info("ACT crop colours measured: crops=%d frames=%d", len(boxes), len(frames))
    return measured
