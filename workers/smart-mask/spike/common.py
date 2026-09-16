"""Shared paths, upstream pins and helpers for the BR0 spike.

Everything heavy (upstream clones, weights, ONNX files, pilot media, results scratch) lives
under ``workers/smart-mask/.cache`` which is git-ignored. Only scripts and small JSON
results are committed.
"""

from __future__ import annotations

import json
import os
import resource
import sys
import time
from pathlib import Path

SPIKE_DIR = Path(__file__).resolve().parent
PACK_DIR = SPIKE_DIR.parent
CACHE = PACK_DIR / ".cache"
UPSTREAM = CACHE / "upstream"
WEIGHTS = CACHE / "weights"
ONNX_DIR = CACHE / "onnx"
MEDIA = CACHE / "media"
RESULTS = SPIKE_DIR / "results"

# Pinned upstream sources. BR3's tools/fetch_models.py must use exactly these.
PINS = {
    "sam2_repo": {
        "url": "https://github.com/facebookresearch/sam2",
        "commit": "2b90b9f5ceec907a1c18123530e92e794ad901a4",
    },
    "sam2.1_hiera_large.pt": {
        "url": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt",
        "sha256": "2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318",
        "bytes": 898083611,
    },
    "birefnet_hr_matting_repo": {
        "url": "https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting",
        "revision": "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f",
    },
    "birefnet_hr_matting.safetensors": {
        "url": "https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting/resolve/"
        "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f/model.safetensors",
        "sha256": "a5a4de698739ea5e0e8bbab28e1b293dde95092b87a442d566cbc585c53cef55",
        "bytes": 444473596,
    },
}

#: ONNX opset used for every export (DeformConv needs >= 19).
OPSET = 19

SAM_CONFIG = "configs/sam2.1/sam2.1_hiera_l.yaml"
SAM_CKPT = WEIGHTS / "sam2.1_hiera_large.pt"
BIREFNET_CKPT = WEIGHTS / "birefnet_hr_matting.safetensors"


def add_upstream_to_path() -> None:
    """Make ``sam2`` and ``birefnet_hr`` (symlink to the HF clone) importable."""
    for p in (UPSTREAM / "sam2", UPSTREAM):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))


def peak_rss_mib() -> float:
    # macOS reports ru_maxrss in bytes (Linux: KiB).
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r / (1024 * 1024) if sys.platform == "darwin" else r / 1024


def write_result(name: str, payload: dict) -> Path:
    RESULTS.mkdir(parents=True, exist_ok=True)
    out = RESULTS / f"{name}.json"
    payload = {"recordedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "host": host_info(), **payload}
    out.write_text(json.dumps(payload, indent=2) + "\n")
    return out


def host_info() -> dict:
    import platform

    info = {"platform": sys.platform, "machine": platform.machine(), "python": platform.python_version()}
    try:
        import onnxruntime as ort
        import torch

        info["onnxruntime"] = ort.__version__
        info["torch"] = torch.__version__
    except Exception:  # pragma: no cover - informational only
        pass
    if sys.platform == "darwin":
        info["cpu"] = os.popen("sysctl -n machdep.cpu.brand_string").read().strip()
    return info


def providers_for(ep: str, cache_dir: Path | None = None) -> list:
    """onnxruntime provider list for a named EP, always ending at CPU.

    ``ep`` is one of: cpu, coreml, dml, winml. Windows ML's EP names depend on the vendor
    EP it resolves; the parity script accepts an explicit provider name for that case.
    """
    if ep == "cpu":
        return ["CPUExecutionProvider"]
    if ep == "coreml":
        opts = {"ModelFormat": "MLProgram", "RequireStaticInputShapes": "1", "MLComputeUnits": "ALL"}
        if cache_dir is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)
            opts["ModelCacheDirectory"] = str(cache_dir)
        return [("CoreMLExecutionProvider", opts), "CPUExecutionProvider"]
    if ep == "dml":
        return ["DmlExecutionProvider", "CPUExecutionProvider"]
    return [ep, "CPUExecutionProvider"]
