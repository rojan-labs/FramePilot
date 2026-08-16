"""Black-frame analysis via ffmpeg ``blackdetect`` (plan B1.1).

WHY: black spans mark bad takes, gaps left by misaligned clips, and natural
chapter boundaries — edits like "trim the dead air at the start" need to know
*where* the picture is black. The detector was previously locked inside render
QC (:mod:`framepilot_engine.validation.render_validation`); this module makes
it a first-class analysis capability and the QC check now shares these parsers
(no logic duplication).

This is an ANALYSIS capability — it returns data and never mutates the
timeline. As with the other analyzers, the log **parser** is pure
(unit-testable without ffmpeg) and the subprocess call takes an injectable
:data:`framepilot_engine.media.ffmpeg.Runner`.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel, Field

from framepilot_engine.media.ffmpeg import Runner, find_ffmpeg, run_logs

# blackdetect reports each finding on one stderr line:
#   [blackdetect @ 0x..] black_start:0 black_end:5.008 black_duration:5.008
_BLACK_RANGE_RE = re.compile(
    r"black_start:\s*(-?\d+(?:\.\d+)?)\s+"
    r"black_end:\s*(-?\d+(?:\.\d+)?)\s+"
    r"black_duration:\s*(\d+(?:\.\d+)?)"
)
_BLACK_DURATION_RE = re.compile(r"black_duration:(\d+(?:\.\d+)?)")

#: Default minimum black-span length (seconds) to report as an analysis finding.
#: Render QC uses a much smaller 0.05s window (it hunts for *any* blackness in a
#: near-fully-black render); analysis surfaces editorially meaningful spans.
DEFAULT_MIN_BLACK_SECONDS = 0.5
#: Fraction of pixels that must be below the pixel threshold for a "black" frame.
DEFAULT_PICTURE_THRESHOLD = 0.98
#: Luminance threshold (0..1) below which a pixel counts as black.
DEFAULT_PIXEL_THRESHOLD = 0.10


class BlackRange(BaseModel):
    """One detected span of (near-)black video (seconds)."""

    start: float = Field(ge=0.0, description="Black span start time in seconds.")
    end: float = Field(ge=0.0, description="Black span end time in seconds.")
    duration: float = Field(ge=0.0, description="Black span length in seconds.")


def parse_black_ranges(logs: str) -> list[BlackRange]:
    """Reduce ffmpeg ``blackdetect`` stderr to typed black spans (pure).

    A negative ``black_start`` (ffmpeg clamps to just before 0) is normalised to
    0 so downstream edits never receive a negative time.

    :param logs: ffmpeg stderr text.
    :returns: The detected spans in start order.
    """
    ranges = [
        BlackRange(
            start=max(0.0, float(start)),
            end=max(0.0, float(end)),
            duration=float(duration),
        )
        for start, end, duration in _BLACK_RANGE_RE.findall(logs)
    ]
    return sorted(ranges, key=lambda r: r.start)


def parse_black_seconds(logs: str) -> float:
    """Sum the ``black_duration`` values reported by ffmpeg ``blackdetect`` (pure).

    Used by render QC (:mod:`framepilot_engine.validation.render_validation`),
    which only needs the total to compute a black ratio.

    :param logs: ffmpeg stderr text.
    :returns: Total seconds detected as black (0.0 if none).
    """
    return sum(float(m) for m in _BLACK_DURATION_RE.findall(logs))


def _blackdetect_argv(path: Path, filter_params: str) -> list[str]:
    return [
        find_ffmpeg(),
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-vf",
        f"blackdetect={filter_params}",
        "-an",
        "-f",
        "null",
        "-",
    ]


def detect_black(
    path: Path,
    *,
    min_black_seconds: float = DEFAULT_MIN_BLACK_SECONDS,
    picture_threshold: float = DEFAULT_PICTURE_THRESHOLD,
    pixel_threshold: float = DEFAULT_PIXEL_THRESHOLD,
    runner: Runner | None = None,
    timeout: float | None = 60.0,
) -> list[BlackRange]:
    """Run ffmpeg ``blackdetect`` on ``path`` and return the black spans.

    :param path: Media file to analyse (assumed already sandbox-resolved).
    :param min_black_seconds: Minimum span length to report.
    :param picture_threshold: Fraction of black pixels for a frame to count.
    :param pixel_threshold: Luminance below which a pixel counts as black.
    :param runner: ffmpeg stderr runner; defaults to the real subprocess runner.
    :param timeout: Per-call timeout in seconds (bounds the subprocess).
    :returns: The detected black spans.
    """
    invoke = runner or (lambda argv: run_logs(argv, timeout=timeout))
    argv = _blackdetect_argv(
        path,
        f"d={min_black_seconds}:pic_th={picture_threshold}:pix_th={pixel_threshold}",
    )
    return parse_black_ranges(invoke(argv))


def detect_black_seconds(path: Path, *, runner: Runner) -> float:
    """Run ``blackdetect`` tuned for render QC and return total black seconds.

    The 0.05s window is deliberate: QC asks "is this render (near-)entirely
    black", so even the shortest black run must be counted. The ``runner``
    already carries any timeout.
    """
    argv = _blackdetect_argv(path, "d=0.05:pic_th=0.98:pix_th=0.10")
    return parse_black_seconds(runner(argv))
