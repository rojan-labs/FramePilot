"""Text and caption rasters for the desktop program monitor (PX2.3).

WHY: the export rasterises text with Pillow's FreeType path (TrueType hinting, its own coverage).
A browser canvas draws the same font unhinted, so glyph edges differ by more than the parity
gates allow even when the layout is exact. On the desktop the monitor therefore asks the engine
for the raster itself, through the SAME calls the compiler makes, and does only placement,
transform, opacity and blending on the GPU. Nothing here opens media or MoviePy.

The raster is returned as Pillow stores it (straight RGBA, colour blended into the transparent
background channel by channel), not premultiplied: the compositor's integer composite consumes
exactly those bytes, and premultiplying would round them away.
"""

from __future__ import annotations

import base64
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

from framepilot_engine.render.captions import render_caption_image
from framepilot_engine.render.text_overlay import rasterize_text_overlay

#: Largest output frame edge the route rasterises for (the export's own 8K ceiling).
MAX_FRAME_EDGE = 8192
#: Longest text accepted; a caption cue or title card is far shorter.
MAX_TEXT_LENGTH = 2000


class PreviewTextError(ValueError):
    """The request cannot be rasterised (empty text, bad frame size)."""


@dataclass(frozen=True)
class PreviewTextRaster:
    """An RGBA raster and, for a caption, the paste position the export uses."""

    rgba: np.ndarray
    x: int | None
    y: int | None

    @property
    def width(self) -> int:
        return int(self.rgba.shape[1])

    @property
    def height(self) -> int:
        return int(self.rgba.shape[0])

    def base64(self) -> str:
        return base64.b64encode(np.ascontiguousarray(self.rgba, dtype=np.uint8).tobytes()).decode(
            "ascii"
        )


def _check_frame(frame_width: int, frame_height: int) -> None:
    if not (0 < frame_width <= MAX_FRAME_EDGE and 0 < frame_height <= MAX_FRAME_EDGE):
        raise PreviewTextError(
            f"Frame size {frame_width}x{frame_height} is outside 1..{MAX_FRAME_EDGE} pixels."
        )


def _check_text(text: str) -> None:
    if not text.strip():
        raise PreviewTextError("Text is empty.")
    if len(text) > MAX_TEXT_LENGTH:
        raise PreviewTextError(f"Text is longer than {MAX_TEXT_LENGTH} characters.")


def text_overlay_raster(
    params: Mapping[str, Any], frame_width: int, frame_height: int
) -> PreviewTextRaster:
    """A text clip's raster (its ``text`` effect params) for a ``frame_width`` x ``frame_height``
    output. Placement stays with the frame plan: the layer is centred at ``xPercent/yPercent``
    and transformed like any picture.

    :raises PreviewTextError: If the text is empty or too long, or the frame size is invalid.
    """
    _check_frame(frame_width, frame_height)
    raw = params.get("text")
    text = "" if raw is None else str(raw)
    _check_text(text)
    rgba = rasterize_text_overlay(text, params, frame_width, frame_height)
    return PreviewTextRaster(rgba=rgba, x=None, y=None)


def baseline_caption_raster(text: str, frame_width: int, frame_height: int) -> PreviewTextRaster:
    """An unstyled burned caption's raster and paste position.

    :raises PreviewTextError: If the text is empty or too long, or the frame size is invalid.
    """
    from framepilot_engine.render.compiler import baseline_caption_position

    _check_frame(frame_width, frame_height)
    _check_text(text)
    rgba = render_caption_image(text, frame_width, frame_height)
    x, y = baseline_caption_position(frame_width, frame_height, rgba.shape[1], rgba.shape[0])
    return PreviewTextRaster(rgba=rgba, x=x, y=y)
