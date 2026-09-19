"""BR0.7: throughput, memory and storage per minute, at 1080p30 and 4K30.

Measured here (one job, watchdog-capped):
- CPU-side per-frame stages that scale with source resolution: DIS flow (consensus + two
  verify re-warps), band construction, consensus, component audit, at 1920×1080 and
  3840×2160 on real pilot frames (4K = the 1080p frame upscaled; flow cost depends on size);
- FFV1 storage: matte.mkv (gray, lossless) and foreground.mkv (rgb24, band pixels only, zero
  elsewhere) from the BR0.3 prototype output of a pilot clip, 48 frames at 1080p, and the
  same upscaled to 4K. Scaled to one minute at 30 fps.

Model stage timings (SAM modules per frame, BiRefNet per 2048² tile, session prepare) are
read from the parity and probe results, not re-run. The per-footage-second figure is then an
explicit formula (written into the result) rather than a hidden extrapolation:

  per frame = 2 × SAM(frame) + tiles(res) × BiRefNet(tile) + cpu_stages(res)
  (FFV1 sizes here are from the pilot's synthetic subjects over real backgrounds; the foreground
  stream carries only band pixels, so its size tracks band area, not frame area)
  compute s per footage s = per frame × 30

with tiles(1080p) = 1 (a subject crop ≤ 1080 px fits one 2048² input) and tiles(4K) = 4
(a crop up to 2160 px needs a 2×2 full-resolution tiling with 256 px overlap).
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

import common
import matte_metrics as mm
import pipeline_proto as pp
import verify_proto as vp

FPS_OUT = 30
SIZES = {"1080p": (1920, 1080), "4K": (3840, 2160)}


def ffv1_bytes(frames, w: int, h: int, pix_fmt: str) -> int:
    """Encode an iterable of frames to FFV1 by streaming (one frame in memory at a time)."""
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "x.mkv"
        enc = subprocess.Popen(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", pix_fmt,
                                "-s", f"{w}x{h}", "-r", str(FPS_OUT), "-i", "-", "-c:v", "ffv1", "-level", "3", "-y",
                                str(out)], stdin=subprocess.PIPE)
        for f in frames:
            enc.stdin.write(np.ascontiguousarray(f).tobytes())
        enc.stdin.close()
        if enc.wait() != 0:
            raise RuntimeError("ffmpeg FFV1 encode failed")
        return out.stat().st_size


def cpu_stage_seconds(frames: np.ndarray, alpha: np.ndarray, size: tuple[int, int], n: int = 6) -> dict:
    w, h = size
    fr = [cv2.resize(f, (w, h), interpolation=cv2.INTER_CUBIC) for f in frames[:n]]
    al = [cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR) for a in alpha[:n]]
    gray = [cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in fr]
    edge_r = max(2, int(round(pp.EDGE_RADIUS_1080P * h / 1080)))
    t_flow = t_band = t_verify = 0.0
    for t in range(1, n):
        t0 = time.time()
        fl = pp.dis_flow(gray[t - 1], gray[t])
        warped = pp.warp(al[t - 1].astype(np.float32), fl) >= 127.5
        t_flow += time.time() - t0
        t0 = time.time()
        m = al[t] >= 128
        band = mm.unknown_band([m, warped, m], edge_r)
        mm.consensus_alpha([m, warped, m], band, al[t].astype(np.float32) / 255.0)
        t_band += time.time() - t0
        t0 = time.time()
        for nb in (t - 1,):  # verify: two half-res re-warps (forward + backward flow) per neighbour
            vp.half_flow(gray[nb], gray[t])
            vp.half_flow(gray[t], gray[nb])
        vp.components(m, int(vp.MIN_COMPONENT_FRAC * h * w))
        t_verify += time.time() - t0
    k = n - 1
    # verify uses two neighbours; the loop measured one, so double that part
    return {"flowWarpSeconds": round(t_flow / k, 3), "bandConsensusSeconds": round(t_band / k, 3),
            "verifySeconds": round(2 * t_verify / k, 3)}


def storage(clip: str) -> dict:
    frames, _ = pp.load_clip(clip)
    final = np.load(pp.PROTO_DIR / clip / "final.npz")["alpha"]
    t = len(final)
    res = {}
    for name, (w, h) in SIZES.items():
        def scaled_alpha():
            for a in final:
                yield cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)

        def band_foreground():
            for f, a in zip(frames, final):
                al = cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
                fr = cv2.resize(f, (w, h), interpolation=cv2.INTER_CUBIC)
                band = (al > 0) & (al < 255)
                yield np.where(band[..., None], fr, 0).astype(np.uint8)

        band_frac = float(np.mean([((a > 0) & (a < 255)).mean() for a in final]))
        matte_b = ffv1_bytes(scaled_alpha(), w, h, "gray")
        fg_b = ffv1_bytes(band_foreground(), w, h, "rgb24")
        per_min = 60 * FPS_OUT / t
        res[name] = {"matteMiBPerMinute": round(matte_b * per_min / 2**20, 1),
                     "foregroundMiBPerMinute": round(fg_b * per_min / 2**20, 1),
                     "framesMeasured": t, "bandPixelFractionAtSource": round(band_frac, 5)}
    return res


def main() -> None:
    clips = sorted(p.parent.name for p in pp.PROTO_DIR.glob("*/final.npz"))
    clip = "walk_pan" if "walk_pan" in clips else clips[0]
    frames, _ = pp.load_clip(clip)
    final = np.load(pp.PROTO_DIR / clip / "final.npz")["alpha"]
    cpu = {name: cpu_stage_seconds(frames, final, size) for name, size in SIZES.items()}
    stor = storage(clip)
    common.write_result("throughput_cpu_stages_storage", {"clip": clip, "cpuStages": cpu, "storage": stor,
                                                         "peakRssMiB": round(common.peak_rss_mib())})
    print(json.dumps({"cpu": cpu, "storage": stor}))


if __name__ == "__main__":
    main()
