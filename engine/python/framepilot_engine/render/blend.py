"""Per-channel compositing blend-mode math (schema v8, ``Clip.blend_mode``).

WHY a separate module: the formulas are pure per-channel arithmetic on two
aligned ``float64`` RGB arrays in ``[0, 1]`` — no MoviePy/Pillow dependency —
so they are unit-testable in isolation from the compositor (see
``test_render_compiler.py``'s hand-computed pixel-math cases) and reusable if a
future caller needs the same math outside :mod:`framepilot_engine.render.compiler`.

Convention (see ``docs/adr/0048-clip-blend-mode-schema-v8.md`` addendum): ``a``
is the **base** — the frame already composited from every layer beneath the
clip carrying ``blend_mode`` — and ``b`` is the **blend** layer — the clip's
own (already color-graded/transformed) picture, about to be composited on top.
This matches the codebase's z-order (``compile_timeline`` composites track 0
last/frontmost — see its "Assemble z-order" comment) and is the natural
reading of "this clip blends *onto* what's beneath it".

Every formula operates elementwise on ``np.ndarray`` inputs of identical shape
(typically ``(H, W, 3)``, values in ``[0, 1]``) and returns an array of the
same shape, also in ``[0, 1]`` (compositing then applies the clip's own alpha
on top of this blended RGB — see :func:`framepilot_engine.render.compiler._blend_layer_over`,
which still respects opacity/masks; blend mode only changes *how* the RGB
combines, not whether alpha compositing still applies).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import cast

import numpy as np

BlendFunc = Callable[[np.ndarray, np.ndarray], np.ndarray]

# Avoids a divide-by-zero warning in color-dodge/color-burn's denominators;
# the numerator is clamped to the same [0, 1] range so this has no visible
# effect beyond preventing a NaN/inf at the exact 0/1 boundary.
_EPSILON = 1e-6


def _multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return cast(np.ndarray, a * b)


def _screen(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return cast(np.ndarray, 1.0 - (1.0 - a) * (1.0 - b))


def _darken(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return cast(np.ndarray, np.minimum(a, b))


def _lighten(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return cast(np.ndarray, np.maximum(a, b))


def _overlay(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    # Discriminates on `b` (the blend/top layer) — the base clip is only ever
    # "underneath", so overlay's contrast boost follows what is being placed
    # on top of it. See the module docstring / ADR addendum for the base vs.
    # blend layer assignment this codebase uses.
    return np.where(b < 0.5, 2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b))


def _hard_light(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    # Same expression as `_overlay`, discriminating on `a` (the base) instead
    # of `b` — "overlay with a/b swapped", per the standard hard-light/overlay
    # relationship.
    return np.where(a < 0.5, 2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b))


def _color_dodge(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    denom = np.clip(1.0 - b, _EPSILON, None)
    return np.where(b >= 1.0, 1.0, np.minimum(1.0, a / denom))


def _color_burn(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    denom = np.clip(b, _EPSILON, None)
    return np.where(b <= 0.0, 0.0, 1.0 - np.minimum(1.0, (1.0 - a) / denom))


def _soft_light(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    # Standard W3C compositing-1 soft-light formula: `d(a)` is the darkening
    # helper curve applied to the base channel.
    d = np.where(a <= 0.25, ((16.0 * a - 12.0) * a + 4.0) * a, np.sqrt(a))
    return cast(
        np.ndarray,
        np.where(b <= 0.5, a - (1.0 - 2.0 * b) * a * (1.0 - a), a + (2.0 * b - 1.0) * (d - a)),
    )


def _difference(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return cast(np.ndarray, np.abs(a - b))


def _exclusion(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return cast(np.ndarray, a + b - 2.0 * a * b)


# Maps every non-'normal' `BlendMode` enum value (packages/timeline-schema) to
# its per-channel formula. 'normal'/absent never reaches `apply_blend_mode` —
# the compositor treats that as plain alpha-over and skips this module
# entirely (see `compile_timeline`'s `has_blend_mode` fast path).
BLEND_MODE_FUNCS: dict[str, BlendFunc] = {
    "multiply": _multiply,
    "screen": _screen,
    "darken": _darken,
    "lighten": _lighten,
    "overlay": _overlay,
    "hard-light": _hard_light,
    "color-dodge": _color_dodge,
    "color-burn": _color_burn,
    "soft-light": _soft_light,
    "difference": _difference,
    "exclusion": _exclusion,
}


def apply_blend_mode(base: np.ndarray, blend: np.ndarray, mode: str) -> np.ndarray:
    """Blend two normalized ``[0, 1]`` RGB arrays per ``mode``'s formula.

    :param base: The frame already composited from layers beneath (``a``).
    :param blend: The clip's own picture, about to be composited on top (``b``).
    :param mode: One of :data:`BLEND_MODE_FUNCS`'s keys (never ``'normal'``;
        callers must not invoke this for the no-op case).
    :returns: The blended RGB, same shape as the inputs, clipped to ``[0, 1]``.
    :raises KeyError: If ``mode`` is not a supported blend mode.
    """
    func = BLEND_MODE_FUNCS[mode]
    return np.clip(func(base, blend), 0.0, 1.0)
