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

WHY it is downscaled and JPEG by default: the frame is sent to a model as base64
inside a prompt. A 1080x1920 PNG is megabytes of context for a question a
512-pixel-wide JPEG answers just as well, and the token cost of an image scales
with its pixels. The caller may ask for more when it genuinely needs detail.
"""

from __future__ import annotations

import base64
import io
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from framepilot_engine.media.assets import index_assets
from framepilot_engine.render.compiler import compile_timeline, timeline_duration
from framepilot_engine.render.composition_cache import COMPOSITION_CACHE, composition_key
from framepilot_engine.render.presets import EXPORT_PRESETS, REELS, ExportPreset
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


def _resolve_preset(
    project: Project,
    preset_id: str | None,
    max_dimension: int,
) -> ExportPreset:
    """The frame shape to composite at.

    Defaults to the PROJECT'S OWN aspect rather than an export preset: the model
    is being shown the edit as the user sees it in the preview, and compositing
    a 16:9 project into a 9:16 Reels frame would show it letterboxed content it
    would then, reasonably, report as a framing problem.

    It composites at the project's *aspect* but not necessarily its *resolution*.
    The result of this function is downscaled to ``max_dimension`` before it is
    ever returned (see :func:`grab_frame`), so compositing a UHD frame to answer
    a request for a 512px JPEG decodes ~25 MB and 16x the pixels in order to
    throw all of them away. Capping here makes the composite the size of the
    answer. An explicitly named export preset is left exactly as authored — a
    caller naming one is asking about that format specifically.
    """
    if preset_id is None:
        width, height = _fit_within(
            project.resolution.width, project.resolution.height, max_dimension
        )
        return ExportPreset(
            id="project",
            label="Project resolution",
            # Even on both axes: the decoders feeding this composite are yuv420p.
            width=max(2, width - width % 2),
            height=max(2, height - height % 2),
            fps=project.fps or REELS.fps,
        )
    preset = EXPORT_PRESETS.get(preset_id)
    if preset is None:
        known = ", ".join(sorted(EXPORT_PRESETS)) or "none"
        raise FrameGrabError(f"Unknown export preset {preset_id!r}. Known presets: {known}.")
    return preset


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


def grab_frame(
    project: Project,
    base_dir: Path,
    time_seconds: float,
    *,
    preset_id: str | None = None,
    max_dimension: int = DEFAULT_MAX_DIMENSION,
    image_format: str = "jpeg",
    burn_captions: bool = True,
) -> GrabbedFrame:
    """Composite the timeline at ``time_seconds`` and return it as image bytes.

    :param project: The project to render a frame of.
    :param base_dir: The project directory; assets are sandbox-resolved against it.
    :param time_seconds: Timeline time to grab. **Clamped** into
        ``[0, duration)`` rather than rejected — a model asking for the frame at
        the very end of a 12.0s timeline should see the last frame, not an error
        about floating-point boundaries.
    :param preset_id: Export preset to composite at; defaults to the project's
        own resolution (see :func:`_resolve_preset`).
    :param max_dimension: Longest edge of the returned image, clamped to
        :data:`MAX_ALLOWED_DIMENSION`.
    :param image_format: ``"jpeg"`` (default, small) or ``"png"`` (lossless —
        worth it when the question is about hard text edges).
    :param burn_captions: Draw caption-track text into the frame. Default
        ``True``: soft captions are invisible in a still, and a picture that
        omits them cannot answer "do the captions look right?".
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

    duration = timeline_duration(project.timeline)
    if duration <= 0:
        raise FrameGrabError("The timeline is empty — there is no frame to render.")
    # Clamp, and step just inside the end: `get_frame(duration)` is past the last
    # frame and MoviePy raises rather than returning the final picture.
    fps = float(project.fps or 30)
    last_frame_time = max(0.0, duration - (1.0 / fps))
    at = min(max(0.0, float(time_seconds)), last_frame_time)

    requested_dimension = min(max(1, int(max_dimension)), MAX_ALLOWED_DIMENSION)
    preset = _resolve_preset(project, preset_id, requested_dimension)
    asset_index = index_assets([asset.model_dump() for asset in project.assets], base_dir=base_dir)
    # No source is decoded larger than the frame it is being composited into. The
    # export path deliberately reads camera masters; a picture for a model to look
    # at has no such requirement, and decoding UHD for a 512px JPEG is the single
    # most expensive thing this module used to do.
    decode_budget = max(preset.width, preset.height)

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

    # Borrowed, not built-and-destroyed. Compiling costs ~0.8s per clip and the
    # frame itself ~0.4s, so grabbing several frames of one revision — which is
    # exactly what a model inspecting its own edit does — used to recompile the
    # entire timeline for each one. The cache owns the teardown now (readers are
    # closed on eviction, never mid-borrow); the previous unconditional
    # close_clip_tree here is what made every grab pay full price.
    key = composition_key(
        project,
        base_dir,
        preset,
        burn_captions=burn_captions,
        max_decode_dimension=decode_budget,
    )
    try:
        with COMPOSITION_CACHE.borrow(key, build) as composition:
            pixels = composition.get_frame(at)
    except FrameGrabError:
        raise
    except Exception as exc:
        raise FrameGrabError(f"Could not read the frame at {at:.3f}s: {exc}") from exc

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
        image.save(buffer, format="PNG", optimize=True)
        media_type = "image/png"

    data = buffer.getvalue()
    _log.info(
        "ACT frame grab: t=%.3fs size=%dx%d format=%s bytes=%d",
        at,
        image.width,
        image.height,
        fmt,
        len(data),
    )
    return GrabbedFrame(
        data=data,
        media_type=media_type,
        width=image.width,
        height=image.height,
        time_seconds=at,
        duration_seconds=duration,
    )
