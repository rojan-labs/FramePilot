"""Loudness measurement via ffmpeg ``ebur128`` (plan B1.1).

WHY: "is this clip too quiet for Reels?" / "match the levels" decisions need
EBU R128 measurements — integrated loudness (LUFS), loudness range (LU), and
true peak (dBTP). This is the **measure** counterpart to the ``loudnorm``
correction presets in :mod:`framepilot_engine.audio.filters`; the analyzer only
reads, the filters only write.

This is an ANALYSIS capability — it returns data and never mutates the
timeline. The ``ebur128`` summary **parser** is pure (unit-testable without
ffmpeg) and the subprocess call takes an injectable
:data:`framepilot_engine.media.ffmpeg.Runner`.
"""

from __future__ import annotations

import re
from pathlib import Path

from pydantic import BaseModel, Field

from framepilot_engine.media.ffmpeg import Runner, find_ffmpeg, run_logs

# ebur128 prints a summary block on stderr at end of stream:
#   [Parsed_ebur128_0 @ 0x..] Summary:
#     Integrated loudness:
#       I:         -23.0 LUFS
#     Loudness range:
#       LRA:         1.6 LU
#     True peak:
#       Peak:      -2.4 dBFS
# "LRA:" is matched exactly — the "LRA low:/LRA high:" lines carry LUFS units
# and a different label, so they never collide.
_INTEGRATED_RE = re.compile(r"\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS")
_LRA_RE = re.compile(r"\bLRA:\s*(-?\d+(?:\.\d+)?)\s*LU\b")
_TRUE_PEAK_RE = re.compile(r"\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS")


class LoudnessAnalysis(BaseModel):
    """EBU R128 measurements for an asset's audio (camelCase for the IPC surface)."""

    integrated_lufs: float = Field(
        alias="integratedLufs", description="Integrated programme loudness (LUFS)."
    )
    loudness_range_lu: float | None = Field(
        default=None,
        alias="loudnessRangeLu",
        description="Loudness range (LU); None when ffmpeg reports no LRA (very short audio).",
    )
    true_peak_dbfs: float | None = Field(
        default=None,
        alias="truePeakDbfs",
        description="True peak (dBTP); None when peak measurement was unavailable.",
    )

    model_config = {"populate_by_name": True}


def parse_loudness_summary(logs: str) -> LoudnessAnalysis | None:
    """Reduce an ffmpeg ``ebur128`` summary to typed measurements (pure).

    Uses the LAST match of each figure: ``ebur128`` logs running ``I:``/``LRA:``
    lines per frame before the final summary, and the summary is printed last.

    :param logs: ffmpeg stderr text.
    :returns: The measurements, or ``None`` when no integrated loudness was
        reported (no audio decoded) — the caller reports honest-unavailable
        rather than fabricating a figure.
    """
    integrated = _INTEGRATED_RE.findall(logs)
    if not integrated:
        return None
    lra = _LRA_RE.findall(logs)
    peak = _TRUE_PEAK_RE.findall(logs)
    return LoudnessAnalysis(
        integrated_lufs=float(integrated[-1]),
        loudness_range_lu=float(lra[-1]) if lra else None,
        true_peak_dbfs=float(peak[-1]) if peak else None,
    )


def measure_loudness(
    path: Path,
    *,
    runner: Runner | None = None,
    timeout: float | None = 60.0,
) -> LoudnessAnalysis | None:
    """Run ffmpeg ``ebur128`` on ``path`` and return the R128 measurements.

    :param path: Media file to analyse (assumed already sandbox-resolved).
    :param runner: ffmpeg stderr runner; defaults to the real subprocess runner.
    :param timeout: Per-call timeout in seconds (bounds the subprocess).
    :returns: The measurements, or ``None`` when ebur128 reported no summary at
        all. Note a *silent* track is not that case — it measures at the -70 LUFS
        floor. Nor is a file with **no audio stream**: ``-vn`` leaves ffmpeg no
        streams to output and it errors, so callers must check
        :attr:`MediaInfo.has_audio` first (``/analyze`` skips those assets) rather
        than relying on ``None`` here.
    """
    invoke = runner or (lambda argv: run_logs(argv, timeout=timeout))
    argv = [
        find_ffmpeg(),
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-vn",
        # peak=true enables the true-peak meter (off by default; adds the
        # oversampled Peak figure to the summary).
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
    ]
    return parse_loudness_summary(invoke(argv))
