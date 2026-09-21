"""Plan 13 SP5: the Fast engine against the 06 per-frame gates, on the scored split.

The full harness (``run_eval.py``) scores the MODELS: its calibration, ablations, one-click and
correction gates are about SAM + BiRefNet and do not apply to a Vision matte. What does apply is
the per-frame rule every matte is judged by, and whether the checks that flag frames for review
catch the wrong ones. This script runs the installed entrypoint with ``quality: fast`` on every
scored fixture and reports exactly those::

    .venv/bin/python eval/pilot.py --split scored          # render the fixtures once
    .venv/bin/python eval/fast_gates.py                     # → reports/smart-mask/<date>-fast-<platform>.json

Gates (06): per frame, wrong = IoU(α ≥ 0.5) < 0.98 or BF@2px < 0.95; error-detection recall =
wrong frames flagged / wrong frames (≥ 99.5%); review load = flagged / frames (≤ 10%); band SAD and
dtSSD are reported, not gated here (their gates compare against a models baseline).

READ THE RESULT WITH THIS IN MIND: the pilot's subjects are generated figures composited over
film stills. Vision is trained on photographs of real people and objects; a rendered puppet is
off its distribution in a way real footage is not. A pass here is evidence; a miss on a synthetic
category is a question about the fixture as much as about the engine. macOS only.
"""

from __future__ import annotations

import json
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

from entrypoint import decode_matte, fresh_staging, run_request  # noqa: E402
from fixtures import discover  # noqa: E402
from matte_metrics import band_sad, binarise, boundary_f, dtssd, iou, unknown_band  # noqa: E402
from run_eval import request_for  # noqa: E402

PILOT = PACK / ".cache" / "pilot-br3"
RUNS = PACK / ".cache" / "eval-fast"
IOU_GATE = 0.98
BF_GATE = 0.95
RECALL_GATE = 0.995
REVIEW_LOAD_GATE = 0.10


def score_clip(fixture: Any) -> dict[str, Any]:
    out = RUNS / fixture.name
    out.mkdir(parents=True, exist_ok=True)
    staging = fresh_staging(out)
    request = request_for(fixture, staging, "auto")
    request["parameters"]["quality"] = "fast"
    result = run_request(request, out)
    if result["terminal"].get("type") != "result":
        return {"clip": fixture.name, "failed": result["terminal"]}
    matte = decode_matte(staging / "matte.mkv", fixture.frames, fixture.height, fixture.width)
    report = json.loads((staging / "report.json").read_text())
    flagged = [bool(frame.get("checks")) for frame in report["frames"]]
    ious, bfs, sads, wrong = [], [], [], []
    for index in fixture.scored_frames():
        truth = fixture.truth(index)
        predicted, expected = binarise(matte[index]), binarise(truth)
        ious.append(iou(predicted, expected))
        bfs.append(boundary_f(predicted, expected))
        sads.append(band_sad(matte[index], truth, unknown_band(truth)))
        wrong.append(ious[-1] < IOU_GATE or bfs[-1] < BF_GATE)
    frames = fixture.scored_frames()
    caught = sum(1 for i, bad in zip(frames, wrong, strict=True) if bad and flagged[i])
    return {
        "clip": fixture.name,
        "category": fixture.category,
        "seconds": result["seconds"],
        "framesPerSecond": round(fixture.frames / max(result["seconds"], 1e-6), 2),
        "meanIoU": round(float(np.mean(ious)), 4),
        "minIoU": round(float(np.min(ious)), 4),
        "meanBF2px": round(float(np.mean(bfs)), 4),
        "wrongFrames": int(sum(wrong)),
        "wrongCaught": caught,
        "flaggedFrames": int(sum(flagged)),
        "frames": len(frames),
        "bandSAD": round(float(np.mean(sads)), 3),
        "dtSSD": dtssd([matte[i] for i in frames], [fixture.truth(i) for i in frames]),
    }


def main() -> int:
    fixtures, _skipped = discover([PILOT])
    scored = [fixture for fixture in fixtures if fixture.split == "scored"]
    if not scored:
        print("No scored fixtures: run eval/pilot.py --split scored first.", file=sys.stderr)
        return 2
    rows = [score_clip(fixture) for fixture in scored]
    ok = [row for row in rows if "failed" not in row]
    frames = sum(row["frames"] for row in ok)
    wrong = sum(row["wrongFrames"] for row in ok)
    caught = sum(row["wrongCaught"] for row in ok)
    flagged = sum(row["flaggedFrames"] for row in ok)
    summary = {
        "engine": "fast (Apple Vision)",
        "groundTruth": "construction-true only (generated subjects; see the module docstring)",
        "platform": f"{platform.system().lower()}-{platform.machine()}",
        "clips": len(rows),
        "failedClips": [row["clip"] for row in rows if "failed" in row],
        "categoriesMeanIoUAtLeast0_98": sum(1 for row in ok if row["meanIoU"] >= IOU_GATE),
        "categoriesMeanBFAtLeast0_95": sum(1 for row in ok if row["meanBF2px"] >= BF_GATE),
        "wrongFrameShare": round(wrong / max(frames, 1), 4),
        "errorDetectionRecall": None if wrong == 0 else round(caught / wrong, 4),
        "recallGate": RECALL_GATE,
        "reviewLoad": round(flagged / max(frames, 1), 4),
        "reviewLoadGate": REVIEW_LOAD_GATE,
        "meanFramesPerSecond": round(float(np.mean([row["framesPerSecond"] for row in ok])), 2)
        if ok
        else None,
    }
    stem = f"{time.strftime('%Y-%m-%d')}-fast-{summary['platform']}"
    target = REPO / "reports" / "smart-mask" / f"{stem}.json"
    target.write_text(json.dumps({"summary": summary, "clips": rows}, indent=1) + "\n")
    print(json.dumps(summary, indent=1))
    for row in rows:
        print(json.dumps(row))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
