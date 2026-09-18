"""PX5.4: the mask stack's tail (``combine``, ``quantize_alpha``) in place, same bits.

Every masked export frame ends in these two: the stack combines each layer's alpha into an
accumulator and quantises the result once. At 4K the expressions below allocated two or three
frame-sized float arrays each (35-47 ms per frame for a one-matte stack). The in-place forms
in ``render/mask_raster.py`` apply the same ufuncs to the same operands in the same order, so
they must give the same bits. The definitions are kept here, verbatim from before the change,
and compared with ``tobytes`` (so -0.0 and NaN payloads count), on float64 and float32 planes.
"""

from __future__ import annotations

import math
import tracemalloc
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.mask_raster import combine, quantize_alpha

MODES = ("add", "subtract", "intersect", "difference", "lighten", "darken")


def combine_definition(accumulated: Any, mask: Any, mode: str) -> Any:
    if mode == "add":
        return np.minimum(accumulated + mask, 1.0)
    if mode == "subtract":
        return np.maximum(accumulated - mask, 0.0)
    if mode == "intersect":
        return accumulated * mask
    if mode == "difference":
        return np.abs(accumulated - mask)
    if mode == "lighten":
        return np.maximum(accumulated, mask)
    return np.minimum(accumulated, mask)


def quantize_definition(alpha: Any) -> Any:
    clamped = np.minimum(np.maximum(alpha, 0.0), 1.0)
    return np.rint(clamped * 255.0).astype(np.uint8)


#: Values a stack can hold, and some it should never hold but a definition still defines.
SPECIAL = [0.0, -0.0, 1.0, 0.5, 1.0 / 255.0, 0.5 / 255.0, 1.5 / 255.0, 254.5 / 255.0]
SPECIAL += [1e-300, 5e-324, -1e-9, 1.0 + 2**-52, 2.0, -3.0, math.inf, -math.inf, math.nan]


def _planes(dtype: Any) -> list[np.ndarray]:
    rng = np.random.default_rng(3)
    special = np.array(SPECIAL, dtype=dtype)
    return [
        rng.random((31, 45)).astype(dtype),
        (rng.integers(0, 256, size=(20, 30)) / 255.0).astype(dtype),  # exact quantisation levels
        np.tile(special, (4, 1)),
        np.zeros((6, 7), dtype=dtype),
        np.ones((6, 7), dtype=dtype),
    ]


def _same(actual: np.ndarray, expected: np.ndarray) -> bool:
    return (
        actual.dtype == expected.dtype
        and actual.shape == expected.shape
        and np.ascontiguousarray(actual).tobytes() == np.ascontiguousarray(expected).tobytes()
    )


@pytest.mark.parametrize("dtype", [np.float64, np.float32])
@pytest.mark.parametrize("mode", MODES)
def test_combine_same_bits_as_the_definition(mode: str, dtype: Any) -> None:
    planes = _planes(dtype)
    for first in planes:
        for second in planes:
            if first.shape != second.shape:
                continue
            before = (first.copy(), second.copy())
            with np.errstate(all="ignore"):  # inf - inf: defined identically on both sides
                actual = combine(first, second, mode)
                expected = combine_definition(first, second, mode)
            assert _same(actual, expected), mode
            assert first.tobytes() == before[0].tobytes()
            assert second.tobytes() == before[1].tobytes()


@pytest.mark.parametrize("dtype", [np.float64, np.float32])
def test_quantize_same_bits_as_the_definition(dtype: Any) -> None:
    for plane in _planes(dtype):
        before = plane.copy()
        with np.errstate(invalid="ignore"):  # NaN and inf -> uint8 is defined by numpy, not us
            actual = quantize_alpha(plane)
            expected = quantize_definition(plane)
        assert _same(actual, expected)
        assert plane.tobytes() == before.tobytes()


def test_a_strided_view_quantises_like_its_copy() -> None:
    plane = np.random.default_rng(4).random((40, 60))[:, ::3]
    assert _same(quantize_alpha(plane), quantize_definition(plane))


def test_the_tail_allocates_one_working_plane_per_step() -> None:
    """The regression guard: sizes, not timings. The expressions held two float planes at once."""
    plane = np.random.default_rng(5).random((540, 960))
    other = np.random.default_rng(6).random((540, 960))
    one_plane = plane.nbytes

    def peak(function: Any, *args: Any) -> int:
        tracemalloc.start()
        try:
            function(*args)
            return tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

    assert peak(quantize_definition, plane) >= 2 * one_plane  # the guard measures something
    assert peak(quantize_alpha, plane) < 1.2 * one_plane
    assert peak(combine_definition, plane, other, "add") >= 2 * one_plane
    assert peak(combine, plane, other, "add") < 1.1 * one_plane
