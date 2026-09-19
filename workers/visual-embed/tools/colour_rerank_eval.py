#!/usr/bin/env python3
"""AM2.6: colour re-ranking on real SigLIP weights, through the real worker.

Build-time tool, like ``fetch_models.py``: nothing in ``src/framepilot_visual_embed`` imports it,
and it needs the ``cv`` extra and the pinned weights.

WHAT IT MEASURES. "The red car" with several cars on screen is resolved by the host
(``apps/desktop/electron/ai/crop-reranker.ts``): it asks this pack to embed each candidate's CROP
(a ``visual.embed`` shot with a ``region``) and "a photo of a {colour} {noun}" for the twelve
palette colours (``visual.text``), then scores each crop by the named colour's softmax share at
temperature 0.01 (``packages/ai-sdk/src/masking/colour-rerank.ts``). The resolver picks the top
candidate only when its share is >= 0.5 and >= 1.25x the runner-up's; otherwise it asks. This tool
runs exactly those two requests against the worker CLI and applies exactly that rule.

THE CROP SET is generated, so its ground truth is true by construction: flat-shaded cars and balls
in the twelve palette colours, three to a frame on six backgrounds, encoded as H.264 4:2:0 (the
chroma subsampling camera footage has), decoded by the worker's own OpenCV path, and cropped with
a detector-like margin. Each frame asks for every colour on it (must pick that object) and for one
colour that is NOT on it (must ask: a wrong pick there is a confident-wrong). ``--mission-dir``
adds three hand-boxed objects from a real talking-head clip (``broll/b4-1080p-50s.mp4``).

LATENCY is one colour request as the host makes it: before AM2.6 two worker processes (crops,
then prompts), no cache directory; after, the cache directory and the host's prompt-vector cache.

AM2.7: SigLIP alone is not the shipped rule any more. ``--all-vectors-out`` writes every crop's
vector, and ``engine/python/tests/colour_rerank_replay.py build`` combines them with the engine's
CIELAB measurement of the same regenerated crops into ``reports/ai-masking/colour-rerank-replay
.json``, which CI scores without the weights.

Run ONE at a time, under ``workers/smart-mask/spike/watchdog.py``'s rules: on the 16 GB M1 Pro the
pre-AM2.6 worker loaded both SigLIP towers on CoreML and reached a 7.4 GiB footprint.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

#: The resolver's palette, in its order (``target-vocabulary.ts`` ``COLOUR_WORDS``).
COLOURS = (
    "red",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "pink",
    "brown",
    "black",
    "white",
    "grey",
    "silver",
)
#: A plain rendering of each colour word (sRGB); the scene adds shading and noise around it.
PAINT: dict[str, tuple[int, int, int]] = {
    "red": (200, 30, 35),
    "orange": (240, 130, 25),
    "yellow": (240, 205, 35),
    "green": (40, 150, 55),
    "blue": (35, 75, 200),
    "purple": (115, 45, 160),
    "pink": (240, 125, 175),
    "brown": (115, 70, 35),
    "black": (25, 25, 28),
    "white": (238, 238, 235),
    "grey": (125, 125, 128),
    "silver": (190, 192, 198),
}
#: Pairs a person could also call either; reported separately, never excused.
NEAR_COLOURS = {
    frozenset(pair)
    for pair in (
        ("grey", "silver"),
        ("white", "silver"),
        ("black", "grey"),
        ("red", "pink"),
        ("red", "orange"),
        ("orange", "brown"),
        ("orange", "yellow"),
        ("purple", "pink"),
        ("purple", "blue"),
    )
}
#: ``colour-rerank.ts`` and ``target-resolution.ts``.
TEMPERATURE = 0.01
MIN_GROUNDING = 0.5
MARGIN_RATIO = 1.25
ACHROMATIC = frozenset({"white", "grey", "silver", "black"})
ACHROMATIC_RIVAL_SHARE = 0.1
UNDECIDED_EVIDENCE = MIN_GROUNDING - 1e-6
#: The evidence rules compared: AM2.5's raw share, and AM2.6's (what ``colour-rerank.ts`` ships).
RULES = ("am2.5-share", "am2.6")

WIDTH, HEIGHT, FPS = 640, 360, 10
BACKGROUNDS = ("grass", "sky", "asphalt", "wall", "dark", "clutter")
NOUNS = ("car", "ball")
SCENES_PER_BACKGROUND_AND_NOUN = 4
SLOTS_X = (0.04, 0.37, 0.70)
#: A detector's box is a little larger than the object.
BOX_MARGIN = 0.06
MAX_SHOTS = 64
#: The reported set; ``--seed`` builds a held-out set with the same recipe.
SEED = 20260919

#: Hand-boxed objects in ``broll/b4-1080p-50s.mp4`` at 2.0 s (normalised boxes; the face and the
#: person are never cropped). The lamp is a white bulb lit warm; that is what the camera saw.
REAL_CLIP = "broll/b4-1080p-50s.mp4"
REAL_TIME = 2.0
REAL_OBJECTS = (
    ("monitor", "purple", (0.09, 0.54, 0.16, 0.25)),
    ("microphone", "black", (0.26, 0.57, 0.18, 0.36)),
    ("lamp", "white", (0.095, 0.83, 0.115, 0.17)),
)


# --- Scenes ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Crop:
    crop_id: str
    frame: int
    noun: str
    colour: str
    box: tuple[float, float, float, float]


def _background(kind: str, rng: np.random.Generator) -> np.ndarray:
    ys = np.linspace(0.0, 1.0, HEIGHT)[:, None, None]
    noise = rng.normal(0.0, 1.0, (HEIGHT, WIDTH, 1))
    if kind == "grass":
        base = np.array([60, 125, 45]) + 18 * noise
    elif kind == "sky":
        base = (1 - ys) * np.array([90, 150, 225]) + ys * np.array([225, 235, 245]) + 3 * noise
    elif kind == "asphalt":
        base = np.array([88, 88, 92]) + 14 * noise
    elif kind == "wall":
        base = np.array([222, 216, 205]) + 5 * noise
    elif kind == "dark":
        base = np.array([30, 28, 34]) + 6 * noise
    else:  # clutter: large soft blobs of every hue, the hardest background for a crop
        low = rng.uniform(40, 215, (HEIGHT // 40 + 1, WIDTH // 40 + 1, 3))
        base = np.kron(low, np.ones((40, 40, 1)))[:HEIGHT, :WIDTH] + 8 * noise
    return np.broadcast_to(base, (HEIGHT, WIDTH, 3)).astype(np.float64).copy()


def _shade(canvas: np.ndarray, mask: np.ndarray, colour: str, rng: np.random.Generator) -> None:
    rows = np.nonzero(mask.any(axis=1))[0]
    top, bottom = rows.min(), rows.max() + 1
    light = np.ones((HEIGHT, 1))
    light[top:bottom, 0] = np.linspace(1.12, 0.82, bottom - top)
    paint = np.array(PAINT[colour], dtype=np.float64)[None, None, :] * light[:, :, None]
    paint = paint + rng.normal(0.0, 5.0, canvas.shape)
    canvas[mask] = paint[mask]


def _grid() -> tuple[np.ndarray, np.ndarray]:
    return np.mgrid[0:HEIGHT, 0:WIDTH]


def _draw_car(canvas: np.ndarray, x0: float, colour: str, rng: np.random.Generator) -> tuple:
    yy, xx = _grid()
    left, width = int(x0 * WIDTH), int(0.27 * WIDTH)
    body_top, body_bottom = int(0.55 * HEIGHT), int(0.74 * HEIGHT)
    body = (xx >= left) & (xx < left + width) & (yy >= body_top) & (yy < body_bottom)
    cab_left, cab_right = left + width * 0.22, left + width * 0.78
    cab_top = int(0.41 * HEIGHT)
    slope = (yy - cab_top) / max(body_top - cab_top, 1) * width * 0.1
    cabin = (yy >= cab_top) & (yy < body_top) & (xx >= cab_left - slope) & (xx < cab_right + slope)
    _shade(canvas, body | cabin, colour, rng)
    window = (
        (yy >= cab_top + 6)
        & (yy < body_top - 2)
        & (xx >= cab_left - slope + 6)
        & (xx < cab_right + slope - 6)
        & (np.abs(xx - (cab_left + cab_right) / 2) > 3)
    )
    canvas[window] = (150, 175, 195)
    radius = int(0.055 * HEIGHT * 1.6)
    for cx in (left + width * 0.22, left + width * 0.78):
        wheel = (xx - cx) ** 2 + (yy - body_bottom) ** 2 <= radius**2
        hub = (xx - cx) ** 2 + (yy - body_bottom) ** 2 <= (radius * 0.45) ** 2
        canvas[wheel] = (22, 22, 24)
        canvas[hub] = (150, 150, 155)
    return (left, cab_top, left + width, body_bottom + radius)


def _draw_ball(canvas: np.ndarray, x0: float, colour: str, rng: np.random.Generator) -> tuple:
    yy, xx = _grid()
    radius = int(0.1 * WIDTH)
    cx, cy = int(x0 * WIDTH) + int(0.135 * WIDTH), int(0.6 * HEIGHT)
    ball = (xx - cx) ** 2 + (yy - cy) ** 2 <= radius**2
    _shade(canvas, ball, colour, rng)
    highlight = (xx - (cx - radius * 0.35)) ** 2 + (yy - (cy - radius * 0.35)) ** 2
    spot = ball & (highlight <= (radius * 0.18) ** 2)
    canvas[spot] = np.clip(canvas[spot] * 0.4 + 255 * 0.6, 0, 255)
    return (cx - radius, cy - radius, cx + radius, cy + radius)


def _detector_box(bounds: tuple) -> tuple[float, float, float, float]:
    left, top, right, bottom = bounds
    pad_x, pad_y = (right - left) * BOX_MARGIN, (bottom - top) * BOX_MARGIN
    x = max(0.0, (left - pad_x) / WIDTH)
    y = max(0.0, (top - pad_y) / HEIGHT)
    return (
        round(x, 4),
        round(y, 4),
        round(min(1.0 - x, (right - left + 2 * pad_x) / WIDTH), 4),
        round(min(1.0 - y, (bottom - top + 2 * pad_y) / HEIGHT), 4),
    )


def build_scenes(seed: int = SEED) -> tuple[list[np.ndarray], list[Crop], list[dict[str, Any]]]:
    """Every frame, every crop on it, and every request asked of it. Deterministic."""
    rng = np.random.default_rng(seed)
    frames: list[np.ndarray] = []
    crops: list[Crop] = []
    items: list[dict[str, Any]] = []
    for background in BACKGROUNDS:
        for noun in NOUNS:
            for _ in range(SCENES_PER_BACKGROUND_AND_NOUN):
                index = len(frames)
                canvas = _background(background, rng)
                picked = [COLOURS[i] for i in rng.choice(len(COLOURS), 3, replace=False)]
                on_frame: list[Crop] = []
                for slot, colour in zip(SLOTS_X, picked, strict=True):
                    draw = _draw_car if noun == "car" else _draw_ball
                    bounds = draw(canvas, slot, colour, rng)
                    crop = Crop(f"f{index}-{colour}", index, noun, colour, _detector_box(bounds))
                    on_frame.append(crop)
                frames.append(np.clip(canvas, 0, 255).astype(np.uint8))
                crops.extend(on_frame)
                ids = [crop.crop_id for crop in on_frame]
                for crop in on_frame:
                    items.append(_item(background, noun, crop.colour, ids, crop.crop_id, picked))
                # Every colour NOT on the frame is asked too: each must ask, never pick.
                for colour in COLOURS:
                    if colour not in picked:
                        items.append(_item(background, noun, colour, ids, None, picked))
                # One more draw, so the scenes stay those the AM2.6 rule was designed on.
                rng.integers(len(COLOURS) - 3)
    return frames, crops, items


def _item(
    background: str,
    noun: str,
    colour: str,
    candidates: list[str],
    expected: str | None,
    on_frame: Sequence[str],
) -> dict[str, Any]:
    near = any(frozenset((colour, other)) in NEAR_COLOURS for other in on_frame if other != colour)
    return {
        "request": f"the {colour} {noun}",
        "background": background,
        "noun": noun,
        "colour": colour,
        "candidates": candidates,
        "expected": expected,
        "nearColourOnFrame": near,
    }


def encode_video(frames: Sequence[np.ndarray], path: Path) -> None:
    """H.264 4:2:0, every frame a keyframe, so a seek lands exactly and chroma is subsampled."""
    process = subprocess.Popen(
        [
            shutil.which("ffmpeg") or "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{WIDTH}x{HEIGHT}",
            "-r",
            str(FPS),
            "-i",
            "-",
            "-c:v",
            "libx264",
            "-g",
            "1",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            str(path),
        ],
        stdin=subprocess.PIPE,
    )
    assert process.stdin is not None
    # One trailing copy: OpenCV cannot seek into the middle of a file's last frame.
    for frame in [*frames, frames[-1]]:
        process.stdin.write(frame.tobytes())
    process.stdin.close()
    if process.wait() != 0:
        raise SystemExit("ffmpeg could not encode the scene video")


def keyframe_time(index: int) -> float:
    """Frame ``index``'s own time, as the host sends it (``frame / fps``). OpenCV's millisecond
    seek rounds a time inside a frame UP to the next frame, so a mid-frame time is wrong."""
    return index / FPS


def check_decode(path: Path, frames: Sequence[np.ndarray]) -> float:
    """The worst mean error between each scene and what the worker's decode path returns for it.

    Same calls as ``OnnxVisualEmbedBackend.decode_keyframes``: a seek that landed one frame off
    would score every crop against the wrong picture.
    """
    import cv2

    capture = cv2.VideoCapture(str(path))
    worst = 0.0
    try:
        for index, frame in enumerate(frames):
            capture.set(cv2.CAP_PROP_POS_MSEC, keyframe_time(index) * 1000.0)
            ok, decoded = capture.read()
            if not ok:
                raise SystemExit(f"frame {index} did not decode")
            rgb = cv2.cvtColor(decoded, cv2.COLOR_BGR2RGB).astype(np.float64)
            worst = max(worst, float(np.abs(rgb - frame).mean()))
    finally:
        capture.release()
    return worst


# --- Worker ------------------------------------------------------------------------------


def unpack_fp16(packed: str) -> list[float]:
    raw = base64.b64decode(packed)
    return list(struct.unpack(f"<{len(raw) // 2}e", raw))


@dataclass
class WorkerRun:
    result: dict[str, Any]
    seconds: float


def run_worker(request: dict[str, Any], environment: dict[str, str]) -> WorkerRun:
    """One worker process for one request, as the host runs it; wall-clock from spawn to exit."""
    started = time.perf_counter()
    completed = subprocess.run(
        [sys.executable, "-m", "framepilot_visual_embed", "--framepilot-worker-runtime"],
        input=json.dumps(request) + "\n",
        capture_output=True,
        text=True,
        env={**os.environ, **environment},
        timeout=600,
        check=False,
    )
    seconds = time.perf_counter() - started
    lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    terminal = lines[-1] if lines else {}
    if terminal.get("type") != "result":
        raise SystemExit(f"worker failed: {terminal or completed.stderr[-2000:]}")
    return WorkerRun(terminal, seconds)


def embed_request(
    request_id: str, media: Path, duration: float, fps: float, shots: list[dict[str, Any]]
) -> dict[str, Any]:
    frames = math.ceil(duration * fps)
    return {
        "type": "request",
        "protocolVersion": 1,
        "requestId": request_id,
        "projectRevision": 1,
        "capability": "visual.embed",
        "media": {
            "handleId": f"media:{request_id}",
            "assetId": "eval",
            "absolutePath": str(media),
            "sourceStartSeconds": 0.0,
            "sourceEndSeconds": duration,
            "fps": fps,
            "firstFrame": 0,
            "lastFrameExclusive": frames,
        },
        "parameters": {"promptBankVersion": 1, "shots": shots},
    }


def text_request(request_id: str, texts: list[str]) -> dict[str, Any]:
    return {
        "type": "request",
        "protocolVersion": 1,
        "requestId": request_id,
        "projectRevision": 1,
        "capability": "visual.text",
        "parameters": {"texts": texts},
    }


def prompts_for(noun: str) -> list[str]:
    return [f"a photo of a {colour} {noun}" for colour in COLOURS]


def region(box: tuple[float, float, float, float], inset: float = 0.0) -> dict[str, float]:
    """The shot region for a box, optionally shrunk by ``inset`` of its size on every side."""
    x, y, width, height = box
    return {
        "x": round(x + width * inset, 4),
        "y": round(y + height * inset, 4),
        "width": round(width * (1 - 2 * inset), 4),
        "height": round(height * (1 - 2 * inset), 4),
    }


# --- Scoring (colour-rerank.ts + target-resolution.ts) ------------------------------------


def colour_distribution(crop: Sequence[float], prompts: Sequence[Sequence[float]]) -> list[float]:
    def cosine(a: Sequence[float], b: Sequence[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b, strict=True))
        na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
        return 0.0 if na == 0 or nb == 0 else dot / (na * nb)

    logits = [cosine(crop, prompt) / TEMPERATURE for prompt in prompts]
    peak = max(logits)
    weights = [math.exp(logit - peak) for logit in logits]
    return [weight / sum(weights) for weight in weights]


def evidence(rule: str, distribution: Sequence[float], at: int) -> float:
    """``colourEvidence`` in ``colour-rerank.ts`` (am2.6), or AM2.5's raw share."""
    named = distribution[at]
    if rule == "am2.5-share":
        return named
    others = [share for index, share in enumerate(distribution) if index != at]
    rival = max(others)
    achromatic_rival = max(
        share
        for index, share in enumerate(distribution)
        if index != at and COLOURS[index] in ACHROMATIC
    )
    head_to_head = 0.0 if named + rival == 0 else named / (named + rival)
    undecided = named <= rival or (
        COLOURS[at] in ACHROMATIC and achromatic_rival >= ACHROMATIC_RIVAL_SHARE
    )
    return min(head_to_head, UNDECIDED_EVIDENCE) if undecided else head_to_head


def decide(scores: dict[str, float]) -> str | None:
    """The resolver's rule for two or more plausible candidates: the top one, or ask (None)."""
    ranked = sorted(scores.items(), key=lambda entry: (-entry[1], entry[0]))
    (first, top), (_second, runner_up) = ranked[0], ranked[1]
    return first if top >= MIN_GROUNDING and top >= runner_up * MARGIN_RATIO else None


def score_items(
    items: list[dict[str, Any]],
    crop_vectors: dict[str, list[float]],
    prompt_vectors: dict[str, list[list[float]]],
    rule: str,
) -> dict[str, Any]:
    outcomes = []
    for item in items:
        at = COLOURS.index(item["colour"])
        scores = {
            candidate: evidence(
                rule, colour_distribution(crop_vectors[candidate], prompt_vectors[item["noun"]]), at
            )
            for candidate in item["candidates"]
        }
        pick = decide(scores)
        if pick is None:
            outcome = "asked"
        elif pick == item["expected"]:
            outcome = "correct"
        else:
            outcome = "wrong"
        outcomes.append({**item, "pick": pick, "outcome": outcome, "scores": _round(scores)})
    misses = [
        {
            key: row[key]
            for key in ("request", "candidates", "expected", "pick", "outcome", "scores")
        }
        for row in outcomes
        if row["outcome"] == "wrong" or (row["expected"] is not None and row["outcome"] == "asked")
    ]
    return {"summary": summarise(outcomes), "misses": misses, "outcomes": outcomes}


def _round(shares: dict[str, float]) -> dict[str, float]:
    return {key: round(value, 4) for key, value in shares.items()}


def _rate(passed: int, total: int) -> dict[str, Any]:
    return {"passed": passed, "total": total, "rate": round(passed / total, 4) if total else None}


def summarise(outcomes: list[dict[str, Any]]) -> dict[str, Any]:
    present = [item for item in outcomes if item["expected"] is not None]
    absent = [item for item in outcomes if item["expected"] is None]

    def count(rows: list[dict[str, Any]], outcome: str) -> int:
        return sum(1 for row in rows if row["outcome"] == outcome)

    by_background = {
        background: _rate(
            count([r for r in present if r["background"] == background], "correct"),
            len([r for r in present if r["background"] == background]),
        )
        for background in sorted({row["background"] for row in outcomes})
    }
    near = [row for row in present if row["nearColourOnFrame"]]
    by_colour = {
        colour: _rate(
            count([r for r in present if r["colour"] == colour], "correct"),
            len([r for r in present if r["colour"] == colour]),
        )
        for colour in COLOURS
        if any(r["colour"] == colour for r in present)
    }
    return {
        "targetAccuracy": _rate(count(present, "correct"), len(present)),
        "unnecessaryAsks": _rate(count(present, "asked"), len(present)),
        "absentColourAskRate": _rate(count(absent, "asked"), len(absent)),
        "confidentWrong": count(present, "wrong") + count(absent, "wrong"),
        "nearColourOnFrame": _rate(count(near, "correct"), len(near)),
        "chromaticTargetAccuracy": _rate(
            count([r for r in present if r["colour"] not in ACHROMATIC], "correct"),
            len([r for r in present if r["colour"] not in ACHROMATIC]),
        ),
        "achromaticTargetAccuracy": _rate(
            count([r for r in present if r["colour"] in ACHROMATIC], "correct"),
            len([r for r in present if r["colour"] in ACHROMATIC]),
        ),
        "byBackground": by_background,
        "byColour": by_colour,
    }


# --- Parts ---------------------------------------------------------------------------------


def accuracy(args: argparse.Namespace, workdir: Path, environment: dict[str, str]) -> dict:
    frames, crops, items = build_scenes(args.seed)
    video = workdir / "scenes.mp4"
    encode_video(frames, video)
    decode_error = check_decode(video, frames)
    if decode_error > 12:
        raise SystemExit(f"decoded scenes are {decode_error:.1f} levels off: a seek landed wrong")
    duration = (len(frames) + 1) / FPS
    crop_vectors: dict[str, list[float]] = {}
    seconds = 0.0
    for start in range(0, len(crops), MAX_SHOTS):
        window = crops[start : start + MAX_SHOTS]
        shots = [
            {
                "shotIndex": i,
                "keyframeT": keyframe_time(c.frame),
                "region": region(c.box, args.inset),
            }
            for i, c in enumerate(window)
        ]
        run = run_worker(embed_request(f"eval-{start}", video, duration, FPS, shots), environment)
        seconds += run.seconds
        by_index = {shot["shotIndex"]: shot["vector"] for shot in run.result["shots"]}
        for i, crop in enumerate(window):
            crop_vectors[crop.crop_id] = unpack_fp16(by_index[i])
    nouns = list(NOUNS)
    real_items: list[dict[str, Any]] = []
    real_video = Path(args.mission_dir) / REAL_CLIP if args.mission_dir else None
    if real_video is not None and real_video.is_file():
        nouns.append("object")
        shots = [
            {"shotIndex": i, "keyframeT": REAL_TIME, "region": region(box, args.inset)}
            for i, (_name, _colour, box) in enumerate(REAL_OBJECTS)
        ]
        run = run_worker(embed_request("eval-real", real_video, 50.0, 29.97, shots), environment)
        by_index = {shot["shotIndex"]: shot["vector"] for shot in run.result["shots"]}
        ids = [f"real-{name}" for name, _colour, _box in REAL_OBJECTS]
        on_frame = [colour for _name, colour, _box in REAL_OBJECTS]
        for i, crop_id in enumerate(ids):
            crop_vectors[crop_id] = unpack_fp16(by_index[i])
        for crop_id, (_name, colour, _box) in zip(ids, REAL_OBJECTS, strict=True):
            real_items.append(_item("real-b4", "object", colour, ids, crop_id, on_frame))
        for colour in COLOURS:
            if colour not in on_frame:
                real_items.append(_item("real-b4", "object", colour, ids, None, on_frame))
    texts = [prompt for noun in nouns for prompt in prompts_for(noun)]
    text_run = run_worker(text_request("eval-text", texts), environment)
    vectors = [unpack_fp16(packed) for packed in text_run.result["vectors"]]
    prompt_vectors = {
        noun: vectors[i * len(COLOURS) : (i + 1) * len(COLOURS)] for i, noun in enumerate(nouns)
    }
    synthetic = {rule: score_items(items, crop_vectors, prompt_vectors, rule) for rule in RULES}
    real = {rule: score_items(real_items, crop_vectors, prompt_vectors, rule) for rule in RULES}
    if args.vectors_out:
        picks = {
            row["request"] + "|" + ",".join(row["candidates"]): row["pick"]
            for row in synthetic["am2.6"]["outcomes"]
        }
        subset = [
            {**item, "pick": picks[item["request"] + "|" + ",".join(item["candidates"])]}
            for item in items
            if _frame_of(item) % SCENES_PER_BACKGROUND_AND_NOUN == 0
        ]
        _write_vectors(Path(args.vectors_out), subset, crop_vectors, prompt_vectors)
    if args.all_vectors_out:
        _write_vectors(Path(args.all_vectors_out), items + real_items, crop_vectors, prompt_vectors)
    return {
        "backend": text_run.result.get("backend"),
        "modelDigests": text_run.result.get("modelDigests"),
        "decodeCheckWorstMeanLevels": round(decode_error, 2),
        "crops": len(crop_vectors),
        "workerSeconds": round(seconds + text_run.seconds, 1),
        "seed": args.seed,
        "synthetic": {rule: _public(result) for rule, result in synthetic.items()},
        "realFootage": {rule: _public(result) for rule, result in real.items()}
        if real_items
        else None,
    }


def _public(result: dict[str, Any]) -> dict[str, Any]:
    """The summary and every miss; the full per-item list stays out of the report."""
    return {"summary": result["summary"], "misses": result["misses"]}


def _frame_of(item: dict[str, Any]) -> int:
    return int(item["candidates"][0].split("-")[0][1:])


def _write_vectors(
    path: Path,
    items: list[dict[str, Any]],
    crop_vectors: dict[str, list[float]],
    prompt_vectors: dict[str, list[list[float]]],
) -> None:
    """Real-weights vectors and the requests asked of them, so the host's TypeScript scorer
    can reproduce this tool's decisions without the weights."""

    def pack(vector: Sequence[float]) -> str:
        return base64.b64encode(struct.pack(f"<{len(vector)}e", *vector)).decode("ascii")

    ids = {candidate for item in items for candidate in item["candidates"]}
    nouns = sorted({item["noun"] for item in items})
    payload = {
        "$comment": "Real SigLIP 2 vectors (fp16) from tools/colour_rerank_eval.py (AM2.6).",
        "colours": list(COLOURS),
        "prompts": {noun: [pack(v) for v in prompt_vectors[noun]] for noun in nouns},
        "crops": {crop_id: pack(crop_vectors[crop_id]) for crop_id in sorted(ids)},
        "items": [
            {
                key: item[key]
                for key in ("request", "noun", "colour", "candidates", "expected", "pick")
                if key in item
            }
            for item in items
        ],
    }
    path.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")


def latency(args: argparse.Namespace, workdir: Path, environment: dict[str, str]) -> dict:
    """One colour request (three crops, "the red car") as the host makes it, repeated."""
    frames, crops, _items = build_scenes(args.seed)
    video = workdir / "latency.mp4"
    encode_video(frames[:1], video)
    shots = [
        {"shotIndex": i, "keyframeT": keyframe_time(0), "region": region(c.box)}
        for i, c in enumerate(crops[:3])
    ]
    runs = []
    host_prompt_cache: dict[str, list[str]] = {}
    for attempt in range(args.repeats):
        started = time.perf_counter()
        embed = run_worker(embed_request(f"lat-{attempt}", video, 2 / FPS, FPS, shots), environment)
        text_seconds = None
        prompts = prompts_for("car")
        if args.host == "legacy" or "car" not in host_prompt_cache:
            text = run_worker(text_request(f"lat-text-{attempt}", prompts), environment)
            text_seconds = round(text.seconds, 2)
            host_prompt_cache["car"] = text.result["vectors"]
        runs.append(
            {
                "attempt": attempt,
                "embedSeconds": round(embed.seconds, 2),
                "textSeconds": text_seconds,
                "totalSeconds": round(time.perf_counter() - started, 2),
                "backend": embed.result.get("backend"),
            }
        )
    return {
        "host": args.host,
        "cacheDirectory": "FRAMEPILOT_CAPABILITY_PACK_CACHE" in environment,
        "runs": runs,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("part", choices=("accuracy", "latency"))
    parser.add_argument("--pack-root", required=True, help="directory holding models/")
    parser.add_argument("--cache-dir", help="FRAMEPILOT_CAPABILITY_PACK_CACHE for the worker")
    parser.add_argument("--mission-dir", help="tests/fixtures/mission, for the real-footage crops")
    parser.add_argument("--host", choices=("legacy", "cached"), default="cached")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seed", type=int, default=SEED, help="scene seed (another = held out)")
    parser.add_argument("--inset", type=float, default=0.0, help="shrink each crop box per side")
    parser.add_argument("--vectors-out", help="write the small TS parity fixture here")
    parser.add_argument("--all-vectors-out", help="write every crop's vectors, for analysis")
    parser.add_argument("--out", required=True)
    parser.add_argument("--tag", help="ignored; lets the spike watchdog see this job")
    args = parser.parse_args()
    environment = {"FRAMEPILOT_CAPABILITY_PACK_ROOT": args.pack_root}
    if args.cache_dir:
        environment["FRAMEPILOT_CAPABILITY_PACK_CACHE"] = args.cache_dir
    with tempfile.TemporaryDirectory(prefix="colour-rerank-") as scratch:
        work = accuracy if args.part == "accuracy" else latency
        report = work(args, Path(scratch), environment)
    Path(args.out).write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    synthetic = report.get("synthetic")
    shown = {rule: result["summary"] for rule, result in synthetic.items()} if synthetic else report
    print(json.dumps(shown, indent=1)[:6000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
