"""Smoke check: both upstream models load from the pinned weights (no inference)."""
import sys, time, importlib
sys.path.insert(0, "../.cache/upstream/sam2")
sys.path.insert(0, "../.cache/upstream")
from sam2.build_sam import build_sam2_video_predictor
t = time.time()
p = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", "../.cache/weights/sam2.1_hiera_large.pt", device="cpu")
print("sam ok", round(time.time() - t, 1), sum(x.numel() for x in p.parameters()))
print(p.image_size, p.num_maskmem, type(p.memory_attention).__name__, type(p.sam_mask_decoder).__name__)
del p
m = importlib.import_module("birefnet_hr.birefnet")
net = m.BiRefNet(bb_pretrained=False)
from safetensors.torch import load_file
sd = load_file("../.cache/weights/birefnet_hr_matting.safetensors")
print(net.load_state_dict(sd, strict=True))
print("birefnet", sum(x.numel() for x in net.parameters()), {v.dtype for v in sd.values()})
