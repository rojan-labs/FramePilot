"""Audio waveform extraction (plan 2.1).

WHY: the timeline/audio UI draws a waveform so the user can see where speech and
music sit. Rather than ship raw audio to the UI, the engine decodes the audio to
mono PCM via ffmpeg and reduces it to a compact array of normalised peak values
(one per horizontal bucket). The peak reduction is a pure, numpy-only function so
it is unit-testable without ffmpeg, and the ffmpeg decode is injectable.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path

import numpy as np
from pydantic import BaseModel, Field

from framepilot_engine.media.ffmpeg import FFmpegError, find_ffmpeg, run_bytes

# int16 full-scale magnitude, used to normalise peaks into [0, 1].
_INT16_FULL_SCALE = 32768.0
DEFAULT_BUCKETS = 512
DEFAULT_SAMPLE_RATE = 8000  # plenty for a visual waveform; keeps PCM small

# A bytes-runner returns ffmpeg stdout as raw bytes (decoded PCM).
BytesRunner = Callable[[Sequence[str]], bytes]


class WaveformData(BaseModel):
    """A compact, UI-ready waveform: one normalised peak per bucket."""

    peaks: list[float] = Field(description="Per-bucket peak amplitude in [0, 1].")
    bucket_count: int
    sample_rate: int
    duration_seconds: float


def compute_peaks(samples: np.ndarray, buckets: int) -> list[float]:
    """Reduce a 1-D int16 sample array to ``buckets`` normalised peaks (pure).

    Each bucket's value is the maximum absolute sample within it, scaled to
    ``[0, 1]``. Empty buckets (fewer samples than buckets) contribute ``0.0``.

    :param samples: 1-D array of int16 PCM samples.
    :param buckets: Number of output buckets (must be >= 1).
    :returns: A list of ``buckets`` floats in ``[0, 1]``.
    :raises ValueError: If ``buckets < 1``.
    """
    if buckets < 1:
        raise ValueError(f"buckets must be >= 1, got {buckets}.")
    if samples.size == 0:
        return [0.0] * buckets
    peaks: list[float] = []
    for chunk in np.array_split(samples.astype(np.float64), buckets):
        peak = float(np.max(np.abs(chunk))) / _INT16_FULL_SCALE if chunk.size else 0.0
        peaks.append(min(peak, 1.0))
    return peaks


def extract_waveform(
    source: Path,
    *,
    buckets: int = DEFAULT_BUCKETS,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    runner: BytesRunner | None = None,
    timeout: float | None = 120.0,
) -> WaveformData:
    """Decode ``source`` audio and reduce it to a :class:`WaveformData` (plan 2.1).

    :param source: Input media path (must exist and contain audio).
    :param buckets: Number of waveform buckets to produce.
    :param sample_rate: Decode sample rate (mono); lower = smaller/faster.
    :param runner: ffmpeg bytes-runner; defaults to the real subprocess runner.
    :param timeout: Hard timeout for the decode.
    :returns: The reduced waveform.
    :raises FileNotFoundError: If ``source`` does not exist.
    :raises FFmpegError: If decoding fails or the source has no audio samples.
    """
    if not source.exists():
        raise FileNotFoundError(f"Source media does not exist: {source}")
    invoke = runner or (lambda argv: run_bytes(argv, timeout=timeout))
    raw = invoke(
        [
            find_ffmpeg(),
            "-v",
            "error",
            "-i",
            str(source),
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "-f",
            "s16le",
            "-",
        ]
    )
    samples = np.frombuffer(raw, dtype=np.int16)
    if samples.size == 0:
        raise FFmpegError(f"No audio samples decoded from {source} (no audio stream?).")
    return WaveformData(
        peaks=compute_peaks(samples, buckets),
        bucket_count=buckets,
        sample_rate=sample_rate,
        duration_seconds=samples.size / sample_rate,
    )
