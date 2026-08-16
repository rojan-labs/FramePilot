"""Shared primitives for the frame-effect passes.

Each helper here has a GLSL twin. Keeping them in one place is what stops the
same operation drifting between passes: ``luminance`` uses Rec.709 weights in
every effect that needs brightness, because a bloom that thresholded on a
different luma than a halation would ring differently for no visible reason.
"""

from __future__ import annotations

import numpy as np

__all__ = [
    "REC709",
    "coord_grid",
    "gaussian_blur",
    "hue_to_rgb",
    "luminance",
    "mix",
    "normalized_grid",
    "sample_bilinear",
    "separable_box",
    "smoothstep",
]

#: Rec.709 luma weights — the same primaries the H.264 output uses, so a
#: threshold set in the UI means the same thing in the encoded file.
REC709 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def luminance(frame: np.ndarray) -> np.ndarray:
    """Rec.709 luma of an RGB frame, shape ``(H, W)``."""
    return frame @ REC709


def mix(a: np.ndarray, b: np.ndarray, t: float | np.ndarray) -> np.ndarray:
    """Linear interpolation, matching GLSL ``mix``."""
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(a + (b - a) * np.float32(t) if isinstance(t, float) else a + (b - a) * t)


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    """GLSL ``smoothstep``. Guards a zero-width edge rather than dividing by 0."""
    span = edge1 - edge0
    if abs(span) < 1e-6:
        # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
        return np.asarray((x >= edge1).astype(np.float32))
    t = np.clip((x - np.float32(edge0)) / np.float32(span), 0.0, 1.0)
    return np.asarray((t * t * (np.float32(3.0) - np.float32(2.0) * t)).astype(np.float32))


def coord_grid(height: int, width: int) -> tuple[np.ndarray, np.ndarray]:
    """Integer pixel coordinate grids ``(ys, xs)``, each shape ``(H, W)``."""
    ys, xs = np.meshgrid(
        np.arange(height, dtype=np.int64), np.arange(width, dtype=np.int64), indexing="ij"
    )
    return ys, xs


def normalized_grid(height: int, width: int) -> tuple[np.ndarray, np.ndarray]:
    """UV grids in ``[0, 1]`` at PIXEL CENTRES, shape ``(H, W)`` each.

    Half-pixel offset matters: sampling at cell corners shifts a warp by half a
    pixel relative to the GPU, which uses centres. That is invisible alone and
    obvious as a seam once two mirrored halves are compared.
    """
    ys, xs = coord_grid(height, width)
    u = (xs.astype(np.float32) + np.float32(0.5)) / np.float32(width)
    v = (ys.astype(np.float32) + np.float32(0.5)) / np.float32(height)
    return v, u


def hue_to_rgb(hue_degrees: float) -> np.ndarray:
    """A fully-saturated RGB triple for a hue in degrees. Mirrors GLSL ``hue2rgb``."""
    h = (float(hue_degrees) % 360.0) / 60.0
    x = 1.0 - abs((h % 2.0) - 1.0)
    table = [
        (1.0, x, 0.0),
        (x, 1.0, 0.0),
        (0.0, 1.0, x),
        (0.0, x, 1.0),
        (x, 0.0, 1.0),
        (1.0, 0.0, x),
    ]
    # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
    return np.asarray(np.array(table[int(h) % 6], dtype=np.float32))


def sample_bilinear(frame: np.ndarray, sy: np.ndarray, sx: np.ndarray) -> np.ndarray:
    """Bilinearly sample ``frame`` at float pixel coordinates, clamping at edges.

    Clamp-to-edge (not wrap) because every geometric effect here — fisheye, ripple,
    kaleidoscope — can reach outside the frame, and wrapping would fold unrelated
    content in from the opposite side. Clamping smears the edge pixel, which is
    what a GPU sampler in ``CLAMP_TO_EDGE`` does, so preview and render agree.
    """
    height, width = frame.shape[0], frame.shape[1]
    x = np.clip(sx, 0.0, width - 1.0)
    y = np.clip(sy, 0.0, height - 1.0)

    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    x1 = np.minimum(x0 + 1, width - 1)
    y1 = np.minimum(y0 + 1, height - 1)

    fx = (x - x0).astype(np.float32)[..., None]
    fy = (y - y0).astype(np.float32)[..., None]

    p00 = frame[y0, x0]
    p10 = frame[y0, x1]
    p01 = frame[y1, x0]
    p11 = frame[y1, x1]

    top = p00 + (p10 - p00) * fx
    bottom = p01 + (p11 - p01) * fx
    return np.asarray((top + (bottom - top) * fy).astype(np.float32))


def separable_box(frame: np.ndarray, radius: float) -> np.ndarray:
    """Box blur via a summed-area table — O(1) per pixel regardless of radius.

    WHY not ``scipy.ndimage`` or a convolution: a naive kernel is O(r²) per pixel,
    and a 40px blur on a 1080p frame at 30fps would dominate the whole render. A
    prefix-sum makes radius free, which is what lets the catalog offer a 64px
    spread without a per-frame cost cliff.
    """
    r = round(max(0.0, radius))
    if r <= 0:
        # np.asarray keeps mypy honest: numpy stubs type these expressions as Any.
        return np.asarray(frame.astype(np.float32))

    height, width = frame.shape[0], frame.shape[1]
    # Pad by edge replication so the blur does not darken toward the border (a
    # zero-pad would mix in black and vignette every blurred frame).
    padded = np.pad(frame.astype(np.float32), ((r + 1, r), (r + 1, r), (0, 0)), mode="edge")
    integral = padded.cumsum(axis=0).cumsum(axis=1)

    size = 2 * r + 1
    y0 = np.arange(height)
    x0 = np.arange(width)
    # Inclusive-exclusive corners of each pixel's window in the padded integral.
    top = integral[np.ix_(y0, x0)]
    bottom = integral[np.ix_(y0 + size, x0)]
    left = integral[np.ix_(y0, x0 + size)]
    both = integral[np.ix_(y0 + size, x0 + size)]
    total = both - bottom - left + top
    return np.asarray((total / np.float32(size * size)).astype(np.float32))


def gaussian_blur(frame: np.ndarray, radius: float) -> np.ndarray:
    """Approximate a Gaussian with three successive box blurs.

    Three boxes is the standard approximation (a box convolved with itself thrice
    is within ~3% of a true Gaussian) and it keeps the O(1)-per-pixel property of
    :func:`separable_box`. The GLSL side runs the identical three-pass box, so the
    two match — a real Gaussian kernel there and boxes here would not.
    """
    if radius <= 0.0:
        return frame.astype(np.float32)
    # Matching box width for a target Gaussian sigma: w = sigma * sqrt(12/3 + 1).
    box_radius = max(1.0, radius / 3.0)
    out = frame.astype(np.float32)
    for _ in range(3):
        out = separable_box(out, box_radius)
    return out
