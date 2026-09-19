"""AM2.7: the colour re-ranker replayed on real SigLIP 2 scores plus the engine's measurement.

WHAT THIS IS. ``workers/visual-embed/tools/colour_rerank_eval.py`` runs the real SigLIP 2 worker
on generated crops (cars and balls in the twelve palette colours, H.264 4:2:0) and can write every
crop's vector. Those runs need the pinned weights and happen on the maintainer's machine, one at a
time under the spike watchdog. This module turns their vectors into a replay set that CI can
score without the weights:

* every crop's cosine with its noun's twelve palette prompts (all SigLIP contributes to the rule);
* every crop's colour MEASUREMENT (``framepilot_engine.masking.crop_colour``), taken from the
  same generated pictures, which are regenerated deterministically from the scene seed;
* the threshold fit on the calibration sets, and the frozen thresholds the shipped TypeScript
  uses (``packages/ai-sdk/src/masking/colour-measure.ts``).

THE SETS. Calibration: seeds 20260919 (the AM2.6 reported set) and 7 (the AM2.6 held-out set),
plus three hand-boxed objects in ``broll/b4-1080p-50s.mp4`` (a fetched fixture, measured
locally only). Held-out: seed 424242, generated after the thresholds were frozen.

THE RULE (``colour-rerank.ts`` ``agreedColourPick``, mirrored below): a candidate is picked only
when SigLIP and the measurement both say it is clearly the named colour; otherwise the resolver
asks. Chromatic colours: SigLIP's decisive pick (AM2.6 evidence, >= 0.5 and 1.25x the runner-up)
whose crop measures chromatic. White, grey, silver, black: the one crop in that lightness class
with no crop in a band next to it (nor mixed, nor unmeasured), whose SigLIP top colour is neutral
and at most one step away on black-grey-silver-white, and SigLIP names the colour for no rival
unless it names it for the pick too.

Build (maintainer, after a SigLIP run wrote ``v-<seed>.json`` with ``--all-vectors-out``)::

    cd engine/python && uv run python -m tests.colour_rerank_replay build \\
        --vectors-dir <dir> --mission-dir <tests/fixtures/mission>

``harness`` (same ``--vectors-dir``) writes ``colour-rerank-harness-vectors.json``: the real fp16
vectors and measurements of the held-out crops the AM5 eval's coloured things name
(``tests/fixtures/ai-masking/request-set.json`` ``recordedCrop``). ``report`` re-scores the
committed replay into ``colour-rerank.json`` (``pnpm colour-rerank:replay``).

CI (``test_colour_rerank_replay.py``) re-derives every number from the committed files, and
regenerates the synthetic crops to check the committed measurements against a fresh decode.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import itertools
import json
import logging
import math
import struct
import sys
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np

from framepilot_engine.masking.crop_colour import MAX_CROPS, CropBox, CropColour, measure_crops

_log = logging.getLogger(__name__)

REPO = Path(__file__).resolve().parents[3]
EVAL_TOOL = REPO / "workers" / "visual-embed" / "tools" / "colour_rerank_eval.py"
REPORTS = REPO / "reports" / "ai-masking"
REPLAY_FILE = REPORTS / "colour-rerank-replay.json"
VECTORS_FILE = REPORTS / "colour-rerank-siglip2-vectors.json"
REPORT_FILE = REPORTS / "colour-rerank.json"
HARNESS_FILE = REPORTS / "colour-rerank-harness-vectors.json"
REQUEST_SET = REPO / "tests" / "fixtures" / "ai-masking" / "request-set.json"

#: (set name, role, seed). Held-out was generated after the thresholds were frozen.
SYNTHETIC_SETS = (
    ("calibration-20260919", "calibration", 20260919),
    ("calibration-7", "calibration", 7),
    ("heldOut-424242", "heldOut", 424242),
)
REAL_SET = "calibration-real-b4"
NEUTRAL_SCALE = ("black", "grey", "silver", "white")
#: A regenerated crop must measure within these of the committed value (a different ffmpeg or
#: x264 build encodes and decodes a few levels differently), and in the same class.
SHARE_TOLERANCE = 0.05
LIGHTNESS_TOLERANCE = 2.0
#: Rules replayed: SigLIP alone (what shipped before AM2.7) and SigLIP + measurement.
RULES = ("am2.6", "am2.7")
GATES = {
    "targetAccuracy": (">=", 0.99),
    "unnecessaryAskRate": ("<=", 0.03),
    "absentColourAskRate": (">=", 0.97),
    "confidentWrong": ("==", 0),
}


def eval_tool() -> ModuleType:
    """The SigLIP eval tool, loaded by path: its scene generator and AM2.6 rule are the source."""
    loaded = sys.modules.get("colour_rerank_eval")
    if loaded is not None:
        return loaded
    spec = importlib.util.spec_from_file_location("colour_rerank_eval", EVAL_TOOL)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {EVAL_TOOL}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["colour_rerank_eval"] = module
    spec.loader.exec_module(module)
    return module


# --- Measurement --------------------------------------------------------------------------


def measurement_json(colour: CropColour | None) -> dict[str, float | None] | None:
    """The two numbers the rule reads, rounded as committed."""
    if colour is None:
        return None
    lightness = colour.neutral_lightness
    return {
        "neutralShare": round(colour.neutral_share, 4),
        "neutralLightness": None if lightness is None else round(lightness, 3),
    }


def scene_digest(frames: Sequence[np.ndarray]) -> str:
    """sha256 over the generated pictures: regenerated scenes must be these exact pixels."""
    digest = hashlib.sha256()
    for frame in frames:
        digest.update(np.ascontiguousarray(frame).tobytes())
    return digest.hexdigest()


@dataclass(frozen=True)
class MeasuredSet:
    digest: str
    frames: list[dict[str, Any]]
    measurements: dict[str, dict[str, float | None] | None]


def measure_synthetic(seed: int) -> MeasuredSet:
    """Regenerate one seed's scenes, encode them as the eval tool does, and measure every crop."""
    tool = eval_tool()
    frames, crops, _items = tool.build_scenes(seed)
    layout: dict[int, dict[str, Any]] = {}
    for crop in crops:
        entry = layout.setdefault(crop.frame, {"noun": crop.noun, "crops": []})
        entry["crops"].append({"id": crop.crop_id, "colour": crop.colour})
    for index, entry in layout.items():
        per_background = len(tool.NOUNS) * tool.SCENES_PER_BACKGROUND_AND_NOUN
        entry["background"] = tool.BACKGROUNDS[index // per_background]
    with tempfile.TemporaryDirectory(prefix="colour-replay-") as scratch:
        video = Path(scratch) / "scenes.mp4"
        tool.encode_video(frames, video)
        boxes = [CropBox(tool.keyframe_time(crop.frame), *crop.box) for crop in crops]
        measured: list[CropColour | None] = []
        for start in range(0, len(boxes), MAX_CROPS):
            measured += measure_crops(video, tool.FPS, boxes[start : start + MAX_CROPS])
    return MeasuredSet(
        digest=scene_digest(frames),
        frames=[layout[index] for index in sorted(layout)],
        measurements={
            crop.crop_id: measurement_json(colour)
            for crop, colour in zip(crops, measured, strict=True)
        },
    )


def measure_real(mission_dir: Path) -> MeasuredSet:
    tool = eval_tool()
    video = mission_dir / tool.REAL_CLIP
    boxes = [CropBox(tool.REAL_TIME, *box) for _name, _colour, box in tool.REAL_OBJECTS]
    measured = measure_crops(video, 29.97, boxes)
    ids = [f"real-{name}" for name, _colour, _box in tool.REAL_OBJECTS]
    frame = {
        "noun": "object",
        "background": "real-b4",
        "crops": [
            {"id": crop_id, "colour": colour}
            for crop_id, (_name, colour, _box) in zip(ids, tool.REAL_OBJECTS, strict=True)
        ],
    }
    return MeasuredSet(
        digest="",
        frames=[frame],
        measurements={
            crop_id: measurement_json(colour) for crop_id, colour in zip(ids, measured, strict=True)
        },
    )


# --- SigLIP scores ---------------------------------------------------------------------------


def unpack_fp16(packed: str) -> np.ndarray:
    raw = base64.b64decode(packed)
    return np.array(struct.unpack(f"<{len(raw) // 2}e", raw), dtype=np.float64)


def crop_cosines(
    vectors: Mapping[str, Any], crop_ids: Sequence[str], noun_of: Mapping[str, str]
) -> dict[str, list[float]]:
    """Each crop's cosine with its noun's palette prompts, from the worker's fp16 vectors."""
    prompts = {
        noun: np.array([unpack_fp16(vector) for vector in packed])
        for noun, packed in vectors["prompts"].items()
    }
    out: dict[str, list[float]] = {}
    for crop_id in crop_ids:
        crop = unpack_fp16(vectors["crops"][crop_id])
        bank = prompts[noun_of[crop_id]]
        norms = np.linalg.norm(bank, axis=1) * np.linalg.norm(crop)
        cosines = [float(value) for value in (bank @ crop) / norms]
        # The TypeScript replay embeds these in a 13-d unit vector; that needs sum(c^2) < 1.
        if sum(value * value for value in cosines) >= 1:
            raise ValueError(f"{crop_id}: cosines too large to embed")
        out[crop_id] = cosines
    return out


def distribution(cosines: Sequence[float]) -> list[float]:
    """The crop's palette classification: softmax of cosine / temperature (``colour-rerank.ts``)."""
    tool = eval_tool()
    logits = [value / tool.TEMPERATURE for value in cosines]
    peak = max(logits)
    weights = [math.exp(logit - peak) for logit in logits]
    return [weight / sum(weights) for weight in weights]


# --- Thresholds ------------------------------------------------------------------------------


def fit_thresholds(samples: Sequence[tuple[str, Mapping[str, Any]]]) -> dict[str, Any]:
    """The fit on calibration crops: each band is the middle half of the gap between neighbours.

    :param samples: ``(true colour, measurement)`` for every calibration crop.
    """
    tool = eval_tool()
    achromatic = tool.ACHROMATIC

    def split(low_max: float, high_min: float) -> tuple[float, float]:
        gap = high_min - low_max
        if gap <= 0:
            raise ValueError(f"calibration classes overlap: {low_max} >= {high_min}")
        return low_max + gap / 4, high_min - gap / 4

    shares = [(colour, float(m["neutralShare"])) for colour, m in samples]
    chromatic_max, neutral_min = split(
        max(share for colour, share in shares if colour not in achromatic),
        min(share for colour, share in shares if colour in achromatic),
    )

    def tones(colour: str) -> list[float]:
        return [float(m["neutralLightness"]) for c, m in samples if c == colour]

    bands = []
    for dark, light in itertools.pairwise(NEUTRAL_SCALE):
        dark_max, light_min = split(max(tones(dark)), min(tones(light)))
        bands.append({"dark": dark, "darkMax": dark_max, "lightMin": light_min})
    return {"chromaticMaxShare": chromatic_max, "neutralMinShare": neutral_min, "lightness": bands}


def frozen_from_fit(fit: Mapping[str, Any]) -> dict[str, Any]:
    """The fit as the shipped constants spell it: shares to 2 decimals, lightness to 1."""
    return {
        "chromaticMaxShare": round(fit["chromaticMaxShare"], 2),
        "neutralMinShare": round(fit["neutralMinShare"], 2),
        "lightness": [
            {
                "dark": band["dark"],
                "darkMax": round(band["darkMax"], 1),
                "lightMin": round(band["lightMin"], 1),
            }
            for band in fit["lightness"]
        ],
    }


# --- The rule (colour-measure.ts + colour-rerank.ts) -------------------------------------------


def measured_class(measurement: Mapping[str, Any] | None, thresholds: Mapping[str, Any]) -> str:
    if measurement is None:
        return "unmeasured"
    share = measurement["neutralShare"]
    if share <= thresholds["chromaticMaxShare"]:
        return "chromatic"
    tone = measurement["neutralLightness"]
    if share < thresholds["neutralMinShare"] or tone is None:
        return "mixed"
    for index, band in enumerate(thresholds["lightness"]):
        if tone <= band["darkMax"]:
            return str(band["dark"])
        if tone < band["lightMin"]:
            return f"{band['dark']}|{NEUTRAL_SCALE[index + 1]}"
    return "white"


def measured_neutral_pick(colour: str, classes: Sequence[str]) -> int | None:
    def might_be(measured: str) -> bool:
        if measured in ("mixed", "unmeasured"):
            return True
        return "|" in measured and colour in measured.split("|")

    if any(might_be(measured) for measured in classes):
        return None
    matches = [index for index, measured in enumerate(classes) if measured == colour]
    return matches[0] if len(matches) == 1 else None


def top_colour(shares: Sequence[float]) -> str:
    colours: Sequence[str] = eval_tool().COLOURS
    return colours[max(range(len(shares)), key=lambda index: (shares[index], -index))]


def decisive_index(evidence: Sequence[float]) -> int | None:
    tool = eval_tool()
    order = sorted(range(len(evidence)), key=lambda index: -evidence[index])
    first, second = order[0], order[1]
    top = evidence[first]
    decisive = top >= tool.MIN_GROUNDING and top >= evidence[second] * tool.MARGIN_RATIO
    return first if decisive else None


def agreed_pick(
    colour: str,
    distributions: Sequence[Sequence[float]],
    evidence: Sequence[float],
    classes: Sequence[str],
) -> int | None:
    """``agreedColourPick`` in ``colour-rerank.ts``."""
    if colour not in NEUTRAL_SCALE:
        pick = decisive_index(evidence)
        return pick if pick is not None and classes[pick] == "chromatic" else None
    pick = measured_neutral_pick(colour, classes)
    if pick is None:
        return None
    top = top_colour(distributions[pick])
    if top not in NEUTRAL_SCALE:
        return None
    if abs(NEUTRAL_SCALE.index(top) - NEUTRAL_SCALE.index(colour)) > 1:
        return None
    names_rival = any(
        index != pick and top_colour(shares) == colour for index, shares in enumerate(distributions)
    )
    return None if names_rival and top != colour else pick


# --- Scoring ---------------------------------------------------------------------------------


def items_of(frames: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Every colour on a frame (must pick that crop) and every one that is not (must ask)."""
    tool = eval_tool()
    items = []
    for frame in frames:
        ids = [crop["id"] for crop in frame["crops"]]
        on_frame = [crop["colour"] for crop in frame["crops"]]
        for crop in frame["crops"]:
            items.append(
                tool._item(
                    frame["background"], frame["noun"], crop["colour"], ids, crop["id"], on_frame
                )
            )
        for colour in tool.COLOURS:
            if colour not in on_frame:
                items.append(
                    tool._item(frame["background"], frame["noun"], colour, ids, None, on_frame)
                )
    return items


def decide_item(
    item: Mapping[str, Any],
    cosines: Mapping[str, Sequence[float]],
    measurements: Mapping[str, Mapping[str, Any] | None],
    thresholds: Mapping[str, Any],
    rule: str,
) -> str | None:
    tool = eval_tool()
    at = tool.COLOURS.index(item["colour"])
    candidates = item["candidates"]
    distributions = [distribution(cosines[candidate]) for candidate in candidates]
    evidence = [tool.evidence("am2.6", shares, at) for shares in distributions]
    if rule == "am2.6":
        picked: str | None = tool.decide(dict(zip(candidates, evidence, strict=True)))
        return picked
    classes = [measured_class(measurements.get(candidate), thresholds) for candidate in candidates]
    pick = agreed_pick(item["colour"], distributions, evidence, classes)
    return None if pick is None else candidates[pick]


def score_set(
    frames: Sequence[Mapping[str, Any]],
    cosines: Mapping[str, Sequence[float]],
    measurements: Mapping[str, Mapping[str, Any] | None],
    thresholds: Mapping[str, Any],
    rule: str,
) -> dict[str, Any]:
    tool = eval_tool()
    outcomes = []
    for item in items_of(frames):
        pick = decide_item(item, cosines, measurements, thresholds, rule)
        if pick is None:
            outcome = "asked"
        elif pick == item["expected"]:
            outcome = "correct"
        else:
            outcome = "wrong"
        outcomes.append({**item, "pick": pick, "outcome": outcome})
    summary = tool.summarise(outcomes)
    misses = [
        {key: row[key] for key in ("request", "candidates", "expected", "pick", "outcome")}
        for row in outcomes
        if row["outcome"] == "wrong" or (row["expected"] is not None and row["outcome"] == "asked")
    ]
    return {"summary": _compact(summary), "gates": gates_of(summary), "misses": misses}


def _compact(summary: Mapping[str, Any]) -> dict[str, Any]:
    keys = (
        "targetAccuracy",
        "unnecessaryAsks",
        "absentColourAskRate",
        "confidentWrong",
        "chromaticTargetAccuracy",
        "achromaticTargetAccuracy",
        "byColour",
    )
    return {key: summary[key] for key in keys}


def gates_of(summary: Mapping[str, Any]) -> dict[str, Any]:
    values = {
        "targetAccuracy": summary["targetAccuracy"]["rate"],
        "unnecessaryAskRate": summary["unnecessaryAsks"]["rate"],
        "absentColourAskRate": summary["absentColourAskRate"]["rate"],
        "confidentWrong": summary["confidentWrong"],
    }
    out = {}
    for name, (op, threshold) in GATES.items():
        value = values[name]
        passed = {
            ">=": value is not None and value >= threshold,
            "<=": value is not None and value <= threshold,
            "==": value == threshold,
        }[op]
        out[name] = {"threshold": f"{op} {threshold}", "value": value, "pass": passed}
    return out


def neutral_margins(
    frames: Sequence[Mapping[str, Any]],
    measurements: Mapping[str, Mapping[str, Any] | None],
    thresholds: Mapping[str, Any],
) -> dict[str, float | None]:
    """How close each neutral colour's crops came to leaving their class, in L* (smallest)."""
    # Black has no floor and white no ceiling: only the side facing a neighbour counts.
    lows = {"black": -math.inf}
    highs = {"white": math.inf}
    for index, band in enumerate(thresholds["lightness"]):
        highs[band["dark"]] = band["darkMax"]
        lows[NEUTRAL_SCALE[index + 1]] = band["lightMin"]
    margins: dict[str, float | None] = {}
    for colour in NEUTRAL_SCALE:
        tones = [
            measurements[crop["id"]]["neutralLightness"]  # type: ignore[index]
            for frame in frames
            for crop in frame["crops"]
            if crop["colour"] == colour and measurements.get(crop["id"]) is not None
        ]
        margins[colour] = (
            round(min(min(t - lows[colour], highs[colour] - t) for t in tones), 2)
            if tones
            else None
        )
    return margins


def replay_report(replay: Mapping[str, Any]) -> dict[str, Any]:
    """Every set scored under both rules, from the committed replay file alone."""
    thresholds = replay["thresholds"]["frozen"]
    sets = {}
    for name, entry in replay["sets"].items():
        crops = entry["crops"]
        cosines = {crop_id: value["cosines"] for crop_id, value in crops.items()}
        measurements = {crop_id: value["measurement"] for crop_id, value in crops.items()}
        sets[name] = {
            "role": entry["role"],
            **{
                rule: score_set(entry["frames"], cosines, measurements, thresholds, rule)
                for rule in RULES
            },
            "neutralMarginsL": neutral_margins(entry["frames"], measurements, thresholds),
        }
    return sets


# --- Build ----------------------------------------------------------------------------------


def build(vectors_dir: Path, mission_dir: Path | None) -> dict[str, Any]:
    """Measure every set, attach SigLIP cosines from the SigLIP runs, fit on calibration."""
    sets: dict[str, Any] = {}
    real_vectors = None
    for name, role, seed in SYNTHETIC_SETS:
        vectors = json.loads((vectors_dir / f"v-{seed}.json").read_text(encoding="utf-8"))
        measured = measure_synthetic(seed)
        noun_of = {
            crop["id"]: frame["noun"] for frame in measured.frames for crop in frame["crops"]
        }
        cosines = crop_cosines(vectors, list(noun_of), noun_of)
        sets[name] = _set_entry(role, seed, measured, cosines)
        if "real-lamp" in vectors["crops"]:
            real_vectors = vectors
        _log.info("measured %s: %d crops", name, len(noun_of))
    if mission_dir is not None and real_vectors is not None:
        measured = measure_real(mission_dir)
        noun_of = {crop["id"]: "object" for crop in measured.frames[0]["crops"]}
        cosines = crop_cosines(real_vectors, list(noun_of), noun_of)
        sets[REAL_SET] = {**_set_entry("calibration", None, measured, cosines), "local": True}
    samples = [
        (crop["colour"], entry["crops"][crop["id"]]["measurement"])
        for entry in sets.values()
        if entry["role"] == "calibration"
        for frame in entry["frames"]
        for crop in frame["crops"]
    ]
    fit = fit_thresholds(samples)
    return {
        "$comment": (
            "AM2.7 colour re-rank replay: real SigLIP 2 cosines (crop x its noun's 12 palette "
            "prompts, from the Visual Embed worker's fp16 vectors) and the engine's CIELAB crop "
            "measurement for every crop. Written by engine/python/tests/colour_rerank_replay.py; "
            "do not edit. The TypeScript replay embeds each crop's cosines in a 13-d unit vector "
            "so the shipped colourRerankScores reproduces them exactly."
        ),
        "colours": list(eval_tool().COLOURS),
        "temperature": eval_tool().TEMPERATURE,
        "thresholds": {"fit": fit, "frozen": frozen_from_fit(fit)},
        "sets": sets,
    }


def _set_entry(
    role: str, seed: int | None, measured: MeasuredSet, cosines: Mapping[str, list[float]]
) -> dict[str, Any]:
    return {
        "role": role,
        "seed": seed,
        "sceneDigest": measured.digest,
        "frames": measured.frames,
        "crops": {
            crop_id: {"cosines": cosines[crop_id], "measurement": measured.measurements[crop_id]}
            for crop_id in sorted(measured.measurements)
        },
    }


def annotate_vectors_file(replay: Mapping[str, Any]) -> None:
    """Add each crop's measurement and the AM2.7 decision to the 36-crop vector fixture, so the
    TypeScript parity test and the AM5 eval replay the measurement next to the real vectors."""
    fixture = json.loads(VECTORS_FILE.read_text(encoding="utf-8"))
    crops = replay["sets"]["calibration-20260919"]["crops"]
    measurements = {crop_id: crops[crop_id]["measurement"] for crop_id in fixture["crops"]}
    cosines = {crop_id: crops[crop_id]["cosines"] for crop_id in fixture["crops"]}
    thresholds = replay["thresholds"]["frozen"]
    fixture["measurements"] = measurements
    for item in fixture["items"]:
        item["pickMeasured"] = decide_item(item, cosines, measurements, thresholds, "am2.7")
    fixture["$comment"] = (
        fixture["$comment"].split(" AM2.7:")[0]
        + " AM2.7: measurements are the engine's CIELAB crop measurement of the same generated"
        " pictures; pickMeasured = the decision with it (colour_rerank_replay.py)."
    )
    VECTORS_FILE.write_text(json.dumps(fixture, indent=1) + "\n", encoding="utf-8")


def write_report(replay: Mapping[str, Any]) -> None:
    """Put the AM2.7 numbers into ``colour-rerank.json`` beside the AM2.6 ones."""
    report = json.loads(REPORT_FILE.read_text(encoding="utf-8"))
    sets = replay_report(replay)
    report["am2.7"] = {
        "$comment": (
            "AM2.7: SigLIP 2 (real vectors, as AM2.6 measured them) plus the engine's CIELAB "
            "measurement of each crop (framepilot_engine/masking/crop_colour.py, decoded by the "
            "export's ffmpeg). Scored by engine/python/tests/colour_rerank_replay.py from "
            "colour-rerank-replay.json; CI re-derives these numbers and re-measures the synthetic "
            "crops (test_colour_rerank_replay.py)."
        ),
        "measurement": {
            "region": "detection box weighted (1 - (u^2 + v^2))^2: 1 at the centre, 0 on the "
            "inscribed ellipse and in the corners; no matte (none exists at find time)",
            "colourPipeline": "export ffmpeg (find_export_ffmpeg), scale + bicubic + rgb24: the "
            "source's tagged BT.601/BT.709 matrix and range; R'G'B' read as sRGB, CIELAB D65",
            "neutralPixel": "C* < 16",
            "neutralShare": "weighted share of neutral pixels",
            "neutralLightness": "dominant L* of the neutral pixels: weighted median within 12 L* "
            "of the densest tone (so glass and tyres do not drag a white body to grey)",
        },
        "rule": (
            "Pick only when both signals agree. Chromatic colour: SigLIP's decisive pick (AM2.6 "
            "evidence >= 0.5 and >= 1.25x runner-up) whose crop measures chromatic. White, grey, "
            "silver, black: the single crop measured in that class, with no crop in a band next "
            "to it and none mixed or unmeasured; SigLIP's top colour for it must be neutral and at "
            "most one step away on black-grey-silver-white, and SigLIP must not name the colour "
            "for a rival while not naming it for the pick. Otherwise every candidate is held "
            "under the resolver's floor and the editor is asked."
        ),
        "thresholds": {
            **replay["thresholds"],
            "fitRule": "per neighbouring pair, the middle half of the calibration gap is a dead "
            "band (asks); frozen = fit rounded (shares 2 dp, L* 1 dp) before the held-out set "
            "was scored",
        },
        "sets": sets,
    }
    held_out = sets["heldOut-424242"]
    report.setdefault("am2.6Verdict", report["verdict"])
    report["verdict"] = (
        "AM2.7: with the engine's colour measurement beside SigLIP, every AM5 gate is met on the "
        "two calibration sets, the three real crops and the held-out set (seed 424242, generated "
        "and scored after the thresholds were frozen): held-out targets "
        f"{_fraction(held_out['am2.7']['summary']['targetAccuracy'])}, white/grey/silver/black "
        f"{_fraction(held_out['am2.7']['summary']['achromaticTargetAccuracy'])}, confident-wrong "
        f"{held_out['am2.7']['summary']['confidentWrong']}; SigLIP alone resolves "
        f"{_fraction(held_out['am2.6']['summary']['targetAccuracy'])} of the same targets. "
        "Caveat: the crops are flat renderings (no metallic sheen, no coloured light, no shadowed "
        "whites) and real footage is three objects; 'silver' is separated from 'grey' by "
        "lightness alone."
    )
    REPORT_FILE.write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n", "utf-8")


def _fraction(rate: Mapping[str, Any]) -> str:
    return f"{rate['passed']}/{rate['total']}"


def harness_refs() -> list[str]:
    """Every recorded crop the AM5 request set names (``set/crop id``), in first-use order."""
    request_set = json.loads(REQUEST_SET.read_text(encoding="utf-8"))
    refs: list[str] = []
    for scene in request_set["scenes"].values():
        for thing in scene["things"]:
            ref = thing.get("recordedCrop")
            if ref is not None and ref not in refs:
                refs.append(ref)
    return refs


def build_harness(vectors_dir: Path, replay: Mapping[str, Any]) -> dict[str, Any]:
    """The real fp16 vectors and measurements of the crops the AM5 eval's colour things use."""
    crops: dict[str, Any] = {}
    prompts: dict[str, list[str]] = {}
    for ref in harness_refs():
        set_name, crop_id = ref.split("/", 1)
        entry = replay["sets"][set_name]
        vectors = json.loads((vectors_dir / f"v-{entry['seed']}.json").read_text(encoding="utf-8"))
        frame = next(f for f in entry["frames"] if any(c["id"] == crop_id for c in f["crops"]))
        colour = next(c["colour"] for c in frame["crops"] if c["id"] == crop_id)
        noun = frame["noun"]
        if prompts.setdefault(noun, vectors["prompts"][noun]) != vectors["prompts"][noun]:
            raise ValueError(f"the {noun} prompt vectors differ between SigLIP runs")
        crops[ref] = {
            "noun": noun,
            "colour": colour,
            "vector": vectors["crops"][crop_id],
            "measurement": entry["crops"][crop_id]["measurement"],
        }
    return {
        "$comment": (
            "AM2.7: real SigLIP 2 vectors (fp16, base64, as the Visual Embed worker packs them) "
            "and the engine's colour measurement of the held-out crops the AM5 eval's coloured "
            "things name (tests/fixtures/ai-masking/request-set.json recordedCrop). Written by "
            "engine/python/tests/colour_rerank_replay.py harness; do not edit."
        ),
        "colours": list(eval_tool().COLOURS),
        "prompts": prompts,
        "crops": crops,
    }


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("part", choices=("build", "harness", "report"))
    parser.add_argument("--vectors-dir", type=Path, help="v-<seed>.json from the SigLIP runs")
    parser.add_argument("--mission-dir", type=Path, help="tests/fixtures/mission (real crops)")
    args = parser.parse_args()
    if args.part in ("build", "harness") and args.vectors_dir is None:
        parser.error(f"{args.part} needs --vectors-dir")
    if args.part == "harness":
        harness = build_harness(args.vectors_dir, json.loads(REPLAY_FILE.read_text("utf-8")))
        HARNESS_FILE.write_text(json.dumps(harness, indent=1) + "\n", encoding="utf-8")
    if args.part == "build":
        replay = build(args.vectors_dir, args.mission_dir)
        REPLAY_FILE.write_text(json.dumps(replay, indent=1) + "\n", encoding="utf-8")
        annotate_vectors_file(replay)
    replay = json.loads(REPLAY_FILE.read_text(encoding="utf-8"))
    write_report(replay)
    sets = replay_report(replay)
    print(json.dumps({name: {r: s[r]["gates"] for r in RULES} for name, s in sets.items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
