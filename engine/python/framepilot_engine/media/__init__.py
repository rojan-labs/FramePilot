"""Media inspection & import primitives (plan 2.1).

This package wraps ffprobe/ffmpeg for the deterministic render pipeline:

* :mod:`framepilot_engine.media.ffmpeg` — binary discovery + subprocess runner.
* :mod:`framepilot_engine.media.probe` — ``inspect_media`` (duration/fps/streams).
* :mod:`framepilot_engine.media.assets` — sandboxed asset index + path resolution.
* :mod:`framepilot_engine.media.derive` — proxy / frame / thumbnail generation.
* :mod:`framepilot_engine.media.waveform` — audio waveform extraction.
"""

from __future__ import annotations

from framepilot_engine.media.assets import AssetEntry, AssetIndex, index_assets
from framepilot_engine.media.derive import (
    extract_frame,
    generate_proxy,
    generate_thumbnails,
    thumbnail_timestamps,
)
from framepilot_engine.media.ffmpeg import (
    FFmpegError,
    FFmpegNotFoundError,
    NoAudioStreamError,
    find_ffmpeg,
    find_ffprobe,
)
from framepilot_engine.media.probe import MediaInfo, StreamInfo, inspect_media
from framepilot_engine.media.waveform import WaveformData, compute_peaks, extract_waveform

__all__ = [
    "AssetEntry",
    "AssetIndex",
    "FFmpegError",
    "FFmpegNotFoundError",
    "MediaInfo",
    "NoAudioStreamError",
    "StreamInfo",
    "WaveformData",
    "compute_peaks",
    "extract_frame",
    "extract_waveform",
    "find_ffmpeg",
    "find_ffprobe",
    "generate_proxy",
    "generate_thumbnails",
    "index_assets",
    "inspect_media",
    "thumbnail_timestamps",
]
