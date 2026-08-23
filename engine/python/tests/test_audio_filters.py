"""Tests for the master-bus ffmpeg audio filter builder (PRD §6.8, plan Phase 6)."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

from framepilot_engine.audio.filters import (
    COMPRESSION_PRESETS,
    EQ_PRESETS,
    LOUDNESS_PRESETS,
    apply_master_audio,
    build_master_filter,
)


def test_empty_filter_is_none() -> None:
    assert build_master_filter() is None


def test_denoise_only() -> None:
    assert build_master_filter(denoise=True) == "afftdn=nr=12.0"


def test_loudness_preset() -> None:
    filt = build_master_filter(loudness="social")
    assert filt is not None
    assert f"loudnorm=I={LOUDNESS_PRESETS['social']}" in filt


def test_limiter_only() -> None:
    assert build_master_filter(limiter=True) == "alimiter=limit=0.95"


def test_order_is_denoise_loudness_limiter() -> None:
    filt = build_master_filter(denoise=True, loudness="podcast", limiter=True)
    assert filt is not None
    parts = filt.split(",")
    assert parts[0].startswith("afftdn")
    assert parts[1].startswith("loudnorm")
    assert parts[2].startswith("alimiter")


def test_unknown_loudness_preset_raises() -> None:
    with pytest.raises(ValueError, match="Unknown loudness preset"):
        build_master_filter(loudness="cinema")


# --- EQ (plan H1.4) -----------------------------------------------------------


def test_eq_flat_is_explicit_noop() -> None:
    """``"flat"`` is a recognized preset that produces no filter parts (vs. ``None``)."""
    assert build_master_filter(eq="flat") is None


def test_eq_none_is_unset() -> None:
    assert build_master_filter(eq=None) is None


def test_eq_warm_preset_chains_three_bands() -> None:
    filt = build_master_filter(eq="warm")
    assert filt is not None
    parts = filt.split(",")
    assert len(parts) == 3
    assert all(p.startswith("equalizer=f=") for p in parts)
    low_freq, gain, _octaves = EQ_PRESETS["warm"][0]
    assert f"f={low_freq}" in parts[0] and f"g={gain}" in parts[0]


def test_eq_bright_and_voice_clarity_presets_are_distinct() -> None:
    bright = build_master_filter(eq="bright")
    clarity = build_master_filter(eq="voice-clarity")
    assert bright is not None and clarity is not None
    assert bright != clarity


def test_unknown_eq_preset_raises() -> None:
    with pytest.raises(ValueError, match="Unknown EQ preset"):
        build_master_filter(eq="cinema")


# --- Compression (plan H1.4) --------------------------------------------------


def test_compression_off_by_default() -> None:
    assert build_master_filter(compression=None) is None


def test_compression_voice_preset() -> None:
    filt = build_master_filter(compression="voice")
    assert filt is not None
    threshold, ratio, attack, release, makeup = COMPRESSION_PRESETS["voice"]
    assert filt == (
        f"acompressor=threshold={threshold}dB:ratio={ratio}:"
        f"attack={attack}:release={release}:makeup={makeup}dB"
    )


def test_unknown_compression_preset_raises() -> None:
    with pytest.raises(ValueError, match="Unknown compression preset"):
        build_master_filter(compression="extreme")


# --- Full chain order (plan H1.4: denoise -> EQ -> compression -> loudness -> limiter)


def test_full_chain_order() -> None:
    filt = build_master_filter(
        denoise=True, eq="warm", compression="voice", loudness="social", limiter=True
    )
    assert filt is not None
    parts = filt.split(",")
    # denoise(1) + eq(3 bands) + compression(1) + loudness(1) + limiter(1) = 7
    assert len(parts) == 7
    assert parts[0].startswith("afftdn")
    assert all(p.startswith("equalizer") for p in parts[1:4])
    assert parts[4].startswith("acompressor")
    assert parts[5].startswith("loudnorm")
    assert parts[6].startswith("alimiter")


def test_apply_master_audio_invokes_ffmpeg_with_filter() -> None:
    calls: list[Sequence[str]] = []
    apply_master_audio(
        Path("/in.mp4"),
        Path("/out.mp4"),
        "loudnorm=I=-14.0",
        ffmpeg="ffmpeg",
        run=calls.append,
    )
    assert len(calls) == 1
    args = list(calls[0])
    assert args[0] == "ffmpeg"
    assert "-af" in args and "loudnorm=I=-14.0" in args
    assert args[args.index("-i") + 1] == "/in.mp4"
    assert args[-1] == "/out.mp4"
    # Video is stream-copied; only audio is re-encoded.
    assert "copy" in args


def _rejects(argv: list[str]) -> None:
    """Assert argv validation rejects the given arguments."""
    from framepilot_engine.audio.filters import _validate_ffmpeg_args

    with pytest.raises(ValueError, match="ffmpeg arguments"):
        _validate_ffmpeg_args(argv)


def test_argv_validation_rejects_malformed_tokens() -> None:
    from framepilot_engine.audio.filters import _validate_ffmpeg_args

    _rejects([])
    _rejects(["ffmpeg", "-i", ""])
    _rejects(["ffmpeg", "-i", "a\x00b"])
    _rejects(["ffmpeg", "-af", "volume=0dB\nmalicious"])
    _rejects(["ffmpeg", "-i", "clip\r.mp4"])
    # Legitimate argv passes untouched.
    _validate_ffmpeg_args(["ffmpeg", "-y", "-i", "/in.mp4", "-af", "loudnorm", "/out.mp4"])


def test_apply_audio_filter_validates_argv_before_running() -> None:
    from framepilot_engine.audio.filters import apply_audio_filter

    calls: list[Sequence[str]] = []
    with pytest.raises(ValueError, match="invalid control characters"):
        apply_audio_filter(
            Path("/in.mp4"),
            Path("/out.mp4"),
            "volume=0dB\nrm -rf /",
            ffmpeg="ffmpeg",
            run=calls.append,
        )
    assert calls == []


def test_apply_master_audio_passes_dash_prefixed_values_through() -> None:
    """A path starting with '-' must reach ffmpeg verbatim (no '--' rewriting)."""
    calls: list[Sequence[str]] = []
    apply_master_audio(
        Path("/in/-weird.mp4"),
        Path("/out/-weird-out.wav"),
        "loudnorm",
        ffmpeg="ffmpeg",
        run=calls.append,
    )
    args = list(calls[0])
    assert args[args.index("-i") + 1] == "/in/-weird.mp4"
    assert args[-1] == "/out/-weird-out.wav"
