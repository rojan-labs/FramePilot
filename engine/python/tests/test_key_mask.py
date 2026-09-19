"""MK6.1: the ``key`` mask kind — the qualifier, the four models, shadow retention and despill.

The numbers here are the contract the preview shader is written against
(``preview/masks/key-mask.ts`` and its GLSL twin), so a change to any formula fails on this side
first and the shader has to follow.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from framepilot_engine.render.key_mask import (
    despill,
    key_alpha,
    luma_of,
    to_unit_rgb,
)
from framepilot_engine.render.mask_stack import key_mask_alpha
from framepilot_engine.timeline.models import KeyMask

PURE_GREEN = (0, 255, 0)
DARK_GREEN = (0, 40, 0)
SKIN = (222, 170, 135)
GREY = (128, 128, 128)
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)


def _key(**fields: Any) -> Any:
    """A parsed ``key`` mask layer with the given fields."""
    return KeyMask.model_validate({"id": "k1", "kind": "key", **fields})


def _picture(*colours: tuple[int, int, int]) -> np.ndarray:
    """A 1 x N picture of the given colours, so an alpha row reads as a list."""
    return np.array([list(colours)], dtype=np.uint8)


def _alpha(mask: Any, *colours: tuple[int, int, int]) -> list[float]:
    return [float(value) for value in key_alpha(mask, _picture(*colours))[0]]


class TestModels:
    def test_hue_range_selects_the_backing_and_keeps_skin(self) -> None:
        mask = _key(
            model="hsl",
            ranges=[
                {"channel": "hue", "low": 0.25, "high": 0.45, "softness": 0.02},
                {"channel": "saturation", "low": 0.3, "high": 1.0, "softness": 0.05},
            ],
        )
        green, skin, grey = _alpha(mask, PURE_GREEN, SKIN, GREY)
        assert green == 1.0
        assert skin == 0.0
        assert grey == 0.0

    def test_hue_range_wraps_through_red(self) -> None:
        mask = _key(
            model="hsl",
            ranges=[{"channel": "hue", "low": 0.95, "high": 0.05, "softness": 0.0}],
        )
        # Hue 0 (pure red) is inside a range that runs 0.95 -> 0.05; hue 1/3 (green) is not.
        red, green = _alpha(mask, (255, 0, 0), PURE_GREEN)
        assert red == 1.0
        assert green == 0.0

    def test_rgb_model_qualifies_each_channel(self) -> None:
        mask = _key(
            model="rgb",
            ranges=[
                {"channel": "red", "low": 0.0, "high": 0.2},
                {"channel": "green", "low": 0.8, "high": 1.0},
                {"channel": "blue", "low": 0.0, "high": 0.2},
            ],
        )
        green, skin = _alpha(mask, PURE_GREEN, SKIN)
        assert green == 1.0
        assert skin == 0.0

    def test_luma_model_selects_a_brightness_band(self) -> None:
        mask = _key(model="luma", ranges=[{"channel": "luma", "low": 0.9, "high": 1.0}])
        white, grey, black = _alpha(mask, WHITE, GREY, BLACK)
        assert white == 1.0
        assert grey == 0.0
        assert black == 0.0

    def test_3d_model_is_a_tolerance_sphere_round_each_sample(self) -> None:
        mask = _key(model="3d", samples3d=[[0.0, 1.0, 0.0]], softness=0.2)
        exact, near, far = _alpha(mask, PURE_GREEN, (0, 230, 20), SKIN)
        assert exact == 1.0
        assert 0.0 < near < 1.0 or near == 1.0
        assert far == 0.0

    def test_3d_samples_union_rather_than_intersect(self) -> None:
        mask = _key(model="3d", samples3d=[[0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], softness=0.1)
        green, blue, red = _alpha(mask, PURE_GREEN, (0, 0, 255), (255, 0, 0))
        assert green == 1.0
        assert blue == 1.0
        assert red == 0.0

    def test_an_unfinished_key_qualifies_nothing(self) -> None:
        """An empty qualifier is a mask mid-edit; matching everything would hide that."""
        assert _alpha(_key(model="hsl"), PURE_GREEN, SKIN) == [0.0, 0.0]
        assert _alpha(_key(model="3d"), PURE_GREEN, SKIN) == [0.0, 0.0]


class TestSoftness:
    def test_softness_ramps_smoothly_out_of_the_range(self) -> None:
        mask = _key(
            model="luma", ranges=[{"channel": "luma", "low": 0.5, "high": 1.0, "softness": 0.25}]
        )
        rgb = to_unit_rgb(_picture(GREY))
        inside = float(luma_of(rgb)[0, 0])
        assert inside == pytest.approx(0.50196, abs=1e-4)
        values = _alpha(mask, GREY, (96, 96, 96), (64, 64, 64), (16, 16, 16))
        assert values[0] == 1.0
        assert 0.0 < values[1] < 1.0
        assert 0.0 < values[2] < values[1]
        assert values[3] == 0.0

    def test_the_masks_own_softness_widens_every_range(self) -> None:
        tight = _key(model="luma", ranges=[{"channel": "luma", "low": 0.9, "high": 1.0}])
        wide = _key(
            model="luma",
            ranges=[{"channel": "luma", "low": 0.9, "high": 1.0}],
            softness=0.4,
        )
        assert _alpha(tight, GREY)[0] == 0.0
        assert _alpha(wide, GREY)[0] > 0.0


class TestShadowRetention:
    def test_dark_pixels_come_back_out_of_the_key(self) -> None:
        ranges = [{"channel": "hue", "low": 0.25, "high": 0.45, "softness": 0.05}]
        plain = _key(model="hsl", ranges=ranges)
        kept = _key(model="hsl", ranges=ranges, shadowRetention=0.3)
        assert _alpha(plain, DARK_GREEN)[0] == 1.0
        assert _alpha(kept, DARK_GREEN)[0] < 1.0
        # A bright backing pixel is untouched by shadow retention.
        assert _alpha(kept, PURE_GREEN)[0] == 1.0


class TestCleanLevels:
    def test_clean_black_and_white_crush_the_soft_band(self) -> None:
        ranges = [{"channel": "luma", "low": 0.9, "high": 1.0, "softness": 0.6}]
        soft = _key(model="luma", ranges=ranges)
        crushed = _key(
            model="luma",
            ranges=ranges,
            finesse={"cleanBlack": 0.3, "cleanWhite": 0.7},
        )
        picture = _picture(GREY)
        before = float(key_mask_alpha(soft, picture, 0.0)[0, 0])
        after = float(key_mask_alpha(crushed, picture, 0.0)[0, 0])
        assert 0.0 < before < 1.0
        assert after != before
        assert 0.0 <= after <= 1.0


class TestDespill:
    def test_green_despill_caps_green_at_the_average_of_red_and_blue(self) -> None:
        out = despill(_picture((40, 200, 60)), "green")
        assert list(out[0, 0]) == [40, 50, 60]

    def test_blue_despill_caps_blue(self) -> None:
        out = despill(_picture((40, 60, 200)), "blue")
        assert list(out[0, 0]) == [40, 60, 50]

    def test_a_pixel_below_the_limit_is_untouched(self) -> None:
        picture = _picture((200, 40, 100))
        assert np.array_equal(despill(picture, "green"), picture)

    def test_none_is_the_identity(self) -> None:
        picture = _picture((40, 200, 60))
        assert np.array_equal(despill(picture, "none"), picture)
