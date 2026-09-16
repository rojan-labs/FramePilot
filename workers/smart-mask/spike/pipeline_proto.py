"""BR0.3: consensus + band-alpha prototype (02 stages 3, 4, 5, 7), on ONNX modules.

Stages, each cached to .cache/proto/<clip>/ so the verify iterations (BR0.4) never re-run a
model, and only one model is in memory at a time:

  sam      SAM 2.1 forward from the prompt frame, and backward from a seed frame chosen on
           the forward result (the last frame whose mask keeps >= 50% of the prompt-frame
           area; click = its distance-transform maximum). Two temporal estimates per frame.
  refine   BiRefNet_HR-matting on a padded square crop around the SAM union, resized to the
           2048² static input (a 1080p crop fits one tile; above 2048 px the crop is tiled at
           full resolution with overlap, see ``tiled_alpha``), gated to the dilated SAM union
           so it cannot switch subjects.
  consensus
           Per pixel: forward SAM, backward SAM, BiRefNet (α >= 0.5) and the previous final
           alpha warped by DIS optical flow. Unanimous pixels are exact 0/1; disagreement plus
           a radius around every estimate's edge is the unknown band; the band takes the
           BiRefNet alpha (stage 7; for <= 2048 px crops the same pass is already at source
           resolution after resize-back, so no second pass is needed).

Not in this prototype (and not needed for BR0 measurements): self-correction rounds
(stage 6), foreground colour (8), stabilisation (9), encode (11).

    python pipeline_proto.py --clip walk_pan --stage all --sam-ep coreml --birefnet-ep coreml
"""

from __future__ import annotations

import argparse
import json
import time

import cv2
import numpy as np
import torch

import common
import matte_metrics as mm
import parity_media as pm

PILOT_DIR = common.CACHE / "pilot"
PROTO_DIR = common.CACHE / "proto"
TILE = 2048
TILE_OVERLAP = 256
CROP_PAD = 0.2
GATE_DILATE_FRAC = 0.03
EDGE_RADIUS_1080P = 6
SEED_AREA_KEEP = 0.5


def load_clip(clip: str) -> tuple[np.ndarray, dict]:
    meta = json.loads((PILOT_DIR / clip / "meta.json").read_text())
    frames = pm.decode_rgb(str(PILOT_DIR / clip / "frames.mkv"), meta["frames"])
    return frames, meta


# ---------------------------------------------------------------- stage: sam
def _propagate(predictor, images, h, w, frame_idx, point, reverse):
    import sam2.sam2_video_predictor as svp

    orig = svp.load_video_frames
    svp.load_video_frames = lambda **kw: (images, h, w)
    try:
        with torch.inference_mode():
            state = predictor.init_state(video_path="<decoded>")
            predictor.add_new_points_or_box(state, frame_idx=frame_idx, obj_id=1,
                                            points=np.array([point], np.float32), labels=np.array([1], np.int32))
            logits = {}
            for idx, _, out in predictor.propagate_in_video(state, start_frame_idx=frame_idx, reverse=reverse):
                logits[idx] = out[0, 0].numpy().astype(np.float16)
            obj = state["output_dict_per_obj"][0]
            scores = {}
            for d in (obj["cond_frame_outputs"], obj["non_cond_frame_outputs"]):
                for idx, o in d.items():
                    scores[idx] = float(o["object_score_logits"].flatten()[0])
    finally:
        svp.load_video_frames = orig
    return logits, scores


def stage_sam(clip: str, ep: str, precision: str) -> dict:
    import parity_sam

    frames, meta = load_clip(clip)
    t_frames = len(frames)
    h, w = frames.shape[1:3]
    images = parity_sam.preprocess(frames)
    predictor = parity_sam.build_predictor()
    onnx_sam = parity_sam.OnnxSam(ep, precision)
    onnx_sam.install(predictor)
    t0 = time.time()
    fwd_logits, fwd_scores = _propagate(predictor, images, h, w, 0, meta["click"], reverse=False)
    fwd_s = time.time() - t0
    fwd = np.stack([fwd_logits[i] > 0 for i in range(t_frames)])
    area0 = max(int(fwd[0].sum()), 1)
    seed = max((i for i in range(t_frames) if fwd[i].sum() >= SEED_AREA_KEEP * area0), default=0)
    dist = cv2.distanceTransform(fwd[seed].astype(np.uint8), cv2.DIST_L2, 5)
    yx = np.unravel_index(int(np.argmax(dist)), dist.shape)
    seed_click = [float(yx[1]), float(yx[0])]
    t0 = time.time()
    bwd_logits, bwd_scores = _propagate(predictor, images, h, w, seed, seed_click, reverse=True) if seed > 0 else ({}, {})
    bwd_s = time.time() - t0
    bwd = np.stack([(bwd_logits[i] > 0) if i in bwd_logits else fwd[i] for i in range(t_frames)])
    out = PROTO_DIR / clip
    out.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out / "sam.npz", fwd=fwd, bwd=bwd, has_bwd=np.array([i in bwd_logits for i in range(t_frames)]),
                        fwd_score=np.array([fwd_scores.get(i, np.nan) for i in range(t_frames)], np.float32),
                        bwd_score=np.array([bwd_scores.get(i, np.nan) for i in range(t_frames)], np.float32))
    info = {"frames": t_frames, "seedFrame": seed, "seedClick": seed_click, "forwardSeconds": round(fwd_s, 1),
            "backwardSeconds": round(bwd_s, 1), "samProviders": onnx_sam.active_providers,
            "samModuleMeanSeconds": {k: round(float(np.mean(v)), 3) for k, v in onnx_sam.timings.items() if v}}
    return info


# ---------------------------------------------------------------- stage: refine
class BiRefNetOnnx:
    MEAN = np.array([0.485, 0.456, 0.406], np.float32)
    STD = np.array([0.229, 0.224, 0.225], np.float32)

    def __init__(self, ep: str, precision: str) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        t0 = time.time()
        self.sess = ort.InferenceSession(
            str(common.ONNX_DIR / f"birefnet_hr_matting_{TILE}.{precision}.onnx"), opts,
            providers=common.providers_for(ep, common.CACHE / "coreml-cache" / precision / f"birefnet_{TILE}"))
        self.create_seconds = time.time() - t0
        self.provider = self.sess.get_providers()[0]
        self.run_seconds: list[float] = []

    def __call__(self, rgb_2048: np.ndarray) -> np.ndarray:
        x = ((rgb_2048.astype(np.float32) / 255.0 - self.MEAN) / self.STD).transpose(2, 0, 1)[None]
        t0 = time.time()
        a = self.sess.run(None, {"image": np.ascontiguousarray(x)})[0][0, 0]
        self.run_seconds.append(time.time() - t0)
        return a


def square_crop(mask: np.ndarray, h: int, w: int) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return 0, 0, 0, 0
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    side = int(max(x1 - x0, y1 - y0) * (1 + 2 * CROP_PAD)) + 32
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    side_w, side_h = min(side, w), min(side, h)
    left = int(np.clip(cx - side_w // 2, 0, w - side_w))
    top = int(np.clip(cy - side_h // 2, 0, h - side_h))
    return left, top, side_w, side_h


def tiled_alpha(model: BiRefNetOnnx, crop: np.ndarray) -> np.ndarray:
    """Alpha for a crop: one resized pass when it fits 2048², else full-resolution tiles."""
    ch, cw = crop.shape[:2]
    if max(ch, cw) <= TILE:
        a = model(cv2.resize(crop, (TILE, TILE), interpolation=cv2.INTER_CUBIC))
        return cv2.resize(a, (cw, ch), interpolation=cv2.INTER_LINEAR)
    pad_h, pad_w = max(TILE - ch, 0), max(TILE - cw, 0)
    src = cv2.copyMakeBorder(crop, 0, pad_h, 0, pad_w, cv2.BORDER_REFLECT)
    acc = np.zeros(src.shape[:2], np.float32)
    wsum = np.zeros(src.shape[:2], np.float32)
    wt = mm.blend_weight(TILE, TILE_OVERLAP)
    for y in mm.tiles_1d(src.shape[0], TILE, TILE_OVERLAP):
        for x in mm.tiles_1d(src.shape[1], TILE, TILE_OVERLAP):
            acc[y : y + TILE, x : x + TILE] += model(src[y : y + TILE, x : x + TILE]) * wt
            wsum[y : y + TILE, x : x + TILE] += wt
    return (acc / np.maximum(wsum, 1e-6))[:ch, :cw]


def stage_refine(clip: str, ep: str, precision: str) -> dict:
    frames, _ = load_clip(clip)
    sam = np.load(PROTO_DIR / clip / "sam.npz")
    fwd, bwd = sam["fwd"], sam["bwd"]
    t_frames, h, w = fwd.shape
    model = BiRefNetOnnx(ep, precision)
    alpha = np.zeros((t_frames, h, w), np.uint8)
    for t in range(t_frames):
        union = fwd[t] | bwd[t]
        left, top, cw, ch = square_crop(union, h, w)
        if cw == 0:
            continue
        a = tiled_alpha(model, frames[t, top : top + ch, left : left + cw])
        gate_r = max(8, int(GATE_DILATE_FRAC * max(cw, ch)))
        gate = cv2.dilate(union[top : top + ch, left : left + cw].astype(np.uint8), mm.disk(gate_r)).astype(bool)
        alpha[t, top : top + ch, left : left + cw] = np.clip(np.round(a * gate * 255), 0, 255).astype(np.uint8)
    np.savez_compressed(PROTO_DIR / clip / "birefnet.npz", alpha=alpha)
    return {"birefnetProvider": model.provider, "birefnetCreateSeconds": round(model.create_seconds, 1),
            "birefnetMeanSeconds": round(float(np.mean(model.run_seconds)), 2) if model.run_seconds else None,
            "birefnetFirstSeconds": round(model.run_seconds[0], 2) if model.run_seconds else None}


# ---------------------------------------------------------------- stage: consensus
_DIS = None


def dis_flow(src_gray: np.ndarray, dst_gray: np.ndarray) -> np.ndarray:
    """Flow such that dst(x) ≈ src(x + flow(x)); fixed DIS preset (02: deterministic)."""
    global _DIS
    if _DIS is None:
        _DIS = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    return _DIS.calc(dst_gray, src_gray, None)


def warp(img: np.ndarray, flow: np.ndarray) -> np.ndarray:
    h, w = flow.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return cv2.remap(img, gx + flow[..., 0], gy + flow[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def stage_consensus(clip: str) -> dict:
    frames, _ = load_clip(clip)
    sam = np.load(PROTO_DIR / clip / "sam.npz")
    fwd, bwd = sam["fwd"], sam["bwd"]
    bir = np.load(PROTO_DIR / clip / "birefnet.npz")["alpha"]
    t_frames, h, w = fwd.shape
    edge_r = max(2, int(round(EDGE_RADIUS_1080P * h / 1080)))
    gray = [cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in frames]
    final = np.zeros_like(bir)
    band_frac = np.zeros(t_frames, np.float32)
    t0 = time.time()
    for t in range(t_frames):
        est = [fwd[t], bwd[t], bir[t] >= 128]
        if t > 0:
            flow = dis_flow(gray[t - 1], gray[t])
            est.append(warp(final[t - 1].astype(np.float32), flow) >= 127.5)
        band = mm.unknown_band(est, edge_r)
        a = mm.consensus_alpha(est, band, bir[t].astype(np.float32) / 255.0)
        final[t] = np.clip(np.round(a * 255), 0, 255).astype(np.uint8)
        fg = max(int(np.logical_or.reduce(est).sum()), 1)
        band_frac[t] = band.sum() / fg
    np.savez_compressed(PROTO_DIR / clip / "final.npz", alpha=final, band_frac=band_frac)
    return {"consensusSeconds": round(time.time() - t0, 1), "edgeRadiusPx": edge_r}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", required=True)
    ap.add_argument("--stage", choices=("sam", "refine", "consensus", "all"), default="all")
    ap.add_argument("--sam-ep", default="cpu")
    ap.add_argument("--sam-precision", default="fp32")
    ap.add_argument("--birefnet-ep", default="cpu")
    ap.add_argument("--birefnet-precision", default="fp32")
    a = ap.parse_args()
    info_path = PROTO_DIR / a.clip / "run.json"
    info = json.loads(info_path.read_text()) if info_path.exists() else {}
    if a.stage in ("sam", "all"):
        info["sam"] = stage_sam(a.clip, a.sam_ep, a.sam_precision)
    if a.stage in ("refine", "all"):
        info["refine"] = stage_refine(a.clip, a.birefnet_ep, a.birefnet_precision)
    if a.stage in ("consensus", "all"):
        info["consensus"] = stage_consensus(a.clip)
    info_path.parent.mkdir(parents=True, exist_ok=True)
    info_path.write_text(json.dumps(info, indent=2))
    print(json.dumps(info))


if __name__ == "__main__":
    main()
