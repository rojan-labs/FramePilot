"""Stage 7: fractional alpha in the unknown band at full source resolution.

Stage 4 already runs at or above source resolution when the subject crop fits one tile (or was
tiled). When the crop was *shrunk* into a tile (up to 1.5×), the band's alpha is below source
resolution, so BiRefNet runs again on full-resolution tiles centred on the band, blended with
the same partition-of-unity ramps, and only band pixels take the result. Outside the band
alpha stays exactly 0 or 255 (plan 02: no second matting model to disagree with).
"""

from __future__ import annotations

from typing import Any, Final

import cv2
import numpy as np
import numpy.typing as npt

from .backend import MattingModel
from .refine import TILE_OVERLAP_FRACTION, RefineRecord, blend_weight

Bool = npt.NDArray[np.bool_]
#: Band pixels already covered by a tile's inner region need no further tile.
_INNER_MARGIN_FRACTION: Final = TILE_OVERLAP_FRACTION


def tile_origins(band: Bool, tile: int) -> list[tuple[int, int]]:
    """Greedy tile placement: each tile centred on the first still-uncovered band pixel."""
    height, width = band.shape
    remaining = band.copy()
    margin = int(tile * _INNER_MARGIN_FRACTION)
    origins: list[tuple[int, int]] = []
    while True:
        ys, xs = np.nonzero(remaining)
        if len(xs) == 0:
            return origins
        y, x = int(ys[0]), int(xs[0])
        top = int(np.clip(y - tile // 2, 0, max(height - tile, 0)))
        left = int(np.clip(x - tile // 2, 0, max(width - tile, 0)))
        origins.append((top, left))
        inner_top, inner_left = (top + margin if top > 0 else 0), (left + margin if left > 0 else 0)
        inner_bottom = top + tile - margin if top + tile < height else height
        inner_right = left + tile - margin if left + tile < width else width
        before = int(remaining.sum())
        remaining[inner_top:inner_bottom, inner_left:inner_right] = False
        if (
            int(remaining.sum()) == before
        ):  # pragma: no cover - defensive; a tile always covers its centre
            remaining[y, x] = False


def band_alpha(
    model: MattingModel,
    frame: npt.NDArray[np.uint8],
    alpha: npt.NDArray[np.uint8],
    band: Bool,
    record: RefineRecord,
) -> tuple[npt.NDArray[np.uint8], int]:
    """Return ``alpha`` with band pixels from full-resolution tiles, and the passes run."""
    if not record.downscaled or not band.any():
        return alpha, 0
    tile = model.tile
    height, width = band.shape
    pad_h, pad_w = max(tile - height, 0), max(tile - width, 0)
    source: Any = (
        cv2.copyMakeBorder(frame, 0, pad_h, 0, pad_w, cv2.BORDER_REFLECT)
        if pad_h or pad_w
        else frame
    )
    weight = blend_weight(tile, int(tile * TILE_OVERLAP_FRACTION))
    accumulated = np.zeros(source.shape[:2], np.float32)
    weights = np.zeros(source.shape[:2], np.float32)
    origins = tile_origins(band, tile)
    for top, left in origins:
        accumulated[top : top + tile, left : left + tile] += (
            model.predict(source[top : top + tile, left : left + tile]) * weight
        )
        weights[top : top + tile, left : left + tile] += weight
    full = (accumulated / np.maximum(weights, 1e-6))[:height, :width]
    out = alpha.copy()
    covered = band & (weights[:height, :width] > 0)
    out[covered] = np.clip(np.round(full[covered] * 255.0), 0, 255).astype(np.uint8)
    return out, len(origins)


__all__ = ["band_alpha", "tile_origins"]
