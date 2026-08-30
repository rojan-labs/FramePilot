"""Encoder selection for exports (plan/system-mission P7.4).

Picks the ffmpeg video encoder for a target: a hardware encoder when the local ffmpeg
has one (VideoToolbox on Apple silicon, NVENC, QSV) and the editor has not opted out,
else the software encoder with a preset mapped from the quality tier. The choice is a
plain value the encode step logs, so a slow export can be explained by the exact
encoder and arguments it ran with.

``FRAMEPILOT_HW_ENCODE=0`` forces software encoding (comparisons, a driver that
misbehaves). The probe runs once per process.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from framepilot_engine.media.ffmpeg import FFmpegError, run

#: Hardware encoders in preference order, per codec.
HARDWARE_ENCODERS: dict[str, tuple[str, ...]] = {
    "h264": ("h264_videotoolbox", "h264_nvenc", "h264_qsv"),
    "hevc": ("hevc_videotoolbox", "hevc_nvenc", "hevc_qsv"),
}
SOFTWARE_ENCODERS: dict[str, str] = {"h264": "libx264", "hevc": "libx265"}
#: x264/x265 preset per quality tier — the speed/size trade the tier name promises.
SOFTWARE_PRESET: dict[str, str] = {"low": "veryfast", "recommended": "medium", "high": "slow"}

_probe_cache: set[str] | None = None


def hardware_encoding_enabled(env: dict[str, str] | None = None) -> bool:
    value = (env if env is not None else dict(os.environ)).get("FRAMEPILOT_HW_ENCODE", "1")
    return value.strip().lower() not in {"0", "false", "no", "off"}


def parse_encoder_list(text: str) -> set[str]:
    """Names from ``ffmpeg -encoders`` output (the second column of each ``V....`` row)."""
    names: set[str] = set()
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith("V") and len(parts[0]) == 6 and parts[1] != "=":
            names.add(parts[1])
    return names


def _moviepy_ffmpeg_binary() -> str:
    """The exact binary ``VideoClip.write_videofile`` will actually run.

    MoviePy resolves ffmpeg through imageio-ffmpeg directly, never through this
    project's :func:`~framepilot_engine.media.ffmpeg.find_ffmpeg` — so probing with
    that function instead of this one used to pick a hardware encoder the *probed*
    binary had (e.g. the system ffmpeg on Linux CI reports ``h264_nvenc`` as
    registered, no GPU required for it to appear in ``-encoders``) that the binary
    MoviePy actually invokes does not, failing every hardware-selected export with
    ``Unknown encoder``.
    """
    import imageio_ffmpeg

    return str(imageio_ffmpeg.get_ffmpeg_exe())


def available_encoders(runner: Callable[[Sequence[str]], str] | None = None) -> set[str]:
    """Video encoder names ``write_videofile``'s own ffmpeg reports; cached for the process."""
    global _probe_cache
    if _probe_cache is not None and runner is None:
        return _probe_cache
    invoke = runner or (lambda argv: run(argv, timeout=15.0))
    try:
        names = parse_encoder_list(invoke([_moviepy_ffmpeg_binary(), "-hide_banner", "-encoders"]))
    except (FFmpegError, OSError):
        names = set()
    if runner is None:
        _probe_cache = names
    return names


def reset_probe_cache() -> None:
    global _probe_cache
    _probe_cache = None


@dataclass(frozen=True)
class EncoderChoice:
    """What the encode step runs with."""

    codec: str
    name: str
    hardware: bool
    #: MoviePy ``preset`` (software encoders only).
    preset: str | None
    ffmpeg_params: list[str] = field(default_factory=list)

    def describe(self) -> str:
        kind = "hardware" if self.hardware else "software"
        extra = f" preset={self.preset}" if self.preset else ""
        return f"{self.name} ({kind}){extra} {' '.join(self.ffmpeg_params)}".strip()


def choose_encoder(
    codec: str,
    *,
    quality: str = "recommended",
    container: str = "mp4",
    available: set[str] | None = None,
    allow_hardware: bool | None = None,
) -> EncoderChoice:
    """Pick the encoder for ``codec`` given what ffmpeg offers.

    :param codec: ``h264`` or ``hevc`` (the settings vocabulary).
    :param quality: Quality tier; maps to the software preset.
    :param container: ``mp4``/``mov`` — decides the HEVC tag and faststart.
    :param available: Encoder names to choose from (default: probe ffmpeg once).
    :param allow_hardware: Override the env toggle (tests).
    """
    if codec not in SOFTWARE_ENCODERS:
        raise ValueError(f"Unknown video codec {codec!r}; expected h264 or hevc.")
    names = available if available is not None else available_encoders()
    hardware_ok = hardware_encoding_enabled() if allow_hardware is None else allow_hardware
    params: list[str] = ["-movflags", "+faststart"]
    if codec == "hevc":
        # Apple players only recognise HEVC in MP4/MOV under the hvc1 tag.
        params += ["-tag:v", "hvc1"]
    if hardware_ok:
        for candidate in HARDWARE_ENCODERS[codec]:
            if candidate in names:
                extra = ["-allow_sw", "1"] if candidate.endswith("_videotoolbox") else []
                return EncoderChoice(codec, candidate, True, None, params + extra)
    return EncoderChoice(
        codec, SOFTWARE_ENCODERS[codec], False, SOFTWARE_PRESET.get(quality, "medium"), params
    )
