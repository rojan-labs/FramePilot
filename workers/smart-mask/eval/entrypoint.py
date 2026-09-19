"""Drive the INSTALLED worker entrypoint as the desktop host does (plan 06 "Harness").

The harness never imports the pipeline to produce a matte: it writes one request line to
``framepilot-smart-mask --framepilot-worker-runtime``, reads the terminal line, and reads the
files the worker wrote into its staging directory, exactly the contract the host verifies. What
it measures is therefore what the product ships. (The environment is the shell's plus the model,
tool and tile settings, as BR3.15 measured; the host's scrubbing is tested in the desktop suite.)
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

PACK = Path(__file__).resolve().parent.parent
ENTRYPOINT = PACK / ".venv" / "bin" / "framepilot-smart-mask"
LGPL_BIN = PACK / ".cache" / "ffmpeg-lgpl" / "bin"


def tool(name: str) -> str:
    """The pack's own LGPL ffmpeg/ffprobe when present (what ships), else the PATH one."""
    bundled = LGPL_BIN / name
    return str(bundled) if bundled.is_file() else name


def worker_environment(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment BR3.15 measured with; model and tile settings can be overridden.

    ``extra`` carries a run variant's eval-only settings (ablations, the estimate dump).
    """
    return {
        **os.environ,
        **(extra or {}),
        "FRAMEPILOT_SMART_MASK_MODELS_DIR": os.environ.get(
            "FRAMEPILOT_SMART_MASK_MODELS_DIR", str(PACK / ".cache" / "onnx")
        ),
        "FRAMEPILOT_SMART_MASK_FFMPEG": tool("ffmpeg"),
        "FRAMEPILOT_SMART_MASK_FFPROBE": tool("ffprobe"),
        "FRAMEPILOT_SMART_MASK_MATTING_TILE": os.environ.get(
            "FRAMEPILOT_SMART_MASK_MATTING_TILE", "768"
        ),
        "FRAMEPILOT_SMART_MASK_MEMORY_CEILING_MIB": os.environ.get(
            "FRAMEPILOT_SMART_MASK_MEMORY_CEILING_MIB", "7680"
        ),
        "FRAMEPILOT_SMART_MASK_LOG_LEVEL": "INFO",
    }


def source_pts(clip: Path) -> list[int]:
    """Every video packet's pts in presentation order (the worker's frame identity)."""
    listed = subprocess.run(
        [tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts",
         "-of", "csv=p=0", str(clip)],
        capture_output=True, text=True, check=True,
    ).stdout.split()  # fmt: skip
    return sorted(int(value) for value in listed if value.strip().lstrip("-").isdigit())


def fresh_staging(out: Path) -> Path:
    """A clean staging directory with an ``inputs/`` beside the outputs (as the host makes it)."""
    staging = out / "staging"
    if staging.exists():
        shutil.rmtree(staging)
    (staging / "inputs").mkdir(parents=True)
    return staging


def run_request(
    request: dict[str, Any], out: Path, extra_env: dict[str, str] | None = None
) -> dict[str, Any]:
    """Run one request through the entrypoint; record the terminal line, time and stderr."""
    started = time.time()
    completed = subprocess.run(
        [str(ENTRYPOINT), "--framepilot-worker-runtime"],
        input=json.dumps(request) + "\n",
        capture_output=True, text=True, env=worker_environment(extra_env), check=False,
    )  # fmt: skip
    lines = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    terminal = lines[-1] if lines else {"type": "failure", "code": "no_output"}
    result = {
        "terminal": terminal,
        "seconds": round(time.time() - started, 1),
        "exitCode": completed.returncode,
    }
    (out / "result.json").write_text(json.dumps(result, indent=2))
    (out / "stderr.log").write_text(completed.stderr[-200_000:])
    return result


def decode_matte(path: Path, count: int, height: int, width: int) -> npt.NDArray[np.uint8]:
    raw = subprocess.run(
        [tool("ffmpeg"), "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, check=True,
    ).stdout  # fmt: skip
    frames: npt.NDArray[np.uint8] = np.frombuffer(raw, np.uint8).reshape(count, height, width)
    return frames


def decode_rgb(path: Path, count: int, height: int, width: int) -> npt.NDArray[np.uint8]:
    raw = subprocess.run(
        [tool("ffmpeg"), "-v", "error", "-i", str(path), "-frames:v", str(count), "-f", "rawvideo",
         "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True,
    ).stdout  # fmt: skip
    frames: npt.NDArray[np.uint8] = np.frombuffer(raw, np.uint8).reshape(count, height, width, 3)
    return frames


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


__all__ = [
    "ENTRYPOINT",
    "decode_matte",
    "decode_rgb",
    "fresh_staging",
    "run_request",
    "sha256_file",
    "source_pts",
    "tool",
    "worker_environment",
]
