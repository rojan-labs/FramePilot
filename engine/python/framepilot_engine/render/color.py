"""Deterministic color grading for the render compiler (PRD §6.7, plan Phase 6).

WHY: color is a render concern (PRD §9.1) — it must produce the *same* pixels for
the same grade so golden-media tests hold. This module is the **pure color math**:
a parametric grade (exposure / contrast / saturation / temperature / tint /
shadows / highlights) plus a pure ``.cube`` 3D-LUT parser and trilinear applier.
It operates on numpy frame arrays only (uint8 ``HxWx3``); the compiler applies the
result per frame via MoviePy's ``image_transform``, so no MoviePy dependency leaks
in here and every function is 100% unit-testable without a render.

Param conventions match the editor UI / AI ``color_grade`` effect: every parameter
is a signed offset where ``0`` is identity. ``saturation = -1`` is fully desaturated
(B&W); ``temperature`` > 0 is warmer (more red, less blue); ``tint`` > 0 pushes
green. No new dependency (numpy is already a render dependency).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

# Rec.709 luma coefficients — perceptual channel weights for saturation and the
# shadow/highlight luminance zones.
_LUMA = (0.2126, 0.7152, 0.0722)

# White-balance push per unit temperature/tint. Kept subtle so the UI's natural
# ±1 range spans a believable correction rather than blowing a channel out.
_TEMP_GAIN = 0.3
_TINT_GAIN = 0.3

# Shadow/highlight lift range per unit (in normalized 0..1 light).
_ZONE_GAIN = 0.5

# Grade parameter names, in the dataclass field order below.
_PARAMS = (
    "exposure",
    "contrast",
    "saturation",
    "temperature",
    "tint",
    "shadows",
    "highlights",
)


@dataclass(frozen=True)
class ColorGrade:
    """A resolved parametric color grade. All-zero is the identity (no-op)."""

    exposure: float = 0.0
    contrast: float = 0.0
    saturation: float = 0.0
    temperature: float = 0.0
    tint: float = 0.0
    shadows: float = 0.0
    highlights: float = 0.0

    @property
    def is_identity(self) -> bool:
        """True if the grade changes nothing (every parameter is 0)."""
        return all(getattr(self, name) == 0.0 for name in _PARAMS)


def color_grade_from_params(params: dict[str, Any]) -> ColorGrade:
    """Build a :class:`ColorGrade` from a ``color_grade`` effect's ``params``.

    Missing or non-numeric values default to ``0.0`` (identity for that axis), so a
    partial preset such as ``{"temperature": 0.2}`` grades only what it specifies.
    """

    def value(name: str) -> float:
        try:
            return float(params.get(name, 0.0) or 0.0)
        except (TypeError, ValueError):
            return 0.0

    return ColorGrade(*(value(name) for name in _PARAMS))


def _luma(rgb: np.ndarray) -> np.ndarray:
    """Rec.709 luminance of an ``(..., 3)`` RGB array (drops the channel axis)."""
    return np.asarray(rgb @ np.asarray(_LUMA, dtype=rgb.dtype))


def apply_color_grade(frame: np.ndarray, grade: ColorGrade) -> np.ndarray:
    """Apply a parametric ``grade`` to a ``uint8`` ``HxWx3`` RGB ``frame``.

    The pipeline is a fixed, deterministic order so the output is golden-stable:
    exposure → white balance (temperature/tint) → contrast → shadows/highlights →
    saturation, with a final clamp to ``[0, 255]``. Identity grades return the
    input frame untouched (cheap fast-path for ungraded clips).
    """
    if grade.is_identity:
        return frame

    rgb = frame.astype(np.float32) / 255.0

    # 1) Exposure in stops — multiply scene light.
    if grade.exposure:
        rgb = rgb * float(2.0**grade.exposure)

    # 2) White balance — temperature warms (R up / B down), tint shifts green.
    if grade.temperature:
        rgb[..., 0] *= 1.0 + _TEMP_GAIN * grade.temperature
        rgb[..., 2] *= 1.0 - _TEMP_GAIN * grade.temperature
    if grade.tint:
        rgb[..., 1] *= 1.0 + _TINT_GAIN * grade.tint

    # 3) Contrast around mid-gray.
    if grade.contrast:
        rgb = (rgb - 0.5) * (1.0 + grade.contrast) + 0.5

    # 4) Shadows/highlights — lift weighted by luminance zone.
    if grade.shadows or grade.highlights:
        lum = np.clip(_luma(np.clip(rgb, 0.0, 1.0)), 0.0, 1.0)
        shadow_weight = (1.0 - lum) ** 2
        highlight_weight = lum**2
        delta = _ZONE_GAIN * (grade.shadows * shadow_weight + grade.highlights * highlight_weight)
        rgb = rgb + delta[..., None]

    # 5) Saturation around the pixel's luma (-1 -> fully desaturated).
    if grade.saturation:
        lum = _luma(rgb)[..., None]
        rgb = lum + (rgb - lum) * (1.0 + grade.saturation)

    return np.asarray(np.round(np.clip(rgb, 0.0, 1.0) * 255.0), dtype=np.uint8)


# --- .cube 3D LUT (import) ---------------------------------------------------


@dataclass(frozen=True)
class CubeLut:
    """A parsed 3D ``.cube`` LUT. ``table`` is ``(size, size, size, 3)`` indexed [r, g, b]."""

    size: int
    table: np.ndarray
    domain_min: tuple[float, float, float] = (0.0, 0.0, 0.0)
    domain_max: tuple[float, float, float] = (1.0, 1.0, 1.0)


def parse_cube_lut(text: str) -> CubeLut:
    """Parse Adobe ``.cube`` 3D-LUT text into a :class:`CubeLut` (pure, no I/O).

    Supports ``TITLE``, ``LUT_3D_SIZE``, and optional ``DOMAIN_MIN``/``DOMAIN_MAX``;
    comment (``#``) and blank lines are ignored. Data rows are ``R G B`` floats with
    red varying fastest (per the spec); the table is transposed to ``[r, g, b]``
    indexing for the applier.

    :raises ValueError: For 1D LUTs, a missing size, or an entry-count mismatch.
    """
    size: int | None = None
    domain_min = [0.0, 0.0, 0.0]
    domain_max = [1.0, 1.0, 1.0]
    rows: list[tuple[float, float, float]] = []

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        key = parts[0].upper()
        if key == "TITLE":
            continue
        if key == "LUT_1D_SIZE":
            raise ValueError("1D .cube LUTs are not supported (a 3D LUT is required).")
        if key == "LUT_3D_SIZE":
            size = int(parts[1])
            continue
        if key == "DOMAIN_MIN":
            domain_min = [float(x) for x in parts[1:4]]
            continue
        if key == "DOMAIN_MAX":
            domain_max = [float(x) for x in parts[1:4]]
            continue
        if len(parts) == 3:
            rows.append((float(parts[0]), float(parts[1]), float(parts[2])))

    if size is None:
        raise ValueError("Missing LUT_3D_SIZE in .cube data.")
    if len(rows) != size**3:
        raise ValueError(f".cube has {len(rows)} entries, expected {size**3} for size {size}.")

    data = np.asarray(rows, dtype=np.float32)
    # Red varies fastest, then green, then blue → C-order reshape yields [b, g, r].
    table_bgr = data.reshape(size, size, size, 3)
    table = np.ascontiguousarray(np.transpose(table_bgr, (2, 1, 0, 3)))
    return CubeLut(
        size=size,
        table=table,
        domain_min=(domain_min[0], domain_min[1], domain_min[2]),
        domain_max=(domain_max[0], domain_max[1], domain_max[2]),
    )


def apply_lut(frame: np.ndarray, lut: CubeLut) -> np.ndarray:
    """Apply a 3D ``lut`` to a ``uint8`` ``HxWx3`` frame with trilinear interpolation."""
    rgb = frame.astype(np.float32) / 255.0
    n = lut.size
    domain_min = np.asarray(lut.domain_min, dtype=np.float32)
    domain_max = np.asarray(lut.domain_max, dtype=np.float32)

    coords = (np.clip(rgb, domain_min, domain_max) - domain_min) / (domain_max - domain_min)
    pos = coords * (n - 1)
    lo = np.floor(pos).astype(np.int32)
    hi = np.minimum(lo + 1, n - 1)
    frac = pos - lo

    table = lut.table
    r0, g0, b0 = lo[..., 0], lo[..., 1], lo[..., 2]
    r1, g1, b1 = hi[..., 0], hi[..., 1], hi[..., 2]
    fr = frac[..., 0:1]
    fg = frac[..., 1:2]
    fb = frac[..., 2:3]

    # Trilinear blend of the eight surrounding LUT cells.
    c00 = table[r0, g0, b0] * (1 - fr) + table[r1, g0, b0] * fr
    c10 = table[r0, g1, b0] * (1 - fr) + table[r1, g1, b0] * fr
    c01 = table[r0, g0, b1] * (1 - fr) + table[r1, g0, b1] * fr
    c11 = table[r0, g1, b1] * (1 - fr) + table[r1, g1, b1] * fr
    c0 = c00 * (1 - fg) + c10 * fg
    c1 = c01 * (1 - fg) + c11 * fg
    out = c0 * (1 - fb) + c1 * fb

    return np.asarray(np.round(np.clip(out, 0.0, 1.0) * 255.0), dtype=np.uint8)


# ---------------------------------------------------------------------------
# Skin qualifier
# ---------------------------------------------------------------------------

# The classic RGB skin-tone qualifier (Kovac et al., "Human skin colour
# clustering for face detection", EUROCON 2003), in normalised 0..1 light.
#
# WHY a qualifier and not a detector: FramePilot ships no CV model, and a grade
# that claims to protect faces on the strength of a guess is worse than one that
# does not claim it. This is the same instrument a colorist reaches for — a
# bounded region of colour space — so what it selects is stated, testable, and
# wrong in ways a person can see rather than wrong in ways a model hides. It
# selects skin-*coloured* pixels, which is not the same as skin, and every
# consumer must treat low coverage as "no reading", never as "no drift".
_SKIN_MIN_RED = 95.0 / 255.0
_SKIN_MIN_GREEN = 40.0 / 255.0
_SKIN_MIN_BLUE = 20.0 / 255.0
_SKIN_MIN_SPREAD = 15.0 / 255.0
_SKIN_MIN_RED_GREEN_DELTA = 15.0 / 255.0


def skin_qualifier_mask(rgb: np.ndarray) -> np.ndarray:
    """Boolean mask of skin-coloured pixels in a normalised ``HxWx3`` RGB array.

    :param rgb: Float array in ``[0, 1]``.
    :returns: ``HxW`` boolean mask.
    """
    red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    spread = np.max(rgb, axis=-1) - np.min(rgb, axis=-1)
    return np.asarray(
        (red > _SKIN_MIN_RED)
        & (green > _SKIN_MIN_GREEN)
        & (blue > _SKIN_MIN_BLUE)
        & (spread > _SKIN_MIN_SPREAD)
        & (np.abs(red - green) > _SKIN_MIN_RED_GREEN_DELTA)
        & (red > green)
        & (red > blue)
    )
