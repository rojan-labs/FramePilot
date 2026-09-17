"""BR3.15 accuracy harness: run the worker entrypoint on the pilot, score, calibrate, report.

Three subcommands, so each real-weight run is one watchdog job (one clip, memory released at
process exit):

    # one clip through the INSTALLED entrypoint (not Python imports), as 06 requires
    spike/.venv/bin/python spike/watchdog.py --log .cache/eval.log -- \
        ".venv/bin/python eval/run_eval.py run walk_pan__calibration" ...

    .venv/bin/python eval/run_eval.py score          # metrics, calibration, report

**Scoring (06).** Per frame: IoU of α ≥ 0.5 vs ground truth, BF@2px, wrong = IoU < 0.98 or
BF < 0.95. Error-detection recall = wrong frames flagged / wrong frames (gate ≥ 99.5%), review
load = flagged / frames (gate ≤ 10% on medium categories).

**Calibration without tuning on the reported set.** The pipeline records each frame's
threshold-free verify signals in report.json. Thresholds are fitted on the ``calibration``
split only: the lowest review load whose recall on that split meets the gate, found by a
deterministic coordinate search over each check's threshold. Those frozen thresholds are then
applied, unchanged, to the ``scored`` split, and only the scored split's numbers are reported
as results. The shipped defaults (BR0 attempt 4) are scored too, for comparison.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np

PACK = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACK / "src"))

from framepilot_smart_mask.verify import Thresholds, flag_frames  # noqa: E402

PILOT_DIR = PACK / ".cache" / "pilot-br3"
RUNS_DIR = PACK / ".cache" / "eval-br3"
REPORTS_DIR = PACK / "eval" / "reports"
WRONG_IOU = 0.98
WRONG_BF = 0.95
RECALL_GATE = 0.995
REVIEW_GATE = 0.10
ENTRYPOINT = PACK / ".venv" / "bin" / "framepilot-smart-mask"


# --- run ---------------------------------------------------------------------------------------


def request_for(clip_dir: Path, staging: Path) -> dict[str, Any]:
    meta = json.loads((clip_dir / "meta.json").read_text())
    listed = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts", "-of", "csv=p=0",
         str(clip_dir / "frames.mkv")], capture_output=True, text=True, check=True,
    ).stdout.split()  # fmt: skip
    first_pts = min(int(value) for value in listed)
    return {
        "type": "request", "protocolVersion": 1, "requestId": f"eval-{clip_dir.name}".replace("__", "-"),
        "projectRevision": 1,
        "media": {"handleId": "media", "assetId": clip_dir.name, "absolutePath": str(clip_dir / "frames.mkv"),
                  "sourceStartSeconds": 0.0, "sourceEndSeconds": meta["frames"] / meta["fps"], "fps": float(meta["fps"]),
                  "firstFrame": 0, "lastFrameExclusive": meta["frames"]},
        "capability": "subject.matte",
        "parameters": {
            "output": {"handleId": "out", "absolutePath": str(staging),
                       "allowedFiles": ["matte.mkv", "frames.json", "report.json"], "maxBytes": 4 * 1024**3},
            # Auto mode's prompt: the subject.detect box on the first frame (a perfect detector here).
            "prompts": [{"kind": "box", "pts": first_pts, "box": meta["box"]}],
            "previewHeight": 180,
        },
    }  # fmt: skip


def run_clip(name: str) -> int:
    clip_dir = PILOT_DIR / name
    out = RUNS_DIR / name
    staging = out / "staging"
    if staging.exists():
        shutil.rmtree(staging)
    (staging / "inputs").mkdir(parents=True)
    env = {
        **os.environ,
        "FRAMEPILOT_SMART_MASK_MODELS_DIR": os.environ.get("FRAMEPILOT_SMART_MASK_MODELS_DIR", str(PACK / ".cache" / "onnx")),
        "FRAMEPILOT_SMART_MASK_FFMPEG": str(PACK / ".cache" / "ffmpeg-lgpl" / "bin" / "ffmpeg"),
        "FRAMEPILOT_SMART_MASK_FFPROBE": str(PACK / ".cache" / "ffmpeg-lgpl" / "bin" / "ffprobe"),
        "FRAMEPILOT_SMART_MASK_MATTING_TILE": os.environ.get("FRAMEPILOT_SMART_MASK_MATTING_TILE", "768"),
        "FRAMEPILOT_SMART_MASK_MEMORY_CEILING_MIB": os.environ.get("FRAMEPILOT_SMART_MASK_MEMORY_CEILING_MIB", "7680"),
        "FRAMEPILOT_SMART_MASK_LOG_LEVEL": "INFO",
    }  # fmt: skip
    started = time.time()
    completed = subprocess.run(
        [str(ENTRYPOINT), "--framepilot-worker-runtime"],
        input=json.dumps(request_for(clip_dir, staging)) + "\n",
        capture_output=True, text=True, env=env, check=False,
    )  # fmt: skip
    lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    terminal = lines[-1] if lines else {"type": "failure", "code": "no_output"}
    (out / "result.json").write_text(json.dumps({"terminal": terminal, "seconds": round(time.time() - started, 1),
                                                 "exitCode": completed.returncode}, indent=2))  # fmt: skip
    (out / "stderr.log").write_text(completed.stderr[-200_000:])
    return 0 if terminal.get("type") == "result" else 1


# --- scoring -----------------------------------------------------------------------------------


def boundary(mask: np.ndarray) -> np.ndarray:
    m = mask.astype(np.uint8)
    return (m - cv2.erode(m, np.ones((3, 3), np.uint8))).astype(bool)


def boundary_f(pred: np.ndarray, gt: np.ndarray, tolerance: int = 2) -> float:
    bp, bg = boundary(pred), boundary(gt)
    if not bp.any() and not bg.any():
        return 1.0
    if not bp.any() or not bg.any():
        return 0.0
    to_gt = cv2.distanceTransform((~bg).astype(np.uint8), cv2.DIST_L2, 5)
    to_pred = cv2.distanceTransform((~bp).astype(np.uint8), cv2.DIST_L2, 5)
    precision = float((to_gt[bp] <= tolerance).mean())
    recall = float((to_pred[bg] <= tolerance).mean())
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def iou(pred: np.ndarray, gt: np.ndarray) -> float:
    union = np.logical_or(pred, gt).sum()
    return 1.0 if union == 0 else float(np.logical_and(pred, gt).sum() / union)


def wilson_lower(successes: int, n: int, z: float = 1.96) -> float | None:
    if n == 0:
        return None
    p = successes / n
    denominator = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre - margin) / denominator


def load_run(name: str) -> dict[str, Any] | None:
    out = RUNS_DIR / name
    result_path = out / "result.json"
    if not result_path.is_file():
        return None
    result = json.loads(result_path.read_text())
    if result["terminal"].get("type") != "result":
        return {"name": name, "failed": result["terminal"]}
    meta = json.loads((PILOT_DIR / name / "meta.json").read_text())
    report = json.loads((out / "staging" / "report.json").read_text())
    width, height, count = meta["width"], meta["height"], meta["frames"]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out / "staging" / "matte.mkv"), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, check=True).stdout  # fmt: skip
    matte = np.frombuffer(raw, np.uint8).reshape(count, height, width)
    truth = np.load(PILOT_DIR / name / "gt_alpha.npz")["alpha"]
    frames = []
    for index in range(count):
        pred, gt = matte[index] >= 128, truth[index] >= 128
        frame_iou, bf = iou(pred, gt), boundary_f(pred, gt)
        frames.append({
            "iou": frame_iou, "bf": bf, "wrong": frame_iou < WRONG_IOU or bf < WRONG_BF,
            "checks": report["frames"][index]["checks"], "signals": report["frames"][index]["signals"],
            "locked": report["frames"][index]["locked"],
        })  # fmt: skip
    return {"name": name, "category": meta["category"], "split": meta["split"], "frames": frames,
            "seconds": result["seconds"], "job": report["job"]}  # fmt: skip


def score(runs: list[dict[str, Any]], thresholds: Thresholds | None) -> dict[str, Any]:
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
        category_wrong = sum(frame["wrong"] for frame in run["frames"])
        category_caught = sum(
            1 for frame, flag in zip(run["frames"], flags, strict=True) if frame["wrong"] and flag
        )
        category_flagged = sum(1 for flag in flags if flag)
        ious = [frame["iou"] for frame in run["frames"]]
        per_category[run["category"]] = {
            "frames": len(ious), "wrong": category_wrong, "caught": category_caught, "flagged": category_flagged,
            "meanIoU": round(float(np.mean(ious)), 4), "p5IoU": round(float(np.percentile(ious, 5)), 4),
            "meanBF": round(float(np.mean([frame["bf"] for frame in run["frames"]])), 4),
        }  # fmt: skip
        misses += [{"clip": run["name"], "frame": i, "iou": round(frame["iou"], 4), "bf": round(frame["bf"], 4)}
                   for i, (frame, flag) in enumerate(zip(run["frames"], flags, strict=True)) if frame["wrong"] and not flag]  # fmt: skip
        total += len(ious)
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
    return dataclasses.replace(best, version="br3.15-calibrated"), trace


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
    forward = dataclasses.replace(forward, version="br3.15-calibrated")
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


def report(date: str) -> dict[str, Any]:
    names = sorted(path.name for path in PILOT_DIR.iterdir() if (path / "meta.json").is_file())
    loaded = [load_run(name) for name in names]
    runs = [run for run in loaded if run is not None and "failed" not in run]
    failures = [run for run in loaded if run is not None and "failed" in run]
    not_run = [name for name, run in zip(names, loaded, strict=True) if run is None]
    calibration = [run for run in runs if run["split"] == "calibration"]
    scored = [run for run in runs if run["split"] == "scored"]
    shipped = Thresholds()
    fitted, trace = best_calibration(calibration) if calibration else (shipped, {})
    accuracy = {
        split: {
            "meanIoU": round(float(np.mean([f["iou"] for r in group for f in r["frames"]])), 4) if group else None,
            "p5IoU": round(float(np.percentile([f["iou"] for r in group for f in r["frames"]], 5)), 4) if group else None,
            "meanBF": round(float(np.mean([f["bf"] for r in group for f in r["frames"]])), 4) if group else None,
            "wrongFraction": round(float(np.mean([f["wrong"] for r in group for f in r["frames"]])), 4) if group else None,
        }
        for split, group in (("calibration", calibration), ("scored", scored))
    }  # fmt: skip
    return {
        "date": date,
        "platform": f"{sys.platform}-{platform.machine()}",
        "gates": {"recall": RECALL_GATE, "reviewLoad": REVIEW_GATE, "wrongFrame": {"iou": WRONG_IOU, "bf": WRONG_BF}},
        "clips": {"run": [run["name"] for run in runs], "failed": [{"name": f["name"], "terminal": f["failed"]} for f in failures], "notRun": not_run},
        "accuracy": accuracy,
        "shippedThresholds": {"thresholds": shipped.as_json(), "calibration": score(calibration, shipped), "scored": score(scored, shipped)},
        "calibratedThresholds": {"thresholds": fitted.as_json(), "fittedOn": "calibration", "trace": trace,
                                 "calibration": score(calibration, fitted), "scored": score(scored, fitted)},
        "secondsPerClip": {run["name"]: run["seconds"] for run in runs},
        "job": runs[0]["job"] if runs else None,
    }  # fmt: skip


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("clips", nargs="+")
    commands.add_parser("score")
    arguments = parser.parse_args()
    if arguments.command == "run":
        return max(run_clip(name) for name in arguments.clips)
    date = time.strftime("%Y-%m-%d")
    result = report(date)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORTS_DIR / f"{date}-{result['platform']}.json"
    path.write_text(json.dumps(result, indent=2) + "\n")
    summary = {
        key: result["calibratedThresholds"]["scored"][key]
        for key in ("frames", "wrongFrames", "recall", "reviewLoad")
    }
    sys.stdout.write(
        json.dumps(
            {
                "report": str(path.relative_to(PACK)),
                "scored": summary,
                "accuracy": result["accuracy"],
            }
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
