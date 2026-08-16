"""Tests for audio waveform extraction (media.waveform)."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path

import numpy as np
import pytest

from framepilot_engine.media.ffmpeg import FFmpegError
from framepilot_engine.media.waveform import compute_peaks, extract_waveform

# --- pure peak reduction -----------------------------------------------------


def test_compute_peaks_normalises_to_unit_range() -> None:
    samples = np.array([0, 16384, -32768, 8192], dtype=np.int16)
    peaks = compute_peaks(samples, buckets=2)
    assert peaks == [pytest.approx(0.5), pytest.approx(1.0)]


def test_compute_peaks_empty_samples_all_zero() -> None:
    assert compute_peaks(np.array([], dtype=np.int16), buckets=4) == [0.0, 0.0, 0.0, 0.0]


def test_compute_peaks_more_buckets_than_samples_pads_zero() -> None:
    peaks = compute_peaks(np.array([32767], dtype=np.int16), buckets=3)
    assert len(peaks) == 3
    assert peaks[0] == pytest.approx(32767 / 32768)
    assert peaks[1:] == [0.0, 0.0]


def test_compute_peaks_rejects_bad_buckets() -> None:
    with pytest.raises(ValueError, match="buckets must be"):
        compute_peaks(np.array([1], dtype=np.int16), buckets=0)


# --- extract_waveform (injected decoder) -------------------------------------


def test_extract_waveform_with_injected_runner(tmp_path: Path) -> None:
    source = tmp_path / "a.wav"
    source.write_bytes(b"\x00")
    # 4000 mono int16 samples at 8000 Hz → 0.5s; constant full-scale → peaks ~1.
    pcm = np.full(4000, 32000, dtype=np.int16).tobytes()

    def runner(argv: Sequence[str]) -> bytes:
        assert "s16le" in argv
        return pcm

    wf = extract_waveform(source, buckets=10, sample_rate=8000, runner=runner)
    assert wf.bucket_count == 10
    assert len(wf.peaks) == 10
    assert wf.duration_seconds == pytest.approx(0.5)
    assert all(p > 0.9 for p in wf.peaks)


def test_extract_waveform_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        extract_waveform(tmp_path / "nope.wav")


def test_extract_waveform_no_audio_raises(tmp_path: Path) -> None:
    source = tmp_path / "silent.mp4"
    source.write_bytes(b"\x00")
    with pytest.raises(FFmpegError, match="No audio samples"):
        extract_waveform(source, runner=lambda _argv: b"")


# --- real ffmpeg integration -------------------------------------------------


@pytest.mark.usefixtures("require_ffprobe")
def test_extract_waveform_real(media_factory: Callable[..., Path]) -> None:
    # A 1s sine tone → non-silent waveform.
    source = media_factory("wave_src.mp4", seconds=1.0, with_video=False)
    wf = extract_waveform(source, buckets=64)
    assert wf.bucket_count == 64
    assert max(wf.peaks) > 0.1  # the tone registers
    assert wf.duration_seconds == pytest.approx(1.0, abs=0.2)
