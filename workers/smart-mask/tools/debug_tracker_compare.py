"""Debug (BR3.15): the port's memory inputs for frame 1 vs the captured upstream ones."""
import os, sys
from pathlib import Path
import numpy as np
PACK = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACK / "src"))
os.environ.setdefault("FRAMEPILOT_SMART_MASK_MODELS_DIR", str(PACK / ".cache" / "onnx"))
os.environ.setdefault("FRAMEPILOT_SMART_MASK_ALLOW_UNAPPROVED_FFMPEG", "1")
from framepilot_smart_mask.media import FfmpegTools, verify_tools
from framepilot_smart_mask.onnx_backend import OnnxModelProvider
from framepilot_smart_mask.models import models_directory
from framepilot_smart_mask.tracker import PointPrompt, SamTracker, preprocess
ref = np.load(sys.argv[1])
tools = FfmpegTools(*verify_tools())
path = str(PACK / ".cache/media/sintel_000240.mkv")
info = tools.probe(path)
frames = np.stack(list(tools.frames(path, info, 0, 3)))
sam = OnnxModelProvider(models_directory()).open_sam()
feats = {}
def f(i):
    if i not in feats: feats[i] = sam.encode_image(preprocess(frames[i]))
    return feats[i]
seen = []
orig = sam.attend
def attend(curr, curr_pos, memory, memory_pos, valid):
    seen.append((curr, memory, memory_pos, valid)); return orig(curr, curr_pos, memory, memory_pos, valid)
sam.attend = attend
t = SamTracker(sam, f, memory_storage="bfloat16")
h, w = frames.shape[1:3]
cond = {0: t.condition(0, PointPrompt(((715/w, 470/h),), (1,)))}
print("cond obj_ptr maxdiff", np.abs(cond[0].obj_ptr - ref["cond_obj_ptr"].reshape(-1)).max(), "score", cond[0].score, ref["cond_score"])
print("cond pred maxdiff", np.abs(cond[0].low_res - ref["cond_pred"].reshape(256,256)).max())
cm = ref["cond_maskmem"].reshape(64, 4096).T
print("cond maskmem maxdiff", np.abs(cond[0].maskmem_features - cm).max())
t.propagate(cond, 3, reverse=False, start=0, stop=2)
for i, (curr, memory, pos, valid) in enumerate(seen):
    print(f"frame {i+1}: valid same", np.array_equal(valid, ref[f"f{i}_valid"]), "valid count", valid.sum(), ref[f"f{i}_valid"].sum())
    print("  curr", np.abs(curr - ref[f"f{i}_curr"]).max(), "memory", np.abs(memory - ref[f"f{i}_memory"]).max(), "pos", np.abs(pos - ref[f"f{i}_memory_pos"]).max())
    d = np.abs(pos - ref[f"f{i}_memory_pos"]).reshape(-1, 64).max(axis=1); print("  pos diff tokens >1e-3:", np.nonzero(d > 1e-3)[0][:5], (d > 1e-3).sum())
    d = np.abs(memory - ref[f"f{i}_memory"]).reshape(-1, 64).max(axis=1); print("  mem diff tokens >1e-3:", np.nonzero(d > 1e-3)[0][:5], (d > 1e-3).sum())
