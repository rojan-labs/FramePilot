"""Frozen-frame analysis via ffmpeg ``freezedetect`` (plan B1.1).

WHY: frozen video marks dropped-frame recordings, stuck captures, and dead
B-roll — a "deep" analysis pass flags these spans so the agent can propose
trims instead of shipping a stuck shot. Previously this capability existed
nowhere; ``blackdetect``'s sibling filter was simply unused.

This is an ANALYSIS capability — it returns data and never mutates the
timeline. The log **parser** is pure (unit-testable without ffmpeg) and the
subprocess call takes an injectable
:data:`framepilot_engine.media.ffmpeg.Runner`.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel, Field

from framepilot_engine.media.ffmpeg import Runner, find_ffmpeg, run_logs

# freezedetect reports each finding across three stderr lines (order guaranteed):
#   [freezedetect @ 0x..] lavfi.freezedetect.freeze_start: 4.504
#   [freezedetect @ 0x..] lavfi.freezedetect.freeze_duration: 2.033
#   [freezedetect @ 0x..] lavfi.freezedetect.freeze_end: 6.537
_FREEZE_START_RE = re.compile(r"freeze_start:\s*(-?\d+(?:\.\d+)?)")
_FREEZE_END_RE = re.compile(r"freeze_end:\s*(-?\d+(?:\.\d+)?)")

#: Default noise tolerance (dB) under which two frames count as identical.
DEFAULT_FREEZE_NOISE_DB = -60.0
#: Default minimum frozen span (seconds) to report. 2s is ffmpeg's own default:
#: brief holds are a normal editing device; multi-second freezes are defects.
DEFAULT_MIN_FREEZE_SECONDS = 2.0


class FrozenRange(BaseModel):
    """One detected span of frozen (unchanging) video (seconds)."""

    start: float = Field(ge=0.0, description="Freeze start time in seconds.")
    end: float = Field(ge=0.0, description="Freeze end time in seconds.")
    duration: float = Field(ge=0.0, description="Freeze length in seconds.")


def parse_frozen_ranges(logs: str, *, total_duration: float | None = None) -> list[FrozenRange]:
    """Reduce ffmpeg ``freezedetect`` stderr to typed frozen spans (pure).

    Pairs each ``freeze_start`` with its following ``freeze_end``. A trailing
    ``freeze_start`` with no end (video frozen through EOF — freezedetect emits
    no closing lines then) is closed at ``total_duration`` when known, and
    otherwise dropped (we cannot honestly report an end we do not have).

    :param logs: ffmpeg stderr text.
    :param total_duration: Media duration used to close a trailing open freeze.
    :returns: The detected spans in start order.
    """
    ranges: list[FrozenRange] = []
    open_start: float | None = None
    for line in logs.splitlines():
        end_match = _FREEZE_END_RE.search(line)
        if end_match and open_start is not None:
            end = max(0.0, float(end_match.group(1)))
            ranges.append(FrozenRange(start=open_start, end=end, duration=end - open_start))
            open_start = None
            continue
        start_match = _FREEZE_START_RE.search(line)
        if start_match:
            # Clamp like the other analyzers: never emit a negative time.
            open_start = max(0.0, float(start_match.group(1)))
    if open_start is not None and total_duration is not None and total_duration > open_start:
        ranges.append(
            FrozenRange(
                start=open_start,
                end=total_duration,
                duration=total_duration - open_start,
            )
        )
    return ranges


def detect_freezes(
    path: Path,
    *,
    noise_db: float = DEFAULT_FREEZE_NOISE_DB,
    min_freeze_seconds: float = DEFAULT_MIN_FREEZE_SECONDS,
    total_duration: float | None = None,
    runner: Runner | None = None,
    timeout: float | None = 60.0,
) -> list[FrozenRange]:
    """Run ffmpeg ``freezedetect`` on ``path`` and return the frozen spans.

    :param path: Media file to analyse (assumed already sandbox-resolved).
    :param noise_db: Noise tolerance in dB (negative) for frame equality.
    :param min_freeze_seconds: Minimum frozen span to report.
    :param total_duration: Optional media duration to close a trailing freeze.
    :param runner: ffmpeg stderr runner; defaults to the real subprocess runner.
    :param timeout: Per-call timeout in seconds (bounds the subprocess).
    :returns: The detected frozen spans.
    """
    invoke = runner or (lambda argv: run_logs(argv, timeout=timeout))
    argv = [
        find_ffmpeg(),
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-vf",
        f"freezedetect=n={noise_db}dB:d={min_freeze_seconds}",
        "-an",
        "-f",
        "null",
        "-",
    ]
    return parse_frozen_ranges(invoke(argv), total_duration=total_duration)
