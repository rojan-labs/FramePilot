"""Text-overlay burn-in rasterization (render-vs-preview honesty fix).

WHY: ``add_text_overlay`` stores a synthetic clip (``asset_id == "__text__"``)
carrying a single ``text`` effect whose ``params`` hold the authored ``text``
(see ``packages/editor-core/src/operations.ts::applyAddTextOverlay`` and its
Python mirror ``timeline/operations.py::_apply_add_text_overlay``). That op
**validates and applies** today — it lands in the timeline and survives
save/undo — but the compiler used to skip clips of kind ``"text"`` entirely, so
the overlay never appeared in a render: an edit that "applies" but silently
doesn't render, which violates the "never fake success" invariant (AGENTS.md
§0, CLAUDE.md).

The authoring vocabulary is :data:`TextOverlayParams` in
``apps/web-editor/src/editor/patch-builders-base.ts`` — the same keys the
Inspector writes, the preview reads, and ``add_text_layer`` now sets. This module
resolves them for the render, so what the preview shows is what exports:

* ``fontSizePercent`` — glyph height as a percentage of the FRAME height, which
  is what the preview's ``cqh`` unit means. (Legacy ``fontSize`` in pixels is
  still honored; it predates the percentage and some stored projects carry it.)
* ``color`` — ``#rrggbb`` / ``#rrggbbaa``.
* ``align`` — ``left`` / ``center`` / ``right`` within the text box.
* ``boxWidthPercent`` — the wrap width, as a percentage of frame width.
* ``xPercent`` / ``yPercent`` — the box CENTRE, as a percentage of each axis with
  the origin top-left (the preview anchors with ``translate(-50%, -50%)``).
* ``background`` — an optional filled box behind the text.

Position is applied by the compiler (it owns placement); everything else is
resolved and drawn here.

WHAT IS NOT HERE YET: ``inAnimation`` / ``outAnimation`` / ``animDurationSeconds``.
The preview animates those from the playhead; this module does not, so a text
overlay a person animates in the Inspector still exports without its entrance.
``add_text_layer`` deliberately does not expose them for that reason — the agent
animates text with ``punch_in``, which the compiler does render (see
``compiler.py::_compile_text_clip``).

Pure Pillow + numpy, no MoviePy, no I/O — deterministic and unit-testable,
mirroring :mod:`framepilot_engine.render.captions` (which this module reuses
:func:`~framepilot_engine.render.captions.wrap_lines` from).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from framepilot_engine.render.captions import wrap_lines

# Text overlay occupies at most this fraction of the frame width (safe area).
_MAX_WIDTH_FRACTION = 0.85
# Default font height as a fraction of frame height (larger than captions —
# overlays/titles read as a deliberate on-screen element, not a subtitle).
_FONT_HEIGHT_FRACTION = 1 / 14
_MIN_FONT_SIZE = 16
#: Mirrors ``DEFAULT_TEXT_PARAMS.boxWidthPercent`` in the web editor.
_DEFAULT_BOX_WIDTH_PERCENT = 80.0
_ALIGNMENTS = frozenset({"left", "center", "right"})
_DEFAULT_COLOR: tuple[int, int, int, int] = (255, 255, 255, 255)
_OUTLINE_COLOR: tuple[int, int, int, int] = (0, 0, 0, 255)

_Font = ImageFont.FreeTypeFont | ImageFont.ImageFont


def _font_size_for(frame_height: int) -> int:
    """Pick a legible default text-overlay font size for a frame of ``frame_height``."""
    return max(_MIN_FONT_SIZE, int(frame_height * _FONT_HEIGHT_FRACTION))


def _color_from_param(value: Any) -> tuple[int, int, int, int]:
    """Parse a ``#rrggbb``/``#rrggbbaa`` ``color`` param; falls back to white.

    Anything that isn't a well-formed hex color string is treated as "not
    specified" rather than raising — an authored text overlay must still render
    (with the deterministic default) rather than fail the whole compile over a
    cosmetic param.
    """
    if not isinstance(value, str):
        return _DEFAULT_COLOR
    hex_str = value.lstrip("#")
    try:
        if len(hex_str) == 6:
            r, g, b = (int(hex_str[i : i + 2], 16) for i in (0, 2, 4))
            return (r, g, b, 255)
        if len(hex_str) == 8:
            r, g, b, a = (int(hex_str[i : i + 2], 16) for i in (0, 2, 4, 6))
            return (r, g, b, a)
    except ValueError:
        pass
    return _DEFAULT_COLOR


def text_overlay_style(
    params: Mapping[str, Any], frame_height: int
) -> tuple[int, tuple[int, int, int, int]]:
    """Resolve ``(font_size, color)`` for a ``text`` effect's ``params``.

    ``fontSizePercent`` is the authored key — a percentage of the FRAME height, which is
    what the preview's ``cqh`` unit means — and it wins when present. ``fontSize`` in
    pixels predates it and is still honored so stored projects keep rendering as they did.

    :param params: The ``text`` effect's ``params``.
    :param frame_height: Target frame height, used to scale the font.
    :returns: A ``(font_size, rgba_color)`` pair.
    """
    font_size = _font_size_for(frame_height)
    percent = params.get("fontSizePercent")
    if isinstance(percent, int | float) and not isinstance(percent, bool) and percent > 0:
        font_size = max(_MIN_FONT_SIZE, int(frame_height * float(percent) / 100.0))
    else:
        raw_size = params.get("fontSize")
        if isinstance(raw_size, int | float) and not isinstance(raw_size, bool) and raw_size > 0:
            font_size = int(raw_size)
    return font_size, _color_from_param(params.get("color"))


@dataclass(frozen=True)
class TextOverlayLayout:
    """Everything the compiler needs to draw and place one text overlay."""

    font_size: int
    color: tuple[int, int, int, int]
    align: str
    #: Wrap width in pixels.
    box_width: int
    #: Box centre in pixels, origin top-left.
    centre_x: float
    centre_y: float
    background: tuple[int, int, int, int] | None


def _percent(value: Any, fallback: float) -> float:
    if isinstance(value, int | float) and not isinstance(value, bool):
        return float(value)
    return fallback


def text_overlay_layout(
    params: Mapping[str, Any], frame_width: int, frame_height: int
) -> TextOverlayLayout:
    """Resolve the authored style params into pixels for this frame.

    Defaults mirror ``DEFAULT_TEXT_PARAMS`` in the web editor exactly — a centred box at
    80% of the frame width. Anything malformed falls back rather than raising: a cosmetic
    param must never fail a whole compile.

    :param params: The ``text`` effect's ``params``.
    :param frame_width: Target frame width in pixels.
    :param frame_height: Target frame height in pixels.
    """
    font_size, color = text_overlay_style(params, frame_height)
    align = params.get("align")
    box_percent = _percent(params.get("boxWidthPercent"), _DEFAULT_BOX_WIDTH_PERCENT)
    box_width = max(1, int(frame_width * min(max(box_percent, 1.0), 100.0) / 100.0))
    background = params.get("background")
    return TextOverlayLayout(
        font_size=font_size,
        color=color,
        align=align if align in _ALIGNMENTS else "center",
        box_width=box_width,
        centre_x=frame_width * _percent(params.get("xPercent"), 50.0) / 100.0,
        centre_y=frame_height * _percent(params.get("yPercent"), 50.0) / 100.0,
        background=_color_from_param(background) if isinstance(background, str) else None,
    )


def render_text_overlay_image(
    text: str,
    frame_width: int,
    frame_height: int,
    *,
    font_size: int | None = None,
    color: tuple[int, int, int, int] = _DEFAULT_COLOR,
    max_width: int | None = None,
    align: str = "center",
    background: tuple[int, int, int, int] | None = None,
) -> np.ndarray:
    """Rasterize ``text`` into a tight RGBA overlay image (transparent background).

    Mirrors :func:`framepilot_engine.render.captions.render_caption_image`'s
    wrap-and-measure approach, but draws a stroked (outlined) title-style text
    with no background box — the caption box is a subtitle convention, not
    appropriate for an arbitrary on-screen text overlay.

    :param text: The authored overlay text (must be non-empty).
    :param frame_width: Target frame width in pixels (bounds the wrap width).
    :param frame_height: Target frame height in pixels (scales the default font).
    :param font_size: Explicit font size in pixels; defaults to a frame-relative size.
    :param color: RGBA fill color for the text.
    :param max_width: Wrap width in pixels; defaults to the frame's safe-area fraction.
    :param align: ``left`` / ``center`` / ``right`` within the wrapped block.
    :param background: RGBA fill for a box behind the text, or ``None`` for no box.
    :returns: An ``(H, W, 4)`` ``uint8`` RGBA array sized to the wrapped text.
    :raises ValueError: If ``text`` is empty/whitespace.
    """
    if not text.strip():
        raise ValueError("Cannot render an empty text overlay.")

    size = font_size if font_size is not None else _font_size_for(frame_height)
    font = ImageFont.load_default(size=size)
    max_text_width = (
        max(1, max_width) if max_width is not None else int(frame_width * _MAX_WIDTH_FRACTION)
    )
    lines = wrap_lines(text.split(), font, max_text_width)

    stroke_width = max(1, size // 12)
    probe = Image.new("RGBA", (1, 1))
    draw = ImageDraw.Draw(probe)
    line_metrics = [
        draw.textbbox((0, 0), line, font=font, stroke_width=stroke_width) for line in lines
    ]
    line_widths = [int(bbox[2] - bbox[0]) for bbox in line_metrics]
    line_height = int(max(bbox[3] - bbox[1] for bbox in line_metrics))
    line_gap = max(1, size // 6)

    text_width = max(line_widths)
    text_height = line_height * len(lines) + line_gap * (len(lines) - 1)
    pad = stroke_width * 2
    box_width = text_width + 2 * pad
    box_height = text_height + 2 * pad

    image = Image.new("RGBA", (box_width, box_height), background or (0, 0, 0, 0))
    canvas = ImageDraw.Draw(image)

    y = pad
    for line, width, bbox in zip(lines, line_widths, line_metrics, strict=True):
        # Alignment places each line within the widest one, which is what the preview's
        # `text-align` does inside its box.
        if align == "left":
            x = pad
        elif align == "right":
            x = pad + (text_width - width)
        else:
            x = pad + (text_width - width) // 2
        canvas.text(
            (x - bbox[0], y - bbox[1]),
            line,
            font=font,
            fill=color,
            stroke_width=stroke_width,
            stroke_fill=_OUTLINE_COLOR,
        )
        y += line_height + line_gap

    return np.asarray(image, dtype=np.uint8)
