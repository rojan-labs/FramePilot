"""Text-overlay burn-in rasterization (render-vs-preview honesty fix).

WHY: ``add_text_overlay`` stores a synthetic clip (``TEXT_OVERLAY_ASSET_ID``)
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
* ``fontFamily`` / ``fontWeight`` — a bundled caption family (``render/fonts``) and its weight.
  Absent, the title keeps Pillow's bundled default font, so a project that never chose a
  family renders exactly as it always did.

WHY THE FONT IS HONOURED (2026-09-24). The Inspector and the browser preview have always drawn
a title in its ``fontFamily``/``fontWeight`` (``overlay-painter.ts``: ``ctx.font``), and the
web editor stores ``Inter`` 700 on every new title — while this module ignored both and drew
Pillow's default face. The export and the desktop monitor (which rasterizes through this same
function) therefore showed a different, plainer typeface than the one chosen: the "MOTION"
title of the captured 2026-09-23 runs was an unstyled default font on a short that had
designed caption fonts everywhere else.

Position is applied by the compiler (it owns placement); everything else is
resolved and drawn here.

TYPOGRAPHY (2026-09-28). A text overlay may carry ``typography``: the caption style's LINE-level
fields (case, italic, letter spacing, line height, see-through letters, outline, shadow, and the
chip's shape, frosted glass included). A text overlay with it is drawn by the caption rasterizer
itself (:func:`~framepilot_engine.render.captions.render_caption_raster`) through
:func:`text_overlay_caption_style`, so it draws exactly as a caption in the same look does, in the
export and in the desktop monitor alike. A text overlay without it keeps this module's own
drawing (and its fixed black stroke), byte for byte. Excluded: everything word-timed or animated
(highlight, accent, entrances, loops); a text overlay animates through its layer transitions.

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

import logging
import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from pydantic import ValidationError

from framepilot_engine.render.captions import (
    _FONT_HEIGHT_FRACTION as _CAPTION_FONT_HEIGHT_FRACTION,
)
from framepilot_engine.render.captions import (
    _load_font,
    basic_layout_features,
    measure_caption_layout,
    render_caption_raster,
    wrap_lines,
)
from framepilot_engine.timeline.models import CaptionStyle

log = logging.getLogger(__name__)

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
#: A title's weight when a family is named without one — the web editor's default
#: (``DEFAULT_TEXT_PARAMS.fontWeight``), so a family chosen in the Inspector exports as shown.
_DEFAULT_TITLE_WEIGHT = 700
_MIN_WEIGHT = 100
_MAX_WEIGHT = 900
_OUTLINE_COLOR: tuple[int, int, int, int] = (0, 0, 0, 255)

_Font = ImageFont.FreeTypeFont | ImageFont.ImageFont

#: The caption-style fields a text overlay's ``typography`` carries (camelCase, as the project
#: stores them). Mirrors ``TEXT_OVERLAY_TYPOGRAPHY_FIELDS`` in ``text-overlay-styles.ts``.
TEXT_OVERLAY_TYPOGRAPHY_FIELDS: tuple[str, ...] = (
    "fontStyle",
    "textTransform",
    "letterSpacing",
    "lineHeight",
    "textOpacity",
    "outlineColor",
    "outlineWidth",
    "shadow",
)
#: The chip fields a text overlay takes from ``typography.background``. Its colour is the text
#: overlay's own ``background`` param (the Inspector's switch). ``blur`` makes the chip frosted
#: glass: the picture composited beneath the text overlay is blurred through the chip's coverage
#: (:class:`TextOverlayRaster`, ``compiler.py`` ``_composite_frosted``).
_TEXT_OVERLAY_CHIP_FIELDS: tuple[str, ...] = (
    "radius",
    "paddingX",
    "paddingY",
    "blur",
    "borderColor",
    "borderWidth",
)
_MIN_BOX_WIDTH_PERCENT = 5.0


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
    #: A bundled family name, or ``None`` for Pillow's default face.
    font_family: str | None = None
    font_weight: int = _DEFAULT_TITLE_WEIGHT


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
    family = params.get("fontFamily")
    weight = params.get("fontWeight")
    font_weight = (
        int(min(max(float(weight), _MIN_WEIGHT), _MAX_WEIGHT))
        if isinstance(weight, int | float) and not isinstance(weight, bool)
        else _DEFAULT_TITLE_WEIGHT
    )
    return TextOverlayLayout(
        font_size=font_size,
        color=color,
        align=align if align in _ALIGNMENTS else "center",
        box_width=box_width,
        centre_x=frame_width * _percent(params.get("xPercent"), 50.0) / 100.0,
        centre_y=frame_height * _percent(params.get("yPercent"), 50.0) / 100.0,
        background=_color_from_param(background) if isinstance(background, str) else None,
        font_family=family.strip() if isinstance(family, str) and family.strip() else None,
        font_weight=font_weight,
    )


def text_overlay_caption_style(params: Mapping[str, Any], frame_height: int) -> CaptionStyle | None:
    """The caption style a text overlay with ``typography`` is drawn in; ``None`` for a plain one.

    The text overlay's own params stay authoritative for what they already said — family, weight,
    colour, size, alignment, wrap width and whether there is a chip — and ``typography`` adds
    the rest of the caption vocabulary. Nothing positional is passed: the raster is placed by
    the text overlay's ``xPercent``/``yPercent`` and transform, as every text overlay is.

    A ``typography`` that does not validate draws the plain text overlay rather than failing the
    render (a cosmetic param must never fail a compile), and says so in the log.

    :param params: The ``text`` effect's params.
    :param frame_height: Height of the delivered frame, which the font size is relative to.
    """
    typography = params.get("typography")
    if not isinstance(typography, Mapping):
        return None
    problem = _typography_problem(typography)
    if problem is not None:
        log.warning(
            "Text overlay typography is invalid (%s); drawing the plain text overlay instead.",
            problem,
        )
        return None
    layout = text_overlay_layout(_with_editor_defaults(params), 1, frame_height)
    box_percent = _percent(params.get("boxWidthPercent"), _DEFAULT_BOX_WIDTH_PERCENT)
    style: dict[str, Any] = {
        key: typography[key] for key in TEXT_OVERLAY_TYPOGRAPHY_FIELDS if key in typography
    }
    style.update(
        display="phrase",
        # The caption renderer sizes its font as floor(height / 22 * fontScale). Half a pixel
        # over the text overlay's size makes that floor land on exactly the size it resolved to.
        fontScale=(layout.font_size + 0.5) / (frame_height * _CAPTION_FONT_HEIGHT_FRACTION),
        fontWeight=layout.font_weight,
        textColor=_hex_color(layout.color),
        textAlign=layout.align,
        maxWidthPercent=min(max(box_percent, _MIN_BOX_WIDTH_PERCENT), 100.0),
    )
    if layout.font_family is not None:
        style["fontFamily"] = layout.font_family
    background = params.get("background")
    if isinstance(background, str) and background.strip():
        chip = typography.get("background")
        shape = chip if isinstance(chip, Mapping) else {}
        style["background"] = {
            "color": background,
            **{key: shape[key] for key in _TEXT_OVERLAY_CHIP_FIELDS if key in shape},
        }
    try:
        return CaptionStyle.model_validate(style)
    except ValidationError as exc:
        log.warning(
            "Text overlay typography is invalid; drawing the plain text overlay instead: %s", exc
        )
        return None


#: The web editor's defaults for a text overlay (``DEFAULT_TEXT_PARAMS``): what the preview draws
#: a typed text overlay in when the project stores no family or size (the agent's
#: ``add_text_layer`` writes neither). The plain path keeps its own historic defaults, byte for
#: byte.
_EDITOR_DEFAULT_FAMILY = "Inter"
_EDITOR_DEFAULT_SIZE_PERCENT = 8.0
_TEXT_TRANSFORMS = frozenset({"none", "uppercase", "lowercase"})
_FONT_STYLES = frozenset({"normal", "italic"})
#: ``CaptionStyleSchema.lineHeight``'s range, which the preview's parse enforces.
_LINE_HEIGHT_RANGE = (0.7, 3.0)


def _with_editor_defaults(params: Mapping[str, Any]) -> Mapping[str, Any]:
    """``params`` with the editor's family and size filled in where the project stores none."""
    filled = dict(params)
    family = filled.get("fontFamily")
    if not (isinstance(family, str) and family.strip()):
        filled["fontFamily"] = _EDITOR_DEFAULT_FAMILY
    if filled.get("fontSizePercent") is None and filled.get("fontSize") is None:
        filled["fontSizePercent"] = _EDITOR_DEFAULT_SIZE_PERCENT
    return filled


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _non_negative(value: Any) -> bool:
    return _is_number(value) and value >= 0


def _typography_problem(typography: Mapping[str, Any]) -> str | None:
    """Why ``typography`` fails ``TextOverlayTypographySchema`` (``text-overlay-styles.ts``).

    ``None`` when it passes. The preview reads a text overlay's typography through that schema
    and draws the plain text overlay when it does not parse, so the export must refuse exactly
    the same values or the two disagree about which look a text overlay has. The pydantic
    ``CaptionStyle`` is looser (it bounds only the letter opacity), hence these checks.
    """
    checks: list[tuple[str, bool]] = [
        (
            "textTransform",
            "textTransform" not in typography or typography["textTransform"] in _TEXT_TRANSFORMS,
        ),
        ("fontStyle", "fontStyle" not in typography or typography["fontStyle"] in _FONT_STYLES),
        (
            "letterSpacing",
            "letterSpacing" not in typography or _is_number(typography["letterSpacing"]),
        ),
        (
            "lineHeight",
            "lineHeight" not in typography
            or (
                _is_number(typography["lineHeight"])
                and _LINE_HEIGHT_RANGE[0] <= typography["lineHeight"] <= _LINE_HEIGHT_RANGE[1]
            ),
        ),
        (
            "textOpacity",
            "textOpacity" not in typography
            or (_is_number(typography["textOpacity"]) and 0 <= typography["textOpacity"] <= 1),
        ),
        (
            "outlineColor",
            "outlineColor" not in typography
            or (isinstance(typography["outlineColor"], str) and bool(typography["outlineColor"])),
        ),
        (
            "outlineWidth",
            "outlineWidth" not in typography or _non_negative(typography["outlineWidth"]),
        ),
    ]
    shadow = typography.get("shadow")
    if shadow is not None:
        checks.append(
            (
                "shadow",
                isinstance(shadow, Mapping)
                and isinstance(shadow.get("color"), str)
                and bool(shadow.get("color"))
                and _non_negative(shadow.get("blur"))
                and _is_number(shadow.get("offsetX"))
                and _is_number(shadow.get("offsetY")),
            )
        )
    chip = typography.get("background")
    if chip is not None:
        shape_ok = isinstance(chip, Mapping) and all(
            _non_negative(chip[key])
            for key in ("radius", "paddingX", "paddingY", "blur", "borderWidth")
            if key in chip
        )
        border = chip.get("borderColor") if isinstance(chip, Mapping) else None
        checks.append(
            (
                "background",
                shape_ok and (border is None or (isinstance(border, str) and border != "")),
            )
        )
    for field, ok in checks:
        if not ok:
            return field
    return None


def _hex_color(rgba: tuple[int, int, int, int]) -> str:
    r, g, b, a = rgba
    return f"#{r:02x}{g:02x}{b:02x}{a:02x}"


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
    font_family: str | None = None,
    font_weight: int = _DEFAULT_TITLE_WEIGHT,
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
    :param font_family: A bundled family (``render/fonts``); ``None`` draws Pillow's default
        face. An unknown family falls back to that default with a warning, never a failure.
    :param font_weight: The weight a variable family is set to (100-900).
    :returns: An ``(H, W, 4)`` ``uint8`` RGBA array sized to the wrapped text.
    :raises ValueError: If ``text`` is empty/whitespace.
    """
    if not text.strip():
        raise ValueError("Cannot render an empty text overlay.")

    size = font_size if font_size is not None else _font_size_for(frame_height)
    font = (
        _load_font(font_family, size, font_weight)
        if font_family is not None
        else ImageFont.load_default(size=size)
    )
    max_text_width = (
        max(1, max_width) if max_width is not None else int(frame_width * _MAX_WIDTH_FRACTION)
    )
    features = basic_layout_features(font)
    lines = wrap_lines(text.split(), font, max_text_width, features)

    stroke_width = max(1, size // 12)
    probe = Image.new("RGBA", (1, 1))
    draw = ImageDraw.Draw(probe)
    line_metrics = [
        draw.textbbox((0, 0), line, font=font, stroke_width=stroke_width, features=features)
        for line in lines
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
            features=features,
        )
        y += line_height + line_gap

    return np.asarray(image, dtype=np.uint8)


@dataclass(frozen=True)
class TextOverlayRaster:
    """A text overlay's RGBA raster and, for a frosted chip, where to blur behind it.

    ``backdrop`` is an ``(H, W)`` ``uint8`` coverage mask the SAME size as ``image``, so the
    compiler places both through one transform: the picture beneath the text overlay is replaced
    by its Gaussian blur, ``backdrop_sigma_px`` wide, wherever the coverage is. ``None`` for a
    chip that is not frosted (the common case).
    """

    image: np.ndarray
    backdrop: np.ndarray | None = None
    backdrop_sigma_px: float = 0.0


def rasterize_text_overlay_layers(
    text: str,
    style_params: Mapping[str, Any],
    frame_width: int,
    frame_height: int,
    *,
    rotates: bool = False,
) -> TextOverlayRaster:
    """:func:`rasterize_text_overlay` plus a frosted chip's backdrop coverage.

    The export's compiler and the desktop monitor's raster route both call this, so the coverage
    the monitor blurs through is the export's own.
    """
    styled = text_overlay_caption_style(style_params, frame_height)
    if styled is None:
        return TextOverlayRaster(
            rasterize_text_overlay(text, style_params, frame_width, frame_height, rotates=rotates)
        )
    raster = render_caption_raster(text, frame_width, frame_height, style=styled)
    image = rotation_safe(raster.image) if rotates else raster.image
    if raster.backdrop is None:
        return TextOverlayRaster(image)
    coverage = raster.backdrop[..., np.newaxis]
    backdrop = rotation_safe(coverage)[..., 0] if rotates else raster.backdrop
    return TextOverlayRaster(image, backdrop, raster.backdrop_sigma_px)


def rasterize_text_overlay(
    text: str,
    style_params: Mapping[str, Any],
    frame_width: int,
    frame_height: int,
    *,
    rotates: bool = False,
) -> np.ndarray:
    """A text clip's RGBA raster exactly as the export composites it.

    The one call both the compiler (``_compile_text_clip``) and the desktop preview's text
    raster route make, so the monitor's glyphs are the export's glyphs by construction.

    :param rotates: the clip animates ``rotation``. The export turns a layer inside its own box
        (``expand=False``), and a title's raster is tight to its glyphs, so a turned title lost
        its letters. A turning title is drawn centred in a transparent square as wide as its
        diagonal (plan/elements EL2b.4), as a turning shape is (ADR 0190); its centre, and so its
        placement, stays where it was.
    """
    styled = text_overlay_caption_style(style_params, frame_height)
    if styled is not None:
        image = render_caption_raster(text, frame_width, frame_height, style=styled).image
        return rotation_safe(image) if rotates else image
    layout = text_overlay_layout(style_params, frame_width, frame_height)
    image = render_text_overlay_image(
        text,
        frame_width,
        frame_height,
        font_size=layout.font_size,
        color=layout.color,
        max_width=layout.box_width,
        align=layout.align,
        background=layout.background,
        font_family=layout.font_family,
        font_weight=layout.font_weight,
    )
    return rotation_safe(image) if rotates else image


def title_drawn_size(
    text: str,
    style_params: Mapping[str, Any],
    frame_width: int,
    frame_height: int,
) -> tuple[int, int]:
    """``(width, height)`` in pixels of what a title visibly draws: the box a fit keeps in frame.

    A plain title's raster is tight to what it draws (ink, stroke, padding, chip), so it is its
    own measure. A typed title's raster is the caption rasterizer's canvas, which keeps
    transparent room on every side for motion, glow and shadow (``CaptionRaster.margin``): 36 px
    round a 10 % title, 164 px once it has a drop shadow. The engine's title fit measured that
    canvas and sized a shadowed "MOTION" at 7.8 % where the AI layer's fit
    (``overlay-fit.ts``), measuring the letters, sized it at 10.5 % — so the size a
    ``measure_subject`` answer carried was not the size the title tools would write.

    So a typed title is measured as ``overlay-fit.ts`` ``typedTitleDrawnWidthPx`` reads it (and
    as ``title_metrics`` records it): the wider of the box it wraps in — its words plus the chip
    padding each side, :func:`measure_caption_layout` — and its letters as drawn without their
    shadow, stroke and overhang included. The shadow is left out because the fit leaves it out:
    a soft shadow reaching past the safe width is not a title running off the frame.

    :param text: The title's text.
    :param style_params: The ``text`` effect's params.
    :param frame_width: Width of the delivered frame in pixels.
    :param frame_height: Height of the delivered frame in pixels.
    """
    styled = text_overlay_caption_style(style_params, frame_height)
    if styled is None:
        image = rasterize_text_overlay(text, style_params, frame_width, frame_height)
        return int(image.shape[1]), int(image.shape[0])
    wrap = measure_caption_layout(text, frame_width, frame_height, style=styled).box_width
    unshadowed = styled.model_copy(update={"shadow": None})
    raster = render_caption_raster(text, frame_width, frame_height, style=unshadowed)
    alpha = raster.image[..., 3]
    columns = np.flatnonzero(alpha.max(axis=0))
    rows = np.flatnonzero(alpha.max(axis=1))
    if columns.size == 0:
        # Hollow letters with no outline draw nothing: the caption's own box is all there is.
        return int(wrap), int(raster.image.shape[0] - 2 * raster.margin)
    ink_width = int(columns[-1] - columns[0] + 1)
    return max(int(wrap), ink_width), int(rows[-1] - rows[0] + 1)


def rotation_safe(image: np.ndarray) -> np.ndarray:
    """``image`` centred in a transparent square as wide as its diagonal (EL2b.4).

    Even padding on both sides where the difference is even; the odd pixel goes to the right and
    the bottom, so the TypeScript twin (``text-raster.ts`` ``rotationSafe``) pads identically.
    """
    height, width = image.shape[:2]
    side = math.ceil(math.hypot(width, height))
    left = (side - width) // 2
    top = (side - height) // 2
    padded = np.zeros((side, side, image.shape[2]), dtype=image.dtype)
    padded[top : top + height, left : left + width] = image
    return padded
