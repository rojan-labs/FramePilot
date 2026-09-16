"""BR0.1: export BiRefNet_HR-matting to ONNX (fp32 and fp16-stored/fp32-computed).

Static input (1, 3, 2048, 2048), ImageNet-normalised RGB in [0, 1] before normalisation;
output (1, 1, 2048, 2048) alpha = sigmoid(last prediction), exactly what the upstream
inference snippet does. torchvision's ``deform_conv2d`` is exported to the standard ONNX
``DeformConv`` (opset 19), which onnxruntime implements on the CPU EP.

The published checkpoint is already float16 (444 MB). The PyTorch reference and the "fp32"
ONNX are that checkpoint upcast to float32; the fp16-stored ONNX therefore carries the very
same values as the upstream file.
"""

from __future__ import annotations

import argparse
import importlib
import json
import time

import torch
from safetensors.torch import load_file

import common
import fp16_store

SIZE = 2048


def load_birefnet() -> torch.nn.Module:
    common.add_upstream_to_path()
    mod = importlib.import_module("birefnet_hr.birefnet")
    net = mod.BiRefNet(bb_pretrained=False)
    state = load_file(str(common.BIREFNET_CKPT))
    net.load_state_dict(state, strict=True)
    return net.float().eval()


class BiRefNetAlpha(torch.nn.Module):
    def __init__(self, net: torch.nn.Module) -> None:
        super().__init__()
        self.net = net

    def forward(self, image: torch.Tensor) -> torch.Tensor:
        return self.net(image)[-1].sigmoid()


def _deform_conv2d_onnxscript():
    """torchvision::deform_conv2d -> ONNX DeformConv (opset 19) for the dynamo exporter."""
    from onnxscript import opset19 as op

    def deform_conv2d(input, weight, offset, mask, bias, stride_h: int, stride_w: int, pad_h: int, pad_w: int,
                      dil_h: int, dil_w: int, groups: int, offset_groups: int, use_mask: bool):
        return op.DeformConv(input, weight, offset, bias, mask, strides=[stride_h, stride_w],
                             pads=[pad_h, pad_w, pad_h, pad_w], dilations=[dil_h, dil_w],
                             group=groups, offset_group=offset_groups)

    return deform_conv2d


def export(out_dir) -> dict:
    model = BiRefNetAlpha(load_birefnet())
    dummy = torch.rand(1, 3, SIZE, SIZE)
    fp32 = out_dir / "birefnet_hr_matting_2048.fp32.onnx"
    t0 = time.time()
    # The dynamo exporter traces with fake tensors, so no 2048² activations are allocated
    # (the TorchScript tracer needs a real forward: ~13 GiB at 2048², measured).
    import torchvision  # noqa: F401  registers torchvision::deform_conv2d

    program = torch.onnx.export(
        model, (dummy,), input_names=["image"], output_names=["alpha"], opset_version=common.OPSET,
        dynamo=True, external_data=False, optimize=True,
        custom_translation_table={torch.ops.torchvision.deform_conv2d.default: _deform_conv2d_onnxscript()},
    )
    program.save(str(fp32), external_data=False)
    export_s = time.time() - t0
    del model
    import onnx

    m = onnx.load(str(fp32))
    deduped = fp16_store.dedupe_fp32(m)
    onnx.save(m, str(fp32))
    ops = sorted({n.op_type for n in m.graph.node})
    rep = fp16_store.convert(m)
    fp16 = out_dir / "birefnet_hr_matting_2048.fp16s.onnx"
    onnx.save(m, str(fp16))
    return {"exportSeconds": round(export_s, 1), "ops": ops, "fp32Deduped": deduped, "fp16Store": rep,
            "files": {p.name: p.stat().st_size for p in (fp32, fp16)}}


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()
    common.ONNX_DIR.mkdir(parents=True, exist_ok=True)
    res = export(common.ONNX_DIR)
    res["peakRssMiB"] = round(common.peak_rss_mib())
    res["pins"] = {k: v for k, v in common.PINS.items() if "birefnet" in k}
    print(json.dumps(res, indent=2))
    common.write_result("export_birefnet", res)


if __name__ == "__main__":
    main()
