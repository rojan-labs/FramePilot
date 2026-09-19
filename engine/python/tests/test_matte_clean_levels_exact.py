"""PX5.4: the export's matte pass after the last exact cuts returns the definition's bits.

Three rewrites in ``render/matte_edges.py``, each only allowed if nothing it renders changes:

* ``apply_clean_levels`` writes its four ufuncs into one array instead of allocating four;
  ``apply_clean_levels_dense`` is the definition, compared bit for bit (``tobytes``, so -0.0
  and NaN payloads count) on every value class a float can hold;
* ``edge_shift`` divides in place; the definition is ``astype(float64) / maximum``;
* ``decontaminate`` at source size selects the band's own pixels from the foreground (the
  cases in ``test_matte_decontaminate_exact.py`` compare it with ``decontaminate_dense``; the
  ones here add the inputs the selection must refuse or survive).
"""

from __future__ import annotations

import math
import tracemalloc
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.matte_edges import (
    _disc_morphology,
    apply_clean_levels,
    apply_clean_levels_dense,
    decontaminate,
    decontaminate_dense,
    edge_shift,
)

#: Every float class the levels could meet: the fixed points 0 and 1, -0.0, the band, values
#: past both ends, the smallest subnormal, infinities and NaN.
SPECIAL = np.array(
    [
        *(0.0, -0.0, 1.0, 0.5, 0.25, 0.75, 1e-300, 5e-324, -1e-9, 1.0 + 2**-52, 2.0, -3.0),
        *(math.inf, -math.inf, math.nan, 0.1, 0.9, 1.0 / 3.0, 2.0 / 3.0),
    ],
    dtype=np.float64,
)

LEVELS = [
    (0.25, 0.75),  # edgeMode 'sharp'
    (0.0, 0.5),
    (0.5, 1.0),
    (0.1, 0.9),
    (0.0, 1.0),  # identity
    (0.4, 0.4),  # threshold (they meet)
    (0.7, 0.2),  # threshold (crossed)
    (-0.2, 1.3),  # outside [0, 1]: the formula, not a clamp, decides
    (1.0 / 3.0, 2.0 / 3.0),
]


def _planes() -> list[np.ndarray]:
    rng = np.random.default_rng(7)
    ring = np.zeros((54, 96), dtype=np.float64)
    y, x = np.mgrid[0:54, 0:96]
    ring[:] = np.clip((20.0 - np.hypot(x - 40.0, y - 27.0)) / 5.0, 0.0, 1.0)
    return [
        ring,
        rng.random((33, 47)),
        np.tile(SPECIAL, (5, 1)),
        rng.integers(0, 256, size=(40, 60)).astype(np.float64) / 255.0,
        np.zeros((8, 8)),
        np.ones((8, 8)),
        ring[:, ::2],  # a strided (non-contiguous) view
    ]


@pytest.mark.parametrize(("black", "white"), LEVELS)
def test_clean_levels_same_bits_as_the_definition(black: float, white: float) -> None:
    for plane in _planes():
        before = plane.copy()
        actual = apply_clean_levels(plane, black, white)
        expected = apply_clean_levels_dense(plane, black, white)
        assert actual.dtype == expected.dtype
        assert actual.shape == expected.shape
        assert np.ascontiguousarray(actual).tobytes() == np.ascontiguousarray(expected).tobytes()
        assert plane.tobytes() == before.tobytes(), "the input must never be written"


def test_clean_levels_float32_takes_the_definition() -> None:
    plane = np.linspace(-0.5, 1.5, 101, dtype=np.float32).reshape(1, -1)
    actual = apply_clean_levels(plane, 0.25, 0.75)  # type: ignore[arg-type]
    expected = apply_clean_levels_dense(plane, 0.25, 0.75)  # type: ignore[arg-type]
    assert actual.dtype == expected.dtype
    assert actual.tobytes() == expected.tobytes()


def test_clean_levels_allocates_one_plane_not_several() -> None:
    """The regression guard for the in-place form: deterministic sizes, not a timing."""
    plane = np.random.default_rng(1).random((540, 960))
    one_plane = plane.nbytes

    def peak(function: Any) -> int:
        tracemalloc.start()
        try:
            function(plane, 0.25, 0.75)
            return tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

    assert peak(apply_clean_levels_dense) >= 2 * one_plane  # the guard measures something
    assert peak(apply_clean_levels) < 1.1 * one_plane


@pytest.mark.parametrize("maximum", [255, 65535])
@pytest.mark.parametrize("shift", [0.0, 1.0, -2.0, 1.5, -2.25, 3.7])
def test_edge_shift_same_bits_as_the_definition(maximum: int, shift: float) -> None:
    rng = np.random.default_rng(maximum + int(shift * 100))
    dtype = np.uint8 if maximum == 255 else np.uint16
    alpha_int = rng.integers(0, maximum + 1, size=(24, 31)).astype(dtype)
    magnitude = abs(shift)
    low, high = math.floor(magnitude), math.ceil(magnitude)
    grow = shift > 0
    low_alpha = _disc_morphology(alpha_int, low, grow).astype(np.float64) / float(maximum)
    if high == low:
        expected = low_alpha
    else:
        high_alpha = _disc_morphology(alpha_int, high, grow).astype(np.float64) / float(maximum)
        expected = low_alpha + (high_alpha - low_alpha) * (magnitude - float(low))
    before = alpha_int.copy()
    actual = edge_shift(alpha_int, maximum, shift)
    assert actual.tobytes() == expected.tobytes()
    assert np.array_equal(alpha_int, before)


def _decontaminate_inputs(seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    alpha = rng.integers(0, 256, size=(30, 44)).astype(np.uint8)
    alpha[:10] = 0
    alpha[20:] = 255
    foreground = rng.integers(0, 256, size=(30, 44, 3), dtype=np.uint8)
    picture = rng.integers(0, 256, size=(30, 44, 3), dtype=np.uint8)
    return alpha, foreground, picture


def test_selection_matches_the_definition_on_a_strided_foreground() -> None:
    alpha, foreground, picture = _decontaminate_inputs(11)
    wide = np.zeros((30, 88, 3), dtype=np.uint8)
    wide[:, ::2] = foreground
    strided = wide[:, ::2]
    clip = SimpleNamespace(crop=None)
    expected = decontaminate_dense(picture, alpha, 255, strided, clip)
    assert np.array_equal(decontaminate(picture, alpha, 255, strided, clip), expected)


def test_a_foreground_that_is_not_uint8_is_clipped_as_defined() -> None:
    alpha, foreground, picture = _decontaminate_inputs(12)
    loud = foreground.astype(np.uint16) * 3  # values past 255: the definition clips them
    clip = SimpleNamespace(crop=None)
    expected = decontaminate_dense(picture, alpha, 255, loud, clip)  # type: ignore[arg-type]
    actual = decontaminate(picture, alpha, 255, loud, clip)  # type: ignore[arg-type]
    assert np.array_equal(actual, expected)


def test_selection_never_writes_its_inputs() -> None:
    alpha, foreground, picture = _decontaminate_inputs(13)
    for array in (alpha, foreground, picture):
        array.setflags(write=False)
    out = decontaminate(picture, alpha, 255, foreground, SimpleNamespace(crop=None))
    assert out is not picture
    assert out.flags.writeable
