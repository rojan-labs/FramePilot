"""BR0.4: verify-stage prototype (02 stage 10) -> error-detection recall and review load.

Runs on cached BR0.3 outputs (.cache/proto/<clip>/), no model. Ground truth is the
construction-true alpha from pilot_generate.py, used ONLY for scoring: a check never reads it.

Checks per frame (02 stage 10, plus the pipeline's own consensus signals from stage 5):
  a  flow re-warp: neighbours' masks warped by DIS flow disagree with this frame (both sides)
  b  component audit: significant islands/holes appear that neither neighbour has
  c  edge alignment: alpha gradient vs image gradient correlation inside the band
  c2 unexplained edges (added in attempt 2): strong image edges in a ring just outside the
     matte that no alpha edge accounts for, per boundary pixel (missed hair, a cut-off limb:
     errors every estimate agrees on, which checks a/e cannot see)
  d  area and centroid continuity against the neighbourhood median
  e  model disagreement: forward vs backward SAM IoU, SAM vs BiRefNet IoU, band size
  f  object-score contradiction: SAM says "no object" while a mask is delivered (or reverse)
  h  presence transition (attempt 4): an empty matte within N frames of a non-empty one

A frame is wrong (06) when IoU < 0.98 or BF@2px < 0.95 vs ground truth.
Recall = flagged ∩ wrong / wrong (gate >= 99.5%); review load = flagged / frames (<= 10%).

Every attempt's thresholds are fixed in ATTEMPTS and every result is written, including the
misses. ``--holdout`` calibrates nothing: it reports the same attempt split by clip halves so
a threshold tuned on the whole pilot set can be seen for what it is.

    python verify_proto.py --attempt 1
"""

from __future__ import annotations

import argparse
import json

import cv2
import numpy as np

import common
import matte_metrics as mm
import pipeline_proto as pp

MIN_COMPONENT_FRAC = 0.0005  # 06 leak-rate definition: a region > 0.05% of the frame

ATTEMPTS: dict[int, dict] = {
    1: {  # a-priori thresholds, before looking at any result
        "a_rewarp_mismatch": 0.05, "b_components": True, "c_edge_corr": 0.20,
        "d_area_logratio": 0.15, "d_centroid_frac": 0.25,
        "e_fwd_bwd_iou": 0.95, "e_sam_birefnet_iou": 0.90, "e_band_frac": None, "f_object_score": True,
    },
    2: {  # after attempt 1 missed 36/256 (walk_pan, fast_motion, leave_reenter): add c2 unexplained
          # image edges next to the matte (errors every estimate shares), unchanged otherwise
        "a_rewarp_mismatch": 0.05, "b_components": True, "c_edge_corr": 0.20, "c2_unexplained": 0.5,
        "d_area_logratio": 0.15, "d_centroid_frac": 0.25,
        "e_fwd_bwd_iou": 0.95, "e_sam_birefnet_iou": 0.90, "e_band_frac": None, "f_object_score": True,
    },
    3: {  # attempt 2 + model-disagreement tightened to the IoU gate itself (0.98) and a band-size
          # check: a frame whose unknown band exceeds 40% of the foreground is not "verified"
        "a_rewarp_mismatch": 0.05, "b_components": True, "c_edge_corr": 0.20, "c2_unexplained": 0.5,
        "d_area_logratio": 0.15, "d_centroid_frac": 0.25,
        "e_fwd_bwd_iou": 0.98, "e_sam_birefnet_iou": 0.98, "e_band_frac": 0.40, "f_object_score": True,
    },
    4: {  # attempt 3 missed 2 frames: a 146-176 px sliver of a subject leaving the frame, every
          # estimate agreeing "absent". h: an empty matte within 3 frames of a non-empty one is a
          # presence transition and is reviewed
        "a_rewarp_mismatch": 0.05, "b_components": True, "c_edge_corr": 0.20, "c2_unexplained": 0.5,
        "d_area_logratio": 0.15, "d_centroid_frac": 0.25,
        "e_fwd_bwd_iou": 0.98, "e_sam_birefnet_iou": 0.98, "e_band_frac": 0.40, "f_object_score": True,
        "h_presence_window": 3,
    },
}


def components(mask: np.ndarray, min_px: int) -> tuple[int, int]:
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    fg = int(sum(stats[i, cv2.CC_STAT_AREA] >= min_px for i in range(1, n)))
    inv = (~mask).astype(np.uint8)
    n2, lab2, stats2, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    border = set(np.unique(np.concatenate([lab2[0], lab2[-1], lab2[:, 0], lab2[:, -1]])).tolist())
    holes = int(sum(stats2[i, cv2.CC_STAT_AREA] >= min_px for i in range(1, n2) if i not in border))
    return fg, holes


def half_flow(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """DIS flow at half resolution, upscaled (deterministic, bounded cost)."""
    s = cv2.resize(src, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    d = cv2.resize(dst, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    f = pp.dis_flow(s, d)
    return cv2.resize(f, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_LINEAR) * 2.0


def edge_correlation(alpha: np.ndarray, gray: np.ndarray, band: np.ndarray) -> float:
    if band.sum() < 50:
        return 1.0
    ga = cv2.magnitude(cv2.Sobel(alpha, cv2.CV_32F, 1, 0), cv2.Sobel(alpha, cv2.CV_32F, 0, 1))[band]
    gi = cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0), cv2.Sobel(gray, cv2.CV_32F, 0, 1))[band]
    if ga.std() < 1e-6 or gi.std() < 1e-6:
        return 0.0
    return float(np.corrcoef(ga, gi)[0, 1])


RING_OUT_PX = 16
EDGE_PERCENTILE = 90


def unexplained_edges(alpha: np.ndarray, gray: np.ndarray, mask: np.ndarray) -> float:
    if not mask.any():
        return 0.0
    mag = cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0), cv2.Sobel(gray, cv2.CV_32F, 0, 1))
    m8 = mask.astype(np.uint8)
    ring = cv2.dilate(m8, mm.disk(RING_OUT_PX)).astype(bool) & ~cv2.dilate(m8, mm.disk(2)).astype(bool)
    near = cv2.dilate(m8, mm.disk(RING_OUT_PX * 3)).astype(bool)
    thr = np.percentile(mag[near], EDGE_PERCENTILE)
    a_edge = cv2.magnitude(cv2.Sobel(alpha, cv2.CV_32F, 1, 0), cv2.Sobel(alpha, cv2.CV_32F, 0, 1)) > 0.05
    explained = cv2.dilate(a_edge.astype(np.uint8), mm.disk(2)).astype(bool)
    strong = (mag > thr) & ring & ~explained
    return float(strong.sum() / max(int(mm.boundary(mask).sum()), 1))


def frame_signals(clip: str) -> list[dict]:
    """Per-frame raw check signals (threshold-free), cached as JSON per clip."""
    cache = pp.PROTO_DIR / clip / "signals.json"
    if cache.exists():
        cached = json.loads(cache.read_text())
        if cached and "unexplainedEdges" in cached[0]:
            return cached
    frames, _ = pp.load_clip(clip)
    sam = np.load(pp.PROTO_DIR / clip / "sam.npz")
    bir = np.load(pp.PROTO_DIR / clip / "birefnet.npz")["alpha"]
    final = np.load(pp.PROTO_DIR / clip / "final.npz")
    alpha, band_frac = final["alpha"], final["band_frac"]
    t_frames, h, w = alpha.shape
    masks = alpha >= 128
    gray = [cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in frames]
    min_px = int(MIN_COMPONENT_FRAC * h * w)
    edge_r = max(2, int(round(pp.EDGE_RADIUS_1080P * h / 1080)))
    comps = [components(m, min_px) for m in masks]
    sig = []
    for t in range(t_frames):
        m = masks[t]
        area = int(m.sum())
        rewarp = []
        for n in (t - 1, t + 1):
            if 0 <= n < t_frames:
                fl = half_flow(gray[n], gray[t])
                wn = pp.warp(masks[n].astype(np.float32), fl) >= 0.5
                back = half_flow(gray[t], gray[n])
                # forward-backward consistency: exclude occluded / unreliable pixels
                gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
                bx = cv2.remap(back[..., 0], gx + fl[..., 0], gy + fl[..., 1], cv2.INTER_LINEAR)
                by = cv2.remap(back[..., 1], gx + fl[..., 0], gy + fl[..., 1], cv2.INTER_LINEAR)
                ok = np.hypot(fl[..., 0] + bx, fl[..., 1] + by) < 1.5
                denom = max(int(np.logical_or(m, wn)[ok].sum()), 1)
                rewarp.append(float(np.logical_xor(m, wn)[ok].sum() / denom))
        band = mm.unknown_band([m], edge_r)
        ys, xs = np.nonzero(m)
        sam_union = sam["fwd"][t] | sam["bwd"][t]
        sig.append({
            "t": t, "area": area,
            "cx": float(xs.mean()) if area else None, "cy": float(ys.mean()) if area else None,
            "rewarp": rewarp, "components": comps[t][0], "holes": comps[t][1],
            "edgeCorr": edge_correlation(alpha[t].astype(np.float32) / 255.0, gray[t].astype(np.float32), band),
            "unexplainedEdges": unexplained_edges(alpha[t].astype(np.float32) / 255.0, gray[t].astype(np.float32), m),
            "fwdBwdIoU": mm.iou(sam["fwd"][t], sam["bwd"][t]), "hasBwd": bool(sam["has_bwd"][t]),
            "samBirefnetIoU": mm.iou(sam_union, bir[t] >= 128), "bandFrac": float(band_frac[t]),
            "fwdScore": float(sam["fwd_score"][t]), "bwdScore": float(sam["bwd_score"][t]),
        })
    cache.write_text(json.dumps(sig))
    return sig


def flags_for(sig: list[dict], cfg: dict) -> list[list[str]]:
    out = []
    n = len(sig)
    for t, s in enumerate(sig):
        why = []
        if s["rewarp"] and min(s["rewarp"]) > cfg["a_rewarp_mismatch"]:
            why.append("a")
        if cfg["b_components"]:
            nb = [sig[k] for k in (t - 1, t + 1) if 0 <= k < n]
            if nb and (s["components"] > max(x["components"] for x in nb) or s["holes"] > max(x["holes"] for x in nb)):
                why.append("b")
        if s["area"] and s["edgeCorr"] < cfg["c_edge_corr"]:
            why.append("c")
        win = [sig[k] for k in range(max(0, t - 2), min(n, t + 3)) if k != t]
        areas = [x["area"] for x in win]
        med = float(np.median(areas)) if areas else 0.0
        if (s["area"] == 0) != (med == 0):
            why.append("d")
        elif s["area"] and med and abs(np.log(s["area"] / med)) > cfg["d_area_logratio"]:
            why.append("d")
        elif s["area"]:
            cs = [(x["cx"], x["cy"]) for x in win if x["area"]]
            if cs:
                mcx, mcy = np.median([c[0] for c in cs]), np.median([c[1] for c in cs])
                if np.hypot(s["cx"] - mcx, s["cy"] - mcy) > cfg["d_centroid_frac"] * np.sqrt(s["area"]):
                    why.append("d")
        if cfg.get("c2_unexplained") is not None and s["unexplainedEdges"] > cfg["c2_unexplained"]:
            why.append("c2")
        if s["fwdBwdIoU"] < cfg["e_fwd_bwd_iou"] or s["samBirefnetIoU"] < cfg["e_sam_birefnet_iou"]:
            why.append("e")
        if cfg.get("e_band_frac") is not None and s["bandFrac"] > cfg["e_band_frac"]:
            why.append("e")
        if cfg["f_object_score"]:
            for sc in (s["fwdScore"], s["bwdScore"]):
                if not np.isnan(sc) and ((sc < 0) == (s["area"] > 0)):
                    why.append("f")
                    break
        hw = cfg.get("h_presence_window")
        if hw and s["area"] == 0 and any(sig[k]["area"] > 0 for k in range(max(0, t - hw), min(n, t + hw + 1))):
            why.append("h")
        if cfg.get("g_no_backward") and not s["hasBwd"]:
            why.append("g")
        out.append(sorted(set(why)))
    return out


def truth(clip: str) -> list[dict]:
    gt = np.load(pp.PILOT_DIR / clip / "gt_alpha.npz")["alpha"]
    pred = np.load(pp.PROTO_DIR / clip / "final.npz")["alpha"]
    res = []
    for t in range(len(gt)):
        wrong, i, bf = mm.frame_is_wrong(pred[t], gt[t])
        res.append({"wrong": wrong, "iou": i, "bf": bf})
    return res


def score(clips: list[str], cfg: dict) -> dict:
    tot = wrong = caught = flagged = 0
    per_clip = {}
    missed = []
    for c in clips:
        sig, tr = frame_signals(c), truth(c)
        fl = flags_for(sig, cfg)
        cw = sum(x["wrong"] for x in tr)
        cc = sum(1 for x, f in zip(tr, fl) if x["wrong"] and f)
        cf = sum(1 for f in fl if f)
        per_clip[c] = {"frames": len(tr), "wrong": cw, "caught": cc, "flagged": cf,
                       "meanIoU": round(float(np.mean([x["iou"] for x in tr])), 4),
                       "meanBF": round(float(np.mean([x["bf"] for x in tr])), 4)}
        missed += [{"clip": c, "t": t, "iou": round(x["iou"], 4), "bf": round(x["bf"], 4)}
                   for t, (x, f) in enumerate(zip(tr, fl)) if x["wrong"] and not f]
        tot, wrong, caught, flagged = tot + len(tr), wrong + cw, caught + cc, flagged + cf
    return {"frames": tot, "wrongFrames": wrong, "caught": caught, "flagged": flagged,
            "recall": (caught / wrong) if wrong else None,
            "recallWilson95Lower": mm.wilson_lower(caught, wrong) if wrong else None,
            "reviewLoad": flagged / tot if tot else None, "perClip": per_clip, "missed": missed}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--attempt", type=int, required=True)
    ap.add_argument("--tag", default="", help="suffix for the result file (e.g. the clip subset)")
    a = ap.parse_args()
    cfg = ATTEMPTS[a.attempt]
    clips = sorted(p.parent.name for p in pp.PROTO_DIR.glob("*/final.npz"))
    res = {"attempt": a.attempt, "config": cfg, "clips": clips, "all": score(clips, cfg),
           "splitA": score(clips[0::2], cfg), "splitB": score(clips[1::2], cfg),
           "gate": {"recall": 0.995, "reviewLoad": 0.10}}
    common.write_result(f"verify_attempt_{a.attempt}{a.tag}", res)
    s = res["all"]
    print(json.dumps({k: s[k] for k in ("frames", "wrongFrames", "caught", "flagged", "recall", "recallWilson95Lower",
                                        "reviewLoad")}))


if __name__ == "__main__":
    main()
