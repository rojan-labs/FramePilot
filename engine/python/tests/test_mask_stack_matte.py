"""The ``matte`` mask kind in the stack (BR2.2): edge rules, decontamination, base stack rules."""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from framepilot_engine.render import matte_edges
from framepilot_engine.render.mask_stack import (
    MaskStackRefusal,
    assert_renderable,
    clip_mask_stacks,
    mask_alpha,
    stack_alpha,
)
from framepilot_engine.render.mattes import MatteFrame
from framepilot_engine.timeline.models import Clip, MatteMask

W, H = 16, 12
ARTIFACT = {
    "key": "b" * 64,
    "files": [],
    "width": W,
    "height": H,
    "coverage": {"sourceStart": 0.0, "sourceEnd": 1.0},
    "packId": "p",
    "packVersion": "1",
    "modelDigests": [],
}


def _matte(**extra: Any) -> MatteMask:
    return MatteMask.model_validate({"id": "m", "artifact": ARTIFACT, **extra})


def _clip(masks: list[Any] | None = None, **extra: Any) -> Clip:
    return Clip.model_validate(
        {
            "id": "c",
            "assetId": "a",
            "trackId": "v",
            "start": 0.0,
            "end": 1.0,
            "sourceStart": 0.0,
            "sourceEnd": 1.0,
            "masks": masks or [],
            **extra,
        }
    )


def _disk(radius: float = 3.5, soft: bool = False) -> np.ndarray:
    ys, xs = np.mgrid[0:H, 0:W]
    distance = np.sqrt((xs - 7.5) ** 2 + (ys - 5.5) ** 2)
    if soft:
        smooth: np.ndarray = np.clip(np.rint((radius + 1.0 - distance) * 127.5), 0, 255)
        return smooth.astype(np.uint8)
    hard: np.ndarray = np.where(distance <= radius, 255, 0)
    return hard.astype(np.uint8)


def _frame(alpha: np.ndarray, foreground: np.ndarray | None = None) -> MatteFrame:
    return MatteFrame(index=0, alpha=alpha, maximum=255, foreground=foreground)


# --- Edge shift: exact grey morphology by a disc -------------------------------------------


def _brute_morphology(values: np.ndarray, radius: int, grow: bool) -> np.ndarray:
    height, width = values.shape
    out = values.copy()
    for y in range(height):
        for x in range(width):
            picked = int(values[y, x])
            for dy in range(-radius, radius + 1):
                for dx in range(-radius, radius + 1):
                    if dx * dx + dy * dy > radius * radius:
                        continue
                    sample = int(
                        values[min(max(y + dy, 0), height - 1), min(max(x + dx, 0), width - 1)]
                    )
                    picked = max(picked, sample) if grow else min(picked, sample)
            out[y, x] = picked
    return out


@pytest.mark.parametrize("radius", [1, 2, 3, 5])
@pytest.mark.parametrize("grow", [True, False])
def test_disc_morphology_matches_brute_force(radius: int, grow: bool) -> None:
    values = np.random.default_rng(7 + radius).integers(0, 256, size=(9, 11)).astype(np.uint8)
    actual = matte_edges._disc_morphology(values, radius, grow)
    assert np.array_equal(actual, _brute_morphology(values, radius, grow))


def test_edge_shift_grows_shrinks_and_mixes_fractions() -> None:
    disk = _disk()
    assert np.array_equal(matte_edges.edge_shift(disk, 255, 0.0), disk / 255.0)
    grown = matte_edges.edge_shift(disk, 255, 2.0)
    shrunk = matte_edges.edge_shift(disk, 255, -2.0)
    assert grown.sum() > disk.sum() / 255.0 > shrunk.sum()
    half = matte_edges.edge_shift(disk, 255, 1.5)
    one = matte_edges.edge_shift(disk, 255, 1.0)
    two = matte_edges.edge_shift(disk, 255, 2.0)
    assert np.array_equal(half, one + (two - one) * 0.5)


# --- Clean levels and edge mode ------------------------------------------------------------


def test_edge_mode_maps_onto_finesse_clean_levels() -> None:
    assert matte_edges.clean_levels(_matte()) == (0.0, 1.0)
    assert matte_edges.clean_levels(_matte(edgeMode="sharp")) == (0.25, 0.75)
    explicit = _matte(edgeMode="sharp", finesse={"cleanBlack": 0.1, "cleanWhite": 0.9})
    assert matte_edges.clean_levels(explicit) == (0.1, 0.9)
    alpha = np.array([[0.0, 0.25, 0.5, 0.75, 1.0]])
    assert matte_edges.apply_clean_levels(alpha, 0.0, 1.0) is alpha
    assert matte_edges.apply_clean_levels(alpha, 0.25, 0.75).tolist() == [[0, 0, 0.5, 1, 1]]
    assert matte_edges.apply_clean_levels(alpha, 0.5, 0.5).tolist() == [[0, 0, 1, 1, 1]]


# --- Distance feather ----------------------------------------------------------------------


def test_bounded_distance_is_exact_euclidean_up_to_the_cap() -> None:
    features = np.random.default_rng(3).random((10, 13)) < 0.08
    cap = 4
    actual = matte_edges._bounded_distance(features, cap)
    points = np.argwhere(features)
    for y in range(10):
        for x in range(13):
            best = min(float((py - y) ** 2 + (px - x) ** 2) for py, px in points)
            assert actual[y, x] == np.sqrt(min(best, cap * cap))


def test_distance_feather_redraws_the_contour() -> None:
    alpha = _disk() / 255.0
    assert (
        matte_edges.distance_feather(
            alpha, expansion=0, feather_inner=0, feather_outer=0, falloff="linear"
        )
        is alpha
    )
    hard = matte_edges.distance_feather(
        alpha, expansion=0.0001, feather_inner=0, feather_outer=0, falloff="linear"
    )
    # A zero-width feather is the rasteriser's one-pixel linear edge: a hard disk stays hard.
    assert float(np.abs(hard - alpha).max()) <= 0.0001 + 1e-12
    expanded = matte_edges.distance_feather(
        alpha, expansion=2, feather_inner=0, feather_outer=0, falloff="linear"
    )
    assert expanded.sum() > alpha.sum()
    feathered = matte_edges.distance_feather(
        alpha, expansion=0, feather_inner=0, feather_outer=3, falloff="smooth"
    )
    fractional = (feathered > 0) & (feathered < 1)
    assert fractional.any()
    assert bool(np.all(feathered[alpha == 1.0] == 1.0))


# --- Mapping to the frame and decontamination ----------------------------------------------


def test_to_frame_crops_like_moviepy_and_resamples() -> None:
    plane = np.arange(W * H, dtype=np.float64).reshape(H, W)
    assert np.array_equal(matte_edges.to_frame(plane, _clip(), W, H), plane)
    cropped = _clip(crop={"x": 0.25, "y": 0.5, "width": 0.5, "height": 0.5})
    assert np.array_equal(matte_edges.to_frame(plane, cropped, 8, 6), plane[6:12, 4:12])
    halved = matte_edges.to_frame(plane, _clip(), 8, 6, ceiling=255.0)
    assert halved.shape == (6, 8)
    assert np.array_equal(halved, matte_edges.resample(plane, 8, 6, 255.0))
    # Decoded at half size, then cropped: the plane takes the picture's path.
    decoded = matte_edges.to_frame(plane, cropped, 4, 3, decoded_size=(8, 6), ceiling=255.0)
    assert np.array_equal(decoded, matte_edges.resample(plane, 8, 6, 255.0)[3:6, 2:6])


def test_decontamination_replaces_only_the_soft_band() -> None:
    alpha = np.zeros((H, W), dtype=np.uint8)
    alpha[:, 8:] = 255
    alpha[:, 7] = 128
    picture = np.full((H, W, 3), 30, dtype=np.uint8)
    foreground = np.zeros((H, W, 3), dtype=np.uint8)
    foreground[:, 7] = (220, 100, 10)
    cleaned = matte_edges.decontaminate(picture, alpha, 255, foreground, _clip())
    assert cleaned[:, 7].tolist() == [[220, 100, 10]] * H
    assert bool(np.all(cleaned[:, :7] == 30)) and bool(np.all(cleaned[:, 8:] == 30))


# --- In the stack --------------------------------------------------------------------------


def test_a_plain_matte_is_its_stored_alpha() -> None:
    soft = _disk(soft=True)
    mask = _matte(decontaminate=False)
    alpha = mask_alpha(mask, _clip(), (W, H), W, H, 0.0, lambda _mask: _frame(soft))
    assert np.array_equal(alpha, soft / 255.0)
    stacked = stack_alpha([mask], _clip(), (W, H), W, H, 0.0, lambda _mask: _frame(soft))
    assert np.array_equal(np.rint(stacked * 255).astype(np.uint8), soft)


def test_matte_takes_invert_opacity_and_modes_like_any_kind() -> None:
    disk = _disk()
    inverted = mask_alpha(
        _matte(invert=True, opacity=0.5), _clip(), (W, H), W, H, 0.0, lambda _m: _frame(disk)
    )
    assert np.array_equal(inverted, (1.0 - disk / 255.0) * 0.5)
    subtract_rect = {
        "kind": "rectangle",
        "id": "r",
        "cx": 4,
        "cy": 6,
        "width": 8,
        "height": 12,
        "mode": "subtract",
    }
    clip = _clip([_matte().model_dump(by_alias=True), subtract_rect])
    stacks = clip_mask_stacks(clip, (W, H), {"m": lambda _t: _frame(disk)})
    assert stacks is not None
    result = stacks.alpha_at(0.0, W, H)
    assert result is not None
    assert bool(np.all(result[:, :8] == 0.0))
    assert np.array_equal(result[:, 8:], disk[:, 8:] / 255.0)


def test_matte_keyframed_edge_shift_reads_the_source_clock() -> None:
    disk = _disk()
    mask = _matte(
        keyframes=[
            {"id": "a", "sourceTime": 0.0, "property": "edgeShiftPx", "value": 0},
            {"id": "b", "sourceTime": 1.0, "property": "edgeShiftPx", "value": 2},
        ]
    )
    at_start = mask_alpha(mask, _clip(), (W, H), W, H, 0.0, lambda _m: _frame(disk))
    at_end = mask_alpha(mask, _clip(), (W, H), W, H, 1.0, lambda _m: _frame(disk))
    assert np.array_equal(at_start, disk / 255.0)
    assert np.array_equal(at_end, matte_edges.edge_shift(disk, 255, 2.0))


def test_matte_refusals_before_rendering() -> None:
    assert_renderable(_matte(), _clip(), frozenset())
    with pytest.raises(MaskStackRefusal, match="finesse"):
        assert_renderable(_matte(finesse={"denoise": 0.2}), _clip(), frozenset())
    with pytest.raises(MaskStackRefusal, match="Distance"):
        assert_renderable(_matte(featherModel="gaussian-legacy"), _clip(), frozenset())
    unbound = clip_mask_stacks(_clip([_matte().model_dump(by_alias=True)]), (W, H))
    assert unbound is not None
    with pytest.raises(MaskStackRefusal, match="no decoded frames"):
        unbound.alpha_at(0.0, W, H)
    assert unbound.alpha_animated
