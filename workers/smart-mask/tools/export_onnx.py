"""Build-time only: export every graph the pack pins, from the pinned upstream checkpoints.

Runs in the isolated spike environment (PyTorch never ships in the pack):

    cd workers/smart-mask/spike
    .venv/bin/python watchdog.py --log ../.cache/export.log -- \
        "../tools/export_onnx.py --part decoder_points" \
        "../tools/export_onnx.py --part decoder_mask" \
        "../tools/export_onnx.py --part constants"

Parts:

* ``image_encoder``, ``decoder_multi_n1``, ``memory_attention``, ``memory_encoder``: the BR0
  exports (``spike/export_sam.py``), unchanged.
* ``decoder_points``: prompt encoder + mask decoder + object pointer for any number of points
  (dynamic ``N``), single mask. Used for boxes (2 points), multi-click prompts and the
  self-correction loop's auto prompts. Only the CPU EP runs SAM (parity rule), so a dynamic
  axis costs nothing.
* ``decoder_mask``: the same heads fed a mask prompt through ``mask_downsample`` — upstream's
  ``_use_mask_as_output`` pointer path, used for locked frames, window seeds and corrections.
* ``constants``: the orchestration parameters outside every graph (``tracker.py``).
* ``birefnet``: ``spike/export_birefnet.py`` at a tile size, then ``fp16_store``.

Every output's sha256 must then be recorded in ``pack/models.lock.toml`` and ``models.py``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

SPIKE = Path(__file__).resolve().parent.parent / "spike"
sys.path.insert(0, str(SPIKE))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def export_decoder(part: str, out_dir: Path) -> Path:
    import common
    import export_sam
    import fp16_store
    import onnx
    import sam_modules as sm
    import torch

    sam = export_sam.load_sam()
    feats = (
        torch.randn(1, 256, 64, 64),
        torch.randn(1, 32, 256, 256),
        torch.randn(1, 64, 128, 128),
    )
    outputs = [
        "low_res_multimasks",
        "high_res_multimasks",
        "ious",
        "low_res_masks",
        "high_res_masks",
        "obj_ptr",
        "object_score_logits",
    ]
    if part == "decoder_points":
        module: torch.nn.Module = sm.DecoderExport(sam, multimask=False)
        args = (
            *feats,
            torch.tensor([[[100.0, 90.0], [700.0, 800.0], [512.0, 400.0]]]),
            torch.tensor([[2, 3, 1]], dtype=torch.int32),
        )
        inputs = ["pix_feat", "high_res0", "high_res1", "point_coords", "point_labels"]
        dynamic = {"point_coords": {1: "points"}, "point_labels": {1: "points"}}
    else:

        class DecoderMaskExport(torch.nn.Module):
            def __init__(self, model: torch.nn.Module) -> None:
                super().__init__()
                self.sam = model

            def forward(self, pix_feat, high_res0, high_res1, mask):  # type: ignore[no-untyped-def]
                return self.sam._forward_sam_heads(
                    backbone_features=pix_feat,
                    point_inputs=None,
                    mask_inputs=self.sam.mask_downsample(mask),
                    high_res_features=[high_res0, high_res1],
                    multimask_output=False,
                )

        module = DecoderMaskExport(sam)
        args = (
            *feats,
            (torch.rand(1, 1, 1024, 1024) > 0.5).float(),
        )
        inputs = ["pix_feat", "high_res0", "high_res1", "mask"]
        dynamic = {}
    module.eval()
    target = out_dir / f"sam21l_{part}.fp32.onnx"
    with torch.inference_mode():
        torch.onnx.export(
            module,
            args,
            str(target),
            input_names=inputs,
            output_names=outputs,
            opset_version=common.OPSET,
            dynamo=False,
            do_constant_folding=True,
            dynamic_axes=dynamic,
        )
    model = onnx.load(str(target))
    fp16_store.dedupe_fp32(model)
    onnx.save(model, str(target))
    return target


def export_constants(out_dir: Path) -> Path:
    import export_sam
    import numpy as np

    sam = export_sam.load_sam()
    target = out_dir / "sam21l_constants.npz"
    arrays = {
        "maskmem_tpos_enc": sam.maskmem_tpos_enc.detach().float().numpy(),
        "no_mem_embed": sam.no_mem_embed.detach().float().numpy(),
        "no_obj_embed_spatial": sam.no_obj_embed_spatial.detach().float().numpy(),
        "obj_ptr_tpos_proj_weight": sam.obj_ptr_tpos_proj.weight.detach().float().numpy(),
        "obj_ptr_tpos_proj_bias": sam.obj_ptr_tpos_proj.bias.detach().float().numpy(),
        "no_obj_ptr": sam.no_obj_ptr.detach().float().numpy(),
    }
    # np.savez writes a fixed zip timestamp per entry, so equal arrays give equal bytes.
    with target.open("wb") as handle:
        np.savez(handle, **arrays)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--part", required=True, choices=("decoder_points", "decoder_mask", "constants")
    )
    parser.add_argument("--out", type=Path, default=SPIKE.parent / ".cache" / "onnx")
    arguments = parser.parse_args()
    arguments.out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    if arguments.part == "constants":
        target = export_constants(arguments.out)
    else:
        target = export_decoder(arguments.part, arguments.out)
    record = {
        "part": arguments.part,
        "file": target.name,
        "bytes": target.stat().st_size,
        "sha256": sha256(target),
        "seconds": round(time.time() - started, 1),
    }
    import common

    common.write_result(f"export_{arguments.part}", record)
    sys.stdout.write(json.dumps(record) + "\n")


if __name__ == "__main__":
    main()
