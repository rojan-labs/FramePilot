"""BR7.2 harness pieces that need no weights: fixtures, metrics, scripted fixes, gates, sheet."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
cv2 = pytest.importorskip("cv2")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "eval"))

import contact_sheet  # noqa: E402
import matte_metrics  # noqa: E402
import replay  # noqa: E402
import run_eval  # noqa: E402
from fixtures import discover, load_fixture  # noqa: E402

META = {"category": "talking_head", "split": "scored", "fps": 24, "frames": 4, "width": 32,
        "height": 18, "box": {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.8}}  # fmt: skip


def construction(root: Path, name: str = "walk__scored") -> Path:
    directory = root / name
    directory.mkdir(parents=True)
    (directory / "meta.json").write_text(json.dumps(META))
    np.savez_compressed(directory / "gt_alpha.npz", alpha=np.zeros((4, 18, 32), np.uint8))
    return directory


def human(root: Path, labels: list[dict], name: str = "real__scored") -> Path:
    directory = root / name
    (directory / "labels").mkdir(parents=True)
    (directory / "meta.json").write_text(json.dumps({**META, "groundTruth": "human"}))
    for entry in labels:
        cv2.imwrite(str(directory / entry["file"]), np.full((18, 32), 255, np.uint8))
    (directory / "labels.json").write_text(json.dumps({"labels": labels}))
    return directory


def test_construction_fixtures_score_every_frame(tmp_path: Path) -> None:
    fixture = load_fixture(construction(tmp_path))
    assert fixture.ground_truth == "construction" and fixture.scored_frames() == [0, 1, 2, 3]
    assert fixture.truth(2).shape == (18, 32)


def test_human_fixtures_count_only_human_verified_labels(tmp_path: Path) -> None:
    labels = [
        {"frame": 0, "file": "labels/0.png", "humanVerified": True, "labeller": "a"},
        {"frame": 2, "file": "labels/2.png", "humanVerified": False, "labeller": "model"},
    ]
    fixture = load_fixture(human(tmp_path, labels))
    assert fixture.ground_truth == "human" and fixture.scored_frames() == [0]
    assert fixture.ignored_labels == [{"frame": 2, "reason": "not marked humanVerified"}]
    assert fixture.truth(0).max() == 255
    with pytest.raises(ValueError, match="no human-verified label"):
        fixture.truth(2)


def test_unscorable_fixtures_are_refused_by_name_not_skipped(tmp_path: Path) -> None:
    construction(tmp_path, "good__scored")
    human(tmp_path, [{"frame": 1, "file": "labels/1.png", "humanVerified": False}], "guess__scored")
    missing = tmp_path / "missing__scored"
    missing.mkdir()
    (missing / "meta.json").write_text(json.dumps({**META, "groundTruth": "human"}))
    (missing / "labels.json").write_text(
        json.dumps({"labels": [{"frame": 0, "file": "../../etc/passwd", "humanVerified": True}]})
    )
    fixtures, refused = discover([tmp_path, tmp_path / "absent"])
    assert [f.name for f in fixtures] == ["good__scored"]
    reasons = {item["name"]: item["reason"] for item in refused}
    assert "no human-verified labels" in reasons["guess__scored"]
    assert "missing" in reasons["missing__scored"]


def test_leak_alignment_and_dtssd() -> None:
    truth = np.zeros((100, 100), bool)
    truth[20:80, 20:80] = True
    hole = truth.copy()
    hole[40:45, 40:45] = False  # 25 px: > 0.05% of 10,000 px
    assert matte_metrics.is_leak(hole, truth) and not matte_metrics.is_leak(truth, truth)
    speck = truth.copy()
    speck[40, 40] = False
    assert not matte_metrics.is_leak(speck, truth), "a 1 px error is not a visible leak"
    assert matte_metrics.frames_aligned([0, 512, 1024], [0, 512, 1025]) == (2, 3)
    frames = [np.full((4, 4), v, np.uint8) for v in (0, 128, 255)]
    assert matte_metrics.dtssd(frames, frames) == 0.0
    assert matte_metrics.dtssd(frames[:1], frames[:1]) is None


def test_scripted_fixes_use_only_brush_values_and_stay_off_the_edge_until_the_last() -> None:
    gt = np.zeros((40, 40), np.uint8)
    gt[10:30, 10:30] = 255
    gt[10:30, 30] = 128  # a soft edge column
    pred = np.zeros_like(gt)
    pred[12:28, 12:30] = 255  # missed the rim, and the soft column is hard 0
    pred[2:6, 2:6] = 255  # an island
    first = replay.scripted_brush(pred, gt, 1, None)
    assert set(np.unique(first).tolist()) <= {0, 64, 128, 255}
    assert (first[2:6, 2:6] == replay.REMOVE).all() and first[11, 11] == replay.KEEP
    assert (first[10, :] == replay.UNTOUCHED).all(), "action 1 stays one pixel off the boundary"
    second = replay.scripted_brush(pred, gt, 2, first)
    assert (second[10:30, 30] == replay.EDGE).all(), "action 2 asks for the soft band again"
    assert (second[2:6, 2:6] == replay.REMOVE).all(), "earlier strokes are carried"
    third = replay.scripted_brush(pred, gt, 3, second)
    assert third[10, 10] == replay.KEEP, "the last action is pixel-exact"


def _run(split: str, wrong: list[bool], kind: str = "construction") -> dict:
    signal = {"area": 1000, "cx": 10.0, "cy": 10.0, "rewarp": [0.0], "motionPx": 0.0, "islands": 1,
              "holes": 0, "edgeCorr": 0.9, "unexplainedEdges": 0.0, "samPairIoU": 1.0, "samBirefnetIoU": 1.0,
              "hardDisagreement": 0.0, "bandFrac": 0.1, "estimates": 4.0, "fwdScore": 5.0, "bwdScore": 5.0}  # fmt: skip
    frames = []
    for bad in wrong:
        frames.append({"iou": 0.9 if bad else 0.99, "bf": 0.96, "wrong": bad, "leak": False, "checks": [],
                       "locked": False, "signals": {**signal, "samPairIoU": 0.5 if bad else 1.0}})  # fmt: skip
    return {"name": f"walk__{split}", "category": "walk", "split": split, "groundTruth": kind,
            "frames": frames, "seconds": 1.0, "job": {}, "aligned": len(wrong), "alignedOf": len(wrong),
            "dtSSD": 1.0}  # fmt: skip


def test_gates_say_what_judged_them_and_never_invent_an_unmeasured_gate() -> None:
    calibration = [_run("calibration", [False, True, False, True])]
    scored = [_run("scored", [False, True, False, False])]
    fitted, _ = run_eval.best_calibration(calibration)
    calibrated = {"scored": run_eval.score(scored, fitted)}
    table = {gate["id"]: gate for gate in run_eval.gates(scored, [], calibrated, [])}
    assert table["error_detection_recall"]["status"] == "pass"
    assert table["error_detection_recall"]["constructionTrueOnly"] is True
    assert table["review_load"]["value"] == 0.25 and table["review_load"]["status"] == "fail"
    assert (
        table["mean_iou_auto"]["status"] == "fail" and table["frame_alignment"]["status"] == "pass"
    )
    for unmeasured in ("worst_category_iou_click", "p5_iou_click", "band_sad_grad_hair",
                       "foreground_delta_e", "dtssd", "correction_convergence", "locked_frames",
                       "preview_export"):  # fmt: skip
        assert table[unmeasured]["status"] == "not_measured", unmeasured
    labelled = [_run("scored", [False, True, False, False], kind="human")]
    mixed = run_eval.gates(scored + labelled, [], calibrated, [])
    assert {gate["id"]: gate for gate in mixed}["mean_iou_auto"]["judgedOn"] == [
        "construction",
        "human",
    ]


def test_replays_decide_convergence_and_locks() -> None:
    record = {"groundTruth": "construction", "actionsFrom": "scripted-from-ground-truth", "converged": True,
              "locksBitIdentical": True, "actions": [{"action": 1}, {"action": 2}]}  # fmt: skip
    failing = {**record, "converged": False, "locksBitIdentical": False}
    calibrated = {"scored": {"recall": None}}
    table = {gate["id"]: gate for gate in run_eval.gates([], [], calibrated, [record, failing])}
    assert table["correction_convergence"]["value"] == "1/2"
    assert table["correction_convergence"]["status"] == "fail"
    assert table["locked_frames"]["status"] == "fail" and table["locked_frames"]["reRuns"] == 4


def test_human_frames_without_labels_count_for_review_load_not_recall() -> None:
    run = _run("scored", [True, False, False, False], kind="human")
    run["frames"][2]["wrong"] = None
    run["frames"][2]["iou"] = None
    result = run_eval.score([run], None)
    assert result["wrongFrames"] == 1 and result["frames"] == 4


def test_contact_sheet_is_a_small_jpeg(tmp_path: Path) -> None:
    matte = np.zeros((72, 128), np.uint8)
    matte[10:60, 30:90] = 255
    row = contact_sheet.SheetRow(
        name="walk__scored", frame=3, source_rgb=np.full((72, 128, 3), 90, np.uint8), matte=matte,
        truth=matte, flagged=[True, False, False], wrong=[True, True, None],
    )  # fmt: skip
    path = contact_sheet.write_sheet([row, row], tmp_path / "sheet.jpg", "test")
    image = cv2.imread(str(path))
    assert image is not None and image.shape[1] == contact_sheet.TILE_W * 6
    assert path.stat().st_size < 200_000


def test_ciede2000_matches_sharma_reference_pairs() -> None:
    """Sharma, Wu, Dalal (2005), Table 1 rows 1, 2, 3, 7 and 17."""
    pairs = np.array([
        [[50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485]],
        [[50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485]],
        [[50.0, 2.8361, -74.0200], [50.0, 0.0, -82.7485]],
        [[50.0, 0.0, 0.0], [50.0, -1.0, 2.0]],
        [[50.0, 2.5, 0.0], [73.0, 25.0, -18.0]],
    ])  # fmt: skip
    expected = [2.0425, 2.8615, 3.4412, 2.3669, 27.1492]
    values = matte_metrics.delta_e2000(pairs[:, 0], pairs[:, 1])
    assert np.allclose(values, expected, atol=1e-4)
    assert matte_metrics.delta_e2000(pairs[:, 1], pairs[:, 0]) == pytest.approx(values)


def test_foreground_error_is_zero_for_the_truth_and_grows_with_a_fringe() -> None:
    alpha = np.zeros((20, 20), np.uint8)
    alpha[5:15, 5:15] = 255
    alpha[5:15, 4] = 128
    colour = np.full((20, 20, 3), (200, 150, 100), np.uint8)
    band = matte_metrics.unknown_band(alpha)
    total, pixels = matte_metrics.foreground_delta_e(colour, alpha, colour, alpha, band)
    assert pixels == int(band.sum()) and total == 0.0
    fringe = colour.copy()
    fringe[:, 4] = (0, 255, 0)
    total, pixels = matte_metrics.foreground_delta_e(fringe, alpha, colour, alpha, band)
    assert total > 10 * 20, "each of the 10 fringe pixels is a large colour error"


def _variant_run(name: str, category: str, **values: float) -> dict:
    return {
        "name": name,
        "category": category,
        "split": "scored",
        "groundTruth": "construction",
        **values,
    }


def test_ablation_gates_compare_the_same_clip_and_keep_the_blind_review_open() -> None:
    hair = _variant_run("hair_busy__scored", "hair_busy", bandSAD=1.0, bandGrad=0.5, dtSSD=2.0)
    walk = _variant_run("walk__scored", "walk", dtSSD=3.0)
    variants = {
        "band_off": [_variant_run("hair_busy__scored", "hair_busy", bandSAD=2.0, bandGrad=0.8)],
        "fp32": [_variant_run("hair_busy__scored", "hair_busy", bandSAD=1.01, bandGrad=0.5)],
        "stab_off": [_variant_run("hair_busy__scored", "hair_busy", dtSSD=4.0),
                     _variant_run("walk__scored", "walk", dtSSD=3.5)],
    }  # fmt: skip
    band = run_eval.band_gate([hair], variants)
    assert band["status"] == "pass" and band["value"]["reduction"] == {
        "bandSAD": 0.5,
        "bandGrad": 0.375,
    }
    assert (
        run_eval.band_gate([hair], {"band_off": variants["band_off"]})["status"] == "not_measured"
    )
    worse = {
        **variants,
        "band_off": [_variant_run("hair_busy__scored", "hair_busy", bandSAD=1.1, bandGrad=0.8)],
    }
    assert run_eval.band_gate([hair], worse)["status"] == "fail"
    dt = run_eval.dtssd_gate([hair, walk], variants)
    assert dt["status"] == "fail" and dt["failingCategories"] == ["walk"]
    only_hair = run_eval.dtssd_gate([hair], variants)
    assert only_hair["numericStatus"] == "pass" and only_hair["status"] == "not_measured"


def test_foreground_gate_pools_band_pixels_across_clips() -> None:
    runs = [
        _variant_run("a__scored", "a")
        | {"foregroundDeltaE": {"sum": 30.0, "pixels": 10, "mean": 3.0}},
        _variant_run("b__scored", "b")
        | {"foregroundDeltaE": {"sum": 10.0, "pixels": 30, "mean": 0.333}},
    ]
    gate = run_eval.foreground_gate(runs)
    assert gate["value"] == 1.0 and gate["status"] == "pass" and gate["pixels"] == 40
    assert run_eval.foreground_gate([])["status"] == "not_measured"


def test_attribution_summary_reports_each_estimate_per_category() -> None:
    frame = {name: {"iou": 0.9, "bf": 0.8, "leak": False} for name in run_eval.ESTIMATES}
    frame["bwd"] = None
    runs = [
        {"category": "walk", "attribution": [frame, frame]},
        {"category": "hair", "attribution": None},
    ]
    table = run_eval.attribution_summary(runs)
    assert list(table) == ["walk"] and table["walk"]["frames"] == 2
    assert table["walk"]["bwd"] is None and table["walk"]["fwd"]["meanIoU"] == 0.9


def test_ci_graph_record_and_repin_only_touch_differing_files(tmp_path: Path) -> None:
    import ci_graphs

    from framepilot_smart_mask.models import PINNED_MODELS

    first, second = PINNED_MODELS[0], PINNED_MODELS[1]
    (tmp_path / first.file).write_bytes(b"runner export")
    recorded = ci_graphs.record(tmp_path)
    assert recorded["files"][first.file]["identical"] is False
    assert recorded["allPresentIdentical"] is False and second.file in recorded["missing"]
    text, changed = ci_graphs.repin(ci_graphs.MODELS_SOURCE.read_text(), tmp_path)
    assert changed == [first.file]
    assert first.sha256 not in text and ci_graphs.sha256(tmp_path / first.file) in text
    assert second.sha256 in text, "files absent on the runner keep their pins"
    with pytest.raises(SystemExit, match="only on a CI runner"):
        ci_graphs.main(["repin", "--graphs", str(tmp_path)])


def test_ci_plan_builds_one_job_per_variant_and_clip() -> None:
    import ci_plan

    full = ci_plan.plan("", "", "", "talking_head crossing")
    variants = [run["variant"] for run in full["eval"]]
    assert variants.count("auto") == 20 and variants.count("click") == 10
    assert (
        variants.count("stab_off") == 10
        and variants.count("band_off") == variants.count("fp32") == 1
    )
    assert [r["clip"] for r in full["replay"]] == ["crossing__scored", "talking_head__scored"]
    smoke = ci_plan.plan("auto", "walk_pan", "scored", "")
    assert smoke == {"eval": [{"variant": "auto", "clip": "walk_pan__scored", "category": "walk_pan",
                               "split": "scored"}], "replay": []}  # fmt: skip
    with pytest.raises(SystemExit, match="unknown categories"):
        ci_plan.plan("auto", "walkpan", "", "")
