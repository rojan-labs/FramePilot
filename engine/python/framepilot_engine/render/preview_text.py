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
import hashlib
import json
import logging
import struct
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from framepilot_engine.render.captions import render_caption_image
from framepilot_engine.render.composition_cache import CompositionCache
from framepilot_engine.render.shape_catalog import shape_params_problem
from framepilot_engine.render.shape_raster import rasterize_shape
from framepilot_engine.render.text_overlay import rasterize_text_overlay
from framepilot_engine.timeline.synthetic_assets import CAPTION_ASSET_ID

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
    params: Mapping[str, Any], frame_width: int, frame_height: int, *, rotates: bool = False
) -> PreviewTextRaster:
    """A text clip's raster (its ``text`` effect params) for a ``frame_width`` x ``frame_height``
    output. Placement stays with the frame plan: the layer is centred at ``xPercent/yPercent``
    and transformed like any picture.

    :param rotates: the clip animates rotation: the rotation-safe square the export draws.
    :raises PreviewTextError: If the text is empty or too long, or the frame size is invalid.
    """
    _check_frame(frame_width, frame_height)
    raw = params.get("text")
    text = "" if raw is None else str(raw)
    _check_text(text)
    rgba = rasterize_text_overlay(text, params, frame_width, frame_height, rotates=rotates)
    return PreviewTextRaster(rgba=rgba, x=None, y=None)


def shape_raster(
    params: Mapping[str, Any], frame_width: int, frame_height: int, *, rotates: bool = False
) -> PreviewTextRaster:
    """A shape's raster (its ``shape`` effect params) and the frame pixel its top-left sits at
    before the clip's transform: exactly what the export composites (plan/elements EL4a).

    :param rotates: the clip animates ``rotation`` (the raster is then the rotation-safe square).
    :raises PreviewTextError: If the params cannot be drawn, or the frame size is invalid.
    """
    _check_frame(frame_width, frame_height)
    problem = shape_params_problem(params)
    if problem is not None:
        raise PreviewTextError(problem)
    image, bounds = rasterize_shape(params, frame_width, frame_height, rotates=rotates)
    return PreviewTextRaster(rgba=np.asarray(image, dtype=np.uint8), x=bounds.x, y=bounds.y)


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


#: Built caption layers kept for the monitor (a cue is sampled at many frames, scrubbed back and
#: forth, and prefetched in windows; building its layer is 5-120 ms, sampling a frame 5-25 ms).
#: A caption layer holds no media readers, only Pillow rasters, so eight are a few megabytes.
MAX_CACHED_CAPTION_LAYERS = 8
#: Most frame times one ``styled_caption_frames`` call samples (the monitor asks in windows).
MAX_CAPTION_FRAMES = 120
#: Bytes of distinct rasters one call returns; the frames past it are left for a later call.
MAX_CAPTION_FRAMES_BYTES = 64 * 1024 * 1024

CAPTION_LAYER_CACHE = CompositionCache(
    MAX_CACHED_CAPTION_LAYERS,
    max_concurrent_builds=2,
    name="caption layer",
    hit_log_level=logging.DEBUG,
)


class _CaptionLayerHolder:
    """A built caption layer as the cache lends it; ``close_clip_tree`` closes both clips.

    ``animated`` is whether its raster moves with the frame time (one sample serves a still cue).
    """

    def __init__(self, layer: Any, animated: bool) -> None:
        self.layer = layer
        self.animated = animated
        self._framepilot_children = [
            child for child in (layer.picture, layer.backdrop) if child is not None
        ]


@dataclass(frozen=True)
class PreviewCaptionFrames:
    """A styled cue sampled at several frames: its distinct rasters and which one each frame is.

    ``index[i]`` is the raster drawn at the ``i``-th requested frame time. It is shorter than the
    request when :data:`MAX_CAPTION_FRAMES_BYTES` ran out; the caller asks for the rest later.
    """

    rasters: tuple[PreviewTextRaster, ...]
    index: tuple[int, ...]
    animated: bool


def _caption_layer_key(
    text: str,
    words: Sequence[Mapping[str, Any]],
    track_style: Mapping[str, Any] | None,
    clip_style: Mapping[str, Any] | None,
    clip_start: float,
    clip_end: float,
    frame_width: int,
    frame_height: int,
) -> str:
    """Everything that changes a styled cue's layer, and nothing that only picks its frame."""
    payload = json.dumps(
        [
            text,
            [dict(word) for word in words],
            dict(track_style) if track_style else None,
            dict(clip_style) if clip_style else None,
            clip_start,
            clip_end,
            frame_width,
            frame_height,
        ],
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _check_styled_request(
    text: str,
    words: Sequence[Mapping[str, Any]],
    clip_start: float,
    clip_end: float,
    frame_width: int,
    frame_height: int,
) -> None:
    _check_frame(frame_width, frame_height)
    _check_text(text)
    if not (clip_end > clip_start):
        raise PreviewTextError(f"Caption span {clip_start}..{clip_end} is empty.")
    if len(words) > MAX_CUE_WORDS:
        raise PreviewTextError(f"A cue carries at most {MAX_CUE_WORDS} words.")


def _build_caption_layer(
    text: str,
    words: Sequence[Mapping[str, Any]],
    track_style: Mapping[str, Any] | None,
    clip_style: Mapping[str, Any] | None,
    clip_start: float,
    clip_end: float,
    frame_width: int,
    frame_height: int,
) -> _CaptionLayerHolder:
    """The export's caption layer for one cue, and whether its raster moves with the frame."""
    from pydantic import ValidationError

    from framepilot_engine.render.caption_templates import layer_caption_style
    from framepilot_engine.render.captions import caption_style_is_animated
    from framepilot_engine.render.compiler import caption_layer_for
    from framepilot_engine.timeline.models import CaptionStyle, Clip, TranscriptWord

    try:
        track = CaptionStyle.model_validate(dict(track_style)) if track_style else None
        clip = Clip.model_validate(
            {
                "id": "preview_caption",
                "assetId": CAPTION_ASSET_ID,
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
    return _CaptionLayerHolder(layer, style is not None and caption_style_is_animated(style))


def _sample_caption_layer(
    holder: _CaptionLayerHolder, local: float, animated: bool
) -> PreviewTextRaster:
    """The frame the export draws at clip-local ``local``: pixels, mask as alpha, paste position."""
    layer = holder.layer
    picture = layer.picture
    rgb = np.asarray(picture.get_frame(local), dtype=np.uint8)
    alpha = _mask_bytes(np.asarray(picture.mask.get_frame(local), dtype=np.float64))
    x, y = picture.pos(local)
    backdrop = (
        None
        if layer.backdrop is None
        else _mask_bytes(np.asarray(layer.backdrop.mask.get_frame(local), dtype=np.float64))
    )
    return PreviewTextRaster(
        rgba=np.ascontiguousarray(np.dstack([rgb[:, :, :3], alpha])),
        x=int(x),
        y=int(y),
        animated=animated,
        backdrop=backdrop,
        backdrop_sigma_px=float(layer.backdrop_sigma_px) if backdrop is not None else 0.0,
    )


def _local_time(frame_time: float, clip_start: float, clip_end: float) -> float:
    """Clip-local time, kept inside the cue the way the export's composite only ever asks."""
    duration = clip_end - clip_start
    return min(max(frame_time - clip_start, 0.0), max(duration - 1e-6, 0.0))


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

    The built layer is borrowed from :data:`CAPTION_LAYER_CACHE`, so scrubbing through a cue
    builds it once rather than per frame.

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
    frames = styled_caption_frames(
        text=text,
        words=words,
        track_style=track_style,
        clip_style=clip_style,
        clip_start=clip_start,
        clip_end=clip_end,
        frame_width=frame_width,
        frame_height=frame_height,
        frame_times=[frame_time],
    )
    return frames.rasters[frames.index[0]]


def styled_caption_frames(
    *,
    text: str,
    words: Sequence[Mapping[str, Any]],
    track_style: Mapping[str, Any] | None,
    clip_style: Mapping[str, Any] | None,
    clip_start: float,
    clip_end: float,
    frame_width: int,
    frame_height: int,
    frame_times: Sequence[float],
) -> PreviewCaptionFrames:
    """A styled cue at each of ``frame_times``, from ONE build of its layer.

    WHY: every one of the 68 templates is time-varying (word states, entrances, loops), so the
    monitor needs a raster per frame. Asking once per frame paid the layer build on every frame
    and a round trip each, and the monitor held its whole picture while one was out: the preview
    froze at nearly every cue. Sampling a window here pays the build once, and identical frames
    (a still word state, a cue at rest) are sent once: a cue of 84 frames has a median of 12
    distinct rasters across the templates.

    Each frame is exactly :func:`styled_caption_raster` at that time: the same layer, the same
    ``get_frame``.

    :param frame_times: Timeline seconds of the frames wanted, at most :data:`MAX_CAPTION_FRAMES`.
    :raises PreviewTextError: As :func:`styled_caption_raster`, or on no or too many frame times.
    """
    _check_styled_request(text, words, clip_start, clip_end, frame_width, frame_height)
    if not frame_times:
        raise PreviewTextError("Ask for at least one caption frame.")
    if len(frame_times) > MAX_CAPTION_FRAMES:
        raise PreviewTextError(f"Ask for at most {MAX_CAPTION_FRAMES} caption frames at once.")
    key = _caption_layer_key(
        text, words, track_style, clip_style, clip_start, clip_end, frame_width, frame_height
    )

    def build() -> _CaptionLayerHolder:
        return _build_caption_layer(
            text, words, track_style, clip_style, clip_start, clip_end, frame_width, frame_height
        )

    rasters: list[PreviewTextRaster] = []
    index: list[int] = []
    seen: dict[bytes, int] = {}
    total_bytes = 0
    with CAPTION_LAYER_CACHE.borrow(key, build) as holder:
        animated = holder.animated
        for frame_time in frame_times:
            if not animated and rasters:
                index.append(0)
                continue
            raster = _sample_caption_layer(
                holder, _local_time(frame_time, clip_start, clip_end), animated
            )
            digest = _raster_digest(raster)
            found = seen.get(digest)
            if found is not None:
                index.append(found)
                continue
            size = raster.rgba.nbytes + (0 if raster.backdrop is None else raster.backdrop.nbytes)
            if rasters and total_bytes + size > MAX_CAPTION_FRAMES_BYTES:
                break
            seen[digest] = len(rasters)
            index.append(len(rasters))
            rasters.append(raster)
            total_bytes += size
    return PreviewCaptionFrames(rasters=tuple(rasters), index=tuple(index), animated=animated)


def _raster_digest(raster: PreviewTextRaster) -> bytes:
    """Identity of a sampled caption frame: its pixels, coverage, size and paste position."""
    digest = hashlib.blake2b(digest_size=16)
    digest.update(f"{raster.width}x{raster.height}@{raster.x},{raster.y}".encode("ascii"))
    digest.update(np.ascontiguousarray(raster.rgba, dtype=np.uint8).tobytes())
    if raster.backdrop is not None:
        digest.update(b"|backdrop|")
        digest.update(np.ascontiguousarray(raster.backdrop, dtype=np.uint8).tobytes())
    return digest.digest()


def encode_caption_frames(frames: PreviewCaptionFrames) -> bytes:
    """The binary body of ``POST /preview/caption-frames``.

    Layout: a big-endian ``uint32`` header length, the header as UTF-8 JSON, then the raw bytes
    the header's ``[offset, length]`` pairs point into (offsets from the end of the header). Raw
    because a window of a karaoke cue is tens of megabytes of RGBA, and base64 inside JSON cost a
    third more bytes plus an encode, a parse and a decode of all of them.
    """
    chunks: list[bytes] = []
    offset = 0
    described: list[dict[str, Any]] = []

    def put(data: np.ndarray) -> list[int]:
        nonlocal offset
        raw = np.ascontiguousarray(data, dtype=np.uint8).tobytes()
        chunks.append(raw)
        span = [offset, len(raw)]
        offset += len(raw)
        return span

    for raster in frames.rasters:
        described.append(
            {
                "width": raster.width,
                "height": raster.height,
                "x": raster.x,
                "y": raster.y,
                "rgba": put(raster.rgba),
                "backdrop": None if raster.backdrop is None else put(raster.backdrop),
                "backdrop_sigma_px": raster.backdrop_sigma_px,
            }
        )
    header = json.dumps(
        {"animated": frames.animated, "index": list(frames.index), "rasters": described},
        separators=(",", ":"),
    ).encode("utf-8")
    return b"".join([struct.pack(">I", len(header)), header, *chunks])
