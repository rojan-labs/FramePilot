"""BR7.5 subject-crop SAM pass: when it runs, what it is prompted with, how it is merged."""

from __future__ import annotations

import numpy as np
from fakes import FakeSam, square_frames, truth

from framepilot_smart_mask.crop_refine import (
    MIN_GAIN,
    corridor_px,
    crop_box,
    refine_in_crop,
    refined_masks,
)


def _mask(height: int, width: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    mask = np.zeros((height, width), bool)
    mask[y0:y1, x0:x1] = True
    return mask


def test_small_subject_gets_a_padded_crop_inside_the_frame() -> None:
    box = crop_box(_mask(720, 1280, 600, 300, 700, 500))
    assert box is not None
    # The silhouette's box is inside the crop, with padding on every side.
    assert box.x0 < 600 and box.x1 > 700 and box.y0 < 300 and box.y1 > 500
    assert box.x0 >= 0 and box.x1 <= 1280 and box.y0 >= 0 and box.y1 <= 720
    assert box.width == box.height


def test_crop_near_the_frame_edge_is_shifted_inside() -> None:
    box = crop_box(_mask(720, 1280, 0, 0, 80, 120))
    assert box is not None
    assert box.x0 == 0 and box.y0 == 0


def test_large_subject_is_not_cropped() -> None:
    # A head-and-shoulders close-up already has enough logit cells.
    assert crop_box(_mask(720, 1280, 300, 100, 900, 720)) is None
    side = 720 / MIN_GAIN
    assert crop_box(_mask(720, 1280, 0, 0, int(side), int(side))) is None


def test_empty_or_tiny_subject_is_not_cropped() -> None:
    assert crop_box(np.zeros((90, 160), bool)) is None
    assert crop_box(_mask(90, 160, 10, 10, 15, 15)) is None


def test_crop_pass_is_prompted_with_the_first_pass_answer() -> None:
    frames = square_frames(1)
    exact = truth(1)[0]
    # A first pass that is one pixel short on the right: the crop pass recovers the square.
    prior = exact.copy()
    prior[:, np.nonzero(exact.any(axis=0))[0].max()] = False
    sam = FakeSam()
    estimate = refine_in_crop(sam, frames[0], prior)
    assert estimate is not None
    assert sam.encodes == 1
    assert estimate.agreement >= 0.85
    assert (estimate.mask == exact).mean() > 0.99


def test_crop_estimate_that_disagrees_is_discarded() -> None:
    frames = square_frames(1)
    # The "first pass" is somewhere else entirely: the crop finds no subject there.
    prior = np.zeros(frames.shape[1:3], bool)
    prior[60:80, 120:150] = True
    assert refine_in_crop(FakeSam(), frames[0], prior) is None


def test_crop_decides_only_the_edge_corridor() -> None:
    height, width = 180, 320
    first = _mask(height, width, 100, 50, 200, 130)
    # The crop moves the edge by 2 px (inside the corridor) and drops a far block (outside it).
    crop = _mask(height, width, 102, 50, 200, 130)
    crop[80:100, 140:160] = False
    (merged,) = refined_masks([first], crop)
    reach = corridor_px(height, width)
    assert reach >= 2
    assert not merged[90, 100] and not merged[90, 101]
    assert merged[90, 150], "a pixel far from the edge keeps the first pass"
    assert refined_masks([first], None)[0] is first
