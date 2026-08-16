"""Silence analysis via ffmpeg ``silencedetect`` (plan Phase 9.2).

WHY: "remove silence" / "tighten pacing" edits need to know *where* the silent
gaps are. Rather than ship audio to the client, the engine runs ffmpeg's
``silencedetect`` audio filter and reduces its log output to a list of typed
:class:`SilentRange`s the AI orchestrator can turn into ripple-delete edits.

This is an ANALYSIS capability — it returns data and never mutates the timeline.
Following :mod:`framepilot_engine.validation.render_validation`, the log
**parser** is pure (unit-testable without ffmpeg) and the subprocess call takes
an injectable :data:`framepilot_engine.media.ffmpeg.Runner`.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel, Field

from framepilot_engine.media.ffmpeg import (
    FFmpegError,
    NoAudioStreamError,
    Runner,
    find_ffmpeg,
    run_logs,
)
from framepilot_engine.media.probe import inspect_media

# silencedetect emits its findings on stderr in this shape (order guaranteed:
# a ``silence_start`` line, then a ``silence_end … | silence_duration …`` line):
#   [silencedetect @ 0x..] silence_start: 3.20049
#   [silencedetect @ 0x..] silence_end: 5.80000 | silence_duration: 2.59951
_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_SILENCE_END_RE = re.compile(
    r"silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)"
)

#: Default RMS threshold below which audio counts as silence. ``silencedetect``
#: takes this in dB (negative); -30 dB is a common speech-gap default.
DEFAULT_NOISE_FLOOR_DB = -30.0
#: Default minimum gap length (seconds) to report — shorter dips are ignored so
#: we surface real pauses, not inter-word micro-gaps.
DEFAULT_MIN_SILENCE_SECONDS = 0.5


class SilentRange(BaseModel):
    """One detected silent span on the audio (seconds)."""

    start: float = Field(ge=0.0, description="Silence start time in seconds.")
    end: float = Field(ge=0.0, description="Silence end time in seconds.")
    duration: float = Field(ge=0.0, description="Silence length in seconds.")


def parse_silence_ranges(logs: str, *, total_duration: float | None = None) -> list[SilentRange]:
    """Reduce ffmpeg ``silencedetect`` stderr to typed silent ranges (pure).

    Pairs each ``silence_start`` with its following ``silence_end`` /
    ``silence_duration`` line. A trailing ``silence_start`` with no matching end
    (silence that runs to the end of the file) is closed at ``total_duration``
    when that is known, and otherwise dropped (we cannot honestly report an
    end/duration we do not have).

    :param logs: ffmpeg stderr text.
    :param total_duration: Media duration used to close a trailing open silence.
    :returns: The detected ranges in start order.
    """
    ranges: list[SilentRange] = []
    open_start: float | None = None
    for line in logs.splitlines():
        end_match = _SILENCE_END_RE.search(line)
        if end_match and open_start is not None:
            end = float(end_match.group(1))
            duration = float(end_match.group(2))
            ranges.append(SilentRange(start=open_start, end=end, duration=duration))
            open_start = None
            continue
        start_match = _SILENCE_START_RE.search(line)
        if start_match:
            # A negative silence_start (ffmpeg clamps to just before 0) is normalised
            # to 0 so downstream edits never receive a negative time.
            open_start = max(0.0, float(start_match.group(1)))
    if open_start is not None and total_duration is not None and total_duration > open_start:
        ranges.append(
            SilentRange(
                start=open_start,
                end=total_duration,
                duration=total_duration - open_start,
            )
        )
    return ranges


def _decode_failure(path: Path, exc: FFmpegError, *, timeout: float | None) -> FFmpegError:
    """Classify a failed silencedetect run of ``path`` into the error worth reporting.

    :param path: The media whose decode failed.
    :param exc: The original ffmpeg failure, returned as-is when the cause is not
        a missing audio stream (or when the probe itself cannot answer).
    :param timeout: Timeout for the classifying probe.
    :returns: A :class:`NoAudioStreamError` when the media has no audio, else ``exc``.
    """
    try:
        info = inspect_media(path, timeout=timeout)
    except (FFmpegError, FileNotFoundError):
        return exc
    if info.has_audio:
        return exc
    return NoAudioStreamError(
        f"{path.name} has no audio track, so there is no silence to detect. "
        "Run silence detection on an asset with audio instead."
    )


def detect_silence(
    path: Path,
    *,
    noise_floor_db: float = DEFAULT_NOISE_FLOOR_DB,
    min_silence_seconds: float = DEFAULT_MIN_SILENCE_SECONDS,
    total_duration: float | None = None,
    runner: Runner | None = None,
    timeout: float | None = 60.0,
) -> list[SilentRange]:
    """Run ffmpeg ``silencedetect`` on ``path`` and return the silent ranges.

    :param path: Media file to analyse (assumed already sandbox-resolved).
    :param noise_floor_db: RMS dB below which audio counts as silence (negative).
    :param min_silence_seconds: Minimum gap length to report.
    :param total_duration: Optional media duration to close a trailing silence.
    :param runner: ffmpeg stderr runner; defaults to the real subprocess runner.
    :param timeout: Per-call timeout in seconds (bounds the subprocess).
    :returns: The detected silent ranges.
    :raises NoAudioStreamError: If ``path`` carries no audio stream to analyse.
    :raises FFmpegError: If the decode fails for any other reason.
    """
    invoke = runner or (lambda argv: run_logs(argv, timeout=timeout))
    argv = [
        find_ffmpeg(),
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-af",
        f"silencedetect=noise={noise_floor_db}dB:d={min_silence_seconds}",
        "-vn",
        "-f",
        "null",
        "-",
    ]
    try:
        logs = invoke(argv)
    except FFmpegError as exc:
        # A video-only asset is the overwhelmingly common cause: with `-vn` and no
        # audio track there is nothing to write, so ffmpeg exits non-zero with
        # "Output file does not contain any stream". Probe rather than string-match
        # its stderr — the wording is version-specific, the stream list is not — and
        # only on the failure path, so the happy path pays no extra subprocess.
        raise _decode_failure(path, exc, timeout=timeout) from exc
    return parse_silence_ranges(logs, total_duration=total_duration)
