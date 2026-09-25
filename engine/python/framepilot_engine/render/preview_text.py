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
from collections.abc import Mapping, Sequence
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
    #: Whether the raster changes with the frame time (a styled caption's motion, word states).
    #: ``False`` means one raster serves the cue's whole duration.
    animated: bool = False
    #: A frosted-glass chip's coverage (``uint8``, same size as ``rgba``): where the delivered
    #: picture behind the caption is replaced by its Gaussian blur. ``None`` without a frost.
    backdrop: np.ndarray | None = None
    #: The frost's Gaussian standard deviation, in output pixels (Pillow ``GaussianBlur``).
    backdrop_sigma_px: float = 0.0

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

    def backdrop_base64(self) -> str | None:
        if self.backdrop is None:
            return None
        return base64.b64encode(
            np.ascontiguousarray(self.backdrop, dtype=np.uint8).tobytes()
        ).decode("ascii")


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


#: Most timed words a cue may carry; the segmenter's widest preset writes 14.
MAX_CUE_WORDS = 400


def _mask_bytes(mask: np.ndarray) -> np.ndarray:
    """A MoviePy mask frame (0..1 floats) as the 0..255 alpha the preview composites."""
    return np.asarray(np.round(np.clip(mask, 0.0, 1.0) * 255.0), dtype=np.uint8)


def styled_caption_raster(
    *,
    text: str,
    words: Sequence[Mapping[str, Any]],
    track_style: Mapping[str, Any] | None,
    clip_style: Mapping[str, Any] | None,
    clip_start: float,
    clip_end: float,
    frame_width: int,
    frame_height: int,
    frame_time: float,
) -> PreviewTextRaster:
    """A styled caption at ``frame_time``: the export's own caption layer, sampled at one frame.

    WHY not a separate renderer: the monitor drew styled captions as HTML over the canvas, and
    that second rendering drifted from the export in placement and wrapping (run ``fb90e58d``:
    three rows in the editor, two in the export). This builds the caption through
    :func:`~framepilot_engine.render.compiler.caption_layer_for` — the layer the compiler
    composites, with its motion, rotation and placement — and reads the frame the export would
    draw: the pixels, the mask as alpha, the paste position, and a frosted chip's coverage.

    :param text: The cue's resolved text.
    :param words: The cue's timed words (``word``, ``start``, ``end``), in timeline seconds.
    :param track_style: The caption track's default style, as the project stores it.
    :param clip_style: The cue's own style override.
    :param clip_start: The cue's start on the timeline, in seconds.
    :param clip_end: The cue's end on the timeline, in seconds.
    :param frame_width: Output frame width in pixels.
    :param frame_height: Output frame height in pixels.
    :param frame_time: Timeline seconds of the frame being drawn.
    :raises PreviewTextError: On empty or oversized text, a bad frame size, an empty cue span,
        too many words, or a style the schema rejects.
    """
    from pydantic import ValidationError

    from framepilot_engine.render.caption_templates import layer_caption_style
    from framepilot_engine.render.captions import caption_style_is_animated
    from framepilot_engine.render.compiler import caption_layer_for
    from framepilot_engine.render.resources import close_clip_tree
    from framepilot_engine.timeline.models import CaptionStyle, Clip, TranscriptWord

    _check_frame(frame_width, frame_height)
    _check_text(text)
    if not (clip_end > clip_start):
        raise PreviewTextError(f"Caption span {clip_start}..{clip_end} is empty.")
    if len(words) > MAX_CUE_WORDS:
        raise PreviewTextError(f"A cue carries at most {MAX_CUE_WORDS} words.")
    try:
        track = CaptionStyle.model_validate(dict(track_style)) if track_style else None
        clip = Clip.model_validate(
            {
                "id": "preview_caption",
                "assetId": "__caption__",
                "trackId": "preview_captions",
                "start": clip_start,
                "end": clip_end,
                "sourceStart": 0.0,
                "sourceEnd": clip_end - clip_start,
                "effects": [],
                **({"captionStyle": dict(clip_style)} if clip_style else {}),
            }
        )
        timed = [TranscriptWord.model_validate(dict(word)) for word in words]
    except ValidationError as exc:
        raise PreviewTextError(f"Invalid caption style or words: {exc.errors()[:3]}") from exc
    style = layer_caption_style(track, clip.caption_style)
    layer = caption_layer_for(clip, text, style, timed, (frame_width, frame_height))
    # Clip-local time, kept inside the cue the way the export's composite only ever asks.
    duration = clip_end - clip_start
    local = min(max(frame_time - clip_start, 0.0), max(duration - 1e-6, 0.0))
    try:
        picture = layer.picture
        rgb = np.asarray(picture.get_frame(local), dtype=np.uint8)
        alpha = _mask_bytes(np.asarray(picture.mask.get_frame(local), dtype=np.float64))
        x, y = picture.pos(local)
        backdrop = (
            None
            if layer.backdrop is None
            else _mask_bytes(np.asarray(layer.backdrop.mask.get_frame(local), dtype=np.float64))
        )
    finally:
        close_clip_tree(layer.picture)
        if layer.backdrop is not None:
            close_clip_tree(layer.backdrop)
    return PreviewTextRaster(
        rgba=np.ascontiguousarray(np.dstack([rgb[:, :, :3], alpha])),
        x=int(x),
        y=int(y),
        animated=style is not None and caption_style_is_animated(style),
        backdrop=backdrop,
        backdrop_sigma_px=float(layer.backdrop_sigma_px) if backdrop is not None else 0.0,
    )
