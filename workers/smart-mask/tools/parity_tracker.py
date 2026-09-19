"""Parity of the pack's numpy SAM orchestration against the upstream PyTorch reference.

BR0.2 measured the exported graphs *inside* the upstream predictor. The pack replaces that
predictor with ``tracker.py``; this script proves the replacement is the same algorithm by
running it on BR0's parity clips with the same prompts and comparing per-frame masks with the
stored upstream reference (``.cache/parity/sam_ref_<clip>.npz``). Memory features are stored as
bfloat16 here, exactly as upstream does, so the comparison isolates the orchestration.

Gate (06 runtime parity): per-frame IoU ≥ 0.999. Run under the watchdog with the pack venv:

    spike/.venv/bin/python spike/watchdog.py --log .cache/parity_tracker.log -- \
        ".venv/bin/python tools/parity_tracker.py"
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import numpy as np

PACK = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACK / "src"))

from framepilot_smart_mask.embeddings import EmbeddingCache  # noqa: E402
from framepilot_smart_mask.media import FfmpegTools, verify_tools  # noqa: E402
from framepilot_smart_mask.models import DigestCache, models_directory  # noqa: E402
from framepilot_smart_mask.onnx_backend import OnnxModelProvider  # noqa: E402
from framepilot_smart_mask.tracker import (  # noqa: E402
    PointPrompt,
    SamTracker,
    preprocess,
    video_logits,
)

CACHE = PACK / ".cache"
#: BR0's parity clips: Sintel (CC-BY 3.0), prompts in source pixels (spike/parity_media.py).
CLIPS = {
    "sintel_000240": ([[715.0, 470.0]], [1]),
    "sintel_000705": ([[880.0, 450.0], [1300.0, 250.0]], [1, 0]),
}
GATE = 0.999


def first_cut(frames: np.ndarray, ratio: float = 8.0, floor: float = 8.0) -> int:
    diffs: list[float] = []
    for index in range(1, len(frames)):
        difference = float(
            np.abs(frames[index].astype(np.int16) - frames[index - 1].astype(np.int16)).mean()
        )
        if diffs and difference > max(floor, ratio * float(np.median(diffs))):
            return index
        diffs.append(difference)
    return len(frames)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return 1.0 if union == 0 else float(np.logical_and(a, b).sum() / union)


def main() -> None:
    os.environ.setdefault("FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG", "1")
    os.environ.setdefault("FRAMEPILOT_SMART_MASK_MODELS_DIR", str(CACHE / "onnx"))
    ffmpeg, ffprobe, report = verify_tools()
    tools = FfmpegTools(ffmpeg, ffprobe, report)
    provider = OnnxModelProvider(models_directory(), digests=DigestCache())
    sam = provider.open_sam()
    result: dict[str, object] = {"gate": GATE, "memoryStorage": "bfloat16", "clips": {}}
    passed = True
    for clip, (points, labels) in CLIPS.items():
        path = str(CACHE / "media" / f"{clip}.mkv")
        info = tools.probe(path)
        frames = np.stack(list(tools.frames(path, info, 0, 24)))
        frames = frames[: first_cut(frames)]
        height, width = frames.shape[1:3]
        cache = EmbeddingCache(
            lambda index, clip_frames=frames: sam.encode_image(preprocess(clip_frames[index])),
            max_ram_bytes=26 * 21 * 2**20,
        )
        tracker = SamTracker(sam, cache.get, memory_storage="bfloat16")
        prompt = PointPrompt(
            coords=tuple((x / width, y / height) for x, y in points), labels=tuple(labels)
        )
        started = time.time()
        cond = {0: tracker.condition(0, prompt)}
        forward = tracker.propagate(cond, len(frames), reverse=False, start=0, stop=len(frames) - 1)
        reference = np.load(CACHE / "parity" / f"sam_ref_{clip}.npz")["masks"]
        ious = [
            iou(video_logits(forward.low_res[i], height, width) > 0, reference[i])
            for i in range(len(frames))
        ]
        passed &= min(ious) >= GATE
        result["clips"][clip] = {  # type: ignore[index]
            "frames": len(frames),
            "minIoU": round(min(ious), 6),
            "meanIoU": round(float(np.mean(ious)), 6),
            "framesBelowGate": int(sum(value < GATE for value in ious)),
            "perFrameIoU": [round(value, 6) for value in ious],
            "seconds": round(time.time() - started, 1),
        }
        cache.clear()
    sam.close()
    result["pass"] = bool(passed)
    result["providers"] = provider.provider_report()
    out = PACK / "spike" / "results" / f"parity_tracker_{sys.platform}_cpu_fp32.json"
    out.write_text(json.dumps(result, indent=2) + "\n")
    sys.stdout.write(json.dumps({k: v for k, v in result.items() if k != "clips"}) + "\n")


if __name__ == "__main__":
    main()
