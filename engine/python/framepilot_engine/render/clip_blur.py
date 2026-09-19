"""The clip ``blur`` picture effect: a Gaussian blur a clip mask can limit (plan 10, MK5).

Why it exists: plan 10 makes every clip effect a mask target ("face blur, sky grade"), but until
this effect the only clip picture effects were ``color_grade`` and ``lut``; a blur lived only on
an adjustment lane, whose masks are fixed to the frame and cannot follow a track. A face blur that
slides off the face is a privacy failure, so the blur has to be a CLIP effect, where the clip's
own mask stack (tracked, keyframed, matte) limits it.

``params.amount`` is the blur radius as a fraction of the smaller side of the picture the effect
runs on, not pixels: the export decodes a clip either at its native size or straight to its
placed size (``compile_timeline``'s static fit), and the preview mirrors whichever it was. A
fraction gives the same look on both and at every export resolution.

The blur is Pillow's ``GaussianBlur``, the one the transition blur already uses, which the
preview compositor reproduces exactly (``pilGaussianBlur``).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

import numpy as np
from PIL import Image, ImageFilter

#: The effect type a clip stores (mirrors ``CLIP_BLUR_EFFECT_TYPE`` in editor-core).
CLIP_BLUR_EFFECT_TYPE: Final = "blur"

#: The strongest blur a clip may carry: a quarter of the smaller side already erases a face.
MAX_CLIP_BLUR_AMOUNT: Final = 0.25


def clip_blur_amount(params: Mapping[str, Any]) -> float:
    """The effect's ``amount``, clamped to ``[0, MAX_CLIP_BLUR_AMOUNT]`` (0 when missing or bad)."""
    raw = params.get("amount")
    if isinstance(raw, bool) or not isinstance(raw, int | float):
        return 0.0
    amount = float(raw)
    if not np.isfinite(amount):
        return 0.0
    return min(MAX_CLIP_BLUR_AMOUNT, max(0.0, amount))


def clip_blur_radius(params: Mapping[str, Any], width: int, height: int) -> float:
    """The Gaussian radius in pixels for a ``width`` x ``height`` picture."""
    return clip_blur_amount(params) * float(min(width, height))


def apply_clip_blur(frame: np.ndarray, params: Mapping[str, Any]) -> np.ndarray:
    """Blur a ``uint8`` ``HxWxC`` frame by the effect's ``amount``; a zero amount is a no-op."""
    height, width = int(frame.shape[0]), int(frame.shape[1])
    radius = clip_blur_radius(params, width, height)
    if radius <= 0.0:
        return frame
    image = Image.fromarray(np.asarray(frame, dtype=np.uint8))
    return np.asarray(image.filter(ImageFilter.GaussianBlur(radius)))
