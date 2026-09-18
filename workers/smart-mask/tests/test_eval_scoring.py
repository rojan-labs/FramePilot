"""The accuracy harness's scoring and held-out calibration (no weights, no media)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("cv2")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "eval"))

import run_eval  # noqa: E402

from framepilot_smart_mask.verify import Thresholds  # noqa: E402


def signal(pair: float, area: int = 1000) -> dict:
    return {
        "area": area, "cx": 10.0, "cy": 10.0, "rewarp": [0.0], "motionPx": 0.0, "islands": 1, "holes": 0,
        "edgeCorr": 0.9, "unexplainedEdges": 0.0, "samPairIoU": pair, "samBirefnetIoU": 1.0,
        "hardDisagreement": 0.0, "bandFrac": 0.1, "estimates": 4.0, "fwdScore": 5.0, "bwdScore": 5.0,
    }  # fmt: skip


def run(split: str, pairs: list[float], wrong: list[bool], category: str = "walk") -> dict:
    frames = [{"iou": 0.9 if bad else 0.99, "bf": 0.97, "wrong": bad, "checks": [], "signals": signal(p), "locked": False}
              for p, bad in zip(pairs, wrong, strict=True)]  # fmt: skip
    return {
        "name": f"{category}__{split}",
        "category": category,
        "split": split,
        "frames": frames,
        "seconds": 1.0,
        "job": {},
    }


def test_score_counts_recall_review_load_and_misses() -> None:
    thresholds = Thresholds(e_sam_pair_iou=0.95, a_rewarp_mismatch=None, c_edge_corr=None, c2_unexplained=None,
                            d_area_logratio=None, d_centroid_frac=None, e_sam_birefnet_iou=None, e_hard_disagreement=None,
                            e_band_frac=None)  # fmt: skip
    result = run_eval.score(
        [run("scored", [0.99, 0.9, 0.97, 0.99], [False, True, True, False])], thresholds
    )
    assert (result["wrongFrames"], result["caught"], result["flagged"]) == (2, 1, 1)
    assert result["recall"] == 0.5 and result["reviewLoad"] == 0.25
    assert result["missed"] == [{"clip": "walk__scored", "frame": 2, "iou": 0.9, "bf": 0.97}]
    assert run_eval.wilson_lower(199, 200) is not None and run_eval.wilson_lower(199, 200) < 0.995


def test_calibration_fits_on_the_calibration_split_only() -> None:
    calibration = [
        run(
            "calibration",
            [0.99, 0.97, 0.99, 0.96, 0.99, 0.99],
            [False, True, False, True, False, False],
        )
    ]
    start = Thresholds(e_sam_pair_iou=None, a_rewarp_mismatch=None, c_edge_corr=None, c2_unexplained=None,
                       d_area_logratio=None, d_centroid_frac=None, e_sam_birefnet_iou=None, e_hard_disagreement=None,
                       e_band_frac=None, b_components=False, f_object_score=False, h_presence_window=0)  # fmt: skip
    fitted, trace = run_eval.calibrate(calibration, start)
    assert fitted.e_sam_pair_iou in (0.98, 0.99) and fitted.version == run_eval.CALIBRATED_VERSION
    result = run_eval.score(calibration, fitted)
    assert result["recall"] == 1.0 and result["reviewLoad"] == pytest.approx(2 / 6)
    assert trace[0]["step"] == "start"


def test_boundary_f_and_iou() -> None:
    a = np.zeros((40, 40), bool)
    a[10:30, 10:30] = True
    b = np.zeros_like(a)
    b[11:31, 10:30] = True
    assert run_eval.iou(a, a) == 1.0 and run_eval.boundary_f(a, a) == 1.0
    assert run_eval.boundary_f(a, b) == 1.0, "a 1 px shift is inside the 2 px tolerance"
    assert run_eval.boundary_f(a, np.zeros_like(a)) == 0.0


def test_forward_selection_drops_a_check_that_flags_correct_frames() -> None:
    # Frames 1 and 3 are wrong and only the pair-IoU signal separates them; c2 fires everywhere.
    calibration = [
        run(
            "calibration",
            [0.99, 0.97, 0.99, 0.96, 0.99, 0.99],
            [False, True, False, True, False, False],
        )
    ]
    for frame in calibration[0]["frames"]:
        frame["signals"]["unexplainedEdges"] = 2.0
    fitted, trace = run_eval.forward_select(calibration)
    result = run_eval.score(calibration, fitted)
    assert result["recall"] == 1.0 and result["reviewLoad"] == pytest.approx(2 / 6)
    assert fitted.c2_unexplained is None and trace[0]["add"].startswith("e_sam_pair_iou")
    chosen, details = run_eval.best_calibration(calibration)
    assert run_eval.score(calibration, chosen)["reviewLoad"] == pytest.approx(2 / 6)
    assert details["chosen"] in ("coordinate", "forward")
