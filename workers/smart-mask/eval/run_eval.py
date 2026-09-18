"""BR7.2 matte eval: run the INSTALLED entrypoint on the fixtures, score every 06 gate, report.

Plan 06 "Harness". Subcommands, so each real-weight run is one watchdog job (one process tree,
memory released at exit)::

    # one clip through the installed entrypoint (auto prompt = the first frame's subject box)
    spike/.venv/bin/python spike/watchdog.py --log .cache/eval.log -- \
        "../.venv/bin/python ../eval/run_eval.py run walk_pan__scored"
    # the same clip prompted with ONE click (06's one-click gates)
    "... run_eval.py run --prompt click walk_pan__scored"
    # correction convergence: up to 3 corrective actions on the clip's worst frame
    "... run_eval.py replay talking_head__scored"

    .venv/bin/python eval/run_eval.py score     # every gate, contact sheet, committed report

**Fixtures** (``eval/fixtures.py``): the BR3.15 construction-true pilot (``.cache/pilot-br3``) and,
when they exist, MO-8's human-labelled clips (``tests/fixtures/background-removal`` in the repo, or
``--fixtures DIR``). A label counts only when marked human-verified. The report says, per gate,
which kind of ground truth judged it, and says "construction-true only" whenever no human label
contributed.

**Scoring (06).** Per frame: IoU of α ≥ 0.5 vs ground truth, BF@2px; wrong = IoU < 0.98 or
BF < 0.95. Error-detection recall = wrong frames flagged / wrong frames (gate ≥ 99.5%); review
load = flagged / frames (gate ≤ 10%).

**Calibration without tuning on the reported set.** Each frame's threshold-free verify signals are
recorded in report.json by the worker. Thresholds are fitted on the ``calibration`` split only (the
lowest review load whose recall meets the gate there, by coordinate search and by forward
selection, whichever does better there), frozen, and applied unchanged to the ``scored`` split.
Only scored-split numbers are gate results. The shipped defaults are scored too, for comparison.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import platform
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

EVAL = Path(__file__).resolve().parent
PACK = EVAL.parent
REPO = PACK.parent.parent
sys.path.insert(0, str(PACK / "src"))
sys.path.insert(0, str(EVAL))

from contact_sheet import SheetRow, write_sheet  # noqa: E402
from entrypoint import (  # noqa: E402
    decode_matte,
    decode_rgb,
    fresh_staging,
    run_request,
    source_pts,
)
from fixtures import Fixture, discover  # noqa: E402
from matte_metrics import (  # noqa: E402
    band_grad,
    band_sad,
    binarise,
    boundary_f,
    dtssd,
    frames_aligned,
    iou,
    is_leak,
    unknown_band,
)
from replay import replay as replay_fixture  # noqa: E402

from framepilot_smart_mask.verify import Thresholds, flag_frames  # noqa: E402

PILOT_DIR = PACK / ".cache" / "pilot-br3"
HUMAN_DIR = REPO / "tests" / "fixtures" / "background-removal"
#: Auto-prompt runs (BR3.15 wrote here too, so its runs are reused as they are).
RUNS_DIR = PACK / ".cache" / "eval-br3"
CLICK_RUNS_DIR = PACK / ".cache" / "eval-br7-click"
REPLAY_DIR = PACK / ".cache" / "eval-br7-replay"
REPORTS_DIR = REPO / "reports" / "smart-mask"
WRONG_IOU = 0.98
WRONG_BF = 0.95
RECALL_GATE = 0.995
REVIEW_GATE = 0.10
CALIBRATED_VERSION = "br7.3-calibrated"
PROMPTS = ("auto", "click")


def fixture_roots(extra: list[Path] | None = None) -> list[Path]:
    return [PILOT_DIR, HUMAN_DIR, *(extra or [])]


def find_fixture(name: str, extra: list[Path] | None = None) -> Fixture:
    fixtures, refused = discover(fixture_roots(extra))
    for fixture in fixtures:
        if fixture.name == name:
            return fixture
    reason = next((item["reason"] for item in refused if item["name"] == name), "not found")
    raise SystemExit(f"fixture {name}: {reason}")


# --- run ---------------------------------------------------------------------------------------


def click_point(truth: np.ndarray) -> dict[str, Any]:
    """06's "one click": the deepest point inside the subject on the first frame."""
    import cv2

    mask = (truth >= 128).astype(np.uint8)
    depth = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    y, x = np.unravel_index(int(np.argmax(depth)), depth.shape)
    height, width = truth.shape
    return {"x": round((x + 0.5) / width, 6), "y": round((y + 0.5) / height, 6), "label": "include"}


def request_for(fixture: Fixture, staging: Path, prompt: str = "auto") -> dict[str, Any]:
    first_pts = source_pts(fixture.clip)[0]
    if prompt == "click":
        first = fixture.scored_frames()[0]
        prompts = [{"kind": "points", "pts": source_pts(fixture.clip)[first],
                    "points": [click_point(fixture.truth(first))]}]  # fmt: skip
    else:
        # Auto mode's prompt: the subject.detect box on the first frame (a perfect detector here).
        prompts = [{"kind": "box", "pts": first_pts, "box": fixture.box}]
    return {
        "type": "request", "protocolVersion": 1,
        "requestId": f"eval-{fixture.name}".replace("__", "-")[:64], "projectRevision": 1,
        "media": {"handleId": "media", "assetId": fixture.name, "absolutePath": str(fixture.clip),
                  "sourceStartSeconds": 0.0, "sourceEndSeconds": fixture.frames / fixture.fps,
                  "fps": float(fixture.fps), "firstFrame": 0, "lastFrameExclusive": fixture.frames},
        "capability": "subject.matte",
        "parameters": {
            "output": {"handleId": "out", "absolutePath": str(staging),
                       "allowedFiles": ["matte.mkv", "frames.json", "report.json"], "maxBytes": 4 * 1024**3},
            "prompts": prompts,
            "previewHeight": 180,
        },
    }  # fmt: skip


def runs_dir(prompt: str) -> Path:
    return RUNS_DIR if prompt == "auto" else CLICK_RUNS_DIR


def run_clip(name: str, prompt: str = "auto", extra: list[Path] | None = None) -> int:
    fixture = find_fixture(name, extra)
    out = runs_dir(prompt) / name
    out.mkdir(parents=True, exist_ok=True)
    staging = fresh_staging(out)
    result = run_request(request_for(fixture, staging, prompt), out)
    return 0 if result["terminal"].get("type") == "result" else 1


def run_replay(name: str, extra: list[Path] | None = None) -> int:
    fixture = find_fixture(name, extra)
    base = RUNS_DIR / name / "staging"
    if not (base / "matte.mkv").is_file():
        raise SystemExit(f"{name}: run the auto-prompt clip first (no base matte).")
    out = REPLAY_DIR / name
    out.mkdir(parents=True, exist_ok=True)
    record = replay_fixture(fixture, base, out, request_for(fixture, base))
    sys.stdout.write(json.dumps({k: record[k] for k in ("fixture", "convergedAtAction", "converged",
                                                        "locksBitIdentical")}) + "\n")  # fmt: skip
    return 0 if record["actions"] and "failed" not in record["actions"][-1] else 1


# --- scoring -----------------------------------------------------------------------------------


def wilson_lower(successes: int, n: int, z: float = 1.96) -> float | None:
    if n == 0:
        return None
    p = successes / n
    denominator = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre - margin) / denominator


def load_run(
    fixture: Fixture, directory: Path = RUNS_DIR, with_arrays: bool = False
) -> dict[str, Any] | None:
    """One finished run, scored frame by frame. ``None`` when it never ran."""
    out = directory / fixture.name
    result_path = out / "result.json"
    if not result_path.is_file():
        return None
    result = json.loads(result_path.read_text())
    if result["terminal"].get("type") != "result":
        return {"name": fixture.name, "failed": result["terminal"]}
    staging = out / "staging"
    report = json.loads((staging / "report.json").read_text())
    count, height, width = fixture.frames, fixture.height, fixture.width
    matte = decode_matte(staging / "matte.mkv", count, height, width)
    scored = set(fixture.scored_frames())
    frames = []
    for index in range(count):
        entry: dict[str, Any] = {
            "iou": None, "bf": None, "wrong": None, "leak": None,
            "checks": report["frames"][index]["checks"], "signals": report["frames"][index]["signals"],
            "locked": report["frames"][index]["locked"],
        }  # fmt: skip
        if index in scored:
            pred, truth = binarise(matte[index]), binarise(fixture.truth(index))
            frame_iou, bf = iou(pred, truth), boundary_f(pred, truth)
            entry.update({"iou": frame_iou, "bf": bf, "wrong": frame_iou < WRONG_IOU or bf < WRONG_BF,
                          "leak": is_leak(pred, truth)})  # fmt: skip
        frames.append(entry)
    matte_pts = [int(value) for value in json.loads((staging / "frames.json").read_text())["pts"]]
    aligned, compared = frames_aligned(matte_pts, source_pts(fixture.clip)[:count])
    run: dict[str, Any] = {
        "name": fixture.name, "category": fixture.category, "split": fixture.split,
        "groundTruth": fixture.ground_truth, "frames": frames, "seconds": result["seconds"],
        "job": report["job"], "aligned": aligned, "alignedOf": compared,
    }  # fmt: skip
    if fixture.ground_truth == "construction":
        truths = [fixture.truth(index) for index in range(count)]
        run["dtSSD"] = dtssd(list(matte), truths)
        bands = [unknown_band(truth) for truth in truths]
        run["bandSAD"] = float(
            np.mean([band_sad(matte[i], truths[i], bands[i]) for i in range(count)])
        )
        run["bandGrad"] = float(
            np.mean([band_grad(matte[i], truths[i], bands[i]) for i in range(count)])
        )
    if with_arrays:
        run["_matte"] = matte
    return run


def _frames_with_truth(run: dict[str, Any]) -> list[dict[str, Any]]:
    return [frame for frame in run["frames"] if frame["wrong"] is not None]


def score(runs: list[dict[str, Any]], thresholds: Thresholds | None) -> dict[str, Any]:
    """Recall over frames with ground truth; review load over every frame of the runs."""
    total = wrong = caught = flagged = 0
    per_category: dict[str, Any] = {}
    misses = []
    for run in runs:
        signals = [frame["signals"] for frame in run["frames"]]
        flags = (
            flag_frames(signals, thresholds, set())
            if thresholds is not None
            else [f["checks"] for f in run["frames"]]
        )
        pairs = list(zip(run["frames"], flags, strict=True))
        category_wrong = sum(1 for frame, _ in pairs if frame["wrong"] is True)
        category_caught = sum(1 for frame, flag in pairs if frame["wrong"] is True and flag)
        category_flagged = sum(1 for flag in flags if flag)
        ious = [frame["iou"] for frame in _frames_with_truth(run)]
        per_category[run["category"]] = {
            "frames": len(run["frames"]), "wrong": category_wrong, "caught": category_caught,
            "flagged": category_flagged,
            "meanIoU": round(float(np.mean(ious)), 4) if ious else None,
            "p5IoU": round(float(np.percentile(ious, 5)), 4) if ious else None,
            "meanBF": round(float(np.mean([f["bf"] for f in _frames_with_truth(run)])), 4) if ious else None,
        }  # fmt: skip
        misses += [{"clip": run["name"], "frame": i, "iou": round(frame["iou"], 4), "bf": round(frame["bf"], 4)}
                   for i, (frame, flag) in enumerate(pairs) if frame["wrong"] is True and not flag]  # fmt: skip
        total += len(run["frames"])
        wrong += category_wrong
        caught += category_caught
        flagged += category_flagged
    return {
        "frames": total, "wrongFrames": wrong, "caught": caught, "flagged": flagged,
        "recall": caught / wrong if wrong else None, "recallWilson95Lower": wilson_lower(caught, wrong),
        "reviewLoad": flagged / total if total else None, "perCategory": per_category, "missed": misses,
    }  # fmt: skip


#: Candidate values per threshold for the coordinate search (None disables a numeric check).
SEARCH_SPACE: dict[str, list[Any]] = {
    "a_rewarp_mismatch": [None, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2],
    "c_edge_corr": [None, 0.05, 0.1, 0.2, 0.3],
    "c2_unexplained": [None, 0.2, 0.35, 0.5, 0.8, 1.2],
    "d_area_logratio": [None, 0.05, 0.08, 0.15, 0.25],
    "d_centroid_frac": [None, 0.1, 0.25, 0.5],
    "e_sam_pair_iou": [None, 0.9, 0.95, 0.98, 0.99],
    "e_sam_birefnet_iou": [None, 0.9, 0.95, 0.98, 0.99],
    "e_hard_disagreement": [None, 0.005, 0.01, 0.02, 0.05],
    "e_band_frac": [None, 0.2, 0.3, 0.4, 0.6],
    "b_components": [False, True],
    "f_object_score": [False, True],
    "g_single_estimate": [False, True],
    "h_presence_window": [0, 1, 3],
    # BR7.3 verify rules (see verify.py): either-side re-warp, and flags spread to neighbours.
    "a_either": [False, True],
    "n_dilate": [0, 1, 2],
}


def objective(result: dict[str, Any]) -> tuple[float, float]:
    """Meet the recall gate first; then the lowest review load."""
    recall = result["recall"] if result["recall"] is not None else 1.0
    return (0.0 if recall >= RECALL_GATE else RECALL_GATE - recall, result["reviewLoad"] or 0.0)


def calibrate(
    runs: list[dict[str, Any]], start: Thresholds
) -> tuple[Thresholds, list[dict[str, Any]]]:
    best = start
    best_key = objective(score(runs, best))
    trace = [
        {
            "step": "start",
            "recall": score(runs, best)["recall"],
            "reviewLoad": score(runs, best)["reviewLoad"],
        }
    ]
    for sweep in range(3):
        improved = False
        for name, values in SEARCH_SPACE.items():
            for value in values:
                candidate = dataclasses.replace(best, **{name: value})
                key = objective(score(runs, candidate))
                if key < best_key:
                    best, best_key, improved = candidate, key, True
                    trace.append(
                        {
                            "step": f"sweep{sweep}:{name}={value}",
                            "recallGap": key[0],
                            "reviewLoad": key[1],
                        }
                    )
        if not improved:
            break
    return dataclasses.replace(best, version=CALIBRATED_VERSION), trace


#: Every check switched off: the starting point of forward selection.
NOTHING = Thresholds(
    a_rewarp_mismatch=None,
    b_components=False,
    c_edge_corr=None,
    c2_unexplained=None,
    d_area_logratio=None,
    d_centroid_frac=None,
    e_sam_pair_iou=None,
    e_sam_birefnet_iou=None,
    e_hard_disagreement=None,
    e_band_frac=None,
    f_object_score=False,
    g_single_estimate=False,
    h_presence_window=0,
    a_either=False,
    n_dilate=0,
)
#: The "off" value of each parameter, so forward selection knows what adding a rule means.
OFF = {name: getattr(NOTHING, name) for name in SEARCH_SPACE}


def _flag_sets(
    runs: list[dict[str, Any]], thresholds: Thresholds
) -> tuple[set[tuple[str, int]], set[tuple[str, int]]]:
    flagged, wrong = set(), set()
    for run in runs:
        flags = flag_frames([frame["signals"] for frame in run["frames"]], thresholds, set())
        for index, (frame, flag) in enumerate(zip(run["frames"], flags, strict=True)):
            if flag:
                flagged.add((run["name"], index))
            if frame["wrong"]:
                wrong.add((run["name"], index))
    return flagged, wrong


def forward_select(runs: list[dict[str, Any]]) -> tuple[Thresholds, list[dict[str, Any]]]:
    """Add rules greedily by (new wrong frames caught) / (new correct frames flagged + 1),
    until the recall gate holds on these runs; then drop any rule the gate does not need."""
    current = NOTHING
    trace: list[dict[str, Any]] = []
    _, wrong = _flag_sets(runs, current)
    total = len(runs and [f for r in runs for f in r["frames"]])
    while True:
        flagged, _ = _flag_sets(runs, current)
        caught = len(flagged & wrong)
        if not wrong or caught / len(wrong) >= RECALL_GATE:
            break
        best = None
        for name, values in SEARCH_SPACE.items():
            for value in values:
                if value == OFF[name] or value == getattr(current, name):
                    continue
                candidate = dataclasses.replace(current, **{name: value})
                cand_flagged, _ = _flag_sets(runs, candidate)
                gain = len(cand_flagged & wrong) - caught
                cost = len(cand_flagged - wrong) - len(flagged - wrong)
                if gain <= 0:
                    continue
                ratio = gain / (max(cost, 0) + 1)
                if best is None or ratio > best[0]:
                    best = (ratio, candidate, f"{name}={value}", gain, cost)
        if best is None:
            break
        current = best[1]
        trace.append({"add": best[2], "caught": best[3], "extraFlags": best[4]})
    for name in SEARCH_SPACE:
        if getattr(current, name) == OFF[name]:
            continue
        candidate = dataclasses.replace(current, **{name: OFF[name]})
        flagged, _ = _flag_sets(runs, candidate)
        if wrong and len(flagged & wrong) / len(wrong) >= RECALL_GATE:
            current = candidate
            trace.append({"drop": name, "reviewLoad": len(flagged) / max(total, 1)})
    return current, trace


def best_calibration(runs: list[dict[str, Any]]) -> tuple[Thresholds, dict[str, Any]]:
    """Both searches on the calibration split; keep the one with the better objective there."""
    coordinate, coordinate_trace = calibrate(runs, Thresholds())
    forward, forward_trace = forward_select(runs)
    forward = dataclasses.replace(forward, version=CALIBRATED_VERSION)
    chosen = min((coordinate, forward), key=lambda t: objective(score(runs, t)))
    return chosen, {
        "chosen": "coordinate" if chosen is coordinate else "forward",
        "coordinate": {
            "trace": coordinate_trace,
            "calibration": {k: score(runs, coordinate)[k] for k in ("recall", "reviewLoad")},
        },
        "forward": {
            "trace": forward_trace,
            "calibration": {k: score(runs, forward)[k] for k in ("recall", "reviewLoad")},
        },
    }


# --- gates -------------------------------------------------------------------------------------


def _judged(runs: list[dict[str, Any]]) -> dict[str, Any]:
    kinds = sorted({run["groundTruth"] for run in runs})
    return {"judgedOn": kinds, "constructionTrueOnly": kinds == ["construction"]}


def _gate(
    gate_id: str, name: str, threshold: str, status: str, value: Any = None, **extra: Any
) -> dict[str, Any]:
    return {
        "id": gate_id,
        "gate": name,
        "threshold": threshold,
        "status": status,
        "value": value,
        **extra,
    }


def accuracy_by_category(runs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    table: dict[str, dict[str, Any]] = {}
    for category in sorted({run["category"] for run in runs}):
        frames = [f for run in runs if run["category"] == category for f in _frames_with_truth(run)]
        ious = [f["iou"] for f in frames]
        table[category] = {
            "frames": len(frames), "meanIoU": round(float(np.mean(ious)), 4),
            "p5IoU": round(float(np.percentile(ious, 5)), 4),
            "meanBF": round(float(np.mean([f["bf"] for f in frames])), 4),
            "wrong": sum(f["wrong"] for f in frames),
        }  # fmt: skip
    return table


def gates(scored: list[dict[str, Any]], click: list[dict[str, Any]], calibrated: dict[str, Any],
          replays: list[dict[str, Any]]) -> list[dict[str, Any]]:  # fmt: skip
    """Every matte gate in 06, from the scored split only. Never a gate this run could not judge."""
    out: list[dict[str, Any]] = []
    auto = accuracy_by_category(scored) if scored else {}
    judged = _judged(scored) if scored else {}
    if auto:
        worst = min(auto.items(), key=lambda item: item[1]["meanIoU"])
        failing = [name for name, row in auto.items() if row["meanIoU"] < 0.98]
        out.append(_gate("mean_iou_auto", "Mean IoU, auto prompt, every category", ">= 0.98",
                         "pass" if not failing else "fail", worst[1]["meanIoU"],
                         worstCategory=worst[0], failingCategories=failing, **judged))  # fmt: skip
    if click:
        rows = accuracy_by_category(click)
        worst = min(rows.items(), key=lambda item: item[1]["meanIoU"])
        p5 = float(np.percentile([f["iou"] for run in click for f in _frames_with_truth(run)], 5))
        out.append(_gate("worst_category_iou_click", "Worst-category mean IoU, one click", ">= 0.97",
                         "pass" if worst[1]["meanIoU"] >= 0.97 else "fail", worst[1]["meanIoU"],
                         worstCategory=worst[0], categories=len(rows), **_judged(click)))  # fmt: skip
        out.append(_gate("p5_iou_click", "5th-percentile per-frame IoU, one click", ">= 0.95",
                         "pass" if p5 >= 0.95 else "fail", round(p5, 4), **_judged(click)))  # fmt: skip
    else:
        for gate_id, name, threshold in (("worst_category_iou_click", "Worst-category mean IoU, one click", ">= 0.97"),
                                         ("p5_iou_click", "5th-percentile per-frame IoU, one click", ">= 0.95")):  # fmt: skip
            out.append(_gate(gate_id, name, threshold, "not_measured",
                             note="No one-click runs: `run --prompt click` was not run for these fixtures."))  # fmt: skip
    if auto:
        worst = min(auto.items(), key=lambda item: item[1]["meanBF"])
        failing = [name for name, row in auto.items() if row["meanBF"] < 0.95]
        out.append(_gate("bf_every_category", "BF@2px, every category", ">= 0.95",
                         "pass" if not failing else "fail", worst[1]["meanBF"], worstCategory=worst[0],
                         failingCategories=failing, **judged))  # fmt: skip
    hair = [run for run in scored if run["category"] == "hair_busy" and "bandSAD" in run]
    out.append(_gate("band_sad_grad_hair", "Band SAD / Grad, hair category",
                     ">= 25% lower than band alpha disabled; within 2% of the fp32 PyTorch reference", "not_measured",
                     {"bandSAD": round(hair[0]["bandSAD"], 3), "bandGrad": round(hair[0]["bandGrad"], 3)} if hair else None,
                     note="Needs two ablation runs (band alpha disabled; fp32 PyTorch reference of the same pipeline). "
                          "The absolute band errors of this run are recorded for the next comparison."))  # fmt: skip
    out.append(_gate("foreground_delta_e", "Foreground colour error", "mean ΔE2000 <= 2.0 in the band", "not_measured",
                     note="The pilot stores no ground-truth foreground colour, and eval runs do not write "
                          "foreground.mkv; needs a fixture with a known foreground plate."))  # fmt: skip
    dt = {run["category"]: round(run["dtSSD"], 3) for run in scored if run.get("dtSSD") is not None}
    out.append(_gate("dtssd", "dtSSD", ">= 30% lower than stabilisation disabled; no visible crawl (blind review)",
                     "not_measured", dt or None,
                     note="Needs a stabilisation-disabled ablation run and a blind side-by-side review; "
                          "absolute dtSSD per category is recorded."))  # fmt: skip
    leak_frames = [f["leak"] for run in scored for f in _frames_with_truth(run)]
    if leak_frames:
        rate = sum(leak_frames) / len(leak_frames)
        out.append(_gate("leak_rate", "Leak rate", "<= 0.5% of frames before review",
                         "pass" if rate <= 0.005 else "fail", round(rate, 4),
                         leakFrames=sum(leak_frames), frames=len(leak_frames), **judged))  # fmt: skip
    result = calibrated["scored"]
    if result["recall"] is not None:
        out.append(_gate("error_detection_recall", "Error-detection recall", ">= 99.5%",
                         "pass" if result["recall"] >= RECALL_GATE else "fail", round(result["recall"], 4),
                         wilson95Lower=round(result["recallWilson95Lower"], 4), wrongFrames=result["wrongFrames"],
                         caught=result["caught"], thresholds="calibrated on the calibration split, frozen", **judged))  # fmt: skip
        load = result["reviewLoad"]
        out.append(_gate("review_load", "Review load", "<= 10% of frames on medium categories",
                         "pass" if load <= REVIEW_GATE else "fail", round(load, 4),
                         actuallyWrongFraction=round(result["wrongFrames"] / result["frames"], 4),
                         note="06 does not define 'medium'; judged on every scored category. No honest detector "
                              "can flag fewer frames than are actually wrong.", **judged))  # fmt: skip
    if replays:
        converged = [r for r in replays if r["converged"]]
        out.append(_gate("correction_convergence", "Correction convergence",
                         "<= 3 actions -> corrected frame IoU >= 0.995, BF@2px >= 0.98; neighbours within 1 s do not regress",
                         "pass" if len(converged) == len(replays) else "fail", f"{len(converged)}/{len(replays)}",
                         actionsFrom=sorted({r["actionsFrom"] for r in replays}),
                         judgedOn=sorted({r["groundTruth"] for r in replays}),
                         constructionTrueOnly=all(r["groundTruth"] == "construction" for r in replays)))  # fmt: skip
        checked = [r for r in replays if r["locksBitIdentical"] is not None]
        out.append(_gate("locked_frames", "Locked frames", "100% bit-identical after any later re-run",
                         "pass" if checked and all(r["locksBitIdentical"] for r in checked) else "fail",
                         f"{sum(bool(r['locksBitIdentical']) for r in checked)}/{len(checked)} replays",
                         reRuns=sum(len(r["actions"]) for r in checked),
                         judgedOn=sorted({r["groundTruth"] for r in replays})))  # fmt: skip
    else:
        for gate_id, name, threshold in (
            ("correction_convergence", "Correction convergence", "<= 3 actions -> IoU >= 0.995, BF@2px >= 0.98"),
            ("locked_frames", "Locked frames", "100% bit-identical after any later re-run"),
        ):  # fmt: skip
            out.append(_gate(gate_id, name, threshold, "not_measured", note="No replay was run."))
    aligned = sum(run["aligned"] for run in scored)
    compared = sum(run["alignedOf"] for run in scored)
    if compared:
        out.append(_gate("frame_alignment", "Frame alignment", "100%",
                         "pass" if aligned == compared else "fail", f"{aligned}/{compared}", **judged))  # fmt: skip
    out.append(_gate("preview_export", "Preview <-> export", "the matte and text-behind-subject rows of the 09 oracle pass",
                     "not_measured", note="Not measured by this harness. BR5.3's oracle rows (8 matte rows, 7 "
                     "bit-identical) pass in CI run 35281873504; they judge rendering, not the pack."))  # fmt: skip
    return out


# --- report ------------------------------------------------------------------------------------


def _replays() -> list[dict[str, Any]]:
    if not REPLAY_DIR.is_dir():
        return []
    return [json.loads(path.read_text()) for path in sorted(REPLAY_DIR.glob("*/replay.json"))]


def _sheet_rows(
    fixtures: dict[str, Fixture], runs: list[dict[str, Any]], thresholds: Thresholds
) -> list[SheetRow]:
    rows = []
    for run in runs:
        fixture = fixtures[run["name"]]
        matte = run["_matte"]
        worst = min(
            (i for i, f in enumerate(run["frames"]) if f["iou"] is not None),
            key=lambda i: (run["frames"][i]["iou"], run["frames"][i]["bf"]),
        )
        rgb = decode_rgb(fixture.clip, worst + 1, fixture.height, fixture.width)[worst]
        flags = flag_frames([f["signals"] for f in run["frames"]], thresholds, set())
        rows.append(SheetRow(name=run["name"], frame=worst, source_rgb=rgb, matte=matte[worst],
                             truth=fixture.truth(worst), flagged=[bool(f) for f in flags],
                             wrong=[f["wrong"] for f in run["frames"]]))  # fmt: skip
    return rows


def report(
    date: str, extra: list[Path] | None = None, sheet: bool = True
) -> tuple[dict[str, Any], list[SheetRow]]:
    fixtures, refused = discover(fixture_roots(extra))
    by_name = {fixture.name: fixture for fixture in fixtures}
    loaded = [(fixture, load_run(fixture, with_arrays=sheet)) for fixture in fixtures]
    runs = [run for _, run in loaded if run is not None and "failed" not in run]
    failures = [run for _, run in loaded if run is not None and "failed" in run]
    not_run = [fixture.name for fixture, run in loaded if run is None]
    clicks = [
        run
        for fixture in fixtures
        if (run := load_run(fixture, CLICK_RUNS_DIR)) is not None and "failed" not in run
    ]
    calibration = [run for run in runs if run["split"] == "calibration"]
    scored = [run for run in runs if run["split"] == "scored"]
    shipped = Thresholds()
    fitted, trace = best_calibration(calibration) if calibration else (shipped, {})
    calibrated = {"thresholds": fitted.as_json(), "fittedOn": "calibration", "trace": trace,
                  "calibration": score(calibration, fitted), "scored": score(scored, fitted)}  # fmt: skip
    replays = _replays()
    accuracy = {
        split: {
            "meanIoU": round(float(np.mean([f["iou"] for r in group for f in _frames_with_truth(r)])), 4) if group else None,
            "p5IoU": round(float(np.percentile([f["iou"] for r in group for f in _frames_with_truth(r)], 5)), 4) if group else None,
            "meanBF": round(float(np.mean([f["bf"] for r in group for f in _frames_with_truth(r)])), 4) if group else None,
            "wrongFraction": round(float(np.mean([f["wrong"] for r in group for f in _frames_with_truth(r)])), 4) if group else None,
            "byCategory": accuracy_by_category(group) if group else {},
        }
        for split, group in (("calibration", calibration), ("scored", scored))
    }  # fmt: skip
    kinds = sorted({run["groundTruth"] for run in runs})
    result = {
        "date": date,
        "platform": f"{sys.platform}-{platform.machine()}",
        "harness": "workers/smart-mask/eval/run_eval.py (installed entrypoint, BR7.2)",
        "groundTruth": {
            "kinds": kinds,
            "constructionTrueOnly": kinds == ["construction"],
            "humanLabelledFixtures": sorted(f.name for f in fixtures if f.ground_truth == "human"),
            "machineLabelsIgnored": {f.name: f.ignored_labels for f in fixtures if f.ignored_labels},
            "note": "MO-8's human-labelled set does not exist yet; every gate below is judged on construction-true "
                    "clips only." if kinds == ["construction"] else "Mixed: see judgedOn per gate.",
        },
        "fixtures": {"run": [run["name"] for run in runs], "failed": [{"name": f["name"], "terminal": f["failed"]} for f in failures],
                     "notRun": not_run, "refused": refused, "oneClickRuns": [run["name"] for run in clicks]},
        "definitions": {"wrongFrame": {"iou": WRONG_IOU, "bf": WRONG_BF}, "recallGate": RECALL_GATE, "reviewLoadGate": REVIEW_GATE},
        "gates": gates(scored, [r for r in clicks if r["split"] == "scored"], calibrated, replays),
        "accuracy": accuracy,
        "shippedThresholds": {"thresholds": shipped.as_json(), "calibration": score(calibration, shipped), "scored": score(scored, shipped)},
        "calibratedThresholds": calibrated,
        "correctionReplays": replays,
        "secondsPerClip": {run["name"]: run["seconds"] for run in runs},
        "job": runs[0]["job"] if runs else None,
    }  # fmt: skip
    rows = _sheet_rows(by_name, scored, fitted) if sheet else []
    return result, rows


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--fixtures", action="append", type=Path, default=[], help="extra fixture root"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--prompt", choices=PROMPTS, default="auto")
    run.add_argument("clips", nargs="+")
    replay = commands.add_parser("replay")
    replay.add_argument("clips", nargs="+")
    scoring = commands.add_parser("score")
    scoring.add_argument("--no-sheet", action="store_true")
    arguments = parser.parse_args()
    if arguments.command == "run":
        return max(run_clip(name, arguments.prompt, arguments.fixtures) for name in arguments.clips)
    if arguments.command == "replay":
        return max(run_replay(name, arguments.fixtures) for name in arguments.clips)
    date = time.strftime("%Y-%m-%d")
    result, rows = report(date, arguments.fixtures, sheet=not arguments.no_sheet)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    stem = f"{date}-{result['platform']}"
    if rows:
        write_sheet(rows, REPORTS_DIR / f"{stem}-contact-sheet.jpg",
                    f"Smart Mask eval {stem}: scored split, worst frame per clip "
                    f"({'construction-true only' if result['groundTruth']['constructionTrueOnly'] else 'mixed ground truth'})")  # fmt: skip
        result["contactSheet"] = f"reports/smart-mask/{stem}-contact-sheet.jpg"
    path = REPORTS_DIR / f"{stem}.json"
    path.write_text(json.dumps(result, indent=2) + "\n")
    summary = {
        gate["id"]: {"status": gate["status"], "value": gate["value"]} for gate in result["gates"]
    }
    sys.stdout.write(json.dumps({"report": str(path.relative_to(REPO)), "gates": summary}) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
