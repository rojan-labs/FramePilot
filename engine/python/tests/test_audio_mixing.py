"""Tests for pure audio mixing primitives (PRD §6.8, plan Phase 6)."""

from __future__ import annotations

import numpy as np
import pytest

from framepilot_engine.audio.mixing import (
    SILENCE_DBFS,
    apply_eq,
    apply_gain_envelope,
    automation_envelope,
    compressor_gain,
    db_to_gain,
    duck_gain_at,
    eq_magnitude_response,
    fade_gain_at,
    normalize_gain,
    peak_dbfs,
    sample_envelope,
)
from framepilot_engine.timeline.models import Keyframe


def test_db_to_gain() -> None:
    assert db_to_gain(0.0) == pytest.approx(1.0)
    assert db_to_gain(-20.0) == pytest.approx(0.1)
    assert db_to_gain(6.0) == pytest.approx(1.995, rel=1e-3)


def test_peak_dbfs() -> None:
    assert peak_dbfs(np.array([])) == SILENCE_DBFS
    assert peak_dbfs(np.zeros(10)) == SILENCE_DBFS
    assert peak_dbfs(np.array([1.0, -1.0])) == pytest.approx(0.0)
    assert peak_dbfs(np.array([0.5])) == pytest.approx(-6.02, abs=0.01)


def test_normalize_gain() -> None:
    # Peak 0.5 → target -1 dBFS (~0.891) → gain ~1.78.
    gain = normalize_gain(np.array([0.5, -0.25]), target_dbfs=-1.0)
    assert gain == pytest.approx(1.782, rel=1e-3)
    assert normalize_gain(np.zeros(4)) == 1.0  # silence → unity
    assert normalize_gain(np.array([])) == 1.0


def test_fade_in_and_out_envelope() -> None:
    t = np.array([0.0, 0.5, 1.0, 2.0, 3.5, 4.0])
    gain = fade_gain_at(t, fade_in=1.0, fade_out=1.0, duration=4.0)
    assert gain[0] == pytest.approx(0.0)  # start silent
    assert gain[1] == pytest.approx(0.5)  # mid fade-in
    assert gain[2] == pytest.approx(1.0)  # full
    assert gain[3] == pytest.approx(1.0)  # plateau
    assert gain[4] == pytest.approx(0.5)  # mid fade-out
    assert gain[5] == pytest.approx(0.0)  # end silent


def test_fade_overlapping_ramps_take_minimum() -> None:
    # A clip shorter than fade_in + fade_out never exceeds 1.
    gain = fade_gain_at(np.linspace(0, 1, 11), fade_in=1.0, fade_out=1.0, duration=1.0)
    assert float(gain.max()) <= 1.0


def test_no_fade_is_unity() -> None:
    gain = fade_gain_at(np.array([0.0, 1.0, 2.0]), 0.0, 0.0, 2.0)
    assert np.allclose(gain, 1.0)


def test_duck_reduces_inside_intervals() -> None:
    t = np.array([0.0, 1.0, 2.0, 5.0])
    gain = duck_gain_at(t, [(1.0, 2.0)], amount_db=-12.0, ramp=0.0)
    assert gain[0] == pytest.approx(1.0)  # before
    assert gain[1] == pytest.approx(db_to_gain(-12.0))  # inside (edge)
    assert gain[3] == pytest.approx(1.0)  # after


def test_duck_empty_intervals_is_unity() -> None:
    assert np.allclose(duck_gain_at(np.array([0.0, 1.0]), [], -12.0), 1.0)


def test_duck_overlapping_takes_deepest() -> None:
    t = np.array([1.5])
    gain = duck_gain_at(t, [(1.0, 2.0), (1.0, 2.0)], amount_db=-12.0, ramp=0.0)
    assert gain[0] == pytest.approx(db_to_gain(-12.0))


def test_apply_gain_envelope_mono_and_stereo() -> None:
    mono = apply_gain_envelope(np.array([1.0, 1.0]), np.array([0.5, 0.25]))
    assert np.allclose(mono, [0.5, 0.25])
    stereo = apply_gain_envelope(np.array([[1.0, 1.0], [1.0, 1.0]]), np.array([0.5, 0.25]))
    assert np.allclose(stereo, [[0.5, 0.5], [0.25, 0.25]])


def test_equal_power_fade_holds_the_summed_power_constant() -> None:
    """Two clips crossfading must not dip in the middle.

    On LINEAR gain they do: power goes as the square of amplitude, so 0.5 + 0.5 of
    amplitude is only 0.707 of the power — an audible hole halfway through every
    music crossfade. A sine/cosine pair holds the sum at 1.
    """
    times = np.linspace(0.0, 1.0, 21)
    rising = fade_gain_at(times, 1.0, 0.0, 1.0, "equal-power")
    falling = fade_gain_at(times, 0.0, 1.0, 1.0, "equal-power")
    power = rising**2 + falling**2
    assert np.allclose(power, 1.0, atol=1e-6)
    # …which linear does not manage, which is the whole reason for the option.
    linear_power = fade_gain_at(times, 1.0, 0.0, 1.0) ** 2 + fade_gain_at(times, 0.0, 1.0, 1.0) ** 2
    assert float(linear_power.min()) < 0.75


def test_fade_curves_still_start_at_silence_and_reach_unity() -> None:
    for curve in ("linear", "equal-power", "smooth"):
        gain = fade_gain_at(np.array([0.0, 1.0]), 1.0, 0.0, 2.0, curve)
        assert float(gain[0]) == pytest.approx(0.0, abs=1e-9)
        assert float(gain[1]) == pytest.approx(1.0, abs=1e-9)


def test_an_unknown_curve_falls_back_to_linear() -> None:
    # A project from a newer build must render, not raise.
    times = np.linspace(0.0, 1.0, 5)
    assert np.allclose(
        fade_gain_at(times, 1.0, 0.0, 1.0, "spiral"), fade_gain_at(times, 1.0, 0.0, 1.0)
    )


# ---------------------------------------------------------------------------
# EQ
# ---------------------------------------------------------------------------


def test_eq_bands_hit_their_stated_gain_at_their_own_frequency() -> None:
    """A +6 dB peak at 3 kHz must be +6 dB at 3 kHz, not "roughly a boost"."""
    frequencies = np.array([3000.0])
    peak = eq_magnitude_response(
        frequencies, [{"kind": "peaking", "frequencyHz": 3000, "gainDb": 6.0, "q": 1.0}]
    )
    assert 20 * np.log10(float(peak[0])) == pytest.approx(6.0, abs=1e-6)


def test_shelves_reach_their_gain_in_the_band_and_unity_outside_it() -> None:
    low = eq_magnitude_response(
        np.array([20.0, 20000.0]), [{"kind": "low-shelf", "frequencyHz": 200, "gainDb": -6.0}]
    )
    assert 20 * np.log10(float(low[0])) == pytest.approx(-6.0, abs=0.2)
    assert float(low[1]) == pytest.approx(1.0, abs=1e-3)

    high = eq_magnitude_response(
        np.array([20.0, 20000.0]), [{"kind": "high-shelf", "frequencyHz": 4000, "gainDb": 3.0}]
    )
    assert float(high[0]) == pytest.approx(1.0, abs=1e-3)
    assert 20 * np.log10(float(high[1])) == pytest.approx(3.0, abs=0.3)


def test_pass_filters_are_minus_three_db_at_their_corner() -> None:
    """The -3 dB corner is what "an 80 Hz high-pass" names; anything else is a different filter."""
    for kind in ("high-pass", "low-pass"):
        response = eq_magnitude_response(
            np.array([80.0]), [{"kind": kind, "frequencyHz": 80, "q": 0.707}]
        )
        assert 20 * np.log10(float(response[0])) == pytest.approx(-3.0, abs=0.05)


def test_a_high_pass_removes_the_rumble_and_keeps_the_voice() -> None:
    sample_rate = 48000
    times = np.arange(sample_rate) / sample_rate
    rumble = 0.5 * np.sin(2 * np.pi * 30.0 * times)
    voice = 0.5 * np.sin(2 * np.pi * 1000.0 * times)
    filtered = apply_eq(rumble + voice, sample_rate, [{"kind": "high-pass", "frequencyHz": 120}])

    # Measure each component back out by projecting onto its own basis.
    def amplitude(signal: np.ndarray, frequency: float) -> float:
        phase = 2 * np.pi * frequency * times
        return float(
            2.0 * np.hypot(np.mean(signal * np.sin(phase)), np.mean(signal * np.cos(phase)))
        )

    assert amplitude(filtered, 30.0) < 0.05
    assert amplitude(filtered, 1000.0) == pytest.approx(0.5, abs=0.02)


def test_an_eq_with_no_bands_returns_the_buffer_untouched() -> None:
    samples = np.linspace(-0.5, 0.5, 100)
    assert np.array_equal(apply_eq(samples, 48000, []), samples)


def test_an_unknown_band_shape_is_skipped_rather_than_guessed() -> None:
    frequencies = np.array([100.0, 1000.0])
    response = eq_magnitude_response(frequencies, [{"kind": "telephone", "frequencyHz": 1000}])
    assert np.allclose(response, 1.0)


# ---------------------------------------------------------------------------
# Dynamics
# ---------------------------------------------------------------------------


def test_a_compressor_leaves_signal_below_the_threshold_alone() -> None:
    sample_rate = 48000
    quiet = 0.05 * np.sin(2 * np.pi * 440 * np.arange(sample_rate) / sample_rate)
    gain = compressor_gain(
        quiet, sample_rate, threshold_db=-12.0, ratio=4.0, attack_ms=5.0, release_ms=100.0
    )
    assert np.allclose(gain, 1.0)


def test_a_compressor_settles_on_the_reduction_its_ratio_implies() -> None:
    sample_rate = 48000
    loud = 0.8 * np.sin(2 * np.pi * 440 * np.arange(sample_rate) / sample_rate)
    gain = compressor_gain(
        loud, sample_rate, threshold_db=-12.0, ratio=4.0, attack_ms=5.0, release_ms=100.0
    )
    # 0.8 is -1.94 dBFS; 10.06 dB over the threshold at 4:1 keeps a quarter of it.
    excess = -1.938 - -12.0
    expected = -excess * (1.0 - 1.0 / 4.0)
    assert 20 * np.log10(float(gain[-1])) == pytest.approx(expected, abs=0.1)
    # …and it got there over the attack, rather than clamping on the first sample.
    assert 20 * np.log10(float(gain[0])) > expected + 3.0


def test_a_faster_attack_reaches_the_reduction_sooner() -> None:
    sample_rate = 48000
    loud = 0.8 * np.sin(2 * np.pi * 440 * np.arange(sample_rate // 10) / sample_rate)
    fast, slow = (
        compressor_gain(
            loud, sample_rate, threshold_db=-20.0, ratio=4.0, attack_ms=attack, release_ms=100.0
        )
        for attack in (2.0, 50.0)
    )
    at_ten_ms = sample_rate // 100
    assert float(fast[at_ten_ms]) < float(slow[at_ten_ms])


def test_makeup_gain_lifts_the_whole_curve() -> None:
    sample_rate = 48000
    quiet = 0.05 * np.sin(2 * np.pi * 440 * np.arange(sample_rate // 10) / sample_rate)
    lifted = compressor_gain(
        quiet,
        sample_rate,
        threshold_db=-12.0,
        ratio=4.0,
        attack_ms=5.0,
        release_ms=100.0,
        makeup_gain_db=6.0,
    )
    assert np.allclose(20 * np.log10(lifted), 6.0)


# ---------------------------------------------------------------------------
# Automation
# ---------------------------------------------------------------------------


def _lane(*points: tuple[float, float]) -> list[Keyframe]:
    return [
        Keyframe(id=f"k{index}", time=time, property="gainDb", value=value)
        for index, (time, value) in enumerate(points)
    ]


def test_an_automation_lane_reads_its_authored_values_and_ramps_between_them() -> None:
    envelope = automation_envelope(_lane((0.0, 0.0), (2.0, -12.0)), "gainDb", 2.0)
    assert envelope is not None
    times, gains = envelope
    assert float(sample_envelope(0.0, times, gains)) == pytest.approx(1.0, abs=1e-3)
    assert 20 * np.log10(float(sample_envelope(2.0, times, gains))) == pytest.approx(
        -12.0, abs=0.01
    )
    # Linear easing interpolates in dB, so the midpoint is -6 dB, not half the amplitude.
    assert 20 * np.log10(float(sample_envelope(1.0, times, gains))) == pytest.approx(-6.0, abs=0.05)


def test_an_unautomated_property_reports_no_lane_at_all() -> None:
    assert automation_envelope(_lane((0.0, 0.0), (1.0, -6.0)), "pan", 1.0) is None
    assert automation_envelope([], "gainDb", 1.0) is None


def test_a_lane_holds_its_end_values_outside_the_authored_span() -> None:
    envelope = automation_envelope(_lane((1.0, -6.0), (2.0, 0.0)), "gainDb", 3.0)
    assert envelope is not None
    times, gains = envelope
    assert 20 * np.log10(float(sample_envelope(0.0, times, gains))) == pytest.approx(-6.0, abs=0.05)
    assert 20 * np.log10(float(sample_envelope(3.0, times, gains))) == pytest.approx(0.0, abs=0.05)


def test_a_flat_band_reproduces_the_input_through_the_overlap_add() -> None:
    """The windowed blocks must sum back to unity, or every EQ leaks its own seams.

    A 0 dB peaking band is the identity curve, so any deviation here is the
    overlap-add itself — a window that does not sum to one shows up as periodic
    amplitude ripple at the hop rate, which is audible as a flutter and would not
    be caught by measuring one frequency's gain.
    """
    sample_rate = 48000
    rng = np.random.default_rng(7)
    # Deliberately not a whole number of blocks: the tail is where padding bugs live.
    samples = rng.standard_normal((sample_rate + 1234, 2)) * 0.1
    flat = apply_eq(samples, sample_rate, [{"kind": "peaking", "frequencyHz": 1000, "gainDb": 0.0}])
    assert flat.shape == samples.shape
    assert float(np.abs(flat - samples).max()) < 1e-9


def test_a_clip_shorter_than_one_block_still_filters() -> None:
    sample_rate = 48000
    times = np.arange(600) / sample_rate
    rumble = 0.5 * np.sin(2 * np.pi * 30.0 * times)
    filtered = apply_eq(rumble, sample_rate, [{"kind": "high-pass", "frequencyHz": 400}])
    assert filtered.shape == rumble.shape
    assert float(np.abs(filtered).max()) < float(np.abs(rumble).max())
