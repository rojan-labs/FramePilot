"""Caption burn-in rasterization (plan 3.3 — caption render-wiring; schema v5 —
karaoke/animated captions).

WHY: a caption track carries only time-ranged caption *clips* — the spoken text
is derived from the project transcript, exactly as the editor preview does (see
``apps/web-editor/src/editor/captions.ts``). To burn captions into a rendered
output the engine must, for each caption clip, reconstruct its text from the
transcript and rasterize it to an overlay image the compiler composites on top
of the video.

Two properties matter and are why this module is pure (Pillow + numpy only, no
MoviePy, no I/O):

* **Deterministic** — the same transcript + clip (+ style + frame time) always
  produces the same pixels, which is what makes caption-timing golden tests
  possible (PRD §9.4). Text is drawn with Pillow's *bundled* TrueType font via
  :func:`PIL.ImageFont.load_default` (size-scalable since Pillow 10.1) unless a
  named font family is requested and resolvable.
* **Unit-testable** — :func:`caption_text_for_range` and
  :func:`render_caption_image` need no render to exercise.

Baseline vs styled rendering
-----------------------------
:func:`render_caption_image` is *baseline-preserving*: a caption clip with no
``captionStyle`` (``style=None``) renders byte-identically to the pre-v5
renderer (white text on a translucent box, lower safe area) — old projects
must not change pixels. Passing a :class:`~framepilot_engine.timeline.models.
CaptionStyle` (schema v10, ``Clip.caption_style``) switches to the styled
path: a DATA-DRIVEN TEMPLATE INTERPRETER (ADR 0069) that resolves the style
against the shared caption template catalog
(:mod:`framepilot_engine.render.caption_templates`) and interprets only the
closed enum vocabularies — display mode (phrase / active-word / cumulative),
active-word emphasis (color / pop / karaoke-fill / background / glow /
underline / pulse), entrance and loop animations, accent words, typography
(bundled fonts, weight axis, transform, letter spacing), chips and shadows —
driven by the clip's :class:`~framepilot_engine.timeline.models.TranscriptWord`
list and the current ``frame_time``. It never branches on a template id. See
:func:`caption_style_is_animated` for whether a caller needs to re-render per
output frame or can cache a single image.
"""

from __future__ import annotations

import json
import logging
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from functools import cache, lru_cache
from importlib import resources

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from framepilot_engine.render.caption_templates import resolve_caption_style
from framepilot_engine.timeline.models import CaptionStyle, Clip, TranscriptWord

_log = logging.getLogger(__name__)

# Caption text occupies at most this fraction of the frame width (safe area).
_MAX_WIDTH_FRACTION = 0.9
# Font height as a fraction of frame height; floored so small frames stay legible.
_FONT_HEIGHT_FRACTION = 1 / 22
_MIN_FONT_SIZE = 14
# Padding around the text inside its translucent box, in pixels (scaled by font).
_BOX_PAD_FRACTION = 0.35
# Box fill: translucent black (the "clean" caption look); text is white.
_BOX_FILL = (0, 0, 0, 160)
_TEXT_FILL = (255, 255, 255, 255)

# Either Pillow font flavour: a TrueType font (when a size is requested) or the
# bundled bitmap fallback. Both expose ``getlength`` and work with ImageDraw.
_Font = ImageFont.FreeTypeFont | ImageFont.ImageFont


def caption_words_for_range(
    transcript: Sequence[TranscriptWord],
    start: float,
    end: float,
) -> list[TranscriptWord]:
    """The transcript words spoken within ``[start, end)``, in order.

    A transcript word belongs to the range if its own span overlaps it
    (``word.start < end and word.end > start``). This is the same filter
    :func:`caption_text_for_range` uses for its joined text, exposed here as
    the actual word list so per-word highlighting can use each word's own
    ``start``/``end``.

    :param transcript: Word-level transcript entries (ordered by time).
    :param start: Caption clip start (seconds, inclusive).
    :param end: Caption clip end (seconds, exclusive).
    :returns: The overlapping words, in transcript order.
    """
    return [w for w in transcript if w.start < end and w.end > start]


def caption_text_for_range(
    transcript: Sequence[TranscriptWord],
    start: float,
    end: float,
) -> str:
    """Reconstruct the caption text spoken within ``[start, end)``.

    Mirrors how the editor groups transcript words into caption lines, so a
    clip created by the editor's "generate captions" reproduces the same words
    at render time.

    :param transcript: Word-level transcript entries (ordered by time).
    :param start: Caption clip start (seconds, inclusive).
    :param end: Caption clip end (seconds, exclusive).
    :returns: The joined words, or ``""`` when no word overlaps the range.
    """
    return " ".join(w.word for w in caption_words_for_range(transcript, start, end))


@dataclass(frozen=True)
class ResolvedCue:
    """What a caption clip displays: its text plus the timings driving emphasis."""

    text: str
    words: list[TranscriptWord]


def resolve_caption_cue(clip: Clip, transcript: Sequence[TranscriptWord]) -> ResolvedCue:
    """What ``clip`` displays — its own cue when it has one, else the transcript.

    The Python mirror of the TS ``resolveCaptionCue`` (ADR 0071); change both
    together. A clip carrying ``caption_cue`` (schema v11) is authoritative,
    **including a deliberately blanked cue** (``text=""``), which draws nothing
    and must not silently fall back to the transcript — otherwise clearing a
    caption in the editor would reappear at export.

    Without a cue this derives by **overlap**, exactly as before v11, which is
    what keeps every pre-v11 project (and every existing golden) rendering
    byte-identically.
    """
    cue = clip.caption_cue
    if cue is not None:
        return ResolvedCue(text=cue.text, words=list(cue.words))
    words = caption_words_for_range(transcript, clip.start, clip.end)
    return ResolvedCue(text=" ".join(w.word for w in words), words=words)


def _font_size_for(frame_height: int) -> int:
    """Pick a legible caption font size for a frame of ``frame_height`` pixels."""
    return max(_MIN_FONT_SIZE, int(frame_height * _FONT_HEIGHT_FRACTION))


def wrap_lines(
    words: Iterable[str],
    font: _Font,
    max_text_width: int,
) -> list[str]:
    """Greedily wrap ``words`` into lines no wider than ``max_text_width``.

    A single word longer than the limit still occupies its own line (it is never
    split mid-word) — captions are short, so this is the pragmatic baseline.
    Shared with :mod:`framepilot_engine.render.text_overlay` (text overlays wrap
    the same way captions do; no need for two wrapping implementations).
    """
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and font.getlength(candidate) > max_text_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def render_caption_image(
    text: str,
    frame_width: int,
    frame_height: int,
    *,
    style: CaptionStyle | None = None,
    words: Sequence[TranscriptWord] | None = None,
    frame_time: float = 0.0,
) -> np.ndarray:
    """Rasterize ``text`` into an RGBA overlay image for a caption box.

    When ``style`` is ``None`` this is the deterministic pre-v5 baseline
    (translucent box, centered white text, lower safe area) — unchanged so
    existing projects without a ``captionStyle`` render identical pixels.
    Passing a :class:`CaptionStyle` switches to the richer, styled renderer
    (font/color/outline/position/preset + optional per-word highlight); see
    :func:`caption_style_is_animated` to know whether a caller must re-invoke
    this per output frame (``frame_time`` varies the result) or may cache a
    single image per clip.

    :param text: The caption text (must be non-empty; callers skip empty clips).
    :param frame_width: Target frame width in pixels (bounds the text width).
    :param frame_height: Target frame height in pixels (scales the font).
    :param style: Optional rich caption style (schema v5, ``Clip.caption_style``).
    :param words: The clip's active :class:`TranscriptWord` list (time-filtered
        by the caller, e.g. via :func:`caption_words_for_range`), used for
        per-word highlight state when ``style.highlight`` is enabled. Ignored
        when ``style`` is ``None``.
    :param frame_time: The timeline time (seconds) of the frame being rendered,
        used to classify each active word as upcoming/active/spoken. Ignored
        unless a highlight animation is in effect.
    :returns: An ``(H, W, 4)`` ``uint8`` RGBA array.
    :raises ValueError: If ``text`` is empty/whitespace.
    """
    if not text.strip():
        raise ValueError("Cannot render an empty caption.")

    if style is None:
        return _render_baseline_caption_image(text, frame_width, frame_height)
    return _render_styled_caption_image(
        text, frame_width, frame_height, style, words or [], frame_time
    )


def _render_baseline_caption_image(text: str, frame_width: int, frame_height: int) -> np.ndarray:
    """The pre-v5 deterministic baseline: translucent box, centered white text.

    The returned image is a tight box (translucent background + centered white
    text), sized to the wrapped text — not the full frame. The compiler
    positions it in the lower safe area. Rendering uses Pillow's bundled font so
    output is identical across machines with the same Pillow version.
    """
    font_size = _font_size_for(frame_height)
    font = ImageFont.load_default(size=font_size)
    pad = int(font_size * _BOX_PAD_FRACTION)
    max_text_width = int(frame_width * _MAX_WIDTH_FRACTION) - 2 * pad

    lines = wrap_lines(text.split(), font, max_text_width)

    # Measure each line; the box wraps the widest line and the stacked heights.
    probe = Image.new("RGBA", (1, 1))
    draw = ImageDraw.Draw(probe)
    line_metrics = [draw.textbbox((0, 0), line, font=font) for line in lines]
    line_widths = [int(bbox[2] - bbox[0]) for bbox in line_metrics]
    line_height = int(max(bbox[3] - bbox[1] for bbox in line_metrics))
    line_gap = max(1, font_size // 6)

    text_width = max(line_widths)
    text_height = line_height * len(lines) + line_gap * (len(lines) - 1)
    box_width = text_width + 2 * pad
    box_height = text_height + 2 * pad

    image = Image.new("RGBA", (box_width, box_height), (0, 0, 0, 0))
    canvas = ImageDraw.Draw(image)
    canvas.rounded_rectangle(
        (0, 0, box_width - 1, box_height - 1),
        radius=pad,
        fill=_BOX_FILL,
    )

    y = pad
    for line, width, bbox in zip(lines, line_widths, line_metrics, strict=True):
        x = (box_width - width) // 2
        # Subtract the bbox origin so glyphs with top-bearing align to the box.
        canvas.text((x - bbox[0], y - bbox[1]), line, font=font, fill=_TEXT_FILL)
        y += line_height + line_gap

    return np.asarray(image, dtype=np.uint8)


# --- styled (schema v10, template-based) rendering ---------------------------
#
# The styled path is a DATA-DRIVEN INTERPRETER (ADR 0069): it reads a resolved
# CaptionStyle (template + overrides, see render/caption_templates.py) and
# interprets only the closed enum vocabularies — display mode, emphasis,
# entrance, loop, accent. It never branches on a template id.
#
# Canvas-size invariant: for a given (text, style, frame size) the returned
# image dimensions are CONSTANT across ``frame_time`` — the layout is always
# computed from the full phrase, and per-frame subsets (active-word /
# cumulative / entrances) are drawn inside that fixed canvas. The compiler
# builds MoviePy VideoClips from per-frame re-renders, which requires stable
# frame dimensions.

_DEFAULT_HIGHLIGHT_COLOR: tuple[int, int, int, int] = (255, 214, 10, 255)  # amber
_POP_SCALE = 1.18
# Upcoming (not-yet-spoken) words are dimmed relative to spoken/active ones.
_UPCOMING_ALPHA_SCALE = 0.6
# Loop pulse: peak scale delta; loop wave: vertical bob as a fraction of font
# size, phase-shifted per word.
_PULSE_DEPTH = 0.05
_WAVE_DEPTH = 0.15
_WAVE_PHASE_STEP = 0.8
# Entrances: slide-up start offset (fraction of font size) and zoom start scale.
_SLIDE_FRACTION = 0.6
_ZOOM_START = 0.5
# Emphasis chip padding around the active word, as a fraction of font size.
_WORD_CHIP_PAD = 0.18
# Glow blur radius as a fraction of font size (word emphasis + shadow glow).
_GLOW_BLUR_FRACTION = 0.25

_RGBA = tuple[int, int, int, int]


@dataclass(frozen=True)
class _ResolvedStyle:
    """Fully-resolved caption presentation values (template + explicit overrides)."""

    display: str
    font_family: str | None
    font_weight: int
    font_style: str
    text_transform: str
    letter_spacing: float
    font_scale: float
    text_color: _RGBA
    outline_color: _RGBA | None
    outline_width: int
    box_fill: _RGBA
    box_radius: float
    box_pad_x: float
    box_pad_y: float
    shadow_color: _RGBA | None
    shadow_blur: float
    shadow_offset_x: float
    shadow_offset_y: float
    position: str
    max_width_percent: float
    text_align: str
    line_height: float | None
    highlight_enabled: bool
    highlight_color: _RGBA
    highlight_animation: str
    highlight_background: _RGBA | None
    highlight_scale: float
    entrance: str | None
    entrance_duration: float
    loop: str | None
    loop_period: float
    per_word: bool
    accent_mode: str
    #: Words `accent_mode == "keywords"` accents (schema v11); empty otherwise.
    accent_keywords: tuple[str, ...]
    accent_font_family: str | None
    accent_font_scale: float
    accent_color: _RGBA | None
    accent_font_style: str


def _hex_to_rgba(value: str, alpha: int = 255) -> _RGBA:
    """Parse a ``#rrggbb``/``#rrggbbaa`` color string; opaque white if malformed."""
    hex_str = value.lstrip("#")
    try:
        if len(hex_str) == 6:
            r, g, b = (int(hex_str[i : i + 2], 16) for i in (0, 2, 4))
            return (r, g, b, alpha)
        if len(hex_str) == 8:
            r, g, b, a = (int(hex_str[i : i + 2], 16) for i in (0, 2, 4, 6))
            return (r, g, b, a)
    except ValueError:
        pass
    return (255, 255, 255, 255)


def _resolve_style(style: CaptionStyle) -> _ResolvedStyle:
    """Fold the template catalog under ``style`` and normalize every field.

    Template-vs-override precedence lives in
    :func:`framepilot_engine.render.caption_templates.resolve_caption_style`
    (the Python mirror of the TS resolver); this function only maps the
    resolved model onto renderer-ready values (parsed colors, defaults).
    """
    s = resolve_caption_style(style)

    background = s.background
    box_fill = _hex_to_rgba(background.color) if background is not None else (0, 0, 0, 0)

    shadow = s.shadow
    highlight = s.highlight
    animation = s.animation
    accent = s.accent
    entrance = (
        animation.in_.type
        if animation is not None and animation.in_ is not None and animation.in_.type != "none"
        else None
    )
    entrance_duration = (
        animation.in_.duration
        if animation is not None
        and animation.in_ is not None
        and animation.in_.duration is not None
        else 0.15
    )
    loop = animation.loop.type if animation is not None and animation.loop is not None else None
    loop_period = (
        animation.loop.period
        if animation is not None
        and animation.loop is not None
        and animation.loop.period is not None
        else 1.0
    )

    return _ResolvedStyle(
        display=s.display or "phrase",
        font_family=s.font_family,
        font_weight=s.font_weight if s.font_weight is not None else 400,
        font_style=s.font_style or "normal",
        text_transform=s.text_transform or "none",
        letter_spacing=s.letter_spacing if s.letter_spacing is not None else 0.0,
        font_scale=s.font_scale if s.font_scale is not None else 1.0,
        text_color=_hex_to_rgba(s.text_color) if s.text_color else (255, 255, 255, 255),
        outline_color=_hex_to_rgba(s.outline_color) if s.outline_color else None,
        outline_width=int(s.outline_width) if s.outline_width is not None else 0,
        box_fill=box_fill,
        box_radius=(
            background.radius if background is not None and background.radius is not None else 0.35
        ),
        box_pad_x=(
            background.padding_x
            if background is not None and background.padding_x is not None
            else 0.35
        ),
        box_pad_y=(
            background.padding_y
            if background is not None and background.padding_y is not None
            else 0.35
        ),
        shadow_color=_hex_to_rgba(shadow.color) if shadow is not None else None,
        shadow_blur=shadow.blur if shadow is not None else 0.0,
        shadow_offset_x=shadow.offset_x if shadow is not None else 0.0,
        shadow_offset_y=shadow.offset_y if shadow is not None else 0.0,
        position=s.position or "bottom",
        max_width_percent=s.max_width_percent if s.max_width_percent is not None else 90.0,
        text_align=s.text_align or "center",
        line_height=s.line_height,
        highlight_enabled=bool(highlight.enabled) if highlight is not None else False,
        highlight_color=(
            _hex_to_rgba(highlight.color)
            if highlight is not None and highlight.color
            else _DEFAULT_HIGHLIGHT_COLOR
        ),
        highlight_animation=(
            highlight.animation if highlight is not None and highlight.animation else "none"
        ),
        highlight_background=(
            _hex_to_rgba(highlight.background)
            if highlight is not None and highlight.background
            else None
        ),
        highlight_scale=(
            highlight.scale if highlight is not None and highlight.scale is not None else _POP_SCALE
        ),
        entrance=entrance,
        entrance_duration=entrance_duration,
        loop=loop,
        loop_period=loop_period,
        per_word=bool(animation.per_word) if animation is not None else False,
        accent_mode=accent.mode if accent is not None else "none",
        accent_keywords=(
            tuple(accent.keywords) if accent is not None and accent.keywords else ()
        ),
        accent_font_family=accent.font_family if accent is not None else None,
        accent_font_scale=(
            accent.font_scale if accent is not None and accent.font_scale is not None else 1.0
        ),
        accent_color=(_hex_to_rgba(accent.color) if accent is not None and accent.color else None),
        accent_font_style=(
            accent.font_style if accent is not None and accent.font_style else "normal"
        ),
    )


# --- fonts -------------------------------------------------------------------


@cache
def _font_manifest() -> dict[str, dict[str, object]]:
    """The bundled font manifest (family name → file entries; ADR 0069)."""
    payload = (
        resources.files("framepilot_engine.render")
        .joinpath("fonts", "manifest.json")
        .read_text(encoding="utf-8")
    )
    families = json.loads(payload).get("families", {})
    return families if isinstance(families, dict) else {}


def _bundled_font_path(family: str, weight: int, italic: bool) -> tuple[str, bool] | None:
    """Resolve ``family`` to a bundled font file.

    :returns: ``(absolute path, is_variable)`` or ``None`` when the family is
        not bundled. Static families pick their bold/italic variant file when
        one is listed and requested.
    """
    entry = _font_manifest().get(family)
    if not isinstance(entry, dict):
        return None
    filename = entry.get("file")
    if italic and isinstance(entry.get("italicFile"), str):
        filename = entry["italicFile"]
    elif weight >= 600 and isinstance(entry.get("boldFile"), str):
        filename = entry["boldFile"]
    if not isinstance(filename, str):  # pragma: no cover - malformed manifest
        return None
    path = resources.files("framepilot_engine.render").joinpath("fonts", filename)
    return (str(path), bool(entry.get("variable")))


@lru_cache(maxsize=256)
def _load_font(
    font_family: str | None, size: int, weight: int = 400, italic: bool = False
) -> _Font:
    """Load ``font_family`` at ``size``/``weight``; falls back to the default font.

    Resolution order: bundled catalog font (variable fonts get their ``wght``
    axis set to ``weight``) → system font by name → Pillow's bundled default.
    A missing/unresolvable font family is a cosmetic miss, not a render
    failure: this project's honesty invariant (AGENTS.md) is "no silent
    wrong-but-plausible output", not "block the render over a font choice", so
    a warning is logged and rendering proceeds with the deterministic bundled
    font rather than raising.
    """
    if font_family:
        bundled = _bundled_font_path(font_family, weight, italic)
        if bundled is not None:
            path, is_variable = bundled
            try:
                font = ImageFont.truetype(path, size)
                if is_variable:
                    _set_weight_axis(font, weight)
                return font
            except OSError:  # pragma: no cover - bundled file unreadable
                _log.warning("Bundled caption font %r unreadable; falling back.", path)
        try:
            return ImageFont.truetype(font_family, size)
        except OSError:
            _log.warning(
                "Caption font family %r could not be loaded; falling back to the "
                "bundled default font.",
                font_family,
            )
    return ImageFont.load_default(size=size)


def _set_weight_axis(font: ImageFont.FreeTypeFont, weight: int) -> None:
    """Set a variable font's ``wght`` axis to ``weight`` (other axes keep defaults)."""
    try:
        axes = font.get_variation_axes()
    except OSError:  # pragma: no cover - non-variable despite manifest flag
        return
    values: list[float] = []
    for axis in axes:
        name = axis.get("name", b"")
        label = name.decode("latin-1", "ignore") if isinstance(name, bytes) else str(name)
        minimum = axis.get("minimum") or 0
        maximum = axis.get("maximum") or 0
        default = axis.get("default") or 0
        if "weight" in label.lower() or "wght" in label.lower():
            values.append(float(min(max(weight, minimum), maximum)))
        else:
            values.append(float(default))
    font.set_variation_by_axes(values)


# --- animation math ----------------------------------------------------------


def caption_style_is_animated(style: CaptionStyle | None) -> bool:
    """Whether ``style`` requires a fresh render per output frame.

    ``True`` when any time-varying behavior is in effect after template
    resolution: a non-phrase display mode (the visible words change over
    time), an enabled active-word emphasis (the active word moves), or an
    entrance/loop animation. Otherwise a single cached image per clip is
    byte-identical across the clip's whole duration, so re-rendering per frame
    would be wasted, non-time-varying work.

    :param style: The clip's caption style, or ``None``.
    :returns: ``True`` if the render depends on ``frame_time``.
    """
    if style is None:
        return False
    resolved = _resolve_style(style)
    return (
        resolved.display != "phrase"
        or (resolved.highlight_enabled and resolved.highlight_animation != "none")
        or resolved.entrance is not None
        or resolved.loop is not None
    )


def _word_state(word: TranscriptWord, frame_time: float) -> str:
    """Classify ``word`` at ``frame_time`` as ``'upcoming'``/``'active'``/``'spoken'``."""
    if word.start <= frame_time < word.end:
        return "active"
    if frame_time >= word.end:
        return "spoken"
    return "upcoming"


def _clamp01(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


def _ease_out_back(p: float) -> float:
    """Standard ease-out-back (slight overshoot) for the ``bounce`` entrance."""
    c1 = 1.70158
    c3 = c1 + 1.0
    q = p - 1.0
    return 1.0 + c3 * q * q * q + c1 * q * q


def _entrance_progress(start: float | None, duration: float, frame_time: float) -> float:
    """Linear 0→1 progress of an entrance beginning at ``start``.

    ``start=None`` (no transcript timing available) disables the entrance —
    the caption renders fully arrived, never invisibly stuck at p=0.
    """
    if start is None or duration <= 0:
        return 1.0
    return _clamp01((frame_time - start) / duration)


def _dim(color: _RGBA, scale: float) -> _RGBA:
    """``color`` with its alpha scaled by ``scale`` (used to dim upcoming words)."""
    r, g, b, a = color
    return (r, g, b, int(a * scale))


# --- layout ------------------------------------------------------------------


@dataclass
class _TokenPlan:
    """One caption word, fully planned: glyphs, font, color, timing.

    ``font_family``/``size_px``/``italic`` record how ``font`` was loaded so
    emphasis/entrance code can request the same face at a different size.
    """

    text: str
    font: _Font
    font_family: str | None
    size_px: int
    italic: bool
    fill: _RGBA
    width: float
    ascent: int
    descent: int
    word: TranscriptWord | None
    index: int


def _transform_token(token: str, transform: str) -> str:
    if transform == "uppercase":
        return token.upper()
    if transform == "lowercase":
        return token.lower()
    return token


def _font_ascent_descent(font: _Font) -> tuple[int, int]:
    """Ascent/descent for either Pillow font flavour."""
    if isinstance(font, ImageFont.FreeTypeFont):
        return font.getmetrics()
    # Bitmap fallback font: approximate from a tall probe string.
    bbox = font.getbbox("Ag")  # pragma: no cover - FreeType is always available
    return (int(bbox[3]), 0)  # pragma: no cover


def _token_width(token: str, font: _Font, letter_spacing_px: float) -> float:
    """Token advance width including inter-character letter spacing."""
    if letter_spacing_px <= 0 or len(token) <= 1:
        return font.getlength(token)
    return sum(font.getlength(ch) for ch in token) + letter_spacing_px * (len(token) - 1)


def _draw_token_text(
    canvas: ImageDraw.ImageDraw,
    xy: tuple[float, float],
    token: str,
    font: _Font,
    fill: _RGBA,
    stroke_width: int,
    stroke_color: _RGBA | None,
    letter_spacing_px: float,
) -> None:
    """Draw ``token`` at baseline-left ``xy``, honoring letter spacing."""
    x, y = xy
    if letter_spacing_px <= 0 or len(token) <= 1:
        canvas.text(
            (x, y),
            token,
            font=font,
            fill=fill,
            anchor="ls",
            stroke_width=stroke_width,
            stroke_fill=stroke_color,
        )
        return
    cursor = x
    for ch in token:
        canvas.text(
            (cursor, y),
            ch,
            font=font,
            fill=fill,
            anchor="ls",
            stroke_width=stroke_width,
            stroke_fill=stroke_color,
        )
        cursor += font.getlength(ch) + letter_spacing_px


def _bare_token(token: str) -> str:
    """Fold a token to bare letters/digits, lowercased.

    Mirrors the web preview's ``bareToken`` so a keyword typed in the editor
    accents the same words here as it highlights there.
    """
    return "".join(ch for ch in token.lower() if ch.isalnum())


def _keyword_tokens(keyword: str) -> tuple[str, ...]:
    """Split a keyword into the bare tokens it must match consecutively."""
    return tuple(token for token in (_bare_token(part) for part in keyword.split()) if token)


def _accent_indices(
    tokens: Sequence[str], mode: str, keywords: Sequence[str] = ()
) -> frozenset[int]:
    """Deterministic accent-word selection (must match the web preview).

    ``last-word``/``longest-word`` select exactly one token. ``keywords``
    selects every token matching ``keywords``, compared case- and
    punctuation-insensitively — before schema v11 there was no keyword list to
    compare against, so this mode was a documented no-op and the editor's
    keyword chips never reached a render (ADR 0071).

    A keyword may be a PHRASE ("stop scrolling"), which accents the whole run of
    consecutive tokens that speaks it: emphasis is a unit of meaning, not a unit
    of tokenization. Longer phrases match first so an overlapping single word
    cannot claim part of a run and leave the emphasis half-applied. Mirrors
    ``accentRunIndices`` in the web preview's ``captionPreview.ts``.
    """
    if not tokens or mode == "none":
        return frozenset()
    if mode == "last-word":
        return frozenset({len(tokens) - 1})
    if mode == "longest-word":
        return frozenset({max(range(len(tokens)), key=lambda i: (len(tokens[i]), -i))})
    if mode == "keywords":
        phrases = [phrase for phrase in map(_keyword_tokens, keywords) if phrase]
        if not phrases:
            return frozenset()
        bared = [_bare_token(token) for token in tokens]
        matched: set[int] = set()
        for phrase in sorted(phrases, key=len, reverse=True):
            span = len(phrase)
            for i in range(len(bared) - span + 1):
                if tuple(bared[i : i + span]) == phrase:
                    matched.update(range(i, i + span))
        return frozenset(matched)
    return frozenset()


def _author_line_breaks(text: str) -> frozenset[int]:
    """Token indices that begin a new authored line (the ``\\n`` positions).

    Token *plans* are built from ``text.split()``, which collapses newlines along
    with every other whitespace run, so the author's break positions have to be
    recovered before that and carried separately. Schema v11 (ADR 0071): the
    editor chooses where a cue breaks, rather than each renderer's greedy fill
    deciding it independently at whatever frame size it happens to be drawing.
    """
    breaks: set[int] = set()
    index = 0
    for line in text.split("\n"):
        tokens = line.split()
        # `index > 0` rather than "not the first line": a leading newline, or any
        # empty authored line, contributes no token to break before. Emitting 0
        # would be a break before the first token, which means nothing.
        if index > 0 and tokens:
            breaks.add(index)
        index += len(tokens)
    return frozenset(breaks)


def _plan_tokens(
    text: str,
    words: Sequence[TranscriptWord],
    resolved: _ResolvedStyle,
    font_size: int,
) -> list[_TokenPlan]:
    """Build the per-word render plan for the full phrase."""
    italic = resolved.font_style == "italic"
    base_font = _load_font(resolved.font_family, font_size, resolved.font_weight, italic)
    raw_tokens = text.split()
    accented = _accent_indices(raw_tokens, resolved.accent_mode, resolved.accent_keywords)
    timed = len(words) == len(raw_tokens) and len(raw_tokens) > 0
    spacing_px = resolved.letter_spacing * font_size

    plans: list[_TokenPlan] = []
    for i, raw in enumerate(raw_tokens):
        token = _transform_token(raw, resolved.text_transform)
        font = base_font
        family = resolved.font_family
        size_px = font_size
        token_italic = italic
        fill = resolved.text_color
        if i in accented:
            size_px = max(1, int(font_size * resolved.accent_font_scale))
            family = resolved.accent_font_family or resolved.font_family
            token_italic = resolved.accent_font_style == "italic" or italic
            font = _load_font(family, size_px, resolved.font_weight, token_italic)
            if resolved.accent_color is not None:
                fill = resolved.accent_color
        ascent, descent = _font_ascent_descent(font)
        plans.append(
            _TokenPlan(
                text=token,
                font=font,
                font_family=family,
                size_px=size_px,
                italic=token_italic,
                fill=fill,
                width=_token_width(token, font, spacing_px),
                ascent=ascent,
                descent=descent,
                word=words[i] if timed else None,
                index=i,
            )
        )
    return plans


def _wrap_plans(
    plans: Sequence[_TokenPlan],
    max_width: float,
    space_width: float,
    breaks: frozenset[int] = frozenset(),
) -> list[list[_TokenPlan]]:
    """Greedy wrap of planned tokens by their measured widths.

    Mirrors :func:`wrap_lines` (a single over-long word still gets its own
    line) but works on measured plans so accent words with different fonts
    wrap correctly.

    ``breaks`` holds token indices that must START a new line — the author's
    explicit ``\\n`` positions (schema v11). They are honoured unconditionally,
    and greedy wrapping still applies *within* each authored line, so a line the
    author made too wide for the frame still fits rather than overflowing.
    """
    lines: list[list[_TokenPlan]] = []
    current: list[_TokenPlan] = []
    current_width = 0.0
    for position, plan in enumerate(plans):
        forced = position in breaks and bool(current)
        candidate = current_width + (space_width if current else 0.0) + plan.width
        if forced or (current and candidate > max_width):
            lines.append(current)
            current = [plan]
            current_width = plan.width
        else:
            current.append(plan)
            current_width = candidate
    if current:
        lines.append(current)
    return lines


# --- word drawing ------------------------------------------------------------


def _draw_karaoke_word(
    image: Image.Image,
    xy: tuple[float, float],
    word_text: str,
    font: _Font,
    base_color: _RGBA,
    fill_color: _RGBA,
    fraction: float,
    stroke_width: int,
    stroke_color: _RGBA | None,
) -> None:
    """Draw ``word_text`` with a horizontal karaoke wipe.

    ``fraction`` (0..1, the elapsed portion of the word's own time span) of
    the word's width is drawn in ``fill_color``; the remainder stays
    ``base_color`` — a progressive left-to-right fill as the word is spoken.
    ``xy`` is the tight glyph top-left (as produced by ``textbbox``).
    """
    x, y = xy
    canvas = ImageDraw.Draw(image)
    bbox = canvas.textbbox((0, 0), word_text, font=font, stroke_width=stroke_width)
    width = int(bbox[2] - bbox[0])
    height = int(bbox[3] - bbox[1])
    canvas.text(
        (x - bbox[0], y - bbox[1]),
        word_text,
        font=font,
        fill=base_color,
        stroke_width=stroke_width,
        stroke_fill=stroke_color,
    )
    if fraction <= 0.0 or width <= 0 or height <= 0:
        return
    margin = stroke_width + 1
    tile = Image.new("RGBA", (width + 2 * margin, height + 2 * margin), (0, 0, 0, 0))
    tile_draw = ImageDraw.Draw(tile)
    tile_draw.text(
        (margin - bbox[0], margin - bbox[1]),
        word_text,
        font=font,
        fill=fill_color,
        stroke_width=stroke_width,
        stroke_fill=stroke_color,
    )
    fill_width = max(1, int(width * min(1.0, fraction))) + margin
    strip = tile.crop((0, 0, fill_width, tile.height))
    image.alpha_composite(strip, (int(x) - margin, int(y) - margin))


def _draw_scaled_word(
    image: Image.Image,
    xy: tuple[float, float],
    word_text: str,
    base_font: _Font,
    scaled_font: _Font,
    color: _RGBA,
    stroke_width: int,
    stroke_color: _RGBA | None,
) -> None:
    """Draw ``word_text`` in ``scaled_font``, centered on its normal-size slot.

    Used for the ``pop``/``pulse`` emphasis and the ``zoom``/``bounce``
    per-word entrances: the word renders at a different size but stays
    centered on the position the normal-size word would occupy at ``xy``
    (tight glyph top-left). It may slightly overlap neighbors mid-animation —
    acceptable for short-lived motion.
    """
    canvas = ImageDraw.Draw(image)
    base_bbox = canvas.textbbox((0, 0), word_text, font=base_font, stroke_width=stroke_width)
    scaled_bbox = canvas.textbbox((0, 0), word_text, font=scaled_font, stroke_width=stroke_width)
    base_cx = xy[0] - base_bbox[0] + (base_bbox[2] - base_bbox[0]) / 2
    base_cy = xy[1] - base_bbox[1] + (base_bbox[3] - base_bbox[1]) / 2
    scaled_w = scaled_bbox[2] - scaled_bbox[0]
    scaled_h = scaled_bbox[3] - scaled_bbox[1]
    canvas.text(
        (base_cx - scaled_w / 2 - scaled_bbox[0], base_cy - scaled_h / 2 - scaled_bbox[1]),
        word_text,
        font=scaled_font,
        fill=color,
        stroke_width=stroke_width,
        stroke_fill=stroke_color,
    )


def _draw_word_glow(
    image: Image.Image,
    xy_baseline: tuple[float, float],
    plan: _TokenPlan,
    color: _RGBA,
    blur_radius: float,
    letter_spacing_px: float,
) -> None:
    """Composite a blurred copy of the word under its position (glow emphasis)."""
    pad = int(blur_radius * 3) + 2
    tile = Image.new(
        "RGBA",
        (int(plan.width) + 2 * pad, plan.ascent + plan.descent + 2 * pad),
        (0, 0, 0, 0),
    )
    _draw_token_text(
        ImageDraw.Draw(tile),
        (pad, pad + plan.ascent),
        plan.text,
        plan.font,
        color,
        0,
        None,
        letter_spacing_px,
    )
    tile = tile.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    x, y_baseline = xy_baseline
    image.alpha_composite(tile, (int(x) - pad, int(y_baseline) - plan.ascent - pad))


@dataclass(frozen=True)
class _WordMotion:
    """Per-word, per-frame animation parameters."""

    alpha: float = 1.0
    dy: float = 0.0
    scale: float = 1.0
    reveal: float = 1.0  # fraction of characters shown (typewriter)


def _word_motion(
    plan: _TokenPlan,
    resolved: _ResolvedStyle,
    frame_time: float,
    block_start: float | None,
    font_size: int,
) -> _WordMotion:
    """Entrance + loop motion for one word at ``frame_time``.

    The entrance anchor is the word's own start when ``perWord`` (each word
    animates in as it is spoken), otherwise the block's first word — so a
    whole line arrives together.
    """
    start = plan.word.start if resolved.per_word and plan.word is not None else block_start
    p = _entrance_progress(start, resolved.entrance_duration, frame_time)

    alpha, dy, scale, reveal = 1.0, 0.0, 1.0, 1.0
    entrance = resolved.entrance
    if entrance == "fade":
        alpha = p
    elif entrance == "slide-up":
        alpha = p
        dy = (1.0 - p) * _SLIDE_FRACTION * font_size
    elif entrance == "zoom":
        alpha = p
        scale = _ZOOM_START + (1.0 - _ZOOM_START) * p
    elif entrance == "bounce":
        alpha = min(1.0, p * 2.0)
        scale = max(0.01, _ZOOM_START + (1.0 - _ZOOM_START) * _ease_out_back(p))
    elif entrance == "typewriter":
        reveal = p

    if resolved.loop == "wave":
        phase = 2.0 * math.pi * (frame_time / resolved.loop_period)
        dy += _WAVE_DEPTH * font_size * math.sin(phase + plan.index * _WAVE_PHASE_STEP)

    return _WordMotion(alpha=alpha, dy=dy, scale=scale, reveal=reveal)


# --- whole-image transforms --------------------------------------------------


def _apply_alpha(image: Image.Image, factor: float) -> Image.Image:
    """Scale the image's alpha channel by ``factor`` (entrance fades)."""
    if factor >= 1.0:
        return image
    arr = np.asarray(image, dtype=np.uint8).copy()
    arr[:, :, 3] = (arr[:, :, 3].astype(np.float64) * max(0.0, factor)).astype(np.uint8)
    return Image.fromarray(arr)


def _shift(image: Image.Image, dy: float) -> Image.Image:
    """Shift the image content vertically by ``dy`` pixels (slide entrances)."""
    if abs(dy) < 0.5:
        return image
    shifted = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shifted.alpha_composite(image, (0, round(dy)))
    return shifted


def _resize_about_center(image: Image.Image, scale: float) -> Image.Image:
    """Resize the image content about its center (zoom/bounce/pulse)."""
    if abs(scale - 1.0) < 1e-3:
        return image
    w, h = image.size
    new_w = max(1, round(w * scale))
    new_h = max(1, round(h * scale))
    resized = image.resize((new_w, new_h), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.alpha_composite(resized, ((w - new_w) // 2, (h - new_h) // 2))
    return out


def _tint_alpha(image: Image.Image, color: _RGBA) -> Image.Image:
    """A monochrome copy of ``image``: ``color`` carried by the image's alpha."""
    alpha = np.asarray(image, dtype=np.uint8)[:, :, 3].astype(np.float64) / 255.0
    r, g, b, a = color
    out = np.zeros((image.size[1], image.size[0], 4), dtype=np.uint8)
    out[:, :, 0] = r
    out[:, :, 1] = g
    out[:, :, 2] = b
    out[:, :, 3] = (alpha * a).astype(np.uint8)
    return Image.fromarray(out)


# --- the styled renderer -----------------------------------------------------


def _visible_indices(plans: Sequence[_TokenPlan], display: str, frame_time: float) -> set[int]:
    """Which words are on screen at ``frame_time`` for the display mode.

    Requires timed plans for the non-phrase modes (the caller falls back to
    ``phrase`` otherwise). ``active-word`` shows the currently spoken word,
    holding the last spoken one through gaps (never a blank frame mid-clip);
    ``cumulative`` shows every word that has started.
    """
    if display == "active-word":
        active = [
            p.index
            for p in plans
            if p.word is not None and _word_state(p.word, frame_time) == "active"
        ]
        if active:
            return {active[0]}
        spoken = [
            p.index
            for p in plans
            if p.word is not None and _word_state(p.word, frame_time) == "spoken"
        ]
        if spoken:
            return {spoken[-1]}
        return {plans[0].index}
    if display == "cumulative":
        return {p.index for p in plans if p.word is not None and p.word.start <= frame_time}
    return {p.index for p in plans}


def _render_styled_caption_image(
    text: str,
    frame_width: int,
    frame_height: int,
    style: CaptionStyle,
    words: Sequence[TranscriptWord],
    frame_time: float,
) -> np.ndarray:
    """Render ``text`` via the data-driven template interpreter (schema v10).

    Layout is computed once from the FULL phrase (canvas-size invariant, see
    module docstring); the display mode then selects which planned words are
    drawn at ``frame_time``, the emphasis interpreter styles the active word,
    and entrance/loop math perturbs per-word or whole-image geometry.
    """
    resolved = _resolve_style(style)
    font_size = max(_MIN_FONT_SIZE, int(frame_height * _FONT_HEIGHT_FRACTION * resolved.font_scale))
    spacing_px = resolved.letter_spacing * font_size
    stroke = resolved.outline_width
    plans = _plan_tokens(text, words, resolved, font_size)
    timed = bool(plans) and plans[0].word is not None
    display = resolved.display if timed or resolved.display == "phrase" else "phrase"

    base_font = _load_font(
        resolved.font_family,
        font_size,
        resolved.font_weight,
        resolved.font_style == "italic",
    )
    space_width = base_font.getlength(" ")

    pad_x = int(font_size * resolved.box_pad_x)
    pad_y = int(font_size * resolved.box_pad_y)
    max_text_width = max(
        font_size,
        int(frame_width * min(1.0, max(0.05, resolved.max_width_percent / 100.0))) - 2 * pad_x,
    )
    lines = _wrap_plans(plans, max_text_width, space_width, _author_line_breaks(text))

    line_dims: list[tuple[float, int, int]] = []  # (width, ascent, descent) per line
    for line in lines:
        width = sum(p.width for p in line) + space_width * (len(line) - 1)
        ascent = max(p.ascent for p in line) + stroke
        descent = max(p.descent for p in line) + stroke
        line_dims.append((width, ascent, descent))
    line_gap = (
        max(0, int(font_size * (resolved.line_height - 1.0)))
        if resolved.line_height is not None
        else max(1, font_size // 6)
    )
    block_w = int(max(w for w, _, _ in line_dims))
    block_h = sum(a + d for _, a, d in line_dims) + line_gap * (len(lines) - 1)

    # Outer margin: room for scaled emphasis/entrances, wave bob, slide
    # offsets, glow tiles and the shadow so nothing clips at the canvas edge.
    max_scale = max(_POP_SCALE, resolved.highlight_scale)
    margin = int(font_size * (max_scale - 1.0)) + stroke + 2
    if resolved.loop == "wave":
        margin += int(_WAVE_DEPTH * font_size) + 1
    if resolved.entrance == "slide-up":
        margin += int(_SLIDE_FRACTION * font_size) + 1
    if resolved.highlight_animation == "glow":
        margin += int(_GLOW_BLUR_FRACTION * font_size * 3) + 2
    if resolved.shadow_color is not None:
        margin += (
            int(
                (
                    resolved.shadow_blur * 3
                    + max(abs(resolved.shadow_offset_x), abs(resolved.shadow_offset_y))
                )
                * font_size
            )
            + 2
        )

    canvas_w = block_w + 2 * pad_x + 2 * margin
    canvas_h = block_h + 2 * pad_y + 2 * margin

    image = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    if resolved.box_fill[3] > 0:
        ImageDraw.Draw(image).rounded_rectangle(
            (margin, margin, margin + block_w + 2 * pad_x - 1, margin + block_h + 2 * pad_y - 1),
            radius=int(resolved.box_radius * font_size),
            fill=resolved.box_fill,
        )

    visible = _visible_indices(plans, display, frame_time)
    block_start = min((p.word.start for p in plans if p.word is not None), default=None)

    text_layer = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    y_cursor = float(margin + pad_y)
    for line, (line_width, line_ascent, line_descent) in zip(lines, line_dims, strict=True):
        baseline = y_cursor + line_ascent
        if resolved.text_align == "left":
            x_cursor = float(margin + pad_x)
        elif resolved.text_align == "right":
            x_cursor = margin + pad_x + block_w - line_width
        else:
            x_cursor = margin + pad_x + (block_w - line_width) / 2
        for plan in line:
            if plan.index in visible:
                motion = _word_motion(plan, resolved, frame_time, block_start, font_size)
                _draw_planned_word(
                    text_layer,
                    plan,
                    x_cursor,
                    baseline,
                    resolved,
                    frame_time,
                    motion,
                    spacing_px,
                    font_size,
                )
            x_cursor += plan.width + space_width
        y_cursor += line_ascent + line_descent + line_gap

    if resolved.shadow_color is not None:
        shadow = _tint_alpha(text_layer, resolved.shadow_color)
        blur_px = resolved.shadow_blur * font_size
        if blur_px > 0:
            shadow = shadow.filter(ImageFilter.GaussianBlur(radius=blur_px))
        offset = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        offset.alpha_composite(
            shadow,
            (
                round(resolved.shadow_offset_x * font_size),
                round(resolved.shadow_offset_y * font_size),
            ),
        )
        image.alpha_composite(offset)
    image.alpha_composite(text_layer)

    if resolved.entrance is not None and not resolved.per_word:
        p = _entrance_progress(block_start, resolved.entrance_duration, frame_time)
        if p < 1.0:
            if resolved.entrance in ("fade", "typewriter"):
                image = _apply_alpha(image, p)
            elif resolved.entrance == "slide-up":
                image = _apply_alpha(_shift(image, (1.0 - p) * _SLIDE_FRACTION * font_size), p)
            elif resolved.entrance == "zoom":
                image = _apply_alpha(
                    _resize_about_center(image, _ZOOM_START + (1.0 - _ZOOM_START) * p), p
                )
            else:  # bounce
                scale = max(0.01, _ZOOM_START + (1.0 - _ZOOM_START) * _ease_out_back(p))
                image = _apply_alpha(_resize_about_center(image, scale), min(1.0, p * 2.0))

    if resolved.loop == "pulse":
        phase = 2.0 * math.pi * (frame_time / resolved.loop_period)
        image = _resize_about_center(image, 1.0 + _PULSE_DEPTH * math.sin(phase))

    return np.asarray(image, dtype=np.uint8)


def _draw_planned_word(
    layer: Image.Image,
    plan: _TokenPlan,
    x: float,
    baseline: float,
    resolved: _ResolvedStyle,
    frame_time: float,
    motion: _WordMotion,
    spacing_px: float,
    font_size: int,
) -> None:
    """Draw one planned word with its state, emphasis and motion applied."""
    if motion.reveal <= 0.0 or motion.alpha <= 0.0:
        return
    token = plan.text
    if motion.reveal < 1.0:
        # ceil of a positive product is >= 1, so at least one char is shown
        # (reveal <= 0 already returned above).
        token = token[: math.ceil(len(token) * motion.reveal)]

    canvas = ImageDraw.Draw(layer)
    baseline += motion.dy
    stroke = resolved.outline_width
    state = (
        _word_state(plan.word, frame_time)
        if plan.word is not None and resolved.highlight_enabled
        else None
    )
    emphasis = resolved.highlight_animation if state == "active" else "none"
    fill = plan.fill
    if state == "upcoming" and resolved.display == "phrase":
        fill = _dim(fill, _UPCOMING_ALPHA_SCALE)
    if motion.alpha < 1.0:
        fill = _dim(fill, motion.alpha)

    if emphasis == "color":
        _draw_token_text(
            canvas,
            (x, baseline),
            token,
            plan.font,
            resolved.highlight_color,
            stroke,
            resolved.outline_color,
            spacing_px,
        )
        return
    if emphasis in ("pop", "pulse"):
        if emphasis == "pop":
            scale = resolved.highlight_scale
        else:
            assert plan.word is not None  # state == "active" implies a timed word
            pulse_phase = (frame_time - plan.word.start) / 0.6
            scale = 1.0 + (resolved.highlight_scale - 1.0) * 0.5 * (
                1.0 + math.sin(2.0 * math.pi * pulse_phase)
            )
        scaled_font = _load_font(
            plan.font_family, max(1, int(plan.size_px * scale)), resolved.font_weight, plan.italic
        )
        _draw_scaled_word(
            layer,
            (x, baseline - plan.ascent),
            token,
            plan.font,
            scaled_font,
            resolved.highlight_color,
            stroke,
            resolved.outline_color,
        )
        return
    if emphasis == "karaoke-fill":
        assert plan.word is not None
        span = plan.word.end - plan.word.start
        fraction = (frame_time - plan.word.start) / span if span > 0 else 1.0
        _draw_karaoke_word(
            layer,
            (x, baseline - plan.ascent),
            token,
            plan.font,
            fill,
            resolved.highlight_color,
            fraction,
            stroke,
            resolved.outline_color,
        )
        return
    if emphasis == "background":
        chip_pad = _WORD_CHIP_PAD * font_size
        chip_color = resolved.highlight_background or _DEFAULT_HIGHLIGHT_COLOR
        canvas.rounded_rectangle(
            (
                x - chip_pad,
                baseline - plan.ascent - chip_pad,
                x + plan.width + chip_pad,
                baseline + plan.descent + chip_pad,
            ),
            radius=int(0.15 * font_size),
            fill=chip_color,
        )
        _draw_token_text(
            canvas,
            (x, baseline),
            token,
            plan.font,
            resolved.highlight_color,
            stroke,
            resolved.outline_color,
            spacing_px,
        )
        return
    if emphasis == "glow":
        _draw_word_glow(
            layer,
            (x, baseline),
            plan,
            resolved.highlight_color,
            _GLOW_BLUR_FRACTION * font_size,
            spacing_px,
        )
        _draw_token_text(
            canvas,
            (x, baseline),
            token,
            plan.font,
            resolved.highlight_color,
            stroke,
            resolved.outline_color,
            spacing_px,
        )
        return
    if emphasis == "underline":
        _draw_token_text(
            canvas,
            (x, baseline),
            token,
            plan.font,
            resolved.highlight_color,
            stroke,
            resolved.outline_color,
            spacing_px,
        )
        thickness = max(2, font_size // 12)
        gap = max(2, font_size // 10)
        canvas.rectangle(
            (x, baseline + gap, x + plan.width, baseline + gap + thickness),
            fill=resolved.highlight_color,
        )
        return

    # No emphasis (or word not active): motion scale still applies (zoom/bounce
    # per-word entrances render through the scaled-word path).
    if abs(motion.scale - 1.0) > 1e-3:
        scaled_font = _load_font(
            plan.font_family,
            max(1, int(plan.size_px * motion.scale)),
            resolved.font_weight,
            plan.italic,
        )
        _draw_scaled_word(
            layer,
            (x, baseline - plan.ascent),
            token,
            plan.font,
            scaled_font,
            fill,
            stroke,
            resolved.outline_color,
        )
        return
    _draw_token_text(
        canvas, (x, baseline), token, plan.font, fill, stroke, resolved.outline_color, spacing_px
    )
