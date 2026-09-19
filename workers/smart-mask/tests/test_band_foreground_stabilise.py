"""BR3.6: full-resolution band alpha, foreground colour estimation, band-only stabilisation."""

from __future__ import annotations

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")

from test_refine_consensus import ColourMatting  # noqa: E402

from framepilot_smart_mask.foreground import estimate_foreground, foreground_frame  # noqa: E402
from framepilot_smart_mask.matting import band_alpha, tile_origins  # noqa: E402
from framepilot_smart_mask.refine import RefineRecord  # noqa: E402
from framepilot_smart_mask.stabilise import stabilise, temporal_vote  # noqa: E402


def test_tiles_cover_every_band_pixel() -> None:
    band = np.zeros((300, 500), bool)
    band[20:22, 10:490] = True
    band[250:260, 100:110] = True
    origins = tile_origins(band, 64)
    covered = np.zeros_like(band)
    for top, left in origins:
        covered[top : top + 64, left : left + 64] = True
    assert covered[band].all()
    # 480 px of a 2 px line needs ~480/(64-2*8) = 10 tiles minimum; greedy stays within 2.5x.
    assert len(origins) <= 25


def test_band_alpha_only_reruns_downscaled_crops_and_only_writes_the_band() -> None:
    frame = np.full((120, 200, 3), 90, np.uint8)
    frame[30:90, 50:150] = (220, 30, 30)
    alpha = np.where(frame[..., 0] > 150, 255, 0).astype(np.uint8)
    alpha[30:90, 49:52] = 17  # a wrong, low-resolution edge
    band = np.zeros((120, 200), bool)
    band[25:95, 46:54] = True
    tiled = RefineRecord((0, 0, 200, 200), "tiled", 4)
    untouched, passes = band_alpha(ColourMatting(tile=64), frame, alpha, band, tiled)
    assert passes == 0 and untouched is alpha
    upscaled = RefineRecord((0, 0, 60, 60), "resized", 1, tile=64)
    same, passes = band_alpha(ColourMatting(tile=64), frame, alpha, band, upscaled)
    assert passes == 0 and same is alpha, "a crop matted at or above source size is not redone"
    resized = RefineRecord((0, 0, 90, 90), "resized", 1, tile=64)
    fixed, passes = band_alpha(ColourMatting(tile=64), frame, alpha, band, resized)
    assert passes >= 1
    assert fixed[60, 50] == 255 and fixed[60, 49] == 0
    assert np.array_equal(fixed[~band], alpha[~band])


def test_foreground_estimate_recovers_the_true_colour_in_the_band() -> None:
    rng = np.random.default_rng(1)
    height, width = 48, 64
    true_fg = np.zeros((height, width, 3), np.float32)
    true_fg[:] = (0.9, 0.6, 0.2)
    background = rng.uniform(0, 1, (height, width, 3)).astype(np.float32)
    background = cv2.GaussianBlur(background, (9, 9), 3)
    alpha = np.zeros((height, width), np.float32)
    alpha[:, :24] = 1.0
    alpha[:, 24:40] = np.linspace(1.0, 0.0, 16, dtype=np.float32)
    image = alpha[..., None] * true_fg + (1 - alpha[..., None]) * background
    foreground, _ = estimate_foreground(image, alpha)
    soft = (alpha > 0.2) & (alpha < 0.95)
    naive_error = np.abs(image[soft] - true_fg[soft]).mean()
    estimated_error = np.abs(foreground[soft] - true_fg[soft]).mean()
    assert estimated_error < 0.35 * naive_error, (estimated_error, naive_error)


def test_foreground_frame_is_zero_outside_the_soft_band() -> None:
    frame = np.full((40, 60, 3), 128, np.uint8)
    alpha = np.zeros((40, 60), np.uint8)
    alpha[10:30, 10:30] = 255
    alpha[10:30, 30:34] = 120
    out = foreground_frame(frame, alpha)
    soft = (alpha > 0) & (alpha < 255)
    assert out[~soft].max() == 0 and out[soft].max() > 0
    assert foreground_frame(frame, np.zeros_like(alpha)).max() == 0


def _still(height: int, width: int, trust: float = 1.0):
    return lambda source, target: (
        np.zeros((height, width, 2), np.float32),
        np.full((height, width), trust, np.float32),
    )


def test_stabilisation_smooths_band_shimmer_with_trusted_neighbours_only() -> None:
    count, height, width = 5, 40, 60
    base = np.zeros((height, width), np.uint8)
    base[:, :30] = 255
    base[:, 30] = 128
    alphas = [base.copy() for _ in range(count)]
    alphas[2][:, 30] = 228  # a flicker on one frame's edge
    alphas[2][:, 10] = 200  # a wrong value outside the band must not move
    bands = [np.zeros((height, width), bool) for _ in range(count)]
    for band in bands:
        band[:, 29:32] = True
    fixed = [np.zeros((height, width), bool) for _ in range(count)]
    fixed[3][:, 30] = True  # a brushed pixel column
    out, changed = stabilise(alphas, bands, fixed, _still(height, width))
    # Frame 2 and its four trusted neighbours at 128: (228 + 4 * 128) / 5 = 148.
    assert out[2][20, 30] == 148, "the flicker moves to the trusted neighbours' mean"
    assert out[2][20, 10] == 200, "outside the band nothing changes"
    assert np.array_equal(out[3][:, 30], alphas[3][:, 30]), "brushed pixels never change"
    assert changed[2] > 0
    once, _ = stabilise(alphas, bands, fixed, _still(height, width))
    assert all(np.array_equal(a, b) for a, b in zip(out, once, strict=True)), "deterministic"
    untrusted, _ = stabilise(alphas, bands, fixed, _still(height, width, trust=0.0))
    assert untrusted[2][20, 30] == 228, "a neighbour whose warp cannot be trusted has no say"


def test_temporal_vote_fills_a_one_frame_dropout_only_where_the_motion_is_trusted() -> None:
    count, height, width = 5, 20, 30
    subject = np.zeros((height, width), np.float32)
    subject[5:15, 5:20] = 1.0
    dropped = subject.copy()
    dropped[5:15, 12:20] = 0.0  # one frame's estimate lost half the subject
    estimates = [subject, subject, dropped, subject, subject]
    fused = temporal_vote(2, count, lambda i: estimates[i], _still(height, width))
    assert fused is not None and fused[10, 15], "four trusted neighbours outvote one frame"
    alone = temporal_vote(2, count, lambda i: estimates[i], _still(height, width, trust=0.0))
    assert alone is not None and not alone[10, 15], "untrusted motion leaves the frame's own"
    assert (
        temporal_vote(2, count, lambda i: None if i == 2 else subject, _still(height, width))
        is None
    )
