"""Correction convergence (plan 06 gate): replay corrective actions through the entrypoint.

Gate: a corrected frame reaches IoU ≥ 0.995 and BF@2px ≥ 0.98 in ≤ 3 actions, and frames within
1 s of it do not regress. Plus the locked-frames gate: a frame locked in action 1 is bit-identical
to its lock after every later re-run.

**Where the actions come from.** 06 asks for "the minimal corrective clicks and brushes a
labeller recorded". A fixture may carry that recording (``corrections.json``, below); it is
replayed as recorded. The construction-true pilot has no labeller, so its actions are
**scripted from ground truth**, and the report says so for every replay:

1. Keep brush over missed subject pixels and Remove brush over leaked background, each taken
   one pixel inside the ground-truth edge (a stroke that stays off the boundary, as an editor at
   400% would); plus a lock on the frame farthest from the target.
2. Edge brush over the ground truth's soft band where alpha is still off by more than 1/8, plus
   the Keep/Remove rule again on what is still wrong.
3. Keep/Remove on every pixel still wrong, up to the edge (pixel-exact).

Each action is ONE "Apply fix": one brush PNG for the target frame that carries the earlier
strokes too (one correction per frame, the host's rule), then a partial re-run with the previous
artifact, exactly as the Inspector sends it.

``corrections.json`` (optional, recorded by a labeller)::

    {"frame": 17, "actions": [{"brush": "corrections/a1.png"},
                              {"points": [{"x": 0.4, "y": 0.5, "label": "include"}]}]}
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import numpy.typing as npt
from entrypoint import decode_matte, fresh_staging, run_request, sha256_file, source_pts
from fixtures import Fixture
from matte_metrics import binarise, boundary_f, iou

U8 = npt.NDArray[np.uint8]
KEEP, REMOVE, EDGE, UNTOUCHED = 255, 0, 64, 128
CONVERGED_IOU = 0.995
CONVERGED_BF = 0.98
MAX_ACTIONS = 3
#: A neighbour "regresses" when its IoU drops by more than this after a correction.
NEIGHBOUR_TOLERANCE = 0.001
#: Edge brush where alpha is off by more than this in the ground truth's soft band.
EDGE_ERROR = 32


def _disk(radius: int) -> npt.NDArray[Any]:
    kernel: npt.NDArray[Any] = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)
    )
    return kernel


def scripted_brush(pred: U8, gt: U8, action: int, previous: U8 | None) -> U8:
    """The brush PNG for scripted action ``action`` (1-based), carrying earlier strokes."""
    brush = previous.copy() if previous is not None else np.full(gt.shape, UNTOUCHED, np.uint8)
    truth = binarise(gt)
    mask = binarise(pred)
    missed = truth & ~mask
    leaked = mask & ~truth
    if action < MAX_ACTIONS:
        inside = cv2.erode(truth.astype(np.uint8), _disk(1)).astype(bool)
        outside = ~cv2.dilate(truth.astype(np.uint8), _disk(1)).astype(bool)
        missed &= inside
        leaked &= outside
    if action == 2:
        soft = (gt > 0) & (gt < 255)
        off = np.abs(pred.astype(np.int16) - gt.astype(np.int16)) > EDGE_ERROR
        brush[soft & off & (brush == UNTOUCHED)] = EDGE
    brush[missed] = KEEP
    brush[leaked] = REMOVE
    return brush


@dataclass
class ReplayPlan:
    target: int
    lock: int
    source: str  # "scripted-from-ground-truth" | "labeller-recording"


def plan_replay(fixture: Fixture, base: U8) -> ReplayPlan:
    """Target = the scored frame with the worst IoU (ties: worst BF); lock = the farthest frame
    from it other than frame 0, which carries the auto prompt."""
    frames = fixture.scored_frames()
    scores = []
    for index in frames:
        pred, truth = binarise(base[index]), binarise(fixture.truth(index))
        scores.append((iou(pred, truth), boundary_f(pred, truth), index))
    target = min(scores)[2]
    recording = fixture.directory / "corrections.json"
    if recording.is_file():
        target = int(json.loads(recording.read_text())["frame"])
    # Never the prompt frame: a locked frame cannot also carry the box (the worker refuses).
    lock = max((index for index in frames if index != 0), key=lambda index: abs(index - target))
    source = "labeller-recording" if recording.is_file() else "scripted-from-ground-truth"
    return ReplayPlan(target=target, lock=lock, source=source)


def _write_png(path: Path, image: U8) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), image):
        raise OSError(f"could not write {path.name}")


def _metrics(fixture: Fixture, matte: U8, index: int) -> dict[str, float]:
    pred, truth = binarise(matte[index]), binarise(fixture.truth(index))
    return {"iou": round(iou(pred, truth), 5), "bf": round(boundary_f(pred, truth), 5)}


def replay(
    fixture: Fixture, base_staging: Path, out_root: Path, request_base: dict[str, Any]
) -> dict[str, Any]:
    """Run up to three actions on the worst frame of ``fixture``; returns the replay record."""
    count, height, width = fixture.frames, fixture.height, fixture.width
    base = decode_matte(base_staging / "matte.mkv", count, height, width)
    plan = plan_replay(fixture, base)
    pts = source_pts(fixture.clip)[:count]
    neighbours = [
        index for index in fixture.scored_frames()
        if index != plan.target and abs(index - plan.target) <= round(fixture.fps)
    ]  # fmt: skip
    before = {index: _metrics(fixture, base, index) for index in [plan.target, *neighbours]}
    lock_alpha = base[plan.lock].copy()
    recorded: list[dict[str, Any]] = []
    if plan.source == "labeller-recording":
        recorded = json.loads((fixture.directory / "corrections.json").read_text())["actions"]
    actions: list[dict[str, Any]] = []
    previous_staging, previous_matte, brush = base_staging, base, None
    for number in range(1, MAX_ACTIONS + 1):
        if plan.source == "labeller-recording" and number > len(recorded):
            break
        out = out_root / f"action-{number}"
        out.mkdir(parents=True, exist_ok=True)
        staging = fresh_staging(out)
        inputs = staging / "inputs"
        (inputs / "previous").mkdir()
        shutil.copyfile(previous_staging / "matte.mkv", inputs / "previous" / "matte.mkv")
        shutil.copyfile(previous_staging / "frames.json", inputs / "previous" / "frames.json")
        files = ["previous/matte.mkv", "previous/frames.json"]
        prompts = list(request_base["parameters"]["prompts"])
        target_pts, lock_pts = pts[plan.target], pts[plan.lock]
        step: dict[str, Any] = {"action": number}
        if plan.source == "labeller-recording":
            entry = recorded[number - 1]
            if "brush" in entry:
                brush = cv2.imread(str(fixture.directory / entry["brush"]), cv2.IMREAD_UNCHANGED)
            if "points" in entry:
                prompts.append({"kind": "points", "pts": target_pts, "points": entry["points"]})
                step["points"] = len(entry["points"])
        else:
            brush = scripted_brush(
                previous_matte[plan.target], fixture.truth(plan.target), number, brush
            )
        if brush is not None:
            name = f"corrections/{target_pts}.png"
            _write_png(inputs / name, brush)
            files.append(name)
            prompts.append({"kind": "brush", "pts": target_pts, "file": name})
            step["brushPixels"] = {
                "keep": int((brush == KEEP).sum()), "remove": int((brush == REMOVE).sum()),
                "edge": int((brush == EDGE).sum()),
            }  # fmt: skip
        lock_name = f"locked/{lock_pts}.png"
        _write_png(inputs / lock_name, lock_alpha)
        files.append(lock_name)
        prompts.append({"kind": "lock", "pts": lock_pts, "file": lock_name})
        request = json.loads(json.dumps(request_base))
        request["requestId"] = f"{request_base['requestId']}-fix{number}"[:64]
        request["parameters"]["output"]["absolutePath"] = str(staging)
        request["parameters"]["prompts"] = prompts
        request["parameters"]["inputs"] = {
            "handleId": "in",
            "absolutePath": str(inputs),
            "files": files,
        }
        request["parameters"]["previousArtifact"] = sha256_file(inputs / "previous" / "matte.mkv")
        result = run_request(request, out)
        step["seconds"] = result["seconds"]
        if result["terminal"].get("type") != "result":
            step["failed"] = result["terminal"]
            actions.append(step)
            break
        matte = decode_matte(staging / "matte.mkv", count, height, width)
        step["target"] = _metrics(fixture, matte, plan.target)
        step["lockBitIdentical"] = bool(np.array_equal(matte[plan.lock], lock_alpha))
        drops = [
            before[index]["iou"] - _metrics(fixture, matte, index)["iou"] for index in neighbours
        ]
        step["worstNeighbourIoUDrop"] = round(max(drops), 5) if drops else 0.0
        step["neighboursRegressed"] = sum(drop > NEIGHBOUR_TOLERANCE for drop in drops)
        step["converged"] = (
            step["target"]["iou"] >= CONVERGED_IOU and step["target"]["bf"] >= CONVERGED_BF
        )
        actions.append(step)
        previous_staging, previous_matte = staging, matte
        if step["converged"]:
            break
    converged_at = next((a["action"] for a in actions if a.get("converged")), None)
    record = {
        "fixture": fixture.name,
        "category": fixture.category,
        "groundTruth": fixture.ground_truth,
        "actionsFrom": plan.source,
        "targetFrame": plan.target,
        "lockedFrame": plan.lock,
        "neighbourFrames": len(neighbours),
        "before": before[plan.target],
        "actions": actions,
        "convergedAtAction": converged_at,
        "converged": converged_at is not None
        and all(a.get("neighboursRegressed", 1) == 0 for a in actions[:converged_at]),
        "locksBitIdentical": all(a.get("lockBitIdentical", False) for a in actions)
        if actions
        else None,
    }
    (out_root / "replay.json").write_text(json.dumps(record, indent=2))
    return record


__all__ = ["MAX_ACTIONS", "ReplayPlan", "plan_replay", "replay", "scripted_brush"]
