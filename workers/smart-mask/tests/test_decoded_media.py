"""Opt-in: the real pinned graphs on a tiny real clip, through the whole pipeline.

Never part of the default suite (``-m decoded_media``), and on a developer machine it must run
under the watchdog (8 GB physical footprint cap, swap-growth abort; the 16 GB Mac shut down
twice in BR0):

    spike/.venv/bin/python spike/watchdog.py --log .cache/decoded_media.log -- \
        ".venv/bin/python -m pytest -m decoded_media tests/test_decoded_media.py -q"

Media: 16 frames of Sintel 02:40 (Blender Foundation, CC-BY 3.0; BR0's parity clip A),
downscaled to 640×360 so the run stays inside the local budget. Prompt: BR0's parity click.
Reference: the upstream PyTorch predictor's masks for the same frames (BR0.2), downscaled.
The pipeline's matte is not the reference's output (BiRefNet, consensus and stabilisation
refine it), so the check is a floor on agreement, not parity; parity itself is
``tools/parity_tracker.py``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.decoded_media

PACK = Path(__file__).resolve().parent.parent
CACHE = PACK / ".cache"
SOURCE = CACHE / "media" / "sintel_000240.mkv"
REFERENCE = CACHE / "parity" / "sam_ref_sintel_000240.npz"
FRAMES = 16
WIDTH, HEIGHT = 640, 360
CLICK = (715.0 / 1920, 470.0 / 1080)
MIN_MEAN_IOU = 0.85


def test_real_weights_tiny_clip(tmp_path: Path) -> None:
    np = pytest.importorskip("numpy")
    cv2 = pytest.importorskip("cv2")
    pytest.importorskip("onnxruntime")
    if not SOURCE.is_file() or not REFERENCE.is_file() or shutil.which("ffmpeg") is None:
        pytest.skip(
            "parity media, upstream reference or ffmpeg missing (see spike/parity_media.py)"
        )
    os.environ.setdefault("FRAMEPILOT_SMART_MASK_MODELS_DIR", str(CACHE / "onnx"))
    os.environ.setdefault("FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG", "1")
    os.environ.setdefault("FRAMEPILOT_SMART_MASK_MATTING_TILE", "768")
    clip = tmp_path / "clip.mkv"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(SOURCE), "-frames:v", str(FRAMES), "-vf", f"scale={WIDTH}:{HEIGHT}",
         "-c:v", "ffv1", str(clip)],
        check=True,
    )  # fmt: skip
    staging = tmp_path / "staging"
    (staging / "inputs").mkdir(parents=True)
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts",
            "-of",
            "csv=p=0",
            str(clip),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    first_pts = min(int(value) for value in probe)
    request = {
        "type": "request", "protocolVersion": 1, "requestId": "decoded-media", "projectRevision": 1,
        "media": {"handleId": "m", "assetId": "sintel", "absolutePath": str(clip), "sourceStartSeconds": 0.0,
                  "sourceEndSeconds": 1.0, "fps": 24.0, "firstFrame": 0, "lastFrameExclusive": FRAMES},
        "capability": "subject.matte",
        "parameters": {
            "output": {"handleId": "o", "absolutePath": str(staging),
                       "allowedFiles": ["matte.mkv", "frames.json", "foreground.mkv", "preview.webm", "report.json"],
                       "maxBytes": 2 * 1024**3},
            "prompts": [{"kind": "points", "pts": first_pts, "points": [{"x": CLICK[0], "y": CLICK[1], "label": "include"}]}],
            "previewHeight": 180,
        },
    }  # fmt: skip
    from pipeline_harness import host_verify

    from framepilot_smart_mask.protocol import MatteRequest, parse_input_line
    from framepilot_smart_mask.runtime import CancellationFlag
    from framepilot_smart_mask.services import PackServices

    parsed = parse_input_line(json.dumps(request))
    assert isinstance(parsed, MatteRequest)
    services = PackServices()
    events: list[tuple[str, int, int]] = []

    def progress(phase: str, completed: int, total: int, **_: object) -> None:
        events.append((phase, completed, total))

    outcome = services.run_matte(parsed, progress, CancellationFlag())  # type: ignore[arg-type]
    matte = host_verify(staging, outcome, clip, 0, FRAMES)
    reference = np.load(REFERENCE)["masks"][:FRAMES]
    ious = []
    for index in range(FRAMES):
        expected = (
            cv2.resize(
                reference[index].astype(np.uint8), (WIDTH, HEIGHT), interpolation=cv2.INTER_NEAREST
            )
            > 0
        )
        predicted = matte[index] >= 128
        ious.append(
            float(
                np.logical_and(expected, predicted).sum()
                / max(np.logical_or(expected, predicted).sum(), 1)
            )
        )
    report = json.loads((staging / "report.json").read_text())
    result = {
        "meanIoUVsUpstreamSam": round(float(np.mean(ious)), 4),
        "minIoU": round(min(ious), 4),
        "flagged": outcome.summary.flagged_frames,
        "executionProvider": outcome.execution_provider,
        "backend": services.backend_label,
        "tile": report["job"]["tile"],
        "timingsSeconds": report["job"]["timingsSeconds"],
    }
    (PACK / "spike" / "results" / "decoded_media_tiny_clip.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    assert outcome.execution_provider == "cpu", "parity allows only the CPU EP today"
    assert float(np.mean(ious)) >= MIN_MEAN_IOU, result
