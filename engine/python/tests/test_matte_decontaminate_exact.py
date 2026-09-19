"""PX5: the boxed ``decontaminate`` returns the dense definition's bytes, always.

The export's matte pass was the largest part of what a matte cost per 4K frame, and the fix is
only allowed if nothing it renders changes. ``decontaminate_dense`` is the definition; every
case below compares the two byte for byte, on the shapes that could tell them apart: no band,
a band touching every edge, a band of one pixel, a resampled artifact (whose footprint spreads
past the band), a cropped clip, and a picture that is not ``uint8``.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.matte_edges import decontaminate, decontaminate_dense


def _case(
    seed: int, size: tuple[int, int], band: str, maximum: int = 255
) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    height, width = size
    alpha = np.zeros((height, width), dtype=np.uint16 if maximum > 255 else np.uint8)
    if band == "ring":
        y, x = np.mgrid[0:height, 0:width]
        distance = np.hypot(x - width * 0.4, y - height * 0.55)
        alpha[:] = np.clip((min(size) * 0.3 - distance) / 6.0, 0.0, 1.0) * maximum
    elif band == "everywhere":
        alpha[:] = rng.integers(1, maximum, size=(height, width))
    elif band == "edges":
        alpha[:] = maximum
        alpha[0, :] = alpha[-1, :] = alpha[:, 0] = alpha[:, -1] = maximum // 2
    elif band == "pixel":
        alpha[height // 3, width // 2] = maximum // 3
    elif band == "solid":
        alpha[:] = maximum
    foreground = rng.integers(0, 256, size=(height, width, 3), dtype=np.uint8)
    return alpha, foreground


def _picture(seed: int, size: tuple[int, int]) -> np.ndarray:
    rng = np.random.default_rng(seed + 1000)
    return rng.integers(0, 256, size=(size[0], size[1], 3), dtype=np.uint8)


BANDS = ("none", "ring", "everywhere", "edges", "pixel", "solid")


@pytest.mark.parametrize("band", BANDS)
@pytest.mark.parametrize("maximum", [255, 65535])
def test_same_bytes_at_source_size(band: str, maximum: int) -> None:
    size = (54, 96)
    alpha, foreground = _case(1, size, band, maximum)
    picture = _picture(1, size)
    clip = SimpleNamespace(crop=None)
    expected = decontaminate_dense(picture, alpha, maximum, foreground, clip)
    actual = decontaminate(picture, alpha, maximum, foreground, clip)
    assert actual.dtype == np.uint8
    assert np.array_equal(actual, expected)
    assert actual is not picture


@pytest.mark.parametrize("band", BANDS)
@pytest.mark.parametrize(
    ("frame", "decoded", "crop"),
    [
        ((27, 48), (48, 27), None),  # artifact at 2x the decoded picture
        ((108, 192), (192, 108), None),  # artifact at half of it
        ((30, 40), (96, 54), SimpleNamespace(x=0.25, y=0.2, width=0.42, height=0.56)),
        ((54, 96), (96, 54), SimpleNamespace(x=0.0, y=0.0, width=1.0, height=1.0)),
    ],
)
def test_same_bytes_through_a_resample_or_crop(
    band: str, frame: tuple[int, int], decoded: tuple[int, int], crop: Any
) -> None:
    alpha, foreground = _case(2, (54, 96), band)
    clip = SimpleNamespace(crop=crop)
    if crop is not None and (crop.width, crop.height) != (1.0, 1.0):
        x1, y1 = int(crop.x * decoded[0]), int(crop.y * decoded[1])
        x2 = int((crop.x + crop.width) * decoded[0])
        y2 = int((crop.y + crop.height) * decoded[1])
        frame = (y2 - y1, x2 - x1)
    picture = _picture(2, frame)
    expected = decontaminate_dense(picture, alpha, 255, foreground, clip, decoded)
    actual = decontaminate(picture, alpha, 255, foreground, clip, decoded)
    assert np.array_equal(actual, expected)


def test_a_float_picture_takes_the_dense_path() -> None:
    alpha, foreground = _case(3, (20, 30), "ring")
    picture = _picture(3, (20, 30)).astype(np.float64) + 0.4
    clip = SimpleNamespace(crop=None)
    expected = decontaminate_dense(picture, alpha, 255, foreground, clip)
    assert np.array_equal(decontaminate(picture, alpha, 255, foreground, clip), expected)


def test_the_input_picture_is_never_written() -> None:
    alpha, foreground = _case(4, (20, 30), "ring")
    picture = _picture(4, (20, 30))
    before = picture.copy()
    picture.setflags(write=False)  # MoviePy hands out frames that may be shared
    decontaminate(picture, alpha, 255, foreground, SimpleNamespace(crop=None))
    assert np.array_equal(picture, before)


def test_work_is_bounded_by_the_band_not_the_frame() -> None:
    """The regression guard for the PX5 export budget (masks + 4K mattes <= 1.5x without).

    Deterministic on purpose: not a timing, but what the function allocates. The dense form
    builds several frame-sized float64 arrays per frame; the boxed form must never build even
    ONE frame-sized float64 RGB plane when the band is small, at source size (the export's
    case). ``tracemalloc`` sees numpy's buffers, and sizes are a property of the algorithm, so
    this cannot flake with the machine.
    """
    import tracemalloc

    height, width = 1080, 1920
    alpha = np.zeros((height, width), dtype=np.uint8)
    alpha[500:540, 900:960] = 128
    foreground = np.full((height, width, 3), 200, dtype=np.uint8)
    picture = np.full((height, width, 3), 40, dtype=np.uint8)
    clip = SimpleNamespace(crop=None)
    one_float_rgb_plane = height * width * 3 * 8

    def peak(function: Any) -> int:
        tracemalloc.start()
        try:
            function(picture, alpha, 255, foreground, clip)
            return tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

    assert peak(decontaminate_dense) > 3 * one_float_rgb_plane  # the guard measures something
    assert peak(decontaminate) < one_float_rgb_plane
