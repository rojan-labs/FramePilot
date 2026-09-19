"""BR3.4: tiled BiRefNet refinement, tile choice by memory ceiling, consensus, band, score."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")

from framepilot_smart_mask.backend import BackendUnavailableError  # noqa: E402
from framepilot_smart_mask.consensus import consensus, edge_radius  # noqa: E402
from framepilot_smart_mask.refine import (  # noqa: E402
    GIB,
    blend_weight,
    choose_tile,
    matte_region,
    refine_frame,
    tiles_1d,
)


@dataclass
class ColourMatting:
    """Alpha = redness, so a correct pipeline reproduces the red subject exactly."""

    tile: int = 64
    provider: str = "cpu"
    calls: int = 0

    def predict(self, rgb: np.ndarray) -> np.ndarray:
        assert rgb.shape == (self.tile, self.tile, 3)
        self.calls += 1
        red = rgb[..., 0].astype(np.float32) - rgb[..., 1].astype(np.float32)
        return np.clip(red / 150.0, 0.0, 1.0)

    def close(self) -> None:
        pass


def test_tile_choice_follows_the_memory_ceiling() -> None:
    installed = (768, 1024, 2048)
    assert choose_tile(installed, 8 * GIB).size == 1024
    assert choose_tile(installed, 16 * GIB).size == 2048
    assert choose_tile(installed, 5 * GIB).size == 768
    choice = choose_tile(installed, 8 * GIB, configured=768)
    assert (choice.size, choice.reason) == (768, "configured")
    assert choose_tile(installed, 8 * GIB).as_json()["reason"].startswith("largest")
    with pytest.raises(BackendUnavailableError, match="minimum hardware"):
        choose_tile(installed, 4 * GIB)
    with pytest.raises(BackendUnavailableError, match="not installed"):
        choose_tile((768,), 16 * GIB, configured=2048)


def test_tiles_cover_and_blend_to_unity() -> None:
    assert tiles_1d(100, 64, 8) == [0, 36]
    assert tiles_1d(64, 64, 8) == [0]
    starts = tiles_1d(300, 64, 8)
    covered = np.zeros(300, int)
    for start in starts:
        covered[start : start + 64] += 1
    assert covered.min() >= 1
    weight = blend_weight(64, 8)
    assert weight.shape == (64, 64) and weight.max() == 1.0 and weight.min() > 0


def test_large_crops_are_tiled_at_full_resolution_without_seams() -> None:
    model = ColourMatting(tile=64)
    crop = np.full((200, 200, 3), 90, np.uint8)
    crop[40:160, 30:170] = (220, 30, 30)
    alpha, mode, passes = matte_region(model, crop)
    assert mode == "tiled" and passes == len(tiles_1d(200, 64, 8)) ** 2
    expected = np.zeros((200, 200), np.float32)
    expected[40:160, 30:170] = 1.0
    assert np.abs(alpha - expected).max() < 1e-5
    small = crop[:90, :90]
    _, mode, passes = matte_region(model, small)
    assert (mode, passes) == ("resized", 1)


def test_refinement_is_gated_to_the_sam_subject() -> None:
    frame = np.full((180, 320, 3), 90, np.uint8)
    frame[40:120, 40:100] = (220, 30, 30)  # the subject
    frame[40:120, 240:300] = (220, 30, 30)  # a second red object SAM did not pick
    sam = np.zeros((180, 320), bool)
    sam[40:120, 40:100] = True
    alpha, record = refine_frame(ColourMatting(tile=128), frame, sam)
    assert record.mode in ("resized", "tiled")
    assert alpha[80, 70] == 255
    assert alpha[:, 200:].max() == 0, "BiRefNet cannot switch or add subjects"
    empty, record = refine_frame(ColourMatting(), frame, np.zeros_like(sam))
    assert record.mode == "empty" and empty.max() == 0


def body(height: int = 180, width: int = 320) -> np.ndarray:
    mask = np.zeros((height, width), bool)
    mask[40:160, 120:170] = True  # torso
    mask[60:80, 170:230] = True  # arm
    return mask


def test_consensus_keeps_what_birefnet_drops_and_measures_it() -> None:
    sam = body()
    birefnet_mask = sam.copy()
    birefnet_mask[60:80, 175:230] = False  # BiRefNet lost most of the arm
    birefnet = np.where(birefnet_mask, 255, 0).astype(np.uint8)
    result = consensus([sam, sam.copy()], None, birefnet, None, edge_radius(180))
    binarised = result.alpha >= 128
    iou = np.logical_and(binarised, sam).sum() / np.logical_or(binarised, sam).sum()
    assert iou > 0.95, "BR0's failure: the final matte must not simply become BiRefNet's mask"
    assert result.score["samPairIoU"] == 1.0
    assert result.score["hardDisagreementFraction"] > 0.05
    assert result.score["score"] > 0.05
    assert not result.band[70, 205], (
        "the arm's interior is decided by the vote, not handed to BiRefNet"
    )


def test_band_is_a_ring_and_outside_it_alpha_is_exact() -> None:
    sam = body()
    soft = np.where(sam, 255, 0).astype(np.uint8)
    soft = cv2.GaussianBlur(soft, (7, 7), 2)
    result = consensus([sam, sam], None, soft, None, 3)
    outside = ~result.band
    assert set(np.unique(result.alpha[outside]).tolist()) <= {0, 255}
    inside = result.band
    assert ((result.alpha[inside] > 0) & (result.alpha[inside] < 255)).any(), (
        "the band carries fractional alpha"
    )
    assert result.score["score"] < 0.02


def test_ties_break_on_sam_logits_and_the_warped_previous_frame_votes() -> None:
    sam = body()
    birefnet = np.zeros((180, 320), np.uint8)
    logits = np.where(sam, 5.0, -5.0).astype(np.float32)
    tie = consensus([sam], logits, birefnet, None, 3)
    assert tie.majority[100, 140], "one SAM vs BiRefNet ties; SAM's logits decide"
    previous = np.where(sam, 255.0, 0.0).astype(np.float32)
    three = consensus([sam], None, birefnet, previous, 3)
    assert three.majority[100, 140] and three.score["estimates"] == 3.0


def test_an_edge_stroke_joins_the_band_and_takes_only_matted_alpha() -> None:
    """BR6.10: the Edge brush widens the band; alpha there is BiRefNet's, never the stroke's."""
    sam = body()
    soft = cv2.GaussianBlur(np.where(sam, 255, 0).astype(np.uint8), (31, 31), 9)
    plain = consensus([sam, sam], None, soft, None, 2)
    stroke = np.zeros_like(sam)
    stroke[:, 150:200] = True  # a vertical swipe across the subject's edges and the background
    widened = consensus([sam, sam], None, soft, None, 2, extra_band=stroke)
    assert (widened.band >= plain.band).all() and widened.band[stroke].all()
    added = stroke & ~plain.band
    fractional = added & (soft > 0) & (soft < 255)
    assert fractional.any(), "the swipe reaches soft pixels the default ring missed"
    assert np.array_equal(widened.alpha[fractional], soft[fractional]), "re-matted there"
    # Where BiRefNet is exact the vote's value stands: the stroke never invents alpha.
    exact = added & ((soft == 0) | (soft == 255))
    assert set(np.unique(widened.alpha[exact]).tolist()) <= {0, 255}
    assert np.array_equal(widened.majority, plain.majority), "the silhouette vote is unchanged"
    # Outside the stroke nothing moved.
    assert np.array_equal(widened.alpha[~stroke], plain.alpha[~stroke])


def test_birefnet_sets_the_edge_only_on_frames_where_its_boundary_agrees() -> None:
    """BR7.4: SAM's coarse edge is 2 px outside the subject; BiRefNet's is exact."""
    height, width = 720, 1280
    truth = np.zeros((height, width), bool)
    truth[200:600, 500:700] = True
    coarse = cv2.dilate(truth.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    exact = np.where(truth, 255, 0).astype(np.uint8)
    result = consensus([coarse, coarse], None, exact, None, edge_radius(height))
    assert result.score["edgeTrusted"] == 1.0
    assert np.array_equal(result.majority, truth), "the corridor takes BiRefNet's edge"
    # BiRefNet matting a background slab beside the subject disagrees on a whole boundary side.
    wrong = exact.copy()
    wrong[200:600, 700:900] = 255
    untrusted = consensus([coarse, coarse], None, wrong, None, edge_radius(height))
    assert untrusted.score["edgeTrusted"] == 0.0
    assert np.array_equal(untrusted.majority, coarse), "SAM's silhouette and edge stand"
    assert set(np.unique(untrusted.alpha).tolist()) <= {0, 255}, "no soft edge in the wrong place"


def test_birefnet_never_votes_on_topology() -> None:
    sam = body()
    birefnet = np.where(sam, 255, 0).astype(np.uint8)
    birefnet[100:140, 20:60] = 255  # an island far from the subject
    result = consensus([sam, sam], None, birefnet, None, edge_radius(180))
    assert not result.majority[120, 40]
    assert result.score["hardDisagreementFraction"] > 0, "but the disagreement is measured"


def test_sam_masks_snap_to_the_image_edge() -> None:
    from framepilot_smart_mask.consensus import snap_to_image

    frame = np.full((720, 1280, 3), 40, np.uint8)
    frame[200:600, 500:700] = (220, 190, 160)  # the subject, on a contrasting background
    truth = np.zeros((720, 1280), bool)
    truth[200:600, 500:700] = True
    coarse = cv2.dilate(truth.astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    (snapped,) = snap_to_image([coarse], frame)
    wrong_before = int((coarse ^ truth).sum())
    wrong_after = int((snapped ^ truth).sum())
    assert wrong_after < wrong_before // 3, (wrong_before, wrong_after)
    assert snap_to_image([], frame) == []


def test_an_untrusted_edge_gets_a_soft_band_that_binarises_as_the_silhouette() -> None:
    from framepilot_smart_mask.consensus import soft_edge

    height, width = 720, 1280
    frame = np.full((height, width, 3), 40, np.uint8)
    frame[200:600, 500:700] = (220, 190, 160)
    truth = np.zeros((height, width), bool)
    truth[200:600, 500:700] = True
    wrong = np.where(truth, 255, 0).astype(np.uint8)
    wrong[200:600, 700:900] = 255  # BiRefNet disagrees on a whole side: not trusted
    result = consensus([truth, truth], None, wrong, None, edge_radius(height))
    assert result.score["edgeTrusted"] == 0.0
    soft = soft_edge(result, frame)
    assert np.array_equal(soft >= 128, result.majority), "IoU and BF are unchanged"
    assert ((soft[result.band] > 0) & (soft[result.band] < 255)).any(), "the edge is soft"
    assert np.array_equal(soft[~result.band], result.alpha[~result.band])
    stroke = np.zeros_like(truth)
    stroke[:, 690:710] = True
    kept = soft_edge(result, frame, stroke)
    assert np.array_equal(kept[stroke], result.alpha[stroke]), (
        "an Edge brush stroke is not overwritten"
    )
    trusted = consensus([truth, truth], None, np.where(truth, 255, 0).astype(np.uint8), None, 4)
    assert soft_edge(trusted, frame) is trusted.alpha
