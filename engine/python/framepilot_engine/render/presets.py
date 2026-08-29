"""Encode targets (plan/system-mission Phase 7).

Export is **quality-driven, never platform-driven**: the editor picks a resolution,
frame rate, quality tier, codec and container (:mod:`.export_settings`), and the frame
follows the project's own aspect ratio, capped at what the sources hold. The platform
presets that used to live here ("Reels", "TikTok", …) are gone; nothing in the engine
names a platform.

:class:`ExportPreset` survives as the *encode target* every compiler and encoder path
consumes — width, height, fps, codecs, container, bitrates — built by
:func:`target_from_settings` for exports and :func:`frame_target` for compositing a
single frame at a given shape.
"""

from __future__ import annotations

from pydantic import BaseModel

from framepilot_engine.render.export_settings import (
    ExportSettings,
    ExportTarget,
    SourceFacts,
    resolve_export_target,
)

_FFMPEG_VIDEO_CODEC: dict[str, str] = {"h264": "libx264", "hevc": "libx265"}


class ExportPreset(BaseModel):
    """A concrete encode target (resolution / fps / codecs / container / bitrates)."""

    id: str
    label: str
    width: int
    height: int
    fps: float = 30
    video_codec: str = "libx264"
    audio_codec: str = "aac"
    container: str = "mp4"
    #: Video bitrate in kbit/s; ``None`` lets the encoder pick its default.
    video_bitrate_kbps: int | None = None
    audio_bitrate_kbps: int | None = None
    #: The resolution actually delivered and whether the sources capped the request.
    effective_resolution: str | None = None
    capped_to_source: bool = False


def frame_target(width: int, height: int, fps: float = 30, *, label: str = "frame") -> ExportPreset:
    """A target for compositing at a given shape (frame grabs, tests, previews)."""
    even_w = max(2, width - width % 2)
    even_h = max(2, height - height % 2)
    return ExportPreset(id=f"{even_w}x{even_h}", label=label, width=even_w, height=even_h, fps=fps)


def target_from_export(target: ExportTarget) -> ExportPreset:
    """Wrap a derived :class:`ExportTarget` as the encoder's target."""
    return ExportPreset(
        id=f"{target.effective_resolution}-{target.video_codec}-{target.container}",
        label=(
            f"{target.effective_resolution} · {target.video_codec.upper()} · "
            f"{target.container.upper()}"
        ),
        width=target.width,
        height=target.height,
        fps=target.fps,
        video_codec=_FFMPEG_VIDEO_CODEC[target.video_codec],
        audio_codec="aac",
        container=target.container,
        video_bitrate_kbps=target.video_bitrate_kbps,
        audio_bitrate_kbps=target.audio_bitrate_kbps,
        effective_resolution=target.effective_resolution,
        capped_to_source=target.capped_to_source,
    )


def target_from_settings(settings: ExportSettings, facts: SourceFacts) -> ExportPreset:
    """The encode target for ``settings`` against what the project's sources can supply."""
    return target_from_export(resolve_export_target(settings, facts))
