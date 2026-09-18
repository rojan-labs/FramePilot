"""Stage 4: BiRefNet_HR-matting on the subject, in tiles, guided by the SAM estimates.

The model has no notion of *which* object: it mattes whatever is salient in the crop. So it
only ever sees a padded square crop around the union of SAM's estimates, and its alpha is
zeroed outside a dilation of that union — it can sharpen the subject's edge, never switch
subjects (plan 02 stage 4).

A crop no larger than ``RESIZE_UP_TO`` × the tile is resized into one pass; a larger crop is
tiled at full source resolution with overlap and blended with a partition of unity.

**Tile size** is configurable. By default it is the largest installed tile whose measured
session footprint fits the job's memory ceiling beside the pipeline's baseline; the choice
and why are recorded in report.json. BR0.7 footprints on the CPU EP: 768² 3.8 GB, 1024²
6.2–6.9 GB, 2048² above 12 GB (not completed inside an 8 GB budget).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

from .backend import BackendUnavailableError, MattingModel

_log = logging.getLogger(__name__)

GIB: Final = 1024**3
#: Measured peak session footprint per tile size (BR0.7). 2048 is a lower bound.
TILE_FOOTPRINT_BYTES: Final = {768: int(3.8 * GIB), 1024: int(6.9 * GIB), 2048: int(12.5 * GIB)}
#: What the rest of a job holds while BiRefNet runs (frames page cache, alphas, flow).
PIPELINE_BASELINE_BYTES: Final = int(0.8 * GIB)
RESIZE_UP_TO: Final = 1.5
CROP_PAD: Final = 0.2
CROP_MARGIN_PX: Final = 32
TILE_OVERLAP_FRACTION: Final = 0.125
GATE_DILATE_FRACTION: Final = 0.03
GATE_MIN_PX: Final = 8

Float = npt.NDArray[Any]


@dataclass(frozen=True, slots=True)
class TileChoice:
    size: int
    reason: str
    ceiling_bytes: int

    def as_json(self) -> dict[str, Any]:
        return {"size": self.size, "reason": self.reason, "ceilingBytes": self.ceiling_bytes}


def choose_tile(
    installed: tuple[int, ...], ceiling_bytes: int, configured: int | None = None
) -> TileChoice:
    """Configured size if installed; else the largest tile that fits the ceiling.

    :raises BackendUnavailableError: Nothing installed, a configured size is missing, or no
        installed tile fits the ceiling (running anyway would repeat BR0's memory incidents).
    """
    if not installed:
        raise BackendUnavailableError("no BiRefNet_HR-matting tile graph is installed.")
    if configured is not None:
        if configured not in installed:
            raise BackendUnavailableError(
                f"the configured matting tile {configured} is not installed."
            )
        return TileChoice(configured, "configured", ceiling_bytes)
    fitting = [
        size
        for size in installed
        if TILE_FOOTPRINT_BYTES.get(size, 2**62) + PIPELINE_BASELINE_BYTES <= ceiling_bytes
    ]
    if not fitting:
        raise BackendUnavailableError(
            "no installed matting tile fits this job's memory ceiling; "
            "the machine is below the minimum hardware."
        )
    size = max(fitting)
    return TileChoice(size, "largest installed tile within the memory ceiling", ceiling_bytes)


def tiles_1d(length: int, tile: int, overlap: int) -> list[int]:
    """Start offsets covering ``[0, length)`` with tiles overlapping by at least ``overlap``."""
    if length <= tile:
        return [0]
    step = tile - overlap
    starts = list(range(0, length - tile, step))
    starts.append(length - tile)
    return starts


def blend_weight(tile: int, overlap: int) -> Float:
    """Separable ramps; overlapping tiles sum to a partition of unity after normalisation."""
    ramp = np.ones(tile, np.float32)
    if overlap > 0:
        rise = (np.arange(overlap, dtype=np.float32) + 0.5) / overlap
        ramp[:overlap] = rise
        ramp[-overlap:] = rise[::-1]
    weights: Float = np.outer(ramp, ramp)
    return weights


def square_crop(mask: npt.NDArray[np.bool_]) -> tuple[int, int, int, int]:
    """``(left, top, width, height)`` of a padded square around the mask, clipped to the frame."""
    height, width = mask.shape
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return 0, 0, 0, 0
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    side = int(max(x1 - x0, y1 - y0) * (1 + 2 * CROP_PAD)) + CROP_MARGIN_PX
    crop_w, crop_h = min(side, width), min(side, height)
    left = int(np.clip((x0 + x1) // 2 - crop_w // 2, 0, width - crop_w))
    top = int(np.clip((y0 + y1) // 2 - crop_h // 2, 0, height - crop_h))
    return left, top, crop_w, crop_h


@dataclass(frozen=True, slots=True)
class RefineRecord:
    crop: tuple[int, int, int, int]
    mode: str  # "empty" | "resized" | "tiled"
    passes: int
    #: The tile the crop was matted at (0 when unknown: treated as "any size was shrunk").
    tile: int = 0

    @property
    def downscaled(self) -> bool:
        """The crop was SHRUNK into one tile; stage 7 redoes its edges at source resolution.

        BR7.4: a crop no larger than the tile was matted at or above source resolution, so it
        needs no second pass. Before, any resized crop counted, and at the trained 2048² tile
        every 720p/1080p frame got a second BiRefNet pass over the whole reflect-padded frame
        (outside the subject crop), which scored below the crop pass on the band (BR7.4 it0).
        """
        side = max(self.crop[2], self.crop[3])
        return self.mode == "resized" and side > self.tile


def matte_region(model: MattingModel, crop: npt.NDArray[np.uint8]) -> tuple[Float, str, int]:
    """Alpha for a crop: one resized pass when it fits, else overlapping full-resolution tiles."""
    tile = model.tile
    crop_h, crop_w = crop.shape[:2]
    if max(crop_h, crop_w) <= RESIZE_UP_TO * tile:
        resized = cv2.resize(crop, (tile, tile), interpolation=cv2.INTER_CUBIC)
        alpha: Float = cv2.resize(
            model.predict(resized), (crop_w, crop_h), interpolation=cv2.INTER_LINEAR
        )
        return np.clip(alpha, 0.0, 1.0), "resized", 1
    pad_h, pad_w = max(tile - crop_h, 0), max(tile - crop_w, 0)
    source = (
        cv2.copyMakeBorder(crop, 0, pad_h, 0, pad_w, cv2.BORDER_REFLECT) if pad_h or pad_w else crop
    )
    overlap = int(tile * TILE_OVERLAP_FRACTION)
    weight = blend_weight(tile, overlap)
    accumulated = np.zeros(source.shape[:2], np.float32)
    weights = np.zeros(source.shape[:2], np.float32)
    passes = 0
    for y in tiles_1d(source.shape[0], tile, overlap):
        for x in tiles_1d(source.shape[1], tile, overlap):
            accumulated[y : y + tile, x : x + tile] += (
                model.predict(source[y : y + tile, x : x + tile]) * weight
            )
            weights[y : y + tile, x : x + tile] += weight
            passes += 1
    blended: Float = (accumulated / np.maximum(weights, 1e-6))[:crop_h, :crop_w]
    return np.clip(blended, 0.0, 1.0), "tiled", passes


def refine_frame(
    model: MattingModel, frame: npt.NDArray[np.uint8], sam_union: npt.NDArray[np.bool_]
) -> tuple[npt.NDArray[np.uint8], RefineRecord]:
    """BiRefNet alpha (uint8, full frame) gated to the dilated SAM union."""
    height, width = sam_union.shape
    alpha = np.zeros((height, width), np.uint8)
    left, top, crop_w, crop_h = square_crop(sam_union)
    if crop_w == 0:
        return alpha, RefineRecord((0, 0, 0, 0), "empty", 0)
    region, mode, passes = matte_region(model, frame[top : top + crop_h, left : left + crop_w])
    radius = max(GATE_MIN_PX, int(GATE_DILATE_FRACTION * max(crop_w, crop_h)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    gate = cv2.dilate(
        sam_union[top : top + crop_h, left : left + crop_w].astype(np.uint8), kernel
    ).astype(bool)
    alpha[top : top + crop_h, left : left + crop_w] = np.clip(
        np.round(region * gate * 255.0), 0, 255
    ).astype(np.uint8)
    return alpha, RefineRecord((left, top, crop_w, crop_h), mode, passes, model.tile)


__all__ = [
    "TILE_FOOTPRINT_BYTES",
    "RefineRecord",
    "TileChoice",
    "blend_weight",
    "choose_tile",
    "matte_region",
    "refine_frame",
    "square_crop",
    "tiles_1d",
]
