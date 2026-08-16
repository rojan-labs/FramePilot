"""Deterministic audio mixing primitives.

Time-domain gain utilities stay pure NumPy. Clip EQ/compression/normalization on the production
render path are streamed through :mod:`framepilot_engine.audio.filters`; the buffer processors in
this module remain useful as pure reference/test primitives and deliberately make no claim that
the caller's input buffer itself is duration-independent.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from framepilot_engine.timeline.models import Keyframe

SILENCE_DBFS = -120.0


def db_to_gain(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def peak_dbfs(samples: np.ndarray) -> float:
    if samples.size == 0:
        return SILENCE_DBFS
    peak = float(np.max(np.abs(samples)))
    if peak <= 0.0:
        return SILENCE_DBFS
    return 20.0 * math.log10(peak)


def normalize_gain(samples: np.ndarray, target_dbfs: float = -1.0) -> float:
    if samples.size == 0:
        return 1.0
    peak = float(np.max(np.abs(samples)))
    if peak <= 0.0:
        return 1.0
    return db_to_gain(target_dbfs) / peak


def fade_gain_at(
    t: np.ndarray | float,
    fade_in: float,
    fade_out: float,
    duration: float,
    curve: str = "linear",
) -> np.ndarray:
    times = np.asarray(t, dtype=np.float64)
    gain = np.ones_like(times)
    if fade_in > 0.0:
        gain = np.minimum(gain, np.clip(times / fade_in, 0.0, 1.0))
    if fade_out > 0.0:
        gain = np.minimum(gain, np.clip((duration - times) / fade_out, 0.0, 1.0))
    if curve == "equal-power":
        return np.sin(gain * (np.pi / 2.0))
    if curve == "smooth":
        return gain * gain * (3.0 - 2.0 * gain)
    return gain


def duck_gain_at(
    t: np.ndarray | float,
    intervals: list[tuple[float, float]],
    amount_db: float = -12.0,
    ramp: float = 0.15,
) -> np.ndarray:
    times = np.asarray(t, dtype=np.float64)
    gain = np.ones_like(times)
    if not intervals:
        return gain
    reduced = db_to_gain(amount_db)
    for start, end in intervals:
        attack = (
            np.clip((times - (start - ramp)) / ramp, 0.0, 1.0) if ramp > 0.0 else (times >= start)
        )
        release = np.clip(((end + ramp) - times) / ramp, 0.0, 1.0) if ramp > 0.0 else (times <= end)
        presence = np.clip(np.minimum(attack, release), 0.0, 1.0)
        gain = np.minimum(gain, 1.0 - presence * (1.0 - reduced))
    return gain


def apply_gain_envelope(samples: np.ndarray, gain: np.ndarray) -> np.ndarray:
    scaled = samples * gain[:, None] if samples.ndim == 2 else samples * gain
    return np.asarray(scaled)


_MIN_MAGNITUDE = 1e-9
DEFAULT_EQ_Q = 0.707


def eq_magnitude_response(frequencies: np.ndarray, bands: list[dict[str, Any]]) -> np.ndarray:
    response = np.ones_like(np.asarray(frequencies, dtype=np.float64))
    for band in bands:
        kind = str(band["kind"])
        f0 = float(band["frequencyHz"])
        if f0 <= 0.0:
            continue
        q = float(band.get("q") or DEFAULT_EQ_Q)
        w = np.asarray(frequencies, dtype=np.float64) / f0
        w2 = w * w
        if kind in ("low-shelf", "peaking", "high-shelf"):
            amplitude = 10.0 ** (float(band.get("gainDb") or 0.0) / 40.0)
            if kind == "peaking":
                numerator = np.abs((1.0 - w2) + 1j * w * (amplitude / q))
                denominator = np.abs((1.0 - w2) + 1j * w / (amplitude * q))
            elif kind == "low-shelf":
                root = math.sqrt(amplitude)
                numerator = amplitude * np.abs((amplitude - w2) + 1j * w * (root / q))
                denominator = np.abs((1.0 - amplitude * w2) + 1j * w * (root / q))
            else:
                root = math.sqrt(amplitude)
                numerator = amplitude * np.abs((1.0 - amplitude * w2) + 1j * w * (root / q))
                denominator = np.abs((amplitude - w2) + 1j * w * (root / q))
        elif kind == "high-pass":
            numerator = w2
            denominator = np.abs((1.0 - w2) + 1j * w / q)
        elif kind == "low-pass":
            numerator = np.ones_like(w)
            denominator = np.abs((1.0 - w2) + 1j * w / q)
        else:
            continue
        response = response * (numerator / np.maximum(denominator, _MIN_MAGNITUDE))
    return np.asarray(response)


_EQ_BLOCK = 1 << 15


def apply_eq(samples: np.ndarray, sample_rate: int, bands: list[dict[str, Any]]) -> np.ndarray:
    """Reference buffer EQ with block-bounded FFT workspace.

    The function receives a caller-owned complete buffer, so total memory still scales with that
    buffer's duration. Production clip processing uses the streaming ffmpeg filtergraph instead.
    """
    if not bands or samples.size == 0:
        return samples
    buffer = np.asarray(samples, dtype=np.float64)
    length = buffer.shape[0]
    mono = buffer.ndim == 1
    if mono:
        buffer = buffer[:, None]
    block = min(_EQ_BLOCK, max(2, length if length % 2 == 0 else length + 1))
    hop = block // 2
    window = np.hanning(block + 1)[:block]
    frequencies = np.fft.rfftfreq(block, d=1.0 / float(sample_rate))
    response = eq_magnitude_response(frequencies, bands)[:, None]
    padded = np.zeros((length + 2 * block, buffer.shape[1]), dtype=np.float64)
    padded[hop : hop + length] = buffer
    output = np.zeros_like(padded)
    for start in range(0, padded.shape[0] - block + 1, hop):
        chunk = padded[start : start + block] * window[:, None]
        output[start : start + block] += np.fft.irfft(
            np.fft.rfft(chunk, axis=0) * response, n=block, axis=0
        )
    filtered = output[hop : hop + length]
    return np.asarray(filtered[:, 0] if mono else filtered)


COMPRESSOR_BLOCK_SECONDS = 0.001


def compressor_gain(
    samples: np.ndarray,
    sample_rate: int,
    *,
    threshold_db: float,
    ratio: float,
    attack_ms: float,
    release_ms: float,
    makeup_gain_db: float = 0.0,
) -> np.ndarray:
    """Reference hard-knee compressor envelope for buffer-level tests.

    Production clip compression is streamed by ffmpeg, so this sequential reference loop is no
    longer on the long-form render path.
    """
    buffer = np.asarray(samples, dtype=np.float64)
    if buffer.size == 0:
        return np.ones(0, dtype=np.float64)
    detector = np.max(np.abs(buffer), axis=1) if buffer.ndim == 2 else np.abs(buffer)
    length = detector.shape[0]
    block = max(1, round(sample_rate * COMPRESSOR_BLOCK_SECONDS))
    block_count = math.ceil(length / block)
    padded = np.zeros(block_count * block, dtype=np.float64)
    padded[:length] = detector
    peaks = padded.reshape(block_count, block).max(axis=1)
    levels = 20.0 * np.log10(np.maximum(peaks, _MIN_MAGNITUDE))
    excess = np.maximum(levels - threshold_db, 0.0)
    targets = -excess * (1.0 - 1.0 / max(ratio, 1.0))
    block_seconds = block / float(sample_rate)
    attack_coefficient = math.exp(-block_seconds / max(attack_ms / 1000.0, 1e-6))
    release_coefficient = math.exp(-block_seconds / max(release_ms / 1000.0, 1e-6))
    smoothed = np.empty(block_count, dtype=np.float64)
    current = 0.0
    for index in range(block_count):
        target = float(targets[index])
        coefficient = attack_coefficient if target < current else release_coefficient
        current = coefficient * current + (1.0 - coefficient) * target
        smoothed[index] = current
    per_sample = np.repeat(smoothed, block)[:length]
    return np.asarray(10.0 ** ((per_sample + makeup_gain_db) / 20.0))


AUTOMATION_GRID_SECONDS = 0.001
_BEZIER_NEWTON_ITERATIONS = 8
_BEZIER_BISECTION_ITERATIONS = 20
_BEZIER_MIN_SLOPE = 1e-6


def _bezier_component(a: float, b: float, s: np.ndarray) -> np.ndarray:
    inv = 1.0 - s
    return np.asarray(3.0 * inv * inv * s * a + 3.0 * inv * s * s * b + s * s * s)


def _bezier_slope(a: float, b: float, s: np.ndarray) -> np.ndarray:
    inv = 1.0 - s
    return np.asarray(3.0 * inv * inv * a + 6.0 * inv * s * (b - a) + 3.0 * s * s * (1.0 - b))


def _custom_bezier_progress(left: Keyframe, right: Keyframe, progress: np.ndarray) -> np.ndarray:
    out = left.handles.out if left.handles is not None else None
    into = right.handles.in_ if right.handles is not None else None
    if out is None or into is None:
        return np.asarray(progress * progress * (3.0 - 2.0 * progress))
    x1, y1 = out
    x2, y2 = into
    if x1 == 1.0 / 3.0 and x2 == 2.0 / 3.0:
        return _bezier_component(y1, y2, progress)
    s = progress.copy()
    active = np.ones(s.shape, dtype=np.bool_)
    for _ in range(_BEZIER_NEWTON_ITERATIONS):
        slope = _bezier_slope(x1, x2, s)
        usable = active & (np.abs(slope) >= _BEZIER_MIN_SLOPE)
        if not np.any(usable):
            break
        s[usable] -= (_bezier_component(x1, x2, s[usable]) - progress[usable]) / slope[usable]
        active &= (s >= 0.0) & (s <= 1.0)
    bad = (s < 0.0) | (s > 1.0)
    if np.any(bad):
        low = np.zeros(np.count_nonzero(bad), dtype=np.float64)
        high = np.ones_like(low)
        target = progress[bad]
        middle = target.copy()
        for _ in range(_BEZIER_BISECTION_ITERATIONS):
            middle = (low + high) / 2.0
            before = _bezier_component(x1, x2, middle) < target
            low = np.where(before, middle, low)
            high = np.where(before, high, middle)
        s[bad] = middle
    return _bezier_component(y1, y2, s)


def _segment_progress(left: Keyframe, right: Keyframe, progress: np.ndarray) -> np.ndarray:
    p = np.clip(progress, 0.0, 1.0)
    easing = str(left.easing)
    if easing == "ease-in":
        return np.asarray(p * p)
    if easing == "ease-out":
        return np.asarray(p * (2.0 - p))
    if easing == "ease-in-out":
        return np.asarray(np.where(p < 0.5, 2.0 * p * p, 1.0 - ((-2.0 * p + 2.0) ** 2) / 2.0))
    if easing == "hold":
        return np.asarray(np.where(p >= 1.0, 1.0, 0.0))
    if easing == "bezier":
        return _custom_bezier_progress(left, right, p)
    return np.asarray(p)


def _automation_values(
    points: list[Keyframe], times: np.ndarray
) -> np.ndarray:
    """Evaluate a complete lane by keyframe segment, not once per millisecond in Python."""
    values = np.empty(times.shape, dtype=np.float64)
    first = points[0]
    last = points[-1]
    values[times <= first.time] = first.value
    values[times >= last.time] = last.value
    for index in range(len(points) - 1):
        left = points[index]
        right = points[index + 1]
        # The right endpoint belongs to this segment exactly as evaluate_keyframes does; the
        # next segment writes the same authored keyframe value, so overlap is deterministic.
        mask = (times >= left.time) & (times <= right.time)
        if not np.any(mask):
            continue
        span = right.time - left.time
        if span <= 0.0:
            values[mask] = right.value
            continue
        progress = (times[mask] - left.time) / span
        eased = _segment_progress(left, right, progress)
        values[mask] = left.value + (right.value - left.value) * eased
    return values


def automation_envelope(
    keyframes: list[Keyframe],
    property_name: str,
    duration: float,
    *,
    resolution: float = AUTOMATION_GRID_SECONDS,
) -> tuple[np.ndarray, np.ndarray] | None:
    """Sample an automation lane with O(keyframes) Python dispatch and vectorized segments."""
    if duration <= 0.0:
        return None
    points = sorted(
        (keyframe for keyframe in keyframes if keyframe.property == property_name),
        key=lambda keyframe: keyframe.time,
    )
    if not points:
        return None
    count = max(2, math.ceil(duration / resolution) + 1)
    times = np.linspace(0.0, duration, count)
    values = _automation_values(points, times)
    return times, np.asarray(10.0 ** (values / 20.0))


def sample_envelope(t: np.ndarray | float, times: np.ndarray, values: np.ndarray) -> np.ndarray:
    return np.asarray(np.interp(np.asarray(t, dtype=np.float64), times, values))
