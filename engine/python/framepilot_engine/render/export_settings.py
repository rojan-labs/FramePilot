"""Quality-driven export settings (plan/system-mission Phase 7, P7.1).

Export is a choice of **resolution, frame rate, quality, codec and container** — the way
CapCut and every NLE present it — never a platform. The output frame is derived from the
project's own aspect ratio and the chosen resolution, capped at what the sources can
actually supply so a 1080p camera file is never silently upscaled to "4K".

This module is pure: it turns settings + project facts into an :class:`ExportTarget` the
encoder consumes. Nothing here touches ffmpeg.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Resolution = Literal["480p", "720p", "1080p", "1440p", "2160p", "source"]
FrameRate = Literal[24, 25, 30, 50, 60] | Literal["source"]
QualityTier = Literal["low", "recommended", "high"]
VideoCodec = Literal["h264", "hevc"]
Container = Literal["mp4", "mov"]

#: Short-edge pixel count each named resolution stands for.
RESOLUTION_SHORT_EDGE: dict[str, int] = {
    "480p": 480,
    "720p": 720,
    "1080p": 1080,
    "1440p": 1440,
    "2160p": 2160,
}

#: Video bitrate ladder in kbit/s by short edge and quality tier, for H.264 at <=30 fps.
#: Values follow the widely published delivery recommendations (YouTube/Apple): 1080p
#: ~8 Mbit/s standard, ~12 high; 4K ~35-45 Mbit/s. HEVC takes ~65% of H.264 at equal
#: quality; >30 fps takes ~1.5x. Both factors are applied in :func:`video_bitrate_kbps`.
BITRATE_LADDER_KBPS: dict[int, dict[str, int]] = {
    480: {"low": 1_200, "recommended": 2_500, "high": 4_000},
    720: {"low": 2_500, "recommended": 5_000, "high": 7_500},
    1080: {"low": 4_500, "recommended": 8_000, "high": 12_000},
    1440: {"low": 9_000, "recommended": 16_000, "high": 24_000},
    2160: {"low": 20_000, "recommended": 35_000, "high": 45_000},
}
HEVC_BITRATE_FACTOR = 0.65
HIGH_FPS_BITRATE_FACTOR = 1.5
AUDIO_BITRATE_KBPS: dict[str, int] = {"low": 128, "recommended": 192, "high": 256}


class ExportSettings(BaseModel):
    """What the editor chose in the export dialog."""

    resolution: Resolution = "1080p"
    fps: FrameRate = "source"
    quality: QualityTier = "recommended"
    #: Explicit video bitrate; overrides the ladder when set.
    bitrate_kbps: int | None = Field(default=None, ge=200, le=200_000)
    video_codec: VideoCodec = "h264"
    container: Container = "mp4"
    burn_captions: bool = False


class SourceFacts(BaseModel):
    """What the project's placed media can supply — the cap for the export."""

    #: Largest short edge among the placed picture sources (None when unknown).
    max_short_edge: int | None = None
    #: The project's own frame rate.
    project_fps: float
    project_width: int
    project_height: int


class ExportTarget(BaseModel):
    """The concrete encode target derived from settings + source facts."""

    width: int
    height: int
    fps: float
    video_codec: VideoCodec
    container: Container
    video_bitrate_kbps: int
    audio_bitrate_kbps: int
    #: The resolution actually delivered (may be lower than asked when the source caps it).
    effective_resolution: str
    #: True when the request exceeded what the sources hold and was capped.
    capped_to_source: bool
    burn_captions: bool


def _even(n: int) -> int:
    return max(2, n - (n % 2))


def resolve_frame(resolution: Resolution, facts: SourceFacts) -> tuple[int, int, str, bool]:
    """Output width/height from the project aspect and the resolution, source-capped.

    The short edge is the named resolution (portrait: width; landscape: height; square:
    both). When the sources cannot fill it, the short edge drops to the largest source
    short edge and ``capped`` reports it — nothing is upscaled quietly.
    """
    aspect = facts.project_width / facts.project_height
    project_short = min(facts.project_width, facts.project_height)
    if resolution == "source":
        wanted = facts.max_short_edge or project_short
    else:
        wanted = RESOLUTION_SHORT_EDGE[resolution]
    cap = facts.max_short_edge
    capped = cap is not None and wanted > cap
    short = cap if capped else wanted
    assert short is not None
    if facts.project_width >= facts.project_height:
        height = short
        width = round(short * aspect)
    else:
        width = short
        height = round(short / aspect)
    effective = next(
        (name for name, edge in RESOLUTION_SHORT_EDGE.items() if edge == short), f"{short}p"
    )
    return _even(width), _even(height), effective, bool(capped)


def resolve_fps(fps: FrameRate, facts: SourceFacts) -> float:
    return float(facts.project_fps) if fps == "source" else float(fps)


def video_bitrate_kbps(short_edge: int, quality: QualityTier, codec: VideoCodec, fps: float) -> int:
    """Ladder lookup with codec and frame-rate factors; nearest rung at or above the edge."""
    rungs = sorted(BITRATE_LADDER_KBPS)
    rung = next((r for r in rungs if r >= short_edge), rungs[-1])
    base = BITRATE_LADDER_KBPS[rung][quality]
    factor = (HEVC_BITRATE_FACTOR if codec == "hevc" else 1.0) * (
        HIGH_FPS_BITRATE_FACTOR if fps > 30 else 1.0
    )
    return round(base * factor)


def resolve_export_target(settings: ExportSettings, facts: SourceFacts) -> ExportTarget:
    width, height, effective, capped = resolve_frame(settings.resolution, facts)
    fps = resolve_fps(settings.fps, facts)
    short = min(width, height)
    bitrate = settings.bitrate_kbps or video_bitrate_kbps(
        short, settings.quality, settings.video_codec, fps
    )
    return ExportTarget(
        width=width,
        height=height,
        fps=fps,
        video_codec=settings.video_codec,
        container=settings.container,
        video_bitrate_kbps=bitrate,
        audio_bitrate_kbps=AUDIO_BITRATE_KBPS[settings.quality],
        effective_resolution=effective,
        capped_to_source=capped,
        burn_captions=settings.burn_captions,
    )


def estimate_size_bytes(target: ExportTarget, duration_seconds: float) -> int:
    """Rough file-size estimate the dialog shows live: (video + audio) kbit/s x seconds."""
    kbps = target.video_bitrate_kbps + target.audio_bitrate_kbps
    return int(kbps * 1000 / 8 * max(0.0, duration_seconds))
