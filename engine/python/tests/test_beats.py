"""Tests for beat/onset analysis (plan AGENT-NATIVE-UX T6).

Covers, to 100%: the pure PCM→samples conversion, onset envelope, adaptive
peak picking, BPM estimation (including octave folding and the too-few-beats
guard), and the ffmpeg wrapper via an injected bytes runner — no ffmpeg binary
needed. The synthetic fixture is a click track whose beats are KNOWN, so the
assertions are exact, not statistical hand-waving.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import numpy as np
import pytest

from framepilot_engine.analysis import beats
from framepilot_engine.analysis.beats import (
    DEFAULT_SENSITIVITY,
    HOP,
    SAMPLE_RATE,
    Beat,
    detect_beats,
    estimate_bpm,
    onset_envelope,
    pcm_to_samples,
    pick_beats,
)
from framepilot_engine.media.ffmpeg import FFmpegError, NoAudioStreamError
from framepilot_engine.media.probe import MediaInfo, StreamInfo

# --- Synthetic click track ----------------------------------------------------


def click_track(
    bpm: float = 120.0, seconds: float = 5.0, sample_rate: int = SAMPLE_RATE
) -> np.ndarray:
    """A silent signal with a short decaying burst on every beat (pure)."""
    n = int(seconds * sample_rate)
    samples = np.zeros(n, dtype=np.float32)
    interval = 60.0 / bpm
    burst_len = int(0.03 * sample_rate)
    burst = (np.random.default_rng(7).standard_normal(burst_len) * 0.8).astype(np.float32)
    envelope = np.exp(-np.linspace(0.0, 6.0, burst_len)).astype(np.float32)
    t = 0.25
    while t < seconds:
        start = int(t * sample_rate)
        end = min(n, start + burst_len)
        samples[start:end] += (burst * envelope)[: end - start]
        t += interval
    return np.clip(samples, -1.0, 1.0)


def to_pcm(samples: np.ndarray) -> bytes:
    """Encode float samples as the little-endian s16 mono PCM ffmpeg would emit."""
    return (samples * 32767.0).astype("<i2").tobytes()


# --- pcm_to_samples -----------------------------------------------------------


def test_pcm_to_samples_roundtrip_and_scale() -> None:
    samples = pcm_to_samples((np.array([0, 16384, -32768], dtype="<i2")).tobytes())
    assert samples.dtype == np.float32
    assert samples[0] == 0.0
    assert abs(samples[1] - 0.5) < 1e-3
    assert samples[2] == -1.0


def test_pcm_to_samples_empty_and_odd_byte() -> None:
    assert pcm_to_samples(b"").size == 0
    assert pcm_to_samples(b"\x01").size == 0
    # An odd trailing byte is dropped, not misparsed.
    assert pcm_to_samples(b"\x00\x00\x01").size == 1


# --- onset_envelope -----------------------------------------------------------


def test_onset_envelope_short_signal_is_empty() -> None:
    assert onset_envelope(np.zeros(10, dtype=np.float32)).size == 0


def test_onset_envelope_silence_is_flat_zero() -> None:
    env = onset_envelope(np.zeros(SAMPLE_RATE, dtype=np.float32))
    assert env.size > 0
    assert float(env.max()) == 0.0


def test_onset_envelope_peaks_at_energy_rises() -> None:
    env = onset_envelope(click_track())
    # Every click produces a positive flux peak; silence between clicks is ~0.
    assert float(env.max()) == 1.0
    assert (env > 0.5).sum() >= 8


# --- pick_beats + estimate_bpm ------------------------------------------------


def test_pick_beats_finds_clicks_near_known_times() -> None:
    beats = pick_beats(onset_envelope(click_track(bpm=120.0, seconds=5.0)))
    assert len(beats) >= 8
    expected = [0.25 + i * 0.5 for i in range(len(beats))]
    tolerance = 2.5 * HOP / SAMPLE_RATE
    for beat, want in zip(beats, expected, strict=False):
        assert abs(beat.time - want) <= tolerance
    assert all(0.0 <= b.strength <= 1.0 for b in beats)


def test_pick_beats_empty_envelope() -> None:
    assert pick_beats(np.zeros(0, dtype=np.float32)) == []
    assert pick_beats(np.zeros(100, dtype=np.float32)) == []


def test_pick_beats_folds_double_triggers_within_min_gap() -> None:
    env = np.zeros(200, dtype=np.float32)
    env[50] = 1.0
    env[52] = 0.9  # a second local max ~46ms later — inside the fold gap
    env[150] = 1.0
    beats = pick_beats(env)
    assert len(beats) == 2


def test_estimate_bpm_recovers_click_tempo() -> None:
    beats = pick_beats(onset_envelope(click_track(bpm=120.0, seconds=6.0)))
    bpm = estimate_bpm([b.time for b in beats])
    assert bpm is not None
    assert abs(bpm - 120.0) < 6.0


def test_estimate_bpm_guards_and_octave_folding() -> None:
    assert estimate_bpm([1.0, 2.0, 3.0]) is None  # too few beats
    assert estimate_bpm([0.0, 0.0, 0.0, 0.0]) is None  # zero interval
    # 30 BPM intervals fold up into the sane range (doubled to 60).
    assert estimate_bpm([0.0, 2.0, 4.0, 6.0, 8.0]) == 60.0
    # 400 BPM intervals fold down (÷2 → 200).
    assert estimate_bpm([0.0, 0.15, 0.3, 0.45, 0.6]) == 200.0


# --- detect_beats wrapper -----------------------------------------------------


def test_detect_beats_invokes_ffmpeg_decode_and_analyses() -> None:
    seen: dict[str, Sequence[str]] = {}

    def runner(argv: Sequence[str]) -> bytes:
        seen["argv"] = argv
        return to_pcm(click_track(bpm=100.0, seconds=5.0))

    analysis = detect_beats(Path("/tmp/song.mp3"), runner=runner)
    argv = list(seen["argv"])
    assert "/tmp/song.mp3" in argv
    assert "s16le" in argv and str(SAMPLE_RATE) in argv
    assert len(analysis.beats) >= 6
    assert analysis.bpm is not None
    assert abs(analysis.bpm - 100.0) < 6.0


def test_detect_beats_silent_audio_reports_no_beats() -> None:
    analysis = detect_beats(
        Path("/tmp/quiet.wav"),
        sensitivity=DEFAULT_SENSITIVITY,
        runner=lambda argv: to_pcm(np.zeros(SAMPLE_RATE, dtype=np.float32)),
    )
    assert analysis.beats == []
    assert analysis.bpm is None


def test_beat_model_bounds() -> None:
    beat = Beat(time=1.5, strength=0.7)
    assert beat.time == 1.5 and beat.strength == 0.7


# --- Decode failures are classified, not forwarded raw ------------------------


def _failing_runner(_argv: Sequence[str]) -> bytes:
    # What ffmpeg really returns for `-vn` against a video with no audio track.
    raise FFmpegError(
        "'ffmpeg' exited 234: Output #0, s16le, to 'pipe:':\n"
        "[out#0/s16le] Output file does not contain any stream\n"
        "Error opening output files: Invalid argument"
    )


def _media(*, audio: bool) -> MediaInfo:
    streams = [StreamInfo(index=0, codec_type="video", codec_name="h264")]
    if audio:
        streams.append(StreamInfo(index=1, codec_type="audio", codec_name="aac"))
    return MediaInfo(path="/tmp/clip.mp4", duration_seconds=6.0, streams=streams)


def test_detect_beats_on_a_silent_clip_says_so_instead_of_dumping_ffmpeg(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(beats, "inspect_media", lambda _path, timeout=None: _media(audio=False))
    with pytest.raises(NoAudioStreamError) as raised:
        detect_beats(Path("/tmp/clip.mp4"), runner=_failing_runner)
    message = str(raised.value)
    assert "clip.mp4 has no audio track" in message
    # The creator (and the model) must never be handed the raw ffmpeg dump.
    assert "s16le" not in message and "exited 234" not in message


def test_detect_beats_keeps_a_real_decode_failure_as_itself(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(beats, "inspect_media", lambda _path, timeout=None: _media(audio=True))
    with pytest.raises(FFmpegError) as raised:
        detect_beats(Path("/tmp/clip.mp4"), runner=_failing_runner)
    assert not isinstance(raised.value, NoAudioStreamError)
    assert "exited 234" in str(raised.value)


def test_detect_beats_falls_back_to_the_original_error_when_the_probe_cannot_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unprobeable(_path: Path, timeout: float | None = None) -> MediaInfo:
        raise FileNotFoundError("gone")

    monkeypatch.setattr(beats, "inspect_media", unprobeable)
    with pytest.raises(FFmpegError) as raised:
        detect_beats(Path("/tmp/clip.mp4"), runner=_failing_runner)
    assert "exited 234" in str(raised.value)
