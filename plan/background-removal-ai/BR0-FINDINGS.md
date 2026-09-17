# BR0 findings — Smart Mask verification build

> Recorded 2026-09-17. Machine: Apple M1 Pro, 16 GB, macOS (Darwin 25.2), shared with other
> agents' builds and a VM that held ~11 GB. Spike: `workers/smart-mask/spike/` (isolated uv env,
> Python 3.12, torch 2.14.0, onnxruntime 1.30.0, onnx 1.22.0, onnxscript, OpenCV 5.0).
> Raw results: `workers/smart-mask/spike/results/*.json[l]`. Weights, ONNX, media: the
> git-ignored `workers/smart-mask/.cache/`. Every heavy run went through `spike/watchdog.py`
> (one job at a time, physical-footprint cap 8 GB, swap-growth cap 1 GB).

## Summary for the maintainer

| Question | Answer |
| --- | --- |
| Exports work? | Yes. SAM 2.1 Hiera-L as 4 modules (5 files) with real-valued RoPE and static memory; BiRefNet_HR-matting with ONNX `DeformConv`. |
| fp16-stored / fp32-computed? | **SAM: fails** parity (min IoU 0.99832 < 0.999) → ships fp32. **BiRefNet: passes** (768², CPU). |
| CoreML EP? | **Disabled for SAM on this hardware class**: memory attention 8.4 GB footprint (CPU 2.4 GB) and slower; `decoder_single_n2` does not build; the full video path could not be measured inside the memory budget. BiRefNet on CoreML: build aborted over budget even at 768². |
| Pack size | **≈ 1.47 GB** (SAM fp32 + BiRefNet fp16-stored + runtime), not ≈ 1.05 GB. |
| Throughput (CPU EP, M1 Pro) | ≈ 9 s SAM (fwd+bwd, shared encoder) + 7.8 s BiRefNet at 1024² per 1080p frame, measured. At the trained 2048² (not runnable here) the extrapolation is ≈ 1,200 compute s per footage s at 1080p30 and ≈ 4,000 at 4K30. |
| Minimum hardware | The planned "Apple Silicon 16 GB" floor is **not supported**: BiRefNet at 2048² needs > 12 GB on the CPU EP alone. |
| Error-detection recall | 100% (attempt 4) on the construction-true pilot, **but every one of the 256 pilot frames was actually wrong**, so review load is 100% and the recall number cannot tell a good detector from "flag everything". The gate is **not demonstrated**. |
| Licence | Code licences verified. **BiRefNet_HR-matting training-data terms unverified**: no DIS5K commercial statement found; the upstream model zoo lists Distinctions-646, AM-2k, P3M-10k among matting training sets. |

**Maintainer decisions needed:** (1) BiRefNet training-data licence (blocks shipping);
(2) minimum hardware / whether 2048² matting is required on 16 GB machines; (3) the
fp32 SAM size increase; (4) MO-9 Windows rows; (5) MO-8 human labels, and a quality pass on the
pipeline before recall can be measured meaningfully.

## BR0.1 Exports

Pinned sources (also in `spike/common.py` and `workers/smart-mask/LICENSES.md`):

| Item | Pin | sha256 / bytes |
| --- | --- | --- |
| facebookresearch/sam2 | `2b90b9f5ceec907a1c18123530e92e794ad901a4` | — |
| `sam2.1_hiera_large.pt` (dl.fbaipublicfiles.com/segment_anything_2/092824/) | — | `2647878d…d318`, 898,083,611 |
| ZhengPeng7/BiRefNet_HR-matting (HF) | `5d6b6f8adcb5b417c871b1d84ceaae9871355b7f` | — |
| `model.safetensors` | same revision | `a5a4de69…ef55`, 444,473,596 (matches LFS oid) |
| ZhengPeng7/BiRefNet (GitHub, licence) | `ebcc0bc8ec7fe919cec829f2dea656b3078acddc` | — |

- **SAM 2.1 modules** (`spike/export_sam.py`, `spike/sam_modules.py`, TorchScript exporter,
  opset 19): `image_encoder` (1024² → FPN 0/1/2 + pos), `decoder_multi_n1` (1 point, 3 masks),
  `decoder_single_n2` (2 points = a box, 1 mask), `memory_attention`, `memory_encoder`.
  - **Real-valued RoPE:** (a,b) → (a·cosθ − b·sinθ, a·sinθ + b·cosθ) with precomputed tables.
    Max |Δ| vs upstream complex RoPE on random data: **4.8e-7**.
  - **Static memory:** 7 spatial slots × 4096 tokens + 64 object-pointer tokens, padded, boolean
    key mask. Key RoPE broadcast over slots instead of a repeated table (the first export folded
    28,672×128 tables into every layer: 359 MB → 28 MB after the rewrite and initializer dedupe).
  - Decoder graphs are per point count (static shapes); the pack needs one per supported N or a
    CPU-EP dynamic decoder. Mask prompts (`_use_mask_as_output`) are not exported yet.
  - Upstream stores memory features as bfloat16 in its own state; both the reference and the
    ONNX runs keep that orchestration, so parity includes it.
- **BiRefNet_HR-matting** (`spike/export_birefnet.py`, dynamo exporter, opset 19): static
  (1,3,S,S) → sigmoid alpha; `torchvision::deform_conv2d` → ONNX `DeformConv` (onnxruntime CPU
  kernel exists). Exported at S = 2048 (trained size), 1024 and 768. The TorchScript exporter
  needs a real 2048² forward (≈ 27 GB extrapolated) and thrashed the machine; the dynamo
  exporter traces with fake tensors (2.7 GB peak at 2048²).
  - The published checkpoint is **already float16**; the "fp32" reference is that checkpoint upcast.
- **fp16-stored** (`spike/fp16_store.py`): initializers ≥ 1024 elements stored float16 + `Cast`
  to float32 (folded by onnxruntime at session creation, so compute is fp32). None out of range.

## BR0.2 Parity (per model × EP × precision)

Parity media: Sintel (Blender Foundation, CC-BY 3.0), 02:40 (24 frames, 1 click) and 07:05
(20 frames to the first cut, 1 positive + 1 negative click). SAM reference: upstream
`SAM2VideoPredictor`, PyTorch CPU fp32; ONNX runs use the same orchestration with the four
modules replaced by onnxruntime sessions. BiRefNet: square crops of both clips' first frames.

| Model | EP | Precision | Metric (gate) | Result | Status |
| --- | --- | --- | --- | --- | --- |
| SAM 2.1 Hiera-L | CPU | fp32 | min per-frame IoU ≥ 0.999 | **0.99954** (clip A 1.0, clip B 0.999536; mean 0.99996) | **pass** |
| SAM 2.1 Hiera-L | CPU | fp16-stored | same | **0.998316** (2 of 24 frames below gate on clip A; clip B 0.999207) | **disabled** |
| SAM 2.1 Hiera-L | CoreML (MLProgram, static, ALL) | fp32 | same | Session build failed for the whole set: `decoder_single_n2` "Error in building plan". With that module on CPU, the run reached a 16 GB physical footprint and 64 s/frame and was killed. Per module: memory attention 8.4 GB footprint vs 2.4 GB on CPU, 4.3 s vs 1.9 s/run; image encoder 422 s cold preparation (84 s warm), 5.4 s/run, 3.8 GB. | **disabled** (does not build; exceeds 8 GB budget; slower than CPU) |
| SAM 2.1 Hiera-L | CoreML | fp16-stored | same | not run: the fp16-stored model already fails on CPU | **disabled** |
| BiRefNet_HR-matting | CPU | fp32 @ 768² | band mean ≤ 1/255, max ≤ 4/255 | mean 0.0007/255, max 0.0157/255 | **pass** |
| BiRefNet_HR-matting | CPU | fp16-stored @ 768² | same | mean 0.0047/255, max 0.108/255 | **pass** |
| BiRefNet_HR-matting | CPU | any @ 2048² (trained size) | same | not measured: session footprint reached 12.0 GB (killed at 8 GB cap after overshoot); PyTorch reference ≈ 27 GB | **not measured — exceeds 8 GB local budget** |
| BiRefNet_HR-matting | CoreML | fp32 @ 768² | same | session build ran 755 s, 7.1 GB footprint, swap grew 1.5 GB → killed | **not measured — exceeds local budget** |
| SAM 2.1 / BiRefNet | Windows ML (TensorRT-RTX / OpenVINO / Vitis AI) | fp32, fp16-stored | same | — | **not measured — maintainer hardware (MO-9)** |
| SAM 2.1 / BiRefNet | DirectML | fp32, fp16-stored | same | — | **not measured — maintainer hardware (MO-9)** |

**Windows parity runs unchanged:** `parity_sam.py --reference`, then `parity_sam.py --ep dml`
(or `--ep <VendorExecutionProviderName>`) `--precision fp32|fp16s`; `parity_birefnet.py --size 2048
--reference torch` (needs ~27 GB RAM; else `--reference onnx`, the CPU EP output), then
`parity_birefnet.py --size 2048 --ep dml --precision fp32|fp16s`. Exports: `export_sam.py --module …`,
`export_birefnet.py --size 2048`;
needs torch, onnxruntime-directml / Windows ML onnxruntime, ffmpeg on PATH. The media is fetched
by range request from download.blender.org, so the frames are identical.

BiRefNet parity at 768² exercises the same graph, operators and weights as 2048² (the only
difference is static spatial size); it is evidence the export is right, not a substitute for
2048² parity on the target EP.

## BR0.3 Consensus + band alpha prototype

`spike/pipeline_proto.py`: SAM forward from a frame-0 box and backward from the last frame whose
mask keeps ≥ 50% of the frame-0 area (box of that mask) → BiRefNet on a padded square crop around
the SAM union, gated to the dilated union → per-pixel consensus of fwd SAM, bwd SAM, BiRefNet
(α ≥ 0.5) and the previous final alpha warped by DIS flow; disagreement + 6 px around every
estimate's edge = unknown band; band takes BiRefNet alpha; outside the band exact 0/1.
Pure helpers (band, consensus, IoU, BF@2px, tiling, Wilson bound) in `matte_metrics.py` with
8 unit tests (`spike/tests`, passing).

Deviations forced by this machine, all recorded in `proto/<clip>/run.json`:
- BiRefNet ran at **1024²**, not 2048² (budget). A 1080p subject crop is resized into one pass;
  crops above 1.5× the input are tiled at full resolution with 256 px overlap.
- All models on the **CPU EP** (CoreML disabled above).
- A single click selected a body part (walk_pan IoU 0.16–0.22), so the pilot uses a **box prompt**
  (the frame-0 ground-truth bbox, i.e. a perfect `subject.detect`), as 02's auto mode does.
- Self-correction (stage 6), foreground colour (8), stabilisation (9) and encode (11) are not
  prototyped.

## BR0.4 Verify stage → error-detection recall and review load

**Pilot set (construction-true, NOT the MO-8 labelled set).** `spike/pilot_generate.py`:
8 clips × 32 frames at 1920×1080, 24 fps. Subjects are generated articulated figures rendered
with 4× spatial supersampling (fractional edges), sub-pixel hair strands, and 180° temporal
supersampling (real motion-blur alpha). Backgrounds: Sintel stills (CC-BY 3.0), panned/shaken.
Ground truth = the rendered alpha. Categories: `walk_pan`, `hair_busy` (close-up, 260 strands),
`similar_colour`, `crossing` (a second figure passes in front), `leave_reenter`, `fast_motion`
(6-sample blur), `twin_distractor` (identical figure behind), `low_light` (gain 0.22 + noise).
Licences: subjects generated here; backgrounds Sintel CC-BY 3.0.

**Automatic accuracy on the pilot (final matte, mean over 32 frames):**

| Clip | IoU | BF@2px | Wrong frames (06: IoU < 0.98 or BF < 0.95) |
| --- | --- | --- | --- |
| similar_colour | 0.967 | 0.829 | 32/32 |
| walk_pan | 0.948 | 0.659 | 32/32 |
| crossing | 0.832 | 0.707 | 32/32 |
| hair_busy | 0.821 | 0.595 | 32/32 |
| fast_motion | 0.768 | 0.569 | 32/32 |
| leave_reenter | 0.650 | 0.505 | 32/32 |
| twin_distractor | 0.497 | 0.604 | 32/32 |
| low_light | 0.006 | 0.005 | 32/32 |

The binarised final matte equals BiRefNet's (by construction); SAM forward alone scored higher on
fast_motion (0.94), leave_reenter (0.81), twin_distractor (0.80) and low_light (0.60), i.e. the
1024² BiRefNet pass is where most of the loss is. Removing hair-scale structures from both masks
(7 px opening, diagnostic only) raises walk_pan to 0.975 and hair_busy to 0.863 — thin strands
are part of the error, not all of it. These are not model-gate results (wrong input size, no
self-correction, synthetic subjects), but they are what this pipeline produced.

**Verify attempts** (`spike/verify_proto.py`; every attempt's thresholds are in `ATTEMPTS`;
split A/B = alternate clips):

| Attempt | Change | Recall (all) | Wilson 95% lower | Review load | Split A / B recall |
| --- | --- | --- | --- | --- | --- |
| 1 | a-priori thresholds: flow re-warp, components, edge correlation, area/centroid, fwd-bwd and SAM-BiRefNet IoU, object score | 85.9% (220/256) | 81.1% | 85.9% | 100% / 71.9% |
| 2 | + c2 unexplained image edges next to the matte | 95.7% (245/256) | 92.5% | 95.7% | 100% / 91.4% |
| 3 | model-disagreement thresholds at the IoU gate (0.98), band > 40% of foreground | 99.2% (254/256) | 97.2% | 99.2% | 100% / 98.4% |
| 4 | + h presence transition (empty matte within 3 frames of a non-empty one); the 2 misses were a 146–176 px sliver of a subject leaving frame | **100% (256/256)** | 98.5% | **100%** | 100% / 100% |

**Reading:** recall gate ≥ 99.5% is met numerically by attempt 4, **but the pilot contains no
correct frames**, so review load equals recall and the ≤ 10% review-load gate fails. The measurement
cannot distinguish a discriminating detector from one that flags everything; attempts 3–4 were
also tuned after seeing misses on this same set (split A/B does not remove that, it only shows it).
**The recall gate is not demonstrated.** It needs a pipeline whose output is mostly correct
(2048² matting, self-correction) and MO-8's human-labelled set.

## BR0.5 Licences

`workers/smart-mask/LICENSES.md`: Apache-2.0 (sam2 @ 2b90b9f5) and MIT (BiRefNet @ ebcc0bc8)
verbatim. **Open finding:** no DIS5K commercial-use statement at the pinned revisions; the model
zoo's matting training sets include P3M-10k, AM-2k, AIM-500, Human-2k, Distinctions-646, HIM2K,
PPM-100 (several research/non-commercial terms). Training-data terms: unverified.

Spike-only dependencies (never shipped; isolated env): torch/torchvision (BSD-3), onnx (Apache-2.0),
onnxruntime (MIT), onnxscript (MIT), opencv-contrib-python-headless (Apache-2.0), hydra-core (MIT),
iopath (MIT), timm (Apache-2.0), kornia (Apache-2.0), einops (MIT), transformers (Apache-2.0),
safetensors (Apache-2.0), pillow (MIT-CMU), numpy (BSD-3), psutil (BSD-3), pytest (MIT).

## BR0.6 Pack size

| Part | fp32 bytes | fp16-stored bytes | Ships as |
| --- | --- | --- | --- |
| SAM 2.1 image encoder | 852,442,220 | 427,319,839 | fp32 (fp16s fails parity) |
| SAM 2.1 decoder_multi_n1 + decoder_single_n2 | 35,484,640 | 17,976,692 | fp32 |
| SAM 2.1 memory attention | 28,008,575 | 14,103,079 | fp32 |
| SAM 2.1 memory encoder | 5,582,325 | 2,824,259 | fp32 |
| **SAM total** | **921,517,760** | 462,223,869 | **921.5 MB** |
| BiRefNet_HR-matting 2048² | 890,885,221 | 449,580,627 | fp16-stored (passes at 768²) **449.6 MB** |
| Runtime wheels (macOS arm64): onnxruntime 1.30 20.5 MiB, opencv-contrib 5.0 53.1 MiB, PyAV 18.1 17.4 MiB, numpy 5.2 MiB | ≈ 96 MiB (≈ 101 MB) compressed; unpacked onnxruntime 76 MiB, cv2 139 MiB, numpy 24 MiB | | |

- **Download ≈ 921.5 + 449.6 + 101 ≈ 1.47 GB** vs the 1.05 GB target (SAM stays fp32 by rule).
- All-fp32 fallback (if BiRefNet also failed on a target EP): ≈ 1.91 GB.
- The two decoder files duplicate ~17 MB of weights; a shared-weight export would save it.
- PyAV's bundled FFmpeg must be checked LGPL-only (not done in BR0; BR3 SBOM gate).

## BR0.7 Throughput, memory, first-run preparation, storage

**Measured, CPU EP, M1 Pro, per 1080p frame** (8 pilot clips × 32 frames; parity runs agree):

| Stage | Seconds | Physical footprint (job peak) |
| --- | --- | --- |
| SAM image encoder (1024²) | 5.2 | 3.4 GB (session) |
| SAM memory attention (7 slots) | 1.95 | 2.4 GB (session) |
| SAM decoder + memory encoder | 0.07 | < 0.6 GB |
| SAM video path, one direction, whole process | ≈ 7.2 | 6.1 GB |
| BiRefNet 768² / 1024² | 4.1 / 7.8 | 3.8 / 6.2–6.9 GB |
| BiRefNet 2048² | not runnable | > 12 GB (aborted) |
| Consensus flow+warp / band+consensus / verify checks | 0.053 / 0.009 / 0.093 at 1080p; 0.208 / 0.042 / 0.267 at 4K (`throughput.py`) | 1.0–1.9 GB |

**First-run preparation:** CPU EP session creation 0.1–1.7 s. CoreML EP cold / warm: memory
encoder 2.3 / 0.4 s; decoder 7.2 / 1.3 s; memory attention 12.7 / 2.6 s; **image encoder 422 / 84 s**;
BiRefNet 768² > 755 s (killed over budget, not completed).

**Per footage second (explicit extrapolation, CPU EP, M1 Pro):**
per frame = SAM fwd+bwd with the image embedding shared (5.2 + 2 × 2.0) + BiRefNet + CPU stages.

| Resolution | BiRefNet as measured (1024², 1 pass) | BiRefNet at trained 2048² (extrapolated ≈ 4 × 7.8 s = 31 s/tile) |
| --- | --- | --- |
| 1080p30 | (9.3 + 7.8 + 0.16) × 30 ≈ **520 s per footage s** | (9.3 + 31 + 0.16) × 30 ≈ **1,210 s per footage s** (≈ 20 h per footage minute) |
| 4K30 | subject crop up to 2160 px → 2×2 tiles of 1024²: (9.3 + 4 × 7.8 + 0.52) × 30 ≈ 1,230 | 2×2 tiles of 2048²: (9.3 + 4 × 31 + 0.52) × 30 ≈ **4,020 s per footage s** |

The spike's backward pass re-encoded every frame (≈ 14.4 s/frame for both directions); sharing the
image embedding (as 02's interactive cache implies) is assumed above. 4K SAM uses the same 1024²
input, so SAM cost does not grow with resolution; 4K CPU stages were measured on upscaled frames.

**Peak memory → minimum hardware:** a single job at 1080p needs ≈ 6–7 GB at 1024² matting and
> 12 GB at 2048² on the CPU EP. On a 16 GB Mac with a normal workload the 2048² path does not fit;
the published floor needs either ≥ 32 GB or a maintainer decision on matting input size (which
changes the quality claim). Windows rows: MO-9.

**Storage per minute (FFV1 level 3, 30 fps), measured on the walk_pan pilot output:**

| Resolution | `matte.mkv` (gray) | `foreground.mkv` (rgb24, fractional-alpha pixels only) | Total |
| --- | --- | --- | --- |
| 1080p30 | 23.2 MiB/min | 81.4 MiB/min | ≈ 105 MiB/min |
| 4K30 | 61.2 MiB/min | 218.6 MiB/min | ≈ 280 MiB/min |

The subject covers ~5% of the frame and fractional-alpha pixels ~1.1%; storage scales with those
areas, so a close-up with hair can be several times larger. 4K is the 1080p output upscaled
(smoother than real 4K, so a lower bound). This light job (1.9 GB peak, no model) ran with a 2 GB
footprint cap while swap sat at 6.8 GB with 73% memory free; the 6 GB swap start rule is kept
for model jobs.

## Memory incidents (they set the floor above)

1. **BiRefNet TorchScript trace at 2048²** drove swap from 21.6 to 37.5 GB before it was killed
   (PyTorch CPU fp32: 3.1 GB at 512², 7.9 GB at 1024²). Fix: dynamo exporter.
2. **Concurrent spike jobs** (SAM parity + pilot rendering beside other builds) pushed the machine
   past 70 GB of swap and it shut down. Fix: one heavy job at a time.
3. **SAM on CoreML** reached a 16 GB physical footprint while RSS read 4.6 GiB (compressed and
   Core ML/Metal memory is not RSS); swap reached 15.5 of 16 GB before the coordinator killed it.
   Fix: `watchdog.py` sums physical footprint (`top -stats mem`) over the process tree every
   second, kills above 8 GB footprint, 1 GB swap growth or < 15% free memory, and starts a job
   only with ≥ 50% free memory and swap ≤ 6 GB; ORT sessions run without the CPU arena and memory
   patterns; ONNX runs drop the replaced PyTorch modules. Aborts: `results/aborts.jsonl`.
4. A 5 s poll let a 2048² BiRefNet session overshoot to 12 GB before the kill; the poll is 1 s now.

## Not measured, and why

| Item | Why |
| --- | --- |
| Windows ML and DirectML parity, throughput, memory | No Windows GPU machine (MO-9); scripts run unchanged |
| BiRefNet at 2048² on any EP (parity, speed) | > 12 GB footprint on CPU EP; > 8 GB local budget |
| BiRefNet on CoreML at any size | Build exceeded the budget at 768² (755 s, swap +1.5 GB) |
| SAM video-path parity on CoreML | Does not build as a set; per module exceeds budget or is slower than CPU |
| 4K30 end to end | Would require 2048² tiles (above); extrapolated |
| Recall/review load on human labels | MO-8 labels do not exist; construction-true pilot used, with the caveat above |
| Self-correction, stabilisation, foreground colour | Out of BR0 scope (models/runtime verification) |
