"""BR0.2: SAM 2.1 Hiera-L video-path parity, ONNX (model, EP, precision) vs PyTorch.

How parity is isolated: both runs use the *same* upstream ``SAM2VideoPredictor``
orchestration (memory bank selection, temporal encodings, pointer handling). The ONNX run
replaces exactly the four exported modules (image encoder, prompt encoder + mask decoder,
memory attention, memory encoder) with onnxruntime sessions. Any difference is therefore the
exported maths on that EP, accumulated through the video memory, which is what the gate is
about. Metric: per-frame IoU of the final video-resolution masks (logit > 0), gate >= 0.999.

Runs unchanged on Windows (MO-9): ``--ep dml`` or ``--ep <ProviderName>`` for a Windows ML
vendor EP; requires torch (reference), onnxruntime(-directml/-winml) and ffmpeg on PATH.

    python parity_sam.py --reference                      # once per machine, writes masks
    python parity_sam.py --ep cpu --precision fp32
    python parity_sam.py --ep coreml --precision fp16s
"""

from __future__ import annotations

import argparse
import sys
import time

import numpy as np
import torch
from PIL import Image

import common
import parity_media as pm
import sam_modules as sm

IOU_GATE = 0.999
IMG_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
IMG_STD = np.array([0.229, 0.224, 0.225], np.float32)
PARITY_DIR = common.CACHE / "parity"


def preprocess(frames: np.ndarray, size: int = 1024) -> torch.Tensor:
    """Exactly upstream _load_img_as_tensor + normalisation, from decoded RGB frames."""
    out = np.empty((len(frames), 3, size, size), np.float32)
    for i, f in enumerate(frames):
        img = np.array(Image.fromarray(f).resize((size, size))) / 255.0
        out[i] = ((img - IMG_MEAN) / IMG_STD).transpose(2, 0, 1)
    return torch.from_numpy(out)


def build_predictor():
    common.add_upstream_to_path()
    from sam2.build_sam import build_sam2_video_predictor

    return build_sam2_video_predictor(common.SAM_CONFIG, str(common.SAM_CKPT), device="cpu").float().eval()


class OnnxSam:
    """onnxruntime sessions for the four modules, installed into a predictor."""

    def __init__(self, ep: str, precision: str, cpu_modules: tuple[str, ...] = ()) -> None:
        import onnxruntime as ort

        self.ep = ep
        self.sessions = {}
        self.prepare_seconds = {}
        cache = common.CACHE / "coreml-cache" / precision
        for name in ("image_encoder", "decoder_multi_n1", "decoder_single_n2", "memory_attention", "memory_encoder"):
            path = common.ONNX_DIR / f"sam21l_{name}.{precision}.onnx"
            opts = common.session_options()
            t0 = time.time()
            self.sessions[name] = ort.InferenceSession(str(path), opts, providers=common.providers_for(
                "cpu" if name in cpu_modules else ep, cache / name))
            self.prepare_seconds[name] = round(time.time() - t0, 2)
        self.active_providers = {k: s.get_providers()[0] for k, s in self.sessions.items()}
        self.timings: dict[str, list[float]] = {k: [] for k in self.sessions}

    def _run(self, name, feeds):
        t0 = time.time()
        out = self.sessions[name].run(None, {k: np.ascontiguousarray(v) for k, v in feeds.items()})
        self.timings[name].append(time.time() - t0)
        return [torch.from_numpy(o) for o in out]

    def install(self, predictor) -> None:
        onnx_self = self

        def forward_image(img_batch):
            f0, f1, f2, p0, p1, p2 = onnx_self._run("image_encoder", {"image": img_batch.float().numpy()})
            return {"vision_features": f2, "vision_pos_enc": [p0, p1, p2], "backbone_fpn": [f0, f1, f2]}

        def forward_sam_heads(backbone_features, point_inputs=None, mask_inputs=None, high_res_features=None,
                              multimask_output=False):
            if mask_inputs is not None:
                raise NotImplementedError("mask prompts are not in the parity set")
            if point_inputs is None:
                coords = np.zeros((1, 1, 2), np.float32)
                labels = -np.ones((1, 1), np.int32)
            else:
                coords = point_inputs["point_coords"].float().numpy()
                labels = point_inputs["point_labels"].to(torch.int32).numpy()
            n = coords.shape[1]
            if multimask_output and n == 1:
                name = "decoder_multi_n1"
            elif not multimask_output and n == 2:
                name = "decoder_single_n2"
            else:
                raise NotImplementedError(f"no static decoder for multimask={multimask_output} n={n}")
            return tuple(onnx_self._run(name, {
                "pix_feat": backbone_features.float().numpy(), "high_res0": high_res_features[0].float().numpy(),
                "high_res1": high_res_features[1].float().numpy(), "point_coords": coords, "point_labels": labels}))

        class MemAttn(torch.nn.Module):
            def forward(self, curr, memory, curr_pos=None, memory_pos=None, num_obj_ptr_tokens=0):
                curr = curr[0] if isinstance(curr, list) else curr
                curr_pos = curr_pos[0] if isinstance(curr_pos, list) else curr_pos
                mem, pos, valid = sm.pad_memory(memory.float(), memory_pos.float(), num_obj_ptr_tokens)
                (out,) = onnx_self._run("memory_attention", {
                    "curr": curr.float().numpy(), "curr_pos": curr_pos.float().numpy(), "memory": mem.numpy(),
                    "memory_pos": pos.numpy(), "memory_valid": valid.numpy()})
                return out

        class MemEnc(torch.nn.Module):
            def forward(self, pix_feat, masks, skip_mask_sigmoid=False):
                assert skip_mask_sigmoid
                feats, pos = onnx_self._run("memory_encoder", {"pix_feat": pix_feat.float().numpy(),
                                                               "mask_for_mem": masks.float().numpy()})
                return {"vision_features": feats, "vision_pos_enc": [pos]}

        # The ONNX run needs only the orchestration constants (tpos encodings, no-mem/no-obj
        # embeddings, pointer projection); drop the replaced modules' PyTorch weights (~0.9 GB).
        for name in ("image_encoder", "sam_mask_decoder"):
            predictor._modules[name] = torch.nn.Identity()
        predictor.forward_image = forward_image
        predictor._forward_sam_heads = forward_sam_heads
        predictor._modules["memory_attention"] = MemAttn()
        predictor._modules["memory_encoder"] = MemEnc()


def run_clip(predictor, clip: str, frames_n: int) -> tuple[np.ndarray, list[float]]:
    import sam2.sam2_video_predictor as svp

    path = pm.ensure_clip(clip)
    frames = pm.decode_rgb(path, frames_n)
    cut = pm.first_cut(frames)
    frames = frames[:cut]
    h, w = frames.shape[1:3]
    images = preprocess(frames)
    orig = svp.load_video_frames
    svp.load_video_frames = lambda **kw: (images, h, w)
    try:
        with torch.inference_mode():
            state = predictor.init_state(video_path="<decoded>")
            pts, labels = pm.CLIPS[clip][2:]
            predictor.add_new_points_or_box(state, frame_idx=0, obj_id=1, points=np.array(pts, np.float32),
                                            labels=np.array(labels, np.int32))
            masks = np.zeros((len(frames), h, w), bool)
            per_frame_s = []
            t0 = time.time()
            for idx, _, logits in predictor.propagate_in_video(state):
                masks[idx] = (logits[0, 0] > 0).numpy()
                per_frame_s.append(time.time() - t0)
                t0 = time.time()
    finally:
        svp.load_video_frames = orig
    return masks, per_frame_s


def iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return 1.0 if union == 0 else float(np.logical_and(a, b).sum() / union)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", action="store_true")
    ap.add_argument("--ep", default="cpu")
    ap.add_argument("--precision", choices=("fp32", "fp16s"), default="fp32")
    ap.add_argument("--frames", type=int, default=24)
    ap.add_argument("--cpu-modules", default="", help="comma list of modules forced to the CPU EP "
                    "(a module whose EP session cannot be built falls back, and the result records it)")
    a = ap.parse_args()
    PARITY_DIR.mkdir(parents=True, exist_ok=True)
    predictor = build_predictor()
    tag = "torch_cpu_fp32" if a.reference else f"onnx_{a.ep}_{a.precision}"
    onnx_sam = None
    if not a.reference:
        cpu_modules = tuple(m for m in a.cpu_modules.split(",") if m)
        onnx_sam = OnnxSam(a.ep, a.precision, cpu_modules)
        if cpu_modules:
            tag += "_cpu-" + "-".join(cpu_modules)
        onnx_sam.install(predictor)
    result = {"model": "sam2.1_hiera_large", "variant": tag, "gate": {"perFrameIoU": IOU_GATE}, "clips": {},
              "mediaLicence": pm.LICENCE}
    passed = True
    for clip in pm.CLIPS:
        masks, per_frame = run_clip(predictor, clip, a.frames)
        ref_path = PARITY_DIR / f"sam_ref_{clip}.npz"
        entry = {"frames": int(len(masks)), "meanSecondsPerFrame": round(float(np.mean(per_frame)), 3),
                 "foregroundFraction": round(float(masks.mean()), 4)}
        if a.reference:
            np.savez_compressed(ref_path, masks=masks)
        else:
            ref = np.load(ref_path)["masks"]
            ious = [iou(m, r) for m, r in zip(masks, ref)]
            entry.update({"minIoU": round(min(ious), 6), "meanIoU": round(float(np.mean(ious)), 6),
                          "framesBelowGate": int(sum(i < IOU_GATE for i in ious)),
                          "perFrameIoU": [round(i, 6) for i in ious]})
            passed &= min(ious) >= IOU_GATE
        result["clips"][clip] = entry
        print(clip, {k: v for k, v in entry.items() if k != "perFrameIoU"}, flush=True)
    if onnx_sam is not None:
        result["activeProviders"] = onnx_sam.active_providers
        result["sessionCreateSeconds"] = onnx_sam.prepare_seconds
        result["moduleMeanSeconds"] = {k: round(float(np.mean(v)), 4) for k, v in onnx_sam.timings.items() if v}
        result["pass"] = bool(passed)
    result["peakRssMiB"] = round(common.peak_rss_mib())
    result["footprintAtEndMiB"] = common.footprint_mib()
    out = common.write_result(f"parity_sam_{sys.platform}_{tag}", result)
    print("pass" if result.get("pass", True) else "FAIL", out)


if __name__ == "__main__":
    main()
