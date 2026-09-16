"""BR0.1: export the SAM 2.1 Hiera-Large video modules to ONNX.

Modules (all static shapes, batch 1):
- image_encoder:     image (1,3,1024,1024) -> fpn0, fpn1, fpn2, pos0, pos1, pos2
- decoder_multi_n1:  one point (a click, or the upstream empty point with label -1), 3 masks
- decoder_single_n2: two points, 1 mask (dynamic multimask via stability, as upstream)
- memory_attention:  padded memory (7 slots + 64 pointer tokens) with a key mask, real RoPE
- memory_encoder:    pix_feat + scaled mask -> maskmem features and pos enc

Each is written as fp32 and fp16-stored/fp32-computed. Run one module per process
(``--module``) to keep peak memory low on a shared 16 GB machine.
"""

from __future__ import annotations

import argparse
import json
import time

import onnx
import torch

import common
import fp16_store
import sam_modules as sm

MODULES = ("image_encoder", "decoder_multi_n1", "decoder_single_n2", "memory_attention", "memory_encoder")


def load_sam():
    common.add_upstream_to_path()
    from sam2.build_sam import build_sam2_video_predictor

    return build_sam2_video_predictor(common.SAM_CONFIG, str(common.SAM_CKPT), device="cpu").float().eval()


def build(name: str, sam):
    if name == "image_encoder":
        return (sm.ImageEncoderExport(sam), (torch.randn(1, 3, 1024, 1024),), ["image"],
                ["fpn0", "fpn1", "fpn2", "pos0", "pos1", "pos2"])
    dec_in = ["pix_feat", "high_res0", "high_res1", "point_coords", "point_labels"]
    dec_out = ["low_res_multimasks", "high_res_multimasks", "ious", "low_res_masks", "high_res_masks",
               "obj_ptr", "object_score_logits"]
    feats = (torch.randn(1, 256, 64, 64), torch.randn(1, 32, 256, 256), torch.randn(1, 64, 128, 128))
    if name == "decoder_multi_n1":
        pts = (torch.tensor([[[512.0, 400.0]]]), torch.tensor([[1]], dtype=torch.int32))
        return sm.DecoderExport(sam, multimask=True), feats + pts, dec_in, dec_out
    if name == "decoder_single_n2":
        pts = (torch.tensor([[[512.0, 400.0], [100.0, 90.0]]]), torch.tensor([[1, 0]], dtype=torch.int32))
        return sm.DecoderExport(sam, multimask=False), feats + pts, dec_in, dec_out
    if name == "memory_attention":
        valid = torch.zeros(sm.MEM_TOKENS, dtype=torch.bool)
        valid[: 2 * sm.FEAT_TOKENS] = True
        base = sm.MEM_SLOTS * sm.FEAT_TOKENS
        valid[base : base + 8] = True
        args = (torch.randn(sm.FEAT_TOKENS, 1, 256), torch.randn(sm.FEAT_TOKENS, 1, 256),
                torch.randn(sm.MEM_TOKENS, 1, 64), torch.randn(sm.MEM_TOKENS, 1, 64), valid)
        return (sm.MemoryAttentionExport(sam.memory_attention), args,
                ["curr", "curr_pos", "memory", "memory_pos", "memory_valid"], ["pix_feat_with_mem"])
    if name == "memory_encoder":
        return (sm.MemoryEncoderExport(sam), (torch.randn(1, 256, 64, 64), torch.randn(1, 1, 1024, 1024)),
                ["pix_feat", "mask_for_mem"], ["maskmem_features", "maskmem_pos_enc"])
    raise ValueError(name)


def export_one(name: str) -> dict:
    sam = load_sam()
    module, args, inputs, outputs = build(name, sam)
    module.eval()
    fp32 = common.ONNX_DIR / f"sam21l_{name}.fp32.onnx"
    t0 = time.time()
    with torch.inference_mode():
        torch.onnx.export(module, args, str(fp32), input_names=inputs, output_names=outputs,
                          opset_version=common.OPSET, dynamo=False, do_constant_folding=True)
    export_s = time.time() - t0
    del module, sam
    model = onnx.load(str(fp32))
    deduped = fp16_store.dedupe_fp32(model)
    onnx.save(model, str(fp32))
    ops = sorted({n.op_type for n in model.graph.node})
    rep = fp16_store.convert(model)
    fp16 = common.ONNX_DIR / f"sam21l_{name}.fp16s.onnx"
    onnx.save(model, str(fp16))
    return {"module": name, "exportSeconds": round(export_s, 1), "ops": ops, "fp32Deduped": deduped, "fp16Store": rep,
            "files": {p.name: p.stat().st_size for p in (fp32, fp16)}, "peakRssMiB": round(common.peak_rss_mib())}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--module", choices=MODULES + ("rope_sanity",), required=True)
    a = ap.parse_args()
    common.ONNX_DIR.mkdir(parents=True, exist_ok=True)
    if a.module == "rope_sanity":
        common.add_upstream_to_path()
        err = sm.sanity_rope()
        print(json.dumps({"ropeMaxAbsDiff": err}))
        common.write_result("sam_rope_sanity", {"ropeMaxAbsDiff": err})
        return
    res = export_one(a.module)
    print(json.dumps(res, indent=2))
    common.write_result(f"export_sam_{a.module}", {**res, "pins": {k: v for k, v in common.PINS.items() if "sam" in k}})


if __name__ == "__main__":
    main()
