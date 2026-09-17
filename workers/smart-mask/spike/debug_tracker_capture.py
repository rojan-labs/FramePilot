"""Debug (BR3.15): capture upstream orchestration inputs to memory attention for frames 1-2."""
import sys
import numpy as np
import torch
import common
import parity_media as pm
import parity_sam as ps
import sam_modules as sm

OUT = sys.argv[1]
predictor = ps.build_predictor()
onnx_sam = ps.OnnxSam("cpu", "fp32")
onnx_sam.install(predictor)
captured = []
original = predictor._modules["memory_attention"].forward
def capture(curr, memory, curr_pos=None, memory_pos=None, num_obj_ptr_tokens=0):
    c = curr[0] if isinstance(curr, list) else curr
    mem, pos, valid = sm.pad_memory(memory.float(), memory_pos.float(), num_obj_ptr_tokens)
    captured.append({"memory": mem.numpy(), "memory_pos": pos.numpy(), "valid": valid.numpy(), "curr": c.float().numpy(), "ptr": num_obj_ptr_tokens})
    return original(curr, memory, curr_pos, memory_pos, num_obj_ptr_tokens)
predictor._modules["memory_attention"].forward = capture
import sam2.sam2_video_predictor as svp
clip = "sintel_000240"
frames = pm.decode_rgb(pm.ensure_clip(clip), 3)
h, w = frames.shape[1:3]
images = ps.preprocess(frames)
svp.load_video_frames = lambda **kw: (images, h, w)
with torch.inference_mode():
    state = predictor.init_state(video_path="x")
    pts, labels = pm.CLIPS[clip][2:]
    predictor.add_new_points_or_box(state, frame_idx=0, obj_id=1, points=np.array(pts, np.float32), labels=np.array(labels, np.int32))
    for idx, _, logits in predictor.propagate_in_video(state):
        pass
    cond = state["output_dict_per_obj"][0]["cond_frame_outputs"][0]
np.savez(OUT, **{f"f{i}_{k}": v for i, d in enumerate(captured) for k, v in d.items() if k != "ptr"},
         cond_obj_ptr=cond["obj_ptr"].float().numpy(), cond_maskmem=cond["maskmem_features"].float().numpy(),
         cond_pred=cond["pred_masks"].float().numpy(), cond_score=cond["object_score_logits"].float().numpy())
print("captured", len(captured), [d["ptr"] for d in captured])
