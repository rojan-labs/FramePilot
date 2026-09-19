"""Cut-out edge styles: stroke/outline, outer glow and drop shadow (MK9.2, plan 10).

WHY: a subject cut out by a clip's mask stack (a background removal, a drawn shape, a key) is the
input to the look editors reach for next: the CapCut sticker outline, a glow, a shadow that lifts
it off the background. These are catalog entries (``effect_catalog.json`` ``edgeStyles``) stored as
clip effects of type ``edge_style`` that READ the clip's alpha-target mask stack and draw outside
it. No new mask kind: the stack already says where the subject is.

**The rule** (the preview's edge passes in ``layer-compositor.ts`` run the same one on the GPU):

1. The cut-out is where the stack alpha is at least one half, per pixel of the clip's raster.
2. ``d`` is the exact Euclidean distance, in raster pixels between pixel centres, from a pixel to
   the nearest cut-out pixel (0 inside). It is found by a separable search bounded by the style's
   reach ``R``: per row the nearest cut-out column (``g``), then per column
   ``min over |dy| <= R of g(y + dy)^2 + dy^2``. Integer arithmetic until one ``sqrt``, so it is
   exact wherever ``d <= R`` and "far" beyond, the same numbers on both sides.
3. Style alpha: stroke ``clamp(w + 0.5 - d, 0, 1)``; glow and shadow ``(1 - t)^2`` for
   ``t = d / (r + 1) < 1`` (a polynomial: no ``exp`` in a per-pixel path). A shadow measures ``d``
   from the cut-out moved by its offset, rounded half-to-even to whole raster pixels.
4. Times the style's opacity and the clip's opacity at the instant. Styles stack shadow, glow,
   stroke (bottom to top) in premultiplied colour, and the picture goes over them.

Lengths are display-corrected SOURCE pixels, like a mask's, scaled onto the raster by the mask
mapping's distance scale, so an outline keeps its look at any decode size. The styles draw inside
the clip's picture bounds: a glow or shadow reaching past the picture's edge is clipped there.

Cost: two passes over the cut-out's bounding box grown by ``R``, the second ``2R + 1`` array
operations; a static stack is drawn once and reused (see ``compiler._apply_edge_styles``).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt

from framepilot_engine.render.effect_catalog import (
    clamp_edge_style_params,
    edge_style_kinds,
    edge_style_params_issue,
)
from framepilot_engine.render.mask_raster import FloatArray

_log = logging.getLogger(__name__)

#: The ``Effect.type`` an edge style is stored under on a clip.
EDGE_STYLE_EFFECT_TYPE = "edge_style"

#: A stack alpha at or above this is the cut-out the styles are drawn around.
INSIDE_THRESHOLD = 0.5

#: "No cut-out pixel in this row": larger than any reach, small enough to square in int64.
_NONE = 1 << 30

BoolArray = npt.NDArray[np.bool_]


class EdgeStyleRefusal(ValueError):
    """An edge style the export cannot draw; the message says what to do (no varying numbers)."""


@dataclass(frozen=True)
class EdgeStyle:
    """One edge style: its kind and its clamped params (source pixels, 0-255 colour)."""

    kind: str
    params: dict[str, float]

    def extent(self, scale: float) -> float:
        """How far the style reaches past the cut-out, raster pixels (before rounding up)."""
        if self.kind == "stroke":
            return self.params["widthPx"] * scale + 0.5
        if self.kind == "glow":
            return self.params["radiusPx"] * scale + 1.0
        return self.params["softnessPx"] * scale + 1.0

    def reach(self, scale: float) -> int:
        """The distance search bound ``R``: every pixel the style can touch is within it."""
        return max(1, math.ceil(self.extent(scale)))

    def shift(self, scale: float) -> tuple[int, int]:
        """A shadow's offset in whole raster pixels (round half to even); ``(0, 0)`` otherwise."""
        if self.kind != "shadow":
            return (0, 0)
        return (
            int(np.rint(self.params["offsetXPx"] * scale)),
            int(np.rint(self.params["offsetYPx"] * scale)),
        )

    def colour(self) -> npt.NDArray[np.float64]:
        return (
            np.array(
                [self.params["red"], self.params["green"], self.params["blue"]], dtype=np.float64
            )
            / 255.0
        )


def clip_edge_styles(clip: Any) -> tuple[EdgeStyle, ...]:
    """A clip's edge styles in stacking order (bottom first); the first of each kind counts.

    :raises EdgeStyleRefusal: When a stored style is malformed (the validator refuses it too).
    """
    by_kind: dict[str, EdgeStyle] = {}
    for effect in clip.effects:
        if effect.type != EDGE_STYLE_EFFECT_TYPE:
            continue
        issue = edge_style_params_issue(effect.params)
        if issue is not None:
            raise EdgeStyleRefusal(f"Edge style {effect.id!r} on clip {clip.id!r}: {issue}")
        kind = str(effect.params["kind"])
        by_kind.setdefault(kind, EdgeStyle(kind, clamp_edge_style_params(kind, effect.params)))
    return tuple(by_kind[kind] for kind in edge_style_kinds() if kind in by_kind)


def edge_distance_scale(
    clip: Any, media_size: tuple[float, float], width: int, height: int
) -> float:
    """Raster pixels per display-corrected source pixel: the mask mapping's distance scale."""
    crop = clip.crop
    crop_w, crop_h = (crop.width, crop.height) if crop is not None else (1.0, 1.0)
    return min(width / (crop_w * float(media_size[0])), height / (crop_h * float(media_size[1])))


def shifted(inside: BoolArray, dx: int, dy: int) -> BoolArray:
    """``inside`` moved by ``(dx, dy)`` pixels; what moves off the raster is gone."""
    height, width = inside.shape
    out = np.zeros_like(inside)
    if abs(dx) >= width or abs(dy) >= height:
        return out
    src_y = slice(max(0, -dy), height - max(0, dy))
    src_x = slice(max(0, -dx), width - max(0, dx))
    dst_y = slice(max(0, dy), height - max(0, -dy))
    dst_x = slice(max(0, dx), width - max(0, -dx))
    out[dst_y, dst_x] = inside[src_y, src_x]
    return out


def distance_field(inside: BoolArray, reach: int) -> FloatArray:
    """Exact Euclidean distance to the nearest ``inside`` pixel where ``<= reach``, inf beyond.

    Separable and bounded (see the module docstring): the row pass finds the nearest cut-out
    column with running max/min indices (exact, unbounded), the column pass takes the minimum of
    ``g^2 + dy^2`` over ``|dy| <= reach``. Work is limited to the cut-out's bounding box grown by
    ``reach``, since nothing further away can be within reach.
    """
    height, width = inside.shape
    out = np.full((height, width), np.inf, dtype=np.float64)
    rows = np.flatnonzero(inside.any(axis=1))
    if rows.size == 0:
        return out
    cols = np.flatnonzero(inside.any(axis=0))
    y0, y1 = max(0, int(rows[0]) - reach), min(height, int(rows[-1]) + reach + 1)
    x0, x1 = max(0, int(cols[0]) - reach), min(width, int(cols[-1]) + reach + 1)
    sub = inside[y0:y1, x0:x1]
    sub_h, sub_w = sub.shape
    index = np.arange(sub_w, dtype=np.int64)
    left = np.maximum.accumulate(np.where(sub, index, -_NONE), axis=1)
    right = np.minimum.accumulate(np.where(sub, index, _NONE)[:, ::-1], axis=1)[:, ::-1]
    beyond = reach + 1
    g = np.minimum(np.minimum(index - left, right - index), beyond)
    g2 = g * g
    padded = np.full((sub_h + 2 * reach, sub_w), beyond * beyond, dtype=np.int64)
    padded[reach : reach + sub_h] = g2
    best = np.full((sub_h, sub_w), 2 * beyond * beyond, dtype=np.int64)
    for dy in range(-reach, reach + 1):
        np.minimum(best, padded[reach + dy : reach + dy + sub_h] + dy * dy, out=best)
    within = best <= reach * reach
    out[y0:y1, x0:x1] = np.where(within, np.sqrt(best.astype(np.float64)), np.inf)
    return out


def style_alpha(style: EdgeStyle, distance: FloatArray, scale: float) -> FloatArray:
    """One style's coverage from the distance field, times its own opacity."""
    if style.kind == "stroke":
        width = style.params["widthPx"] * scale
        alpha = np.clip(width + 0.5 - distance, 0.0, 1.0)
    else:
        radius = style.params["radiusPx" if style.kind == "glow" else "softnessPx"] * scale
        t = distance / (radius + 1.0)
        falling = 1.0 - np.minimum(t, 1.0)
        alpha = falling * falling
    return np.asarray(alpha * style.params["opacity"], dtype=np.float64)


def apply_edge_styles(
    rgb: npt.NDArray[np.uint8],
    alpha: FloatArray,
    stack_alpha: FloatArray,
    styles: tuple[EdgeStyle, ...],
    scale: float,
    opacity: float,
) -> tuple[npt.NDArray[np.uint8], FloatArray]:
    """The clip's picture over its edge styles: new straight RGB and alpha.

    :param rgb: The clip's picture on its raster (straight colour).
    :param alpha: Its alpha as attached (stack, opacity and any wipe).
    :param stack_alpha: The alpha-target mask stack alone: the cut-out the styles trace.
    :param styles: From :func:`clip_edge_styles`, bottom first.
    :param scale: Raster pixels per source pixel (:func:`edge_distance_scale`).
    :param opacity: The clip's opacity at this instant, which fades the styles with the clip.
    """
    inside = np.asarray(stack_alpha, dtype=np.float64) >= INSIDE_THRESHOLD
    height, width = inside.shape
    styled_colour = np.zeros((height, width, 3), dtype=np.float64)
    styled_alpha = np.zeros((height, width), dtype=np.float64)
    clip_opacity = min(max(float(opacity), 0.0), 1.0)
    for style in styles:
        dx, dy = style.shift(scale)
        source = shifted(inside, dx, dy) if (dx, dy) != (0, 0) else inside
        coverage = style_alpha(style, distance_field(source, style.reach(scale)), scale)
        coverage = coverage * clip_opacity
        keep = 1.0 - coverage
        styled_colour = style.colour() * coverage[:, :, None] + styled_colour * keep[:, :, None]
        styled_alpha = coverage + styled_alpha * keep
    picture = np.asarray(rgb, dtype=np.float64)[:, :, :3] / 255.0
    base = np.clip(np.asarray(alpha, dtype=np.float64), 0.0, 1.0)
    under = 1.0 - base
    out_alpha = base + styled_alpha * under
    premultiplied = picture * base[:, :, None] + styled_colour * under[:, :, None]
    safe = np.where(out_alpha > 0.0, out_alpha, 1.0)
    colour = np.where(out_alpha[:, :, None] > 0.0, premultiplied / safe[:, :, None], 0.0)
    out_rgb = np.clip(np.rint(colour * 255.0), 0, 255).astype(np.uint8)
    return out_rgb, out_alpha


__all__ = [
    "EDGE_STYLE_EFFECT_TYPE",
    "INSIDE_THRESHOLD",
    "EdgeStyle",
    "EdgeStyleRefusal",
    "apply_edge_styles",
    "clip_edge_styles",
    "distance_field",
    "edge_distance_scale",
    "shifted",
    "style_alpha",
]
