"""Media inspection via ffprobe (plan 2.1, ``inspect-media``).

WHY: the render compiler and validator need a media file's *real* duration, fps,
resolution, and stream layout — the timeline cannot be trusted to know them. This
module wraps ``ffprobe -show_format -show_streams`` and parses its JSON into a
typed :class:`MediaInfo`, which is part of the IPC contract (it crosses to the
desktop shell). The parsing is pure and the ffprobe call is injectable, so the
parser is unit-testable without the binary.
"""

from __future__ import annotations

import json
from fractions import Fraction
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from framepilot_engine.media.ffmpeg import FFmpegError, Runner, find_ffprobe, run

# ffprobe stream codec_type values we care about.
_VIDEO = "video"
_AUDIO = "audio"

# ffprobe container-format tokens for single-frame still images (photos). A
# still image decodes as ONE video stream with no audio, and ffprobe reports a
# bogus ~0.04s container duration for it (e.g. WhatsApp JPEGs, PNGs). Callers
# must therefore classify images on the container FORMAT, never on duration —
# keying off duration mislabels every photo a zero-length "video", which then
# sends the timeline chasing per-frame filmstrip thumbnails that never exist.
# Animated containers (gif/apng/animated webp) are deliberately excluded so they
# stay classified as video. ``format_name`` is a comma-joined token list.
_STILL_IMAGE_FORMATS = frozenset(
    {
        "image2",
        "image2pipe",
        "png_pipe",
        "mjpeg",
        "jpeg_pipe",
        "jpegls_pipe",
        "webp_pipe",
        "bmp_pipe",
        "tiff_pipe",
        "psd_pipe",
    }
)


class StreamInfo(BaseModel):
    """A single media stream (video or audio) as reported by ffprobe."""

    index: int
    codec_type: str = Field(description="'video', 'audio', or another ffprobe type.")
    codec_name: str | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = Field(default=None, description="Frames/sec for video streams.")
    duration_seconds: float | None = None
    sample_rate: int | None = Field(default=None, description="Audio sample rate (Hz).")
    channels: int | None = Field(default=None, description="Audio channel count.")


class MediaInfo(BaseModel):
    """Typed result of probing a media file (plan 2.1)."""

    path: str
    duration_seconds: float | None = None
    format_name: str | None = None
    size_bytes: int | None = None
    streams: list[StreamInfo] = Field(default_factory=list)

    @property
    def video_streams(self) -> list[StreamInfo]:
        """All video streams, in ffprobe order."""
        return [s for s in self.streams if s.codec_type == _VIDEO]

    @property
    def audio_streams(self) -> list[StreamInfo]:
        """All audio streams, in ffprobe order."""
        return [s for s in self.streams if s.codec_type == _AUDIO]

    @property
    def has_video(self) -> bool:
        """True if the file contains at least one video stream."""
        return bool(self.video_streams)

    @property
    def has_audio(self) -> bool:
        """True if the file contains at least one audio stream."""
        return bool(self.audio_streams)

    @property
    def is_image(self) -> bool:
        """True if this is a single still image (photo), not a video/audio clip.

        A still image decodes as one video stream with no audio. ffprobe hands
        back a bogus ~0.04s duration for it, so we classify on the container
        format (the still-image demuxers in :data:`_STILL_IMAGE_FORMATS`) rather
        than trusting the duration. A durationless video stream with no audio
        also falls through to "image" — the safest read of a single decodable
        frame that carries no timeline (matches the prior fallback behaviour).
        """
        if not self.has_video or self.has_audio:
            return False
        tokens = {t.strip() for t in (self.format_name or "").split(",")}
        if tokens & _STILL_IMAGE_FORMATS:
            return True
        return not self.duration_seconds

    @property
    def width(self) -> int | None:
        """Width of the first video stream, if any."""
        return self.video_streams[0].width if self.video_streams else None

    @property
    def height(self) -> int | None:
        """Height of the first video stream, if any."""
        return self.video_streams[0].height if self.video_streams else None

    @property
    def fps(self) -> float | None:
        """Frame rate of the first video stream, if any."""
        return self.video_streams[0].fps if self.video_streams else None


def _to_float(value: Any) -> float | None:
    """Best-effort float parse; ffprobe emits numbers as strings or 'N/A'."""
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _to_int(value: Any) -> int | None:
    """Best-effort int parse for ffprobe string fields."""
    parsed = _to_float(value)
    return int(parsed) if parsed is not None else None


def _parse_fps(rate: Any) -> float | None:
    """Parse an ffprobe frame-rate field like ``"30000/1001"`` into fps.

    A ``0/0`` (image/attachment streams) or unparseable value yields ``None``.
    """
    if not rate or not isinstance(rate, str) or "/" not in rate:
        return _to_float(rate)
    try:
        fraction = Fraction(rate)
    except (ValueError, ZeroDivisionError):
        return None
    return float(fraction) if fraction != 0 else None


def _parse_stream(raw: dict[str, Any]) -> StreamInfo:
    """Map one ffprobe stream object to :class:`StreamInfo`.

    Prefers ``avg_frame_rate`` over ``r_frame_rate`` for fps because the average
    reflects the real played-back rate for variable-frame-rate sources.
    """
    fps = _parse_fps(raw.get("avg_frame_rate")) or _parse_fps(raw.get("r_frame_rate"))
    return StreamInfo(
        index=_to_int(raw.get("index")) or 0,
        codec_type=str(raw.get("codec_type", "unknown")),
        codec_name=raw.get("codec_name"),
        width=_to_int(raw.get("width")),
        height=_to_int(raw.get("height")),
        fps=fps if raw.get("codec_type") == _VIDEO else None,
        duration_seconds=_to_float(raw.get("duration")),
        sample_rate=_to_int(raw.get("sample_rate")),
        channels=_to_int(raw.get("channels")),
    )


def parse_ffprobe_json(path: str, payload: str) -> MediaInfo:
    """Parse raw ffprobe JSON text into :class:`MediaInfo` (pure).

    Exposed separately from :func:`inspect_media` so the parser is unit-testable
    against fixture JSON without running ffprobe.

    :param path: The probed file path (echoed into the result).
    :param payload: ffprobe stdout (``-print_format json`` output).
    :returns: The parsed :class:`MediaInfo`.
    :raises FFmpegError: If ``payload`` is not valid ffprobe JSON.
    """
    try:
        data: dict[str, Any] = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise FFmpegError(f"ffprobe returned invalid JSON for {path!r}: {exc}") from exc

    fmt = data.get("format") or {}
    streams = [_parse_stream(s) for s in data.get("streams", [])]
    return MediaInfo(
        path=path,
        duration_seconds=_to_float(fmt.get("duration")),
        format_name=fmt.get("format_name"),
        size_bytes=_to_int(fmt.get("size")),
        streams=streams,
    )


def inspect_media(
    path: Path,
    *,
    runner: Runner | None = None,
    timeout: float | None = 30.0,
) -> MediaInfo:
    """Probe a media file's duration, fps, resolution, and streams (plan 2.1).

    The path is expected to be already sandbox-resolved by the caller (see
    :func:`framepilot_engine.safety.resolve_within`); this primitive only checks
    that the file exists before invoking ffprobe.

    :param path: Path to the media file to probe.
    :param runner: ffprobe invoker; defaults to the real subprocess
        :func:`framepilot_engine.media.ffmpeg.run`. Injected in tests.
    :param timeout: Hard timeout in seconds for the ffprobe call.
    :returns: A typed :class:`MediaInfo`.
    :raises FileNotFoundError: If ``path`` does not exist.
    :raises FFmpegError: If ffprobe fails or returns unparseable output.
    """
    # `path` is contractually pre-sandboxed by the caller (see the docstring's
    # `resolve_within` note) before it ever reaches this primitive. CodeQL cannot
    # model that cross-function barrier, so this documented suppression stands in
    # for its taint analysis.
    # codeql[py/path-injection]
    if not path.exists():
        raise FileNotFoundError(f"Media file does not exist: {path}")

    argv = [
        find_ffprobe(),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    invoke = runner if runner is not None else (lambda a: run(a, timeout=timeout))
    payload = invoke(argv)
    return parse_ffprobe_json(str(path), payload)
