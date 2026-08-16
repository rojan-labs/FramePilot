"""Shared primitives for the transition passes.

Each helper has a GLSL twin in
``apps/web-editor/src/preview/transitions/glsl-transition-common.ts``. Keeping
them in one place is what stops the same operation drifting between passes — a
wipe and a shape wipe that feathered differently would look like a bug in one of
them rather than the shared constant it actually is.

## The one thing to know before reading any pass

**UV here is y-UP, like the shader's — not like the array.** A numpy frame has row
0 at the visual TOP; a GL texture (uploaded with ``UNPACK_FLIP_Y``) has v = 0 at
the visual BOTTOM. Rather than write every pass twice with the y terms negated,
:func:`uv_grid` hands out a y-up grid and :func:`sample` converts back when it
actually reads pixels. The result is that a pass body here can be read side by
side with its shader and the formulas match line for line, which is the only
practical way to keep 29 pairs honest.

Directions arrive already flipped into that space (see ``TransitionContext``), for
the same reason and at the same single seam.
"""

from __future__ import annotations

import numpy as np

from framepilot_engine.render.frame_effects._common import (
    gaussian_blur,
    luminance,
    sample_bilinear,
)

__all__ = [
    "SOFTNESS_MAX",
    "gaussian_blur",
    "luminance",
    "noise_stable",
    "opaque",
    "picture",
    "reveal",
    "rotate2",
    "sample",
    "screen_blend",
    "square_uv",
    "unsquare_uv",
    "uv_grid",
    "value_noise01",
]

#: The widest feather a softness of 1.0 buys. Mirrors ``_WIPE_SOFTNESS_MAX``.
SOFTNESS_MAX = 0.25

_M1 = np.uint32(0x7FEB352D)
_M2 = np.uint32(0x846CA68B)


def uv_grid(height: int, width: int) -> tuple[np.ndarray, np.ndarray]:
    """A y-UP UV grid at pixel centres, shape ``(H, W)`` each. See the module note.

    Half-pixel offset matters: sampling at cell corners shifts every geometric
    transition by half a pixel relative to the GPU, which uses centres.
    """
    ys, xs = np.meshgrid(
        np.arange(height, dtype=np.float32), np.arange(width, dtype=np.float32), indexing="ij"
    )
    u = (xs + np.float32(0.5)) / np.float32(width)
    v = np.float32(1.0) - (ys + np.float32(0.5)) / np.float32(height)
    return u, v


def sample(frame: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Bilinearly sample ``frame`` at y-up UV, clamping at the edges.

    Clamp rather than wrap, matching the GPU's ``CLAMP_TO_EDGE``: every geometric
    transition can reach outside the frame, and wrapping would fold unrelated
    content in from the opposite side.
    """
    height, width = frame.shape[0], frame.shape[1]
    sx = u * np.float32(width) - np.float32(0.5)
    sy = (np.float32(1.0) - v) * np.float32(height) - np.float32(0.5)
    return sample_bilinear(frame, sy, sx)


def inside(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """1.0 where the UV lands inside the frame, 0.0 outside."""
    within = (u >= 0.0) & (u <= 1.0) & (v >= 0.0) & (v <= 1.0)
    return np.asarray(within.astype(np.float32))


def picture(frame: np.ndarray, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The picture at ``(u, v)``, TRANSPARENT outside the frame.

    The numpy twin of the shader's ``picture()``, and the reason no geometric pass
    needs its own bounds test: a slide, a flip and a spin all move the picture
    partly off-frame, and clamping instead would smear the border pixels across the
    empty half of the screen.
    """
    return sample(frame, u, v), inside(u, v)


def opaque(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """``(rgb, all-ones alpha)`` — for passes that replace the frame outright."""
    return rgb, np.ones(rgb.shape[:2], dtype=np.float32)


def reveal(f: np.ndarray, p: float, softness: float) -> np.ndarray:
    """Alpha at sweep position ``f`` for reveal progress ``p``.

    The exact mirror of :func:`framepilot_engine.render.transitions.wipe_alpha`,
    including the ``p >= 1`` short-circuit: the edge overshoot to ``p * (1 + s)``
    is only *exactly* clear in exact arithmetic, so without the guard the last
    frame of a wipe leaves the trailing edge a hair transparent.

    Every wipe kind is this function over a different ``f``.
    """
    if p >= 1.0:
        return np.ones(f.shape, dtype=np.float32)
    s = max(1e-3, softness)
    return np.asarray(np.clip((p * (1.0 + s) - f) / s, 0.0, 1.0).astype(np.float32))


def square_uv(du: np.ndarray, dv: np.ndarray, aspect: float) -> tuple[np.ndarray, np.ndarray]:
    """Scale UV deltas into a square space so distances are isotropic."""
    return du * np.float32(aspect), dv


def unsquare_uv(du: np.ndarray, dv: np.ndarray, aspect: float) -> tuple[np.ndarray, np.ndarray]:
    """Inverse of :func:`square_uv`."""
    return du / np.float32(max(1e-6, aspect)), dv


def rotate2(
    x: np.ndarray, y: np.ndarray, angle: np.ndarray | float
) -> tuple[np.ndarray, np.ndarray]:
    """Rotate a 2D vector field. Matches GLSL ``rotate2``."""
    ca = np.cos(angle)
    sa = np.sin(angle)
    return x * ca - y * sa, x * sa + y * ca


def screen_blend(base: np.ndarray, add: np.ndarray) -> np.ndarray:
    """Screen blend — adds light without ever darkening a pixel."""
    return np.asarray((1.0 - (1.0 - base) * (1.0 - np.clip(add, 0.0, 1.0))).astype(np.float32))


def _hash_u32(value: np.ndarray) -> np.ndarray:
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


def noise_stable(cx: np.ndarray, cy: np.ndarray, salt: int) -> np.ndarray:
    """White noise in ``[0, 1)`` that does NOT move with the clock.

    A pixel dissolve's arrangement must hold still while it resolves; deriving it
    from the frame clock would re-roll the blocks every frame and read as static
    rather than as a dissolve. Mirrors the shader's ``noiseStable`` bit for bit —
    the integer mixer is what makes that possible (see ``deterministic.py``).
    """
    seed = np.uint32((int(salt) * 0x9E3779B1) & 0xFFFFFFFF)
    key = _hash_u32(
        cx.astype(np.uint32, copy=False) ^ _hash_u32(cy.astype(np.uint32, copy=False) ^ seed)
    )
    return np.asarray((key >> np.uint32(8)).astype(np.float32) / np.float32(16777216.0))


def value_noise01(px: np.ndarray, py: np.ndarray, cell: float, salt: int) -> np.ndarray:
    """Smooth value noise on a stable grid. Mirrors the shader's ``valueNoise01``."""
    scale = max(1e-3, cell)
    fx = px / np.float32(scale)
    fy = py / np.float32(scale)
    ix = np.floor(fx)
    iy = np.floor(fy)
    tx = fx - ix
    ty = fy - iy
    # Smoothstep the interpolants: plain linear leaves visible grid creases.
    sx = tx * tx * (3.0 - 2.0 * tx)
    sy = ty * ty * (3.0 - 2.0 * ty)
    cx = ix.astype(np.int64)
    cy = iy.astype(np.int64)
    n00 = noise_stable(cx, cy, salt)
    n10 = noise_stable(cx + 1, cy, salt)
    n01 = noise_stable(cx, cy + 1, salt)
    n11 = noise_stable(cx + 1, cy + 1, salt)
    top = n00 + (n10 - n00) * sx
    bottom = n01 + (n11 - n01) * sx
    return np.asarray((top + (bottom - top) * sy).astype(np.float32))
