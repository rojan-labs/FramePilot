"""Deterministic pseudo-randomness shared by the render passes and the GLSL shaders.

WHY this file exists at all: half the effect catalog (grain, dust, glitch, tape
dropout, flicker) needs randomness, and "the same timestamp must look the same"
is non-negotiable — a render is a deterministic function of the project, and the
web preview must agree with it frame for frame.

WHY an INTEGER hash and not the usual ``fract(sin(dot(p, k)) * large)``:
that idiom is the GLSL convention, but ``sin`` is only approximated in hardware
and its precision differs between GPU vendors, and between any GPU and numpy.
Grain built on it would visibly differ between preview and render on the same
frame, which is exactly the drift this project cannot have. A 32-bit integer
bit-mix has no such freedom: the operations are exact in numpy ``uint32`` and
exact in GLSL ES 3.0 ``uint``, so both sides produce identical bits.

The mixer is Chris Wellons' ``lowbias32`` (the best-measured 32-bit xor-multiply
triple), chosen for having no visible structure at low bit counts — grain built
on a weaker mixer shows diagonal banding at large cell sizes.

The GLSL side lives in ``apps/web-editor/src/preview/effects/glsl/hash.glsl`` and
is asserted equal by a parity test; change them together.
"""

from __future__ import annotations

import numpy as np

__all__ = [
    "TIME_QUANTUM",
    "hash_u32",
    "noise01",
    "quantize_time",
    "value_noise01",
]

# Animated noise advances in discrete steps rather than continuously: a float
# timestamp cannot be compared for equality across a render (which steps exact
# frame times) and a preview (which lands on whatever the compositor gives it),
# so both sides quantize to this grid first and then agree exactly. 1/60s is fine
# enough that grain still reads as animated at any playback rate.
TIME_QUANTUM = 1.0 / 60.0

_M1 = np.uint32(0x7FEB352D)
_M2 = np.uint32(0x846CA68B)


def hash_u32(value: np.ndarray) -> np.ndarray:
    """Bit-mix a ``uint32`` array into well-distributed ``uint32`` output.

    Exactly mirrors the GLSL ``hashU32``. All arithmetic is deliberately done in
    ``uint32`` with wrapping semantics, which numpy gives natively (and which is
    what GLSL's ``uint`` does too).
    """
    x = value.astype(np.uint32, copy=True)
    # `errstate` because numpy warns on uint32 multiply overflow, which is the
    # entire point of a bit-mixer.
    with np.errstate(over="ignore"):
        x ^= x >> np.uint32(16)
        x *= _M1
        x ^= x >> np.uint32(15)
        x *= _M2
        x ^= x >> np.uint32(16)
    return x


def quantize_time(t: float) -> int:
    """Snap a timestamp onto the shared noise grid. See :data:`TIME_QUANTUM`."""
    return int(np.floor(max(0.0, t) / TIME_QUANTUM))


def noise01(x: np.ndarray, y: np.ndarray, frame: int, salt: int = 0) -> np.ndarray:
    """Per-cell white noise in ``[0, 1)`` for integer coordinates.

    ``salt`` separates independent noise fields on the same frame (e.g. dust
    position vs dust brightness) without needing a second hash function.
    """
    xi = x.astype(np.uint32, copy=False)
    yi = y.astype(np.uint32, copy=False)
    # Mask to 32 bits BEFORE the uint32 cast: `frame * 0x9E3779B1` is evaluated as
    # an arbitrary-precision Python int, and numpy raises OverflowError rather than
    # wrapping when asked to narrow it. GLSL's uint would wrap silently, so masking
    # here is also what keeps the two sides bit-identical.
    seed = np.uint32((frame * 0x9E3779B1 + salt) & 0xFFFFFFFF)
    with np.errstate(over="ignore"):
        # Mixing coordinates through the hash one axis at a time avoids the
        # diagonal correlation a plain `x + y * width` key produces.
        key = hash_u32(xi ^ hash_u32(yi ^ seed))
    # 24 bits is all a float32 can hold exactly, and using the HIGH bits avoids
    # the weak low bits of any xor-multiply mixer.
    return (key >> np.uint32(8)).astype(np.float32) / np.float32(1 << 24)


def value_noise01(
    x: np.ndarray, y: np.ndarray, frame: int, cell: float, salt: int = 0
) -> np.ndarray:
    """Smooth (bilinearly interpolated) value noise in ``[0, 1]``.

    Used where white noise would look like television static but the effect wants
    organic movement — heat shimmer, light-leak drift, handheld drift. ``cell`` is
    the noise wavelength in pixels.
    """
    scale = max(1e-3, cell)
    fx = x.astype(np.float32) / np.float32(scale)
    fy = y.astype(np.float32) / np.float32(scale)
    x0 = np.floor(fx)
    y0 = np.floor(fy)
    tx = fx - x0
    ty = fy - y0
    # Smoothstep the interpolants so the field is C1-continuous; plain linear
    # interpolation leaves visible grid creases.
    sx = tx * tx * (np.float32(3.0) - np.float32(2.0) * tx)
    sy = ty * ty * (np.float32(3.0) - np.float32(2.0) * ty)

    xi = x0.astype(np.int64)
    yi = y0.astype(np.int64)
    n00 = noise01(xi, yi, frame, salt)
    n10 = noise01(xi + 1, yi, frame, salt)
    n01 = noise01(xi, yi + 1, frame, salt)
    n11 = noise01(xi + 1, yi + 1, frame, salt)

    top = n00 + (n10 - n00) * sx
    bottom = n01 + (n11 - n01) * sx
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray((top + (bottom - top) * sy).astype(np.float32))
