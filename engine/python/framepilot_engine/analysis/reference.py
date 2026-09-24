"""Reference-media analysis (plan/system-mission P3.3).

A reference video or image the editor attaches is analyzed ONCE into a small set of
measured facts — shot statistics, tempo, speech share, colour statistics, image size,
alpha, palette — which the TS side turns into the constraints the model reads. Nothing
here infers meaning (no "cinematic", no "energetic"): every field is a number a second
run would reproduce, and a field the media cannot yield is simply absent.

Built entirely on primitives that already exist: :func:`inspect_media`,
:func:`detect_scenes`, :func:`detect_beats`, :func:`detect_silence`, and ffmpeg's raw
RGB output for colour statistics (numpy is already a dependency for beats).
"""

from __future__ import annotations

import base64
import io
import logging
import statistics
from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from framepilot_engine.analysis.beats import detect_beats
from framepilot_engine.analysis.scenes import detect_scenes
from framepilot_engine.analysis.silence import detect_silence
from framepilot_engine.media.ffmpeg import FFmpegError, NoAudioStreamError, find_ffmpeg, run_bytes
from framepilot_engine.media.probe import inspect_media

_log = logging.getLogger(__name__)

#: Frames sampled for colour statistics — enough to average a look, cheap to decode.
COLOR_SAMPLE_FRAMES = 12
#: Sample width in pixels; height follows the aspect. Statistics, not pictures.
COLOR_SAMPLE_WIDTH = 64
#: Below this, a shot list is treated as "one continuous take" for percentile stats.
MIN_SHOTS_FOR_PERCENTILES = 3


class ColorStats(BaseModel):
    """Mean luma/spread/chroma and a warm-cool bias, all 0..1 (temperature -1..1)."""

    brightness: float = Field(ge=0.0, le=1.0)
    contrast: float = Field(ge=0.0, le=1.0)
    saturation: float = Field(ge=0.0, le=1.0)
    temperature: float = Field(ge=-1.0, le=1.0)


class ReferenceMusic(BaseModel):
    bpm: float | None = None
    beat_count: int = Field(default=0, alias="beatCount")

    model_config = {"populate_by_name": True}


class ReferenceVideoAnalysis(BaseModel):
    """Measured facts about a reference video (mirrors TS ``ReferenceVideoProfile``)."""

    duration_s: float = Field(alias="durationS", ge=0.0)
    fps: float | None = None
    width: int | None = None
    height: int | None = None
    shot_count: int = Field(alias="shotCount", ge=0)
    median_shot_s: float | None = Field(default=None, alias="medianShotS")
    shot_length_p10_s: float | None = Field(default=None, alias="shotLengthP10S")
    shot_length_p90_s: float | None = Field(default=None, alias="shotLengthP90S")
    cuts_per_minute: float | None = Field(default=None, alias="cutsPerMinute")
    speech_share: float | None = Field(default=None, alias="speechShare", ge=0.0, le=1.0)
    music: ReferenceMusic | None = None
    color: ColorStats | None = None

    model_config = {"populate_by_name": True}


class ReferenceImageAnalysis(BaseModel):
    """Measured facts about a reference image (mirrors TS ``ReferenceImageProfile``)."""

    width: int
    height: int
    has_alpha: bool = Field(alias="hasAlpha")
    dominant_colors: list[str] = Field(default_factory=list, alias="dominantColors")
    color: ColorStats | None = None

    model_config = {"populate_by_name": True}


def color_stats_from_rgb(pixels: np.ndarray) -> ColorStats:
    """Colour statistics over an ``(N, 3)`` uint8 RGB array.

    Luma is Rec.601; chroma is the per-pixel max-min spread; temperature is the mean
    red-minus-blue bias scaled to -1..1. Deterministic for a given array.
    """
    if pixels.size == 0:
        return ColorStats(brightness=0.0, contrast=0.0, saturation=0.0, temperature=0.0)
    rgb = pixels.astype(np.float64) / 255.0
    luma = 0.299 * rgb[:, 0] + 0.587 * rgb[:, 1] + 0.114 * rgb[:, 2]
    chroma = rgb.max(axis=1) - rgb.min(axis=1)
    temperature = float(np.clip((rgb[:, 0] - rgb[:, 2]).mean() * 2.0, -1.0, 1.0))
    return ColorStats(
        brightness=float(np.clip(luma.mean(), 0.0, 1.0)),
        contrast=float(np.clip(luma.std(), 0.0, 1.0)),
        saturation=float(np.clip(chroma.mean(), 0.0, 1.0)),
        temperature=temperature,
    )


def sample_video_rgb(path: Path, duration_s: float, *, timeout: float | None) -> np.ndarray:
    """Decode ``COLOR_SAMPLE_FRAMES`` evenly spaced tiny frames as one ``(N, 3)`` array."""
    if duration_s <= 0:
        return np.zeros((0, 3), dtype=np.uint8)
    rate = COLOR_SAMPLE_FRAMES / duration_s
    argv = [
        find_ffmpeg(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(path),
        "-vf",
        f"fps={rate:.6f},scale={COLOR_SAMPLE_WIDTH}:-2",
        "-frames:v",
        str(COLOR_SAMPLE_FRAMES),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]
    raw = run_bytes(argv, timeout=timeout)
    usable = len(raw) - (len(raw) % 3)
    return np.frombuffer(raw[:usable], dtype=np.uint8).reshape(-1, 3)


def shot_statistics(cuts: list[float], duration_s: float) -> dict[str, float | int | None]:
    """Shot count and length percentiles from cut times (a cut list is shot boundaries)."""
    boundaries = sorted({0.0, *[c for c in cuts if 0.0 < c < duration_s], duration_s})
    lengths = [b - a for a, b in pairwise(boundaries) if b > a]
    count = max(1, len(lengths))
    if len(lengths) < MIN_SHOTS_FOR_PERCENTILES:
        return {
            "shotCount": count,
            "medianShotS": lengths[0] if len(lengths) == 1 else None,
            "shotLengthP10S": None,
            "shotLengthP90S": None,
            "cutsPerMinute": (len(cuts) / duration_s * 60.0) if duration_s > 0 else None,
        }
    ordered = sorted(lengths)
    p10 = ordered[int(0.1 * (len(ordered) - 1))]
    p90 = ordered[int(0.9 * (len(ordered) - 1))]
    return {
        "shotCount": count,
        "medianShotS": statistics.median(lengths),
        "shotLengthP10S": p10,
        "shotLengthP90S": p90,
        "cutsPerMinute": len(cuts) / duration_s * 60.0 if duration_s > 0 else None,
    }


def analyze_reference_video(path: Path, *, timeout: float | None = 120.0) -> ReferenceVideoAnalysis:
    """Measure a reference video. ``path`` must already be sandbox-resolved."""
    info = inspect_media(path, timeout=timeout)
    duration = float(info.duration_seconds or 0.0)
    video = next((s for s in info.streams if s.codec_type == "video"), None)
    has_audio = any(s.codec_type == "audio" for s in info.streams)
    cuts = [c.time for c in detect_scenes(path, timeout=timeout)]
    stats = shot_statistics(cuts, duration)
    music: ReferenceMusic | None = None
    speech_share: float | None = None
    if has_audio and duration > 0:
        try:
            beats = detect_beats(path, timeout=timeout)
            music = ReferenceMusic(bpm=beats.bpm, beat_count=len(beats.beats))
        except (NoAudioStreamError, FFmpegError) as exc:
            _log.info("reference beats unavailable for %s: %s", path.name, exc)
        try:
            silences = detect_silence(path, total_duration=duration, timeout=timeout)
            silent = sum(max(0.0, r.end - r.start) for r in silences)
            speech_share = float(np.clip(1.0 - silent / duration, 0.0, 1.0))
        except (NoAudioStreamError, FFmpegError) as exc:
            _log.info("reference silence unavailable for %s: %s", path.name, exc)
    color: ColorStats | None = None
    try:
        color = color_stats_from_rgb(sample_video_rgb(path, duration, timeout=timeout))
    except FFmpegError as exc:
        _log.info("reference colour sampling failed for %s: %s", path.name, exc)
    return ReferenceVideoAnalysis(
        duration_s=duration,
        fps=video.fps if video else None,
        width=video.width if video else None,
        height=video.height if video else None,
        shot_count=int(stats["shotCount"] or 1),
        median_shot_s=stats["medianShotS"],
        shot_length_p10_s=stats["shotLengthP10S"],
        shot_length_p90_s=stats["shotLengthP90S"],
        cuts_per_minute=stats["cutsPerMinute"],
        speech_share=speech_share,
        music=music,
        color=color,
    )


def _hex(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


def analyze_reference_image(path: Path, *, palette_size: int = 4) -> ReferenceImageAnalysis:
    """Measure a reference image: size, alpha, a small palette, colour statistics."""
    with Image.open(path) as opened:
        has_alpha = opened.mode in {"RGBA", "LA"} or "transparency" in opened.info
        rgba = opened.convert("RGBA")
        width, height = rgba.size
        small = rgba.copy()
        small.thumbnail((COLOR_SAMPLE_WIDTH * 2, COLOR_SAMPLE_WIDTH * 2))
        arr = np.asarray(small, dtype=np.uint8).reshape(-1, 4)
        opaque = arr[arr[:, 3] > 16][:, :3] if has_alpha else arr[:, :3]
        quantized = small.convert("RGB").quantize(
            colors=palette_size, method=Image.Quantize.MEDIANCUT
        )
        palette = quantized.getpalette() or []
        counts = sorted(
            (
                (int(count), int(index))
                for count, index in (quantized.getcolors() or [])
                if isinstance(index, int)
            ),
            reverse=True,
        )
        dominant = [
            _hex((palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]))
            for _, index in counts[:palette_size]
            if index * 3 + 2 < len(palette)
        ]
    return ReferenceImageAnalysis(
        width=width,
        height=height,
        has_alpha=has_alpha,
        dominant_colors=dominant,
        color=color_stats_from_rgb(opaque) if opaque.size else None,
    )


#: Longest edge of the still a vision model is shown. Larger than a `get_frame` look (512)
#: on purpose: a reference is studied for its detail — a logo's lettering, a design's type,
#: a face — where a timeline frame only has to show what is on screen. 1024 stays under
#: every provider's own downscale threshold, so what we send is what the model reads.
REFERENCE_STILL_MAX_DIMENSION = 1024
#: Hard ceiling a caller cannot ask past (same bound as the frame grab's).
REFERENCE_STILL_MAX_ALLOWED = 1280
_STILL_JPEG_QUALITY = 85
_OPAQUE = 255


class ReferenceStill(BaseModel):
    """A reference image re-encoded at a size a vision model reads."""

    media_type: str
    base64: str
    width: int
    height: int


def reference_still(
    path: Path, *, max_dimension: int = REFERENCE_STILL_MAX_DIMENSION
) -> ReferenceStill:
    """Encode a reference image for a model to LOOK at, not measure.

    Transparency is kept (PNG) when the image has any, because "a logo on a transparent
    background" is part of what the editor attached — flattening it onto black or white
    would show the model a different picture. Everything else is JPEG, which is a fraction
    of the bytes for a photo. EXIF orientation is applied first: a phone photo stored
    sideways must not reach the model sideways.

    "Has any" means a pixel that is actually see-through, not an alpha CHANNEL: a screenshot
    is usually RGBA and fully opaque, and treating it as transparent sent a 380 KB PNG where
    a JPEG of the same picture is a sixth of that.

    :raises OSError: The file is not an image Pillow can decode.
    """
    bound = min(max(1, int(max_dimension)), REFERENCE_STILL_MAX_ALLOWED)
    with Image.open(path) as opened:
        oriented = ImageOps.exif_transpose(opened) or opened
        rgba = oriented.convert("RGBA")
    # A single band's extrema is a (min, max) pair of ints; Pillow types it wider.
    alpha_min = rgba.getchannel("A").getextrema()[0]
    has_alpha = isinstance(alpha_min, int) and alpha_min < _OPAQUE
    image = rgba if has_alpha else rgba.convert("RGB")
    image.thumbnail((bound, bound), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    if has_alpha:
        image.save(buffer, format="PNG", optimize=True)
        media_type = "image/png"
    else:
        image.save(buffer, format="JPEG", quality=_STILL_JPEG_QUALITY, optimize=True)
        media_type = "image/jpeg"
    return ReferenceStill(
        media_type=media_type,
        base64=base64.b64encode(buffer.getvalue()).decode("ascii"),
        width=image.width,
        height=image.height,
    )


def analysis_to_dict(analysis: BaseModel) -> dict[str, Any]:
    """Camel-case JSON the TS profile builder consumes directly."""
    return analysis.model_dump(by_alias=True, exclude_none=True)
