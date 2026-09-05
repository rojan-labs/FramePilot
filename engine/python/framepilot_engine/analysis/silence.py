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

import logging
import re
from collections.abc import Sequence
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

_log = logging.getLogger(__name__)

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
#: The floor the engine always MEASURES at, whatever reporting threshold the caller
#: asked for.
#:
#: WHY: ``silencedetect``'s ``d=`` is applied INSIDE ffmpeg, so asking for gaps ≥0.55s
#: makes the decode itself incapable of reporting the 0.449s gaps that were there. The
#: empty range list that comes back is empty *by construction*, and the agent read it as
#: "this recording has no dead air" — then raised its threshold and abandoned the cut on a
#: 49.8s take holding 10.65s of dead air across 56 gaps. Probing low and filtering in
#: Python is the same single decode and keeps the absence explainable.
SILENCE_PROBE_FLOOR_SECONDS = 0.1
#: Float slack when comparing a measured span against a threshold. ffmpeg reports
#: times to 5 decimals, so an exactly-at-threshold gap must not be lost to binary
#: representation.
_DURATION_EPS = 1e-6


class SilentRange(BaseModel):
    """One detected silent span on the audio (seconds)."""

    start: float = Field(ge=0.0, description="Silence start time in seconds.")
    end: float = Field(ge=0.0, description="Silence end time in seconds.")
    duration: float = Field(ge=0.0, description="Silence length in seconds.")


class SilenceMeasurement(BaseModel):
    """What one silencedetect pass found, reported against a requested threshold.

    ``ranges`` is the actionable answer (gaps at or over ``minSilenceSeconds``); the
    remaining fields describe the gaps that fell BELOW it, which the caller would
    otherwise have no way to distinguish from a recording with no dead air at all.

    Serialized with camelCase aliases: both the ``/analyze-silence`` response and the
    unified ``/analyze`` silence entry carry these fields to the TS orchestrator.
    """

    ranges: list[SilentRange] = Field(
        default_factory=list, description="Silences at or over the requested threshold."
    )
    measured_count: int = Field(
        default=0,
        ge=0,
        alias="measuredCount",
        description="Every silence seen at the probe floor, including sub-threshold ones.",
    )
    longest_seconds: float = Field(
        default=0.0,
        ge=0.0,
        alias="longestSeconds",
        description="Longest measured silence in seconds (0 when nothing was measured).",
    )
    below_threshold_seconds: float = Field(
        default=0.0,
        ge=0.0,
        alias="belowThresholdSeconds",
        description="Total seconds of silence sitting in gaps shorter than the threshold.",
    )
    probe_floor_seconds: float = Field(
        default=SILENCE_PROBE_FLOOR_SECONDS,
        ge=0.0,
        alias="probeFloorSeconds",
        description="Shortest gap the measurement could see at all.",
    )
    #: THE LEVEL THAT DEFINED "SILENT" — carried because the count means nothing without it.
    #: Run ``137d8fd0``: wind-only GoPro audio, no speech, and an editor who asked "check
    #: whether there's any real silence and tell me straight; I don't think there is". The
    #: probe found 728 stretches under the default floor and the run said "silences
    #: catalogued". Quiet wind IS below -30 dB. Whether that is silence is a judgement the
    #: reader can only make if the payload says what level it was judged against.
    noise_floor_db: float = Field(
        default=DEFAULT_NOISE_FLOOR_DB,
        alias="noiseFloorDb",
        description="Level (dBFS) below which audio counted as silent for this measurement.",
    )
    min_silence_seconds: float = Field(
        default=DEFAULT_MIN_SILENCE_SECONDS,
        ge=0.0,
        alias="minSilenceSeconds",
        description="Shortest gap reported in `ranges`; shorter ones are summed below.",
    )

    model_config = {"populate_by_name": True}


def summarize_silence(
    measured: Sequence[SilentRange],
    *,
    min_silence_seconds: float,
    probe_floor_seconds: float = SILENCE_PROBE_FLOOR_SECONDS,
    noise_floor_db: float = DEFAULT_NOISE_FLOOR_DB,
) -> SilenceMeasurement:
    """Split a probe-floor measurement into the reportable ranges plus what sat below (pure).

    Spans are compared as ``end - start`` rather than the reported ``duration``: that is
    the quantity the TS cutter re-derives from the payload it receives, and the two must
    agree on which gaps qualify or a range can clear the engine's filter and be silently
    dropped by the consumer.

    :param measured: Every silence the probe found, at ``probe_floor_seconds``.
    :param min_silence_seconds: The threshold the caller actually asked to act on.
    :param probe_floor_seconds: The floor the measurement ran at (reported back).
    :param noise_floor_db: The level the decode treated as silent (reported back, so a
        count of "silences" can be read as the level it actually is).
    :returns: The filtered ranges plus the sub-threshold measurement.
    """
    kept: list[SilentRange] = []
    longest = 0.0
    below_seconds = 0.0
    for span in measured:
        length = span.end - span.start
        longest = max(longest, length)
        if length >= min_silence_seconds - _DURATION_EPS:
            kept.append(span)
        else:
            below_seconds += length
    _log.debug(
        "silence summary: %d measured at floor %.2fs → %d at ≥%.2fs (longest %.3fs, %.2fs below)",
        len(measured),
        probe_floor_seconds,
        len(kept),
        min_silence_seconds,
        longest,
        below_seconds,
    )
    return SilenceMeasurement(
        ranges=kept,
        measured_count=len(measured),
        longest_seconds=longest,
        below_threshold_seconds=below_seconds,
        probe_floor_seconds=probe_floor_seconds,
        noise_floor_db=noise_floor_db,
        min_silence_seconds=min_silence_seconds,
    )


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
