"""BR0.2: BiRefNet_HR-matting parity, ONNX (EP, precision) vs PyTorch, on 2048² tiles.

Gate (06 Runtime parity): mean |Δα| <= 1/255 and max |Δα| <= 4/255 in the band. The band
here is where the *reference* alpha is fractional (1/255 < α < 254/255), dilated by 8 px,
i.e. where matting actually happens. Whole-tile numbers are reported too.

Tiles: square crops around the subject of each parity clip's first frame, resized to 2048²
(the model's static input). Runs unchanged on Windows (see parity_sam.py).

    python parity_birefnet.py --reference
    python parity_birefnet.py --ep coreml --precision fp16s
"""

from __future__ import annotations

import argparse
import sys
import time

import cv2
import numpy as np
from PIL import Image

import common
import parity_media as pm

SIZE = 2048
MEAN_GATE = 1 / 255
MAX_GATE = 4 / 255
IMG_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
IMG_STD = np.array([0.229, 0.224, 0.225], np.float32)
PARITY_DIR = common.CACHE / "parity"


def tiles() -> dict[str, np.ndarray]:
    out = {}
    for clip, (_, _, pts, _) in pm.CLIPS.items():
        frame = pm.decode_rgb(pm.ensure_clip(clip), 1)[0]
        h, w = frame.shape[:2]
        side = min(h, w)
        cx = int(pts[0][0])
        x0 = int(np.clip(cx - side // 2, 0, w - side))
        crop = frame[:side, x0 : x0 + side]
        out[clip] = np.array(Image.fromarray(crop).resize((SIZE, SIZE), Image.BICUBIC))
    return out


def to_input(tile: np.ndarray) -> np.ndarray:
    x = (tile.astype(np.float32) / 255.0 - IMG_MEAN) / IMG_STD
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None])


def band_mask(ref_alpha: np.ndarray, dilate_px: int = 8) -> np.ndarray:
    frac = ((ref_alpha > 1 / 255) & (ref_alpha < 254 / 255)).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate_px + 1, 2 * dilate_px + 1))
    return cv2.dilate(frac, k).astype(bool)


def compare(alpha: np.ndarray, ref: np.ndarray) -> dict:
    diff = np.abs(alpha.astype(np.float64) - ref.astype(np.float64))
    band = band_mask(ref)
    b = diff[band] if band.any() else np.zeros(1)
    return {"bandPixels": int(band.sum()), "bandMeanAbs": float(b.mean()), "bandMaxAbs": float(b.max()),
            "bandMeanAbs255": round(float(b.mean()) * 255, 4), "bandMaxAbs255": round(float(b.max()) * 255, 4),
            "tileMeanAbs255": round(float(diff.mean()) * 255, 4), "tileMaxAbs255": round(float(diff.max()) * 255, 4),
            "pass": bool(b.mean() <= MEAN_GATE and b.max() <= MAX_GATE)}


def run_reference(inputs: dict[str, np.ndarray]) -> dict:
    import torch

    from export_birefnet import BiRefNetAlpha, load_birefnet

    model = BiRefNetAlpha(load_birefnet())
    res = {}
    for name, x in inputs.items():
        t0 = time.time()
        with torch.inference_mode():
            a = model(torch.from_numpy(x))[0, 0].numpy()
        res[name] = {"seconds": round(time.time() - t0, 1)}
        np.save(PARITY_DIR / f"birefnet_ref_{name}.npy", a.astype(np.float32))
    return res


def run_onnx(inputs: dict[str, np.ndarray], ep: str, precision: str) -> dict:
    import onnxruntime as ort

    path = common.ONNX_DIR / f"birefnet_hr_matting_2048.{precision}.onnx"
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    t0 = time.time()
    sess = ort.InferenceSession(str(path), opts, providers=common.providers_for(
        ep, common.CACHE / "coreml-cache" / precision / "birefnet"))
    res: dict = {"sessionCreateSeconds": round(time.time() - t0, 1), "activeProvider": sess.get_providers()[0],
                 "tiles": {}}
    ok = True
    for i, (name, x) in enumerate(inputs.items()):
        t0 = time.time()
        a = sess.run(None, {"image": x})[0][0, 0]
        secs = time.time() - t0
        ref = np.load(PARITY_DIR / f"birefnet_ref_{name}.npy")
        cmp = compare(a, ref)
        cmp["seconds"] = round(secs, 1)
        cmp["firstRun"] = i == 0
        res["tiles"][name] = cmp
        ok &= cmp["pass"]
        print(name, cmp, flush=True)
    res["pass"] = bool(ok)
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", action="store_true")
    ap.add_argument("--ep", default="cpu")
    ap.add_argument("--precision", choices=("fp32", "fp16s"), default="fp32")
    a = ap.parse_args()
    PARITY_DIR.mkdir(parents=True, exist_ok=True)
    inputs = {k: to_input(v) for k, v in tiles().items()}
    tag = "torch_cpu_fp32" if a.reference else f"onnx_{a.ep}_{a.precision}"
    body = run_reference(inputs) if a.reference else run_onnx(inputs, a.ep, a.precision)
    out = common.write_result(f"parity_birefnet_{sys.platform}_{tag}", {
        "model": "birefnet_hr_matting", "variant": tag, "gate": {"bandMeanAbs": "1/255", "bandMaxAbs": "4/255"},
        "mediaLicence": pm.LICENCE, **body, "peakRssMiB": round(common.peak_rss_mib())})
    print(body.get("pass", "reference written"), out)


if __name__ == "__main__":
    main()
