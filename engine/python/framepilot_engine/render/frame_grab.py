"""Render ONE composited frame of a project timeline, as image bytes.

WHY this exists: the AI can read the timeline, the transcript and every analysis
result, and still not know what the edit *looks like*. A caption that overflows
the safe area, a punch-in that crops someone's head off, a title sitting on a
busy background, a transform the model set from numbers alone — none of these
are visible in any JSON. They are visible in a picture, and this is how the
model gets one (see the ``get_frame`` tool in ``@framepilot/ai-sdk``).

WHY it goes through the real compiler: a frame drawn by any other code path
would be a *second* renderer, and the moment it disagreed with the export the
model would be checking its work against something no viewer will ever see. This
composites through :func:`compile_timeline` — the same function the export uses
— so what the model inspects is what the render produces. Captions are burned in
by default for exactly that reason: soft captions are invisible in a frame, and
"do the captions look right?" is the single most common thing worth looking at.

WHY it compiles only the clips on screen: compiling the whole timeline opened a reader for
every clip to show the two or three playing at one instant — 26s cold for a 60s, 26-clip
edit, 24-45s per look in a desktop run. The same compiler is asked for the clips that can be
playing at that instant (:mod:`framepilot_engine.render.picture_window`), and a layer that is
not playing contributes nothing to a composited frame, so the frame is the export's to the
pixel. Projects the window cannot reproduce exactly (blend modes, track mattes) and instants
where no picture plays still composite everything.

WHY it is downscaled and JPEG by default: the frame is sent to a model as base64
inside a prompt. A 1080x1920 PNG is megabytes of context for a question a
512-pixel-wide JPEG answers just as well, and the token cost of an image scales
with its pixels. The caller may ask for more when it genuinely needs detail.

WHY there is a ``lossless`` mode: the preview/export parity oracle (PX4 in
``plan/background-removal-ai/09-PREVIEW-EXPORT-PARITY.md``) compares the preview's canvas
with the export's frame pixel by pixel, at the project's own resolution. A downscaled or
JPEG frame would hide exactly the half-pixel, colour and edge differences it exists to find.
It is an explicit opt-in so the model-facing defaults and ceiling above stay as they are.
"""

from __future__ import annotations

import base64
import io
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from framepilot_engine.media.assets import AssetIndex, index_assets
from framepilot_engine.render.compiler import (
    PictureWindowMiss,
    compile_timeline,
    timeline_duration,
)
from framepilot_engine.render.composition_cache import (
    COMPOSITION_CACHE,
    FRAME_WINDOW_CACHE,
    composition_key,
)
from framepilot_engine.render.picture_window import PictureWindow, picture_window_at
from framepilot_engine.render.presets import ExportPreset
from framepilot_engine.timeline.models import Project

_log = logging.getLogger(__name__)

#: Default longest edge (pixels) of a returned frame. Small on purpose — see the
#: module note on what a frame costs once it is base64 in a prompt.
DEFAULT_MAX_DIMENSION = 512
#: Hard ceiling a caller may request. Above this the image stops answering
#: questions better and starts crowding the model's context out of the window.
MAX_ALLOWED_DIMENSION = 1280
#: JPEG quality for the default (lossy) format. High enough that caption edges
#: and small text stay legible, which is the whole point of looking.
_JPEG_QUALITY = 82


class FrameGrabError(RuntimeError):
    """A frame could not be produced (bad time, missing assets, compile failure)."""


@dataclass(frozen=True)
class GrabbedFrame:
    """One rendered frame plus what it is actually of."""

    #: Raw encoded image bytes (JPEG or PNG).
    data: bytes
    media_type: str
    width: int
    height: int
    #: The time actually rendered, after clamping into the timeline (seconds).
    time_seconds: float
    #: The timeline's full duration, so a caller can say where in the edit this sits.
    duration_seconds: float

    @property
    def base64(self) -> str:
        """The image bytes, base64-encoded, without a ``data:`` prefix."""
        return base64.b64encode(self.data).decode("ascii")


def _resolve_preset(project: Project, max_dimension: int) -> ExportPreset:
    """The frame shape to composite at: the PROJECT'S OWN aspect, capped to the answer.

    The model is shown the edit as the user sees it in the preview. It composites at the
    project's *aspect* but not necessarily its *resolution*: the result is downscaled to
    ``max_dimension`` before it is returned (see :func:`grab_frame`), so compositing a UHD
    frame to answer a request for a 512px JPEG would decode ~25 MB and 16x the pixels in
    order to throw all of them away. Capping here makes the composite the size of the answer.
    """
    width, height = _fit_within(project.resolution.width, project.resolution.height, max_dimension)
    return ExportPreset(
        id="project",
        label="Project resolution",
        # Even on both axes: the decoders feeding this composite are yuv420p.
        width=max(2, width - width % 2),
        height=max(2, height - height % 2),
        fps=project.fps or 30,
    )


def _fit_within(width: int, height: int, max_dimension: int) -> tuple[int, int]:
    """Scale (width, height) down so the longest edge is at most ``max_dimension``.

    Never scales UP: asking for a 1280px frame of a 720p preset should return the
    720p pixels, not an interpolated blur that costs more tokens for less detail.
    """
    longest = max(width, height)
    if longest <= max_dimension:
        return width, height
    scale = max_dimension / longest
    # At least 1px on each axis — a 1x8000 timeline is degenerate but must not crash.
    return max(1, round(width * scale)), max(1, round(height * scale))


def _windowed_frame(
    project: Project,
    base_dir: Path,
    asset_index: AssetIndex,
    preset: ExportPreset,
    window: PictureWindow,
    *,
    burn_captions: bool,
    decode_budget: int | None,
) -> Any | None:
    """The frame at ``window.time`` composited from the clips in ``window`` alone.

    ``None`` when the window cannot give the full compile's frame (it built no picture
    layer, or its picture ends at or before this instant); the caller composites the whole
    timeline instead. The composite is cached by the clips it holds, so every instant of the
    same shot reuses it — and is kept apart from whole-timeline composites
    (``FRAME_WINDOW_CACHE``), so a grab neither waits behind a background review's build nor
    evicts it.
    """

    def build() -> Any:
        try:
            return compile_timeline(
                project,
                asset_index,
                preset,
                burn_captions=burn_captions,
                max_decode_dimension=decode_budget,
                window=window,
            )
        except PictureWindowMiss:
            raise
        except Exception as exc:
            raise FrameGrabError(f"Could not compile the timeline for a frame: {exc}") from exc

    at = window.time
    key = composition_key(
        project,
        base_dir,
        preset,
        burn_captions=burn_captions,
        max_decode_dimension=decode_budget,
        window=window.clip_ids,
    )
    try:
        with FRAME_WINDOW_CACHE.borrow(key, build) as composition:
            # `duration` is where the windowed picture stops being the full one (see
            # `compile_timeline`); a composite cached for another instant may end before this.
            if composition.duration is not None and at >= float(composition.duration):
                _log.info("frame grab: window ends before %.3fs; compositing everything", at)
                return None
            _log.debug("frame grab: %d clip(s) in the window at %.3fs", len(window.clip_ids), at)
            return composition.get_frame(at)
    except PictureWindowMiss as exc:
        _log.info("frame grab: %s", exc)
        return None
    except FrameGrabError:
        raise
    except Exception as exc:
        raise FrameGrabError(f"Could not read the frame at {at:.3f}s: {exc}") from exc


def _whole_timeline_frame(
    project: Project,
    base_dir: Path,
    asset_index: AssetIndex,
    preset: ExportPreset,
    at: float,
    *,
    burn_captions: bool,
    decode_budget: int | None,
) -> Any:
    """The frame at ``at`` from the whole timeline's composite, the export's own graph."""

    def build() -> Any:
        try:
            return compile_timeline(
                project,
                asset_index,
                preset,
                burn_captions=burn_captions,
                max_decode_dimension=decode_budget,
            )
        except Exception as exc:
            raise FrameGrabError(f"Could not compile the timeline for a frame: {exc}") from exc

    # Borrowed, not built-and-destroyed: a later grab of the same revision reads the cached
    # composite. The cache owns the teardown (readers are closed on eviction, never
    # mid-borrow).
    key = composition_key(
        project,
        base_dir,
        preset,
        burn_captions=burn_captions,
        max_decode_dimension=decode_budget,
    )
    try:
        with COMPOSITION_CACHE.borrow(key, build) as composition:
            return composition.get_frame(at)
    except FrameGrabError:
        raise
    except Exception as exc:
        raise FrameGrabError(f"Could not read the frame at {at:.3f}s: {exc}") from exc


def grab_frame(
    project: Project,
    base_dir: Path,
    time_seconds: float,
    *,
    max_dimension: int = DEFAULT_MAX_DIMENSION,
    image_format: str = "jpeg",
    burn_captions: bool = True,
    lossless: bool = False,
    lossless_size: tuple[int, int] | None = None,
) -> GrabbedFrame:
    """Composite the timeline at ``time_seconds`` and return it as image bytes.

    :param project: The project to render a frame of.
    :param base_dir: The project directory; assets are sandbox-resolved against it.
    :param time_seconds: Timeline time to grab. **Clamped** into
        ``[0, duration)`` rather than rejected — a model asking for the frame at
        the very end of a 12.0s timeline should see the last frame, not an error
        about floating-point boundaries.
    :param max_dimension: Longest edge of the returned image, clamped to
        :data:`MAX_ALLOWED_DIMENSION`.
    :param image_format: ``"jpeg"`` (default, small) or ``"png"`` (lossless —
        worth it when the question is about hard text edges).
    :param burn_captions: Draw caption-track text into the frame. Default
        ``True``: soft captions are invisible in a still, and a picture that
        omits them cannot answer "do the captions look right?".
    :param lossless: Test-only full-fidelity mode for the parity oracle: composite at the
        project's full resolution exactly as the export does (no decode budget, no
        :data:`MAX_ALLOWED_DIMENSION` ceiling, no resize) and encode a PNG. ``max_dimension``
        does not apply. Requires ``image_format="png"``; asking for a lossy format with it
        is refused rather than silently overridden.
    :param lossless_size: With ``lossless``, composite at this ``(width, height)`` instead of the
        project's resolution — the export's compositor run at another output size, not a resize of
        the full frame. The parity oracle uses it to compare at the preview canvas's size (the
        preview may be lower resolution; the comparison never rescales either image). Even
        rounding applies. Refused without ``lossless``.
    :returns: The encoded frame and the time it was actually taken at.
    :raises FrameGrabError: On an unknown preset/format, an empty timeline, or a
        compile/encode failure.
    """
    # Imported here, not at module scope, so a broken Pillow/MoviePy install fails
    # an actual frame grab rather than every import of the render package.
    try:
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - Pillow ships with MoviePy
        raise FrameGrabError("Pillow is not installed; cannot encode a frame.") from exc

    fmt = image_format.lower()
    if fmt not in {"jpeg", "png"}:
        raise FrameGrabError(f"Unsupported image format {image_format!r}; use 'jpeg' or 'png'.")
    if lossless and fmt != "png":
        raise FrameGrabError(
            f"A lossless frame must be encoded as png, not {image_format!r}: "
            "a lossy encode would defeat the pixel comparison it exists for."
        )

    duration = timeline_duration(project.timeline)
    if duration <= 0:
        raise FrameGrabError("The timeline is empty — there is no frame to render.")
    # Clamp, and step just inside the end: `get_frame(duration)` is past the last
    # frame and MoviePy raises rather than returning the final picture.
    fps = float(project.fps or 30)
    last_frame_time = max(0.0, duration - (1.0 / fps))
    at = min(max(0.0, float(time_seconds)), last_frame_time)

    if lossless_size is not None and not lossless:
        raise FrameGrabError("lossless_size only applies to a lossless frame.")
    if lossless and lossless_size is not None:
        size_w, size_h = (int(v) for v in lossless_size)
        if size_w < 2 or size_h < 2:
            raise FrameGrabError(f"lossless_size must be at least 2x2, got {size_w}x{size_h}.")
        requested_dimension = max(size_w, size_h)
        preset = ExportPreset(
            id="project",
            label="Project resolution",
            width=size_w - size_w % 2,
            height=size_h - size_h % 2,
            fps=project.fps or 30,
        )
    else:
        if lossless:
            # The export's own frame size. Even rounding still applies: the sources are yuv420p.
            requested_dimension = max(project.resolution.width, project.resolution.height)
        else:
            requested_dimension = min(max(1, int(max_dimension)), MAX_ALLOWED_DIMENSION)
        preset = _resolve_preset(project, requested_dimension)
    asset_index = index_assets([asset.model_dump() for asset in project.assets], base_dir=base_dir)
    # No source is decoded larger than the frame it is being composited into. The
    # export path deliberately reads camera masters; a picture for a model to look
    # at has no such requirement, and decoding UHD for a 512px JPEG is the single
    # most expensive thing this module used to do.
    # A lossless frame is the export's, so it reads sources the way the export does: unbudgeted.
    decode_budget: int | None = None if lossless else max(preset.width, preset.height)

    # Only the clips that can be on screen at `at` (see `render/picture_window.py`). A
    # lossless frame is the parity oracle's reference, so it keeps compositing the whole
    # timeline exactly as the export does rather than trusting the window it is there to check.
    window = (
        None
        if lossless
        else picture_window_at(
            project, at, {entry.asset_id: entry.kind for entry in asset_index.entries}
        )
    )
    pixels = (
        None
        if window is None
        else _windowed_frame(
            project,
            base_dir,
            asset_index,
            preset,
            window,
            burn_captions=burn_captions,
            decode_budget=decode_budget,
        )
    )
    # Which composite answered, for the ACT line: a grab that silently fell back to the whole
    # timeline is the slow case worth spotting in a run log.
    composited = "timeline" if pixels is None or window is None else f"{len(window.clip_ids)} clips"
    if pixels is None:
        pixels = _whole_timeline_frame(
            project,
            base_dir,
            asset_index,
            preset,
            at,
            burn_captions=burn_captions,
            decode_budget=decode_budget,
        )

    # Encoding is guarded for the same reason the compile above it is: everything this
    # function raises should be a `FrameGrabError`, which the route answers as a 422 with
    # a sentence. Anything that escapes becomes a bare 500 — and a 500 from here is what
    # the model was handed 100 times in `framepilot.runs.jsonl` with no cause attached.
    # A missing Pillow codec, an unusual dtype out of the compositor, an unwritable
    # buffer: all worth naming, none worth "Internal Server Error".
    try:
        image = Image.fromarray(pixels).convert("RGB")
        # Usually a no-op now that the composite is already sized to the request (see
        # `_resolve_preset`); still needed for the even-dimension rounding above and
        # for an explicitly named export preset, which is composited as authored.
        target = _fit_within(image.width, image.height, requested_dimension)
        if target != (image.width, image.height):
            # `Image.Resampling.LANCZOS` (Pillow >= 9.1) — the top-level alias mypy
            # cannot see is deprecated.
            image = image.resize(target, Image.Resampling.LANCZOS)

        buffer = io.BytesIO()
        if fmt == "jpeg":
            image.save(buffer, format="JPEG", quality=_JPEG_QUALITY, optimize=True)
            media_type = "image/jpeg"
        else:
            # `optimize` only shrinks the file; a lossless test frame is written once and read
            # once, so the extra zlib passes buy nothing.
            image.save(buffer, format="PNG", optimize=not lossless)
            media_type = "image/png"
    except Exception as exc:
        raise FrameGrabError(
            f"Rendered the frame at {at:.3f}s but could not encode it as {fmt}: {exc}"
        ) from exc

    data = buffer.getvalue()
    _log.info(
        "ACT frame grab: t=%.3fs size=%dx%d format=%s lossless=%s bytes=%d composited=%s",
        at,
        image.width,
        image.height,
        fmt,
        lossless,
        len(data),
        composited,
    )
    return GrabbedFrame(
        data=data,
        media_type=media_type,
        width=image.width,
        height=image.height,
        time_seconds=at,
        duration_seconds=duration,
    )
