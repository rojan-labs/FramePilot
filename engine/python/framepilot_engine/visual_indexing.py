"""Frame decode + adaptive sampling for the visual index (plan MI1.2, MI4.1).

WHY: the pure sampler in :mod:`framepilot_engine.analysis.visual_sampler` folds
per-candidate perceptual hashes into contiguous spans, and the NVIDIA client in
:mod:`framepilot_engine.brain.visual_embed` embeds keyframe JPEGs — but neither
touches pixels. This top-level module is the bridge that owns the **decode**: it
turns a media file plus timestamps into the 9x8 grayscale grids the dHash needs
and the resolution-bounded JPEG keyframes the embedder/captioner consume, all via
ffmpeg. Deliberately **no Pillow / no new dependency** (plan §4/§6): ffmpeg is
already a hard dependency and scales + grayscale-converts in one pass.

It sits *above* both ``analysis`` and ``brain`` (so it may import from each)
because that composition is exactly its job: pure sampler + real extraction. The
ffmpeg invocation is an injectable :data:`BytesRunner` (mirroring
:data:`framepilot_engine.media.ffmpeg.Runner`, but returning raw stdout bytes),
so the sampling logic is golden-testable without the binary — a static shot
collapses to one span, a cut splits — exactly the MI1.1 golden the sampler
deferred until a decode path existed.

Design rules mirror the analysis modules:

- **Per-timestamp seek** (``-ss <t> -frames:v 1``) so extraction is deterministic
  and independent of decode order — the same timestamp always yields the same
  bytes.
- **Injected transport.** The runner and the resolved ffmpeg binary are
  parameters; the real subprocess is only reached through the module's defaults.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from pathlib import Path

from framepilot_engine.analysis.visual_sampler import (
    DEFAULT_HAMMING_THRESHOLD,
    DHASH_GRID_HEIGHT,
    DHASH_GRID_WIDTH,
    VisualSpan,
    dhash,
    image_span,
    plan_spans,
)
from framepilot_engine.media.ffmpeg import find_ffmpeg, run_bytes

_log = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "KEYFRAME_MAX_EDGE",
    "KEYFRAME_QUALITY",
    "BytesRunner",
    "FrameExtractionError",
    "extract_keyframe_jpeg",
    "grid_from_bytes",
    "sample_asset",
]

#: Longest-edge ceiling (px) for the keyframe JPEGs sent to the embedder and the
#: captioner. The cross-modal model reasons over content, not 4K detail (plan
#: §3.2), so bounding the long edge here keeps every API payload small and
#: predictable — and keeps the embed client's split-on-413 path the exception,
#: not the rule. Preserves aspect ratio (``force_original_aspect_ratio=decrease``).
KEYFRAME_MAX_EDGE = 768

#: ffmpeg mjpeg quality scale (2 = best … 31 = worst). 3 is visually lossless for
#: embedding/captioning while staying compact.
KEYFRAME_QUALITY = 3

#: Per-extraction ffmpeg timeout (seconds); a single-frame seek is fast, but a
#: pathological input must not hang the index job.
DEFAULT_TIMEOUT_SECONDS = 60.0

#: Bytes in one 9x8 grayscale dHash grid (one byte per pixel).
_GRID_BYTES = DHASH_GRID_WIDTH * DHASH_GRID_HEIGHT

#: An ffmpeg runner that returns **raw stdout bytes** (frames are binary, never
#: UTF-8). Injected so the sampling/extraction logic is testable without ffmpeg.
BytesRunner = Callable[[Sequence[str]], bytes]


class FrameExtractionError(Exception):
    """ffmpeg produced output that could not be read as the expected frame."""


def _seek_args(t: float) -> list[str]:
    """Input-seek flags (before ``-i``), omitted entirely at ``t <= 0``.

    ffmpeg 8.1's ``image2`` still-image demuxer returns ZERO frames for ANY
    ``-ss`` value placed before ``-i`` — including ``-ss 0`` — even though the
    identical command with ``-ss`` simply omitted decodes correctly (verified
    against a real still image: ``-ss 0.0`` before ``-i`` yields 0 bytes on
    ffmpeg 8.1; dropping it yields the expected frame). Every still-image
    extraction requests ``t=0.0`` (:func:`~framepilot_engine.analysis.
    visual_sampler.image_span` — there is only one frame), and skipping a
    seek-to-the-start is a no-op for any stream regardless of format (verified
    equivalent on a real video too), so this guard is safe for every caller,
    not just images.
    """
    return [] if t <= 0 else ["-ss", f"{t}"]


def _grid_argv(ffmpeg: str, media_path: Path, t: float) -> list[str]:
    """ffmpeg argv that emits ONE 9x8 grayscale frame as raw bytes at ``t``.

    ``scale=9:8`` then ``format=gray`` downsamples straight to the dHash grid in
    the decode pass, so no image library is needed to build the hash input.
    """
    return [
        ffmpeg,
        "-v",
        "error",
        *_seek_args(t),
        "-i",
        str(media_path),
        "-frames:v",
        "1",
        "-vf",
        f"scale={DHASH_GRID_WIDTH}:{DHASH_GRID_HEIGHT},format=gray",
        "-f",
        "rawvideo",
        "-",
    ]


def _keyframe_argv(ffmpeg: str, media_path: Path, t: float, max_edge: int) -> list[str]:
    """ffmpeg argv that emits ONE aspect-preserving, bounded JPEG at ``t``.

    ``force_original_aspect_ratio=decrease`` fits the frame inside a
    ``max_edge`` square without distortion, so the longest edge is ``<= max_edge``
    and portrait/landscape both shrink correctly.
    """
    scale = (
        f"scale='min({max_edge},iw)':'min({max_edge},ih)'"
        ":force_original_aspect_ratio=decrease"
    )
    return [
        ffmpeg,
        "-v",
        "error",
        *_seek_args(t),
        "-i",
        str(media_path),
        "-frames:v",
        "1",
        "-vf",
        scale,
        "-q:v",
        str(KEYFRAME_QUALITY),
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-",
    ]


def grid_from_bytes(raw: bytes) -> list[list[int]]:
    """Reshape ``9*8`` grayscale bytes into the row-major grid :func:`dhash` wants.

    :raises FrameExtractionError: When ffmpeg returned a different byte count
        than a single 9x8 grayscale frame (a decode failure or a mis-scaled
        stream) — silently reshaping a wrong-sized buffer would corrupt hashes.
    """
    if len(raw) != _GRID_BYTES:
        raise FrameExtractionError(
            f"Expected {_GRID_BYTES} grayscale bytes for a "
            f"{DHASH_GRID_WIDTH}x{DHASH_GRID_HEIGHT} dHash grid, got {len(raw)}."
        )
    return [
        list(raw[row * DHASH_GRID_WIDTH : (row + 1) * DHASH_GRID_WIDTH])
        for row in range(DHASH_GRID_HEIGHT)
    ]


def _resolve(
    ffmpeg: str | None, runner: BytesRunner | None, timeout: float
) -> tuple[str, BytesRunner]:
    """Fill in the real ffmpeg binary + subprocess runner unless injected."""
    resolved_ffmpeg = ffmpeg or find_ffmpeg()
    invoke = runner or (lambda argv: run_bytes(argv, timeout=timeout))
    return resolved_ffmpeg, invoke


def extract_keyframe_jpeg(
    media_path: Path,
    t: float,
    *,
    ffmpeg: str | None = None,
    runner: BytesRunner | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_edge: int = KEYFRAME_MAX_EDGE,
) -> bytes:
    """Extract one resolution-bounded JPEG keyframe at ``t`` (for embed/caption).

    :param media_path: Sandbox-resolved source media.
    :param t: Seek position in seconds.
    :param ffmpeg: Resolved ffmpeg binary; defaults to :func:`find_ffmpeg`.
    :param runner: Bytes runner; defaults to the real subprocess runner.
    :param max_edge: Longest-edge ceiling in pixels (aspect preserved).
    :returns: The JPEG bytes.
    :raises FrameExtractionError: When ffmpeg produced no output.
    """
    resolved_ffmpeg, invoke = _resolve(ffmpeg, runner, timeout)
    data = invoke(_keyframe_argv(resolved_ffmpeg, media_path, t, max_edge))
    if not data:
        raise FrameExtractionError(
            f"ffmpeg produced no keyframe at t={t}s for {media_path.name}."
        )
    return bytes(data)


def sample_asset(
    media_path: Path,
    *,
    duration_seconds: float,
    scene_cuts: Sequence[float],
    is_image: bool = False,
    ffmpeg: str | None = None,
    runner: BytesRunner | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    hamming_threshold: int = DEFAULT_HAMMING_THRESHOLD,
) -> list[VisualSpan]:
    """Sample one asset into contiguous visual spans (plan §3.1, composing MI1.1).

    Decodes a 9x8 grayscale grid per candidate timestamp, dHashes it, and lets
    the pure :func:`~framepilot_engine.analysis.visual_sampler.plan_spans` fold
    the hashes into scene-aware, non-overlapping spans. A still image is its own
    single ``[0, 0)`` span, hashed once so a re-index still detects a changed
    photo.

    :param duration_seconds: Media duration (ignored for images).
    :param scene_cuts: Detected scene-cut times (empty for images).
    :param is_image: True for a still photo — collapses to one span.
    :param runner: Bytes runner; defaults to the real subprocess runner.
    :returns: Ordered, contiguous spans covering ``[0, duration)``.
    """
    resolved_ffmpeg, invoke = _resolve(ffmpeg, runner, timeout)

    def hash_at(timestamp: float) -> int:
        return dhash(grid_from_bytes(invoke(_grid_argv(resolved_ffmpeg, media_path, timestamp))))

    if is_image:
        return [image_span(phash=hash_at(0.0))]
    return plan_spans(
        duration_seconds=duration_seconds,
        scene_cuts=scene_cuts,
        frame_hashes=hash_at,
        hamming_threshold=hamming_threshold,
    )
