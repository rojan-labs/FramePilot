"""MK6.2: the matte finesse group — what each control does, and that the order is the one
the docstring promises.

These are the numbers the TypeScript twin (`preview/masks/matte-edges.ts`) is asserted against,
so a change to any formula fails here first.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.matte_edges import (
    apply_finesse,
    blur,
    denoise,
    finesse_is_identity,
    in_out_ratio,
    morph_close,
    morph_open,
    shrink_grow,
)
from framepilot_engine.timeline.models import MaskFinesse


def _speckled() -> np.ndarray:
    """A solid block with a pinhole inside it and a speck outside it."""
    alpha = np.zeros((16, 16), dtype=np.float64)
    alpha[4:12, 4:12] = 1.0
    alpha[7, 7] = 0.0  # pinhole
    alpha[0, 15] = 1.0  # speck, far enough from the block that a blur cannot reach it
    return alpha


def _finesse(**fields: Any) -> MaskFinesse:
    return MaskFinesse.model_validate(fields)


class TestControls:
    def test_denoise_blends_toward_the_3x3_mean_and_nothing_at_zero(self) -> None:
        alpha = _speckled()
        assert np.array_equal(denoise(alpha, 0.0), alpha)
        softened = denoise(alpha, 1.0)
        # The pinhole fills to eight ninths. The speck sits in a corner, where the replicated
        # edge counts it four times — which is the same rule the morphology uses.
        assert softened[0, 15] == pytest.approx(4.0 / 9.0)
        assert softened[7, 7] == pytest.approx(8.0 / 9.0)

    def test_open_deletes_the_speck_and_keeps_the_pinhole(self) -> None:
        opened = morph_open(_speckled(), 1.0)
        assert opened[0, 15] == 0.0
        assert opened[7, 7] == 0.0
        assert opened[8, 8] == 1.0

    def test_close_fills_the_pinhole_and_keeps_the_speck(self) -> None:
        closed = morph_close(_speckled(), 1.0)
        assert closed[7, 7] == 1.0
        assert closed[0, 15] == 1.0

    def test_shrink_grow_moves_the_whole_edge_both_ways(self) -> None:
        alpha = np.zeros((16, 16), dtype=np.float64)
        alpha[4:12, 4:12] = 1.0
        assert shrink_grow(alpha, 1.0).sum() > alpha.sum()
        assert shrink_grow(alpha, -1.0).sum() < alpha.sum()
        assert np.array_equal(shrink_grow(alpha, 0.0), alpha)

    def test_blur_softens_an_edge_without_moving_its_midpoint(self) -> None:
        alpha = np.zeros((16, 32), dtype=np.float64)
        alpha[:, :16] = 1.0
        softened = blur(alpha, 3.0)
        assert 0.0 < softened[8, 17] < 1.0
        # The crossing stays between the last opaque column and the first clear one.
        assert softened[8, 15] > 0.5 > softened[8, 16]

    def test_in_out_ratio_moves_the_crossing_and_keeps_the_ends(self) -> None:
        ramp = np.array([[0.0, 0.25, 0.5, 0.75, 1.0]])
        out = in_out_ratio(ramp, 0.5)
        assert out[0, 0] == 0.0
        assert out[0, 4] == 1.0
        assert out[0, 1] == pytest.approx(0.5)  # the new midpoint sits at 0.25
        inward = in_out_ratio(ramp, -0.5)
        assert inward[0, 3] == pytest.approx(0.5)
        assert np.array_equal(in_out_ratio(ramp, 0.0), ramp)


class TestChain:
    def test_identity_when_nothing_is_set(self) -> None:
        alpha = _speckled()
        finesse = _finesse()
        assert finesse_is_identity(finesse, (0.0, 1.0))
        assert np.array_equal(apply_finesse(alpha, finesse, (0.0, 1.0)), alpha)

    def test_clean_levels_are_not_identity(self) -> None:
        assert not finesse_is_identity(_finesse(), (0.25, 0.75))

    def test_open_runs_before_blur_so_the_speck_is_gone_not_smeared(self) -> None:
        cleaned = apply_finesse(_speckled(), _finesse(morphOpenPx=1.0, blurPx=3.0), (0.0, 1.0))
        # Blurring first would leave a faint halo where the speck was; the block's own halo
        # cannot reach this corner, so anything here would be the speck smeared.
        assert cleaned[0:2, 14:16].max() == pytest.approx(0.0, abs=1e-12)

    def test_the_group_stays_inside_zero_and_one(self) -> None:
        result = apply_finesse(
            _speckled(),
            _finesse(
                denoise=0.5,
                morphOpenPx=1.0,
                morphClosePx=1.0,
                shrinkGrowPx=1.5,
                blurPx=4.0,
                inOutRatio=0.6,
            ),
            (0.2, 0.8),
        )
        assert result.min() >= 0.0
        assert result.max() <= 1.0
