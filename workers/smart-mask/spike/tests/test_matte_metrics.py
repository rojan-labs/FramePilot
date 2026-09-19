import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import matte_metrics as mm  # noqa: E402


def square(h=64, w=64, y0=16, x0=16, s=32):
    m = np.zeros((h, w), bool)
    m[y0 : y0 + s, x0 : x0 + s] = True
    return m


def test_iou_identical_and_disjoint():
    a = square()
    assert mm.iou(a, a) == 1.0
    assert mm.iou(a, np.zeros_like(a)) == 0.0
    assert mm.iou(np.zeros_like(a), np.zeros_like(a)) == 1.0


def test_boundary_f_tolerates_small_shift_only():
    a = square()
    assert mm.boundary_f(a, square(x0=18)) == pytest.approx(1.0)  # 2 px shift is within tol
    assert mm.boundary_f(a, square(x0=22)) < 0.95


def test_frame_is_wrong_thresholds():
    gt = (square(256, 256, 64, 64, 128)).astype(np.float32)
    wrong, i, bf = mm.frame_is_wrong(gt, gt)
    assert not wrong and i == 1.0 and bf == 1.0
    shifted = np.roll(gt, 6, axis=1)
    wrong, i, _ = mm.frame_is_wrong(shifted, gt)
    assert wrong and i < mm.WRONG_IOU


def test_binarise_uint8_and_float():
    assert mm.binarise(np.array([127, 128], np.uint8)).tolist() == [False, True]
    assert mm.binarise(np.array([0.49, 0.5], np.float32)).tolist() == [False, True]


def test_unknown_band_contains_disagreement_and_edges():
    a, b = square(), square(x0=20)
    band = mm.unknown_band([a, b], edge_radius=1)
    assert band[a ^ b].all()
    assert not band[0, 0] and not band[32, 32]  # far background, deep interior


def test_consensus_is_exact_outside_band():
    a = square()
    band = mm.unknown_band([a, a], edge_radius=2)
    alpha = mm.consensus_alpha([a, a], band, np.full(a.shape, 0.3, np.float32))
    assert set(np.unique(alpha[~band])) <= {0.0, 1.0}
    assert np.allclose(alpha[band], 0.3)


def test_wilson_lower_bound():
    assert mm.wilson_lower(200, 200) < 1.0
    assert mm.wilson_lower(200, 200) > 0.98
    assert mm.wilson_lower(0, 10) == pytest.approx(0.0, abs=1e-12)


def test_tiles_cover_and_weights_partition():
    starts = mm.tiles_1d(3840, 2048, 256)
    assert starts[0] == 0 and starts[-1] + 2048 == 3840
    assert all(b - a <= 2048 - 256 for a, b in zip(starts, starts[1:]))
    acc = np.zeros(3840, np.float32)
    w = mm.blend_weight(2048, 256)[1024]
    for s in starts:
        acc[s : s + 2048] += w
    covered = acc[256:-256]
    assert covered.min() > 0
