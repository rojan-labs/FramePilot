"""Audio filtering through ffmpeg.

Master-bus and per-clip EQ/dynamics are standard deterministic ffmpeg filters. Keeping those
processors here avoids whole-program NumPy PCM materialization and keeps one supported DSP
implementation for both mastering and clip channel strips.
"""

from __future__ import annotations

import math
import re
import subprocess
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from framepilot_engine.media.ffmpeg import find_ffmpeg

LOUDNESS_PRESETS: dict[str, float] = {
    "social": -14.0,
    "podcast": -16.0,
    "broadcast": -23.0,
}

EQ_PRESETS: dict[str, tuple[tuple[float, float, float], ...]] = {
    "flat": (),
    "warm": ((150.0, 3.0, 1.0), (3000.0, -2.0, 1.0), (10000.0, -1.0, 1.0)),
    "bright": ((150.0, -2.0, 1.0), (4000.0, 3.0, 1.0), (10000.0, 2.0, 1.0)),
    "voice-clarity": ((100.0, -3.0, 1.0), (3500.0, 4.0, 1.0), (9000.0, 2.0, 1.0)),
}

COMPRESSION_PRESETS: dict[str, tuple[float, float, float, float, float]] = {
    "voice": (-18.0, 3.0, 20.0, 250.0, 4.0),
}

_TRUE_PEAK_DB = -1.5
_LOUDNESS_RANGE = 11.0
_LIMITER_CEILING = 0.95
_DENOISE_NR_DB = 12.0
_MAX_VOLUME = re.compile(r"max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB", re.IGNORECASE)


def _build_eq_filter(preset: str) -> list[str]:
    try:
        bands = EQ_PRESETS[preset]
    except KeyError as exc:
        raise ValueError(
            f"Unknown EQ preset {preset!r}. Known: {sorted(EQ_PRESETS)}."
        ) from exc
    return [
        f"equalizer=f={freq}:width_type=o:w={octaves}:g={gain}" for freq, gain, octaves in bands
    ]


def _build_compression_filter(preset: str) -> str:
    try:
        threshold, ratio, attack, release, makeup = COMPRESSION_PRESETS[preset]
    except KeyError as exc:
        raise ValueError(
            f"Unknown compression preset {preset!r}. Known: {sorted(COMPRESSION_PRESETS)}."
        ) from exc
    return (
        f"acompressor=threshold={threshold}dB:ratio={ratio}:"
        f"attack={attack}:release={release}:makeup={makeup}dB"
    )


def build_master_filter(
    *,
    denoise: bool = False,
    eq: str | None = None,
    compression: str | None = None,
    loudness: str | None = None,
    limiter: bool = False,
) -> str | None:
    parts: list[str] = []
    if denoise:
        parts.append(f"afftdn=nr={_DENOISE_NR_DB}")
    if eq is not None:
        parts.extend(_build_eq_filter(eq))
    if compression is not None:
        parts.append(_build_compression_filter(compression))
    if loudness is not None:
        try:
            target = LOUDNESS_PRESETS[loudness]
        except KeyError as exc:
            raise ValueError(
                f"Unknown loudness preset {loudness!r}. Known: {sorted(LOUDNESS_PRESETS)}."
            ) from exc
        parts.append(f"loudnorm=I={target}:TP={_TRUE_PEAK_DB}:LRA={_LOUDNESS_RANGE}")
    if limiter:
        parts.append(f"alimiter=limit={_LIMITER_CEILING}")
    return ",".join(parts) if parts else None


def build_clip_filter(
    *,
    eq_bands: Sequence[Mapping[str, Any]] = (),
    dynamics: Mapping[str, Any] | None = None,
    normalize_gain_db: float | None = None,
) -> str | None:
    """Build the per-clip channel-strip filtergraph.

    Order matches the compiler contract: peak normalize → EQ → compressor. The timeline fader,
    fades, ducking and automation remain MoviePy time-domain gain operations after this pass.
    """
    parts: list[str] = []
    if normalize_gain_db is not None and abs(normalize_gain_db) > 1e-9:
        parts.append(f"volume={normalize_gain_db:.9g}dB")
    for band in eq_bands:
        kind = str(band.get("kind", ""))
        frequency = float(band.get("frequencyHz", 0.0))
        q = float(band.get("q") or 0.707)
        gain = float(band.get("gainDb") or 0.0)
        if frequency <= 0.0:
            continue
        if kind == "peaking":
            parts.append(
                f"equalizer=f={frequency:.9g}:width_type=q:w={q:.9g}:g={gain:.9g}"
            )
        elif kind == "low-shelf":
            parts.append(f"lowshelf=f={frequency:.9g}:width_type=q:w={q:.9g}:g={gain:.9g}")
        elif kind == "high-shelf":
            parts.append(f"highshelf=f={frequency:.9g}:width_type=q:w={q:.9g}:g={gain:.9g}")
        elif kind == "high-pass":
            parts.append(f"highpass=f={frequency:.9g}:width_type=q:w={q:.9g}")
        elif kind == "low-pass":
            parts.append(f"lowpass=f={frequency:.9g}:width_type=q:w={q:.9g}")
    if dynamics is not None:
        threshold = float(dynamics.get("thresholdDb", 0.0))
        ratio = max(1.0, float(dynamics.get("ratio", 1.0)))
        attack = float(dynamics.get("attackMs", 10.0))
        release = float(dynamics.get("releaseMs", 100.0))
        makeup = float(dynamics.get("makeupGainDb", 0.0) or 0.0)
        parts.append(
            f"acompressor=threshold={threshold:.9g}dB:ratio={ratio:.9g}:"
            f"attack={attack:.9g}:release={release:.9g}:makeup={makeup:.9g}dB"
        )
    return ",".join(parts) if parts else None


def measure_peak_dbfs_file(src: Path, *, ffmpeg: str | None = None) -> float | None:
    """Measure a file's sample peak with ffmpeg `volumedetect`, without loading PCM in Python."""
    binary = ffmpeg or find_ffmpeg()
    argv = [
        binary,
        "-hide_banner",
        "-nostdin",
        "-i",
        str(src),
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
    ]
    _validate_ffmpeg_args(argv)
    completed = subprocess.run(
        argv,
        check=True,
        capture_output=True,
        text=True,
    )
    matches = _MAX_VOLUME.findall(completed.stderr)
    if not matches:
        return None
    value = matches[-1].lower()
    if value == "-inf":
        return None
    parsed = float(value)
    return parsed if math.isfinite(parsed) else None


def peak_normalize_gain_db(src: Path, target_dbfs: float = -1.0) -> float:
    peak = measure_peak_dbfs_file(src)
    return 0.0 if peak is None else target_dbfs - peak


def _validate_ffmpeg_args(args: Sequence[str]) -> None:
    """Reject malformed ffmpeg argv before subprocess execution (defense in depth).

    WHY validation only, no rewriting: every caller builds argv from sandboxed
    paths (PRD §18.1, enforced at the route boundary) plus fixed flags and
    preset-derived filter strings. We additionally refuse empty tokens and
    control characters (NUL/CR/LF) that could confuse downstream tooling or
    log parsers. We deliberately do NOT mutate argv (e.g. inserting ``--``):
    that would corrupt legitimate invocations whose values start with ``-``
    and does not address any real injection surface for an argv-array exec.
    """
    if not args:
        raise ValueError("ffmpeg arguments must not be empty.")
    for part in args:
        if not part:
            raise ValueError("ffmpeg arguments must not contain empty values.")
        if "\x00" in part or "\n" in part or "\r" in part:
            raise ValueError("ffmpeg arguments contain invalid control characters.")


def _default_runner(args: Sequence[str]) -> None:
    subprocess.run(list(args), check=True, capture_output=True)


def apply_audio_filter(
    src: Path,
    dst: Path,
    filter_str: str,
    *,
    ffmpeg: str | None = None,
    run: Callable[[Sequence[str]], None] = _default_runner,
    audio_codec: str = "pcm_f32le",
) -> None:
    """Apply an audio-only filtergraph to a file using bounded ffmpeg streaming I/O."""
    binary = ffmpeg or find_ffmpeg()
    argv = [
        binary,
        "-y",
        "-nostdin",
        "-i",
        str(src),
        "-af",
        filter_str,
        "-vn",
        "-c:a",
        audio_codec,
        str(dst),
    ]
    _validate_ffmpeg_args(argv)
    run(argv)


def apply_master_audio(
    src: Path,
    dst: Path,
    filter_str: str,
    *,
    ffmpeg: str | None = None,
    run: Callable[[Sequence[str]], None] = _default_runner,
    audio_codec: str = "aac",
) -> None:
    """Run a single ffmpeg pass applying ``filter_str`` to ``src``'s audio → ``dst``."""
    binary = ffmpeg or find_ffmpeg()
    argv = [
        binary,
        "-y",
        "-i",
        str(src),
        "-af",
        filter_str,
        "-c:v",
        "copy",
        "-c:a",
        audio_codec,
        str(dst),
    ]
    _validate_ffmpeg_args(argv)
    run(argv)
