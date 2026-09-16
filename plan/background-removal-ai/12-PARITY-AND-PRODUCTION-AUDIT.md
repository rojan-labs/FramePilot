# 12 — Parity with Premiere Pro, DaVinci Resolve and CapCut, and production readiness

> **Audit date:** 2026-09-16, against plan commit `9f1eed90` and code at `8889d605`.
> **Question asked by the maintainer:** "Are you sure everything is production ready on the plan, and
> is it similar to Premiere Pro, DaVinci, CapCut?" **Answer at audit time: no.** This file lists every
> gap found, and the fix now written into the plan. The maintainer approved making all changes
> ("i am ready to go with any changes").
>
> Competitor feature lists come from public documentation and product knowledge up to early 2026.
> They are re-checked against current releases in **RD0** before the parity claim is made publicly.

## A. Feature parity

Legend: ✓ already in the plan · **+** added by this audit · D deferred with a reason in [`08`](./08-DEFERRED-AND-RISKS.md)

### Mask shapes and kinds

| Capability                                                   | Premiere Pro                | DaVinci Resolve                     | CapCut                  | Plan                                                      |
| ------------------------------------------------------------ | --------------------------- | ----------------------------------- | ----------------------- | --------------------------------------------------------- |
| Rectangle, ellipse                                           | ✓                           | ✓ (Power Windows)                   | ✓                       | ✓                                                         |
| Rounded rectangle                                            | —                           | ✓                                   | ✓                       | ✓                                                         |
| Bezier pen path                                              | ✓                           | ✓ (curve window)                    | —                       | ✓                                                         |
| Freehand                                                     | —                           | ✓                                   | —                       | ✓                                                         |
| **Linear split mask** (one straight edge, half-plane)        | via 4-point                 | ✓ (linear window)                   | ✓ (Split)               | **+** `linear` kind                                       |
| **Mirror / band mask** (two parallel edges)                  | —                           | via linear                          | ✓ (Filmstrip/Mirror)    | **+** `band` kind                                         |
| **Gradient mask** (soft graduated falloff, linear or radial) | via feather                 | ✓ (gradient window)                 | —                       | **+** `gradient` kind (linear, radial)                    |
| **Shape presets** (heart, star, polygon n-gon)               | —                           | preset library                      | ✓                       | **+** presets producing `path` masks                      |
| **Text as a mask** ("video inside text")                     | Track Matte Key             | composite mode                      | ✓                       | **+** `layer` kind (track matte)                          |
| **Track matte from another clip/track** (alpha or luma)      | Track Matte Key             | alpha output / composite            | —                       | **+** `layer` kind                                        |
| Colour/luma qualifier                                        | Lumetri HSL secondary       | ✓ HSL, RGB, Luma, **3D**            | Chroma key              | ✓ HSL + luma; **+** RGB and 3D sample keyer               |
| Chroma key with spill and shadow                             | Ultra Key                   | ✓                                   | ✓ (intensity, shadow)   | ✓ despill; **+** shadow/shade retention                   |
| AI object/person mask                                        | Object Mask (hover + click) | Magic Mask (person/object, strokes) | Smart cutout            | ✓ AI Object, AI Brush; **+** hover highlight before click |
| AI background removal                                        | Remove background (AI)      | Magic Mask + invert                 | ✓ Auto + Custom removal | ✓                                                         |
| AI face/body part masks                                      | —                           | Magic Mask features                 | Retouch (separate)      | D (licence)                                               |

### Mask controls

| Capability                                                                                             | Premiere    | Resolve                   | CapCut               | Plan                                                                        |
| ------------------------------------------------------------------------------------------------------ | ----------- | ------------------------- | -------------------- | --------------------------------------------------------------------------- |
| Feather, opacity, expansion, invert                                                                    | ✓           | ✓                         | ✓ feather, invert    | ✓                                                                           |
| Inner/outer softness, per-edge softness                                                                | —           | ✓                         | —                    | ✓ inner/outer, per-vertex                                                   |
| Mask modes add/subtract/intersect/difference                                                           | ✓           | ✓                         | —                    | ✓                                                                           |
| **Matte finesse** (denoise, morphology open/close, shrink/grow, blur, in/out ratio, clean black/white) | —           | ✓                         | —                    | **+** `finesse` group on `key`, `matte` and `layer` kinds                   |
| **Cut-out edge styles** (stroke/outline, glow, drop shadow of the mask edge)                           | via effects | via nodes                 | ✓ (stroke on cutout) | **+** `edge style` effect reading the mask                                  |
| Mask in clip space vs frame space                                                                      | clip        | clip/node                 | clip                 | ✓ clip (source) space; **+** `space: 'frame'` for masks on adjustment lanes |
| **Masks on adjustment layers**                                                                         | ✓           | ✓ (nodes)                 | —                    | **+** masks on effect layers (schema v13 adjustment lanes)                  |
| Mask view modes                                                                                        | ✓           | ✓ (highlight, B/W, alpha) | —                    | ✓                                                                           |
| Copy/paste, presets                                                                                    | ✓           | ✓                         | —                    | ✓                                                                           |

### Tracking

| Capability                                                            | Premiere | Resolve                    | CapCut                    | Plan                                                         |
| --------------------------------------------------------------------- | -------- | -------------------------- | ------------------------- | ------------------------------------------------------------ |
| Position / scale+rotation / perspective                               | ✓        | ✓ (+ 3D)                   | Tracking (position/scale) | ✓                                                            |
| Track one frame / all, forward / backward                             | ✓        | ✓                          | —                         | ✓                                                            |
| Interactive feature-point selection                                   | —        | ✓ (point/interactive mode) | —                         | **+** interactive: add/remove feature points before tracking |
| **Track data reuse** (apply a track to another mask, text or graphic) | via copy | ✓ (copy track)             | ✓ (text follows)          | **+** `use_track` on masks, text and overlay transforms      |
| Stabilise-then-mask                                                   | —        | ✓                          | —                         | D (stabilisation is its own domain)                          |

### Workflow

| Capability                                                      | Premiere       | Resolve | CapCut | Plan                                                                                           |
| --------------------------------------------------------------- | -------------- | ------- | ------ | ---------------------------------------------------------------------------------------------- |
| **Instant single-frame AI result** on click, before propagation | ✓              | ✓       | ✓      | **+** `subject.segment_frame` interactive capability (≤ 300 ms target after first frame embed) |
| **Progressive results** while a long job runs                   | ✓ (render bar) | ✓       | ✓      | **+** windows land in the preview as they finish; unprocessed ranges shown on the clip         |
| Background job list, resume after restart                       | ✓              | ✓       | —      | **+** jobs panel + resumable windows                                                           |
| Render cache for heavy effects                                  | ✓              | ✓       | —      | ✓ mattes are baked; **+** measured export budget                                               |

## B. Production readiness

| #   | Gap found                                                                                                                                                                   | Severity    | Fix now in the plan                                                                                                                                                                                                                                  | Where      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P1  | **No signed pack catalog, signing keys or CDN** configured in any build (`service.ts:547` → `catalog_unconfigured`). Real users cannot install Smart Mask or Tracking Lite. | **Blocker** | **RD1** release infrastructure: offline root keys, signed catalog, CDN hosting for multi-GiB artifacts, Apple notarisation + Authenticode, SBOM gate, staged rollout and delisting                                                                   | `07` RD    |
| P2  | Windows execution provider: DirectML is officially in maintenance mode, and Windows ML (Windows 11 24H2+) is the forward path; `visual-embed` ships only CoreML + CPU       | High        | **Decided:** Windows ML → DirectML EP (older Windows) → CPU, with a per-(model, EP) parity gate that disables failing pairs                                                                                                                          | `02`       |
| P3  | First-run model compilation (CoreML can take minutes) looks like a hang                                                                                                     | Medium      | "Preparing models (first run only)" phase with progress; compiled model cache inside the pack's data dir                                                                                                                                             | `02`, `05` |
| P4  | Byte-identical rasteriser is not guaranteed by "same algorithm": numpy's pairwise summation and SIMD vs JS sequential doubles change results                                | High        | Spec: float64 only, explicit left-to-right accumulation (no `np.sum` over axes), no FMA, correctly rounded `sqrt`, integer fixed-point for coverage accumulation, round-half-even quantisation; vectors run on macOS arm64, Windows x64 and Linux CI | `10`       |
| P5  | Anamorphic sources (non-square pixel aspect) and rotation metadata: masks in "source pixels" would be distorted                                                             | High        | Mask geometry in **display-corrected source space** (PAR and rotation applied); oracle rows for anamorphic and rotated phone footage                                                                                                                 | `10`, `09` |
| P6  | HDR / 10-bit sources (HLG, PQ, 10-bit ProRes/HEVC): the engine and preview pipelines are 8-bit SDR today (no HDR handling found in engine or preview)                       | High        | Stated limitation: masks, keys and mattes operate on the same 8-bit SDR conversion the export uses, and are exact relative to it. HDR is a visible "HDR source converted to SDR" notice, not silent. Full HDR pipeline deferred                      | `08`, `05` |
| P7  | Interlaced and mixed-frame-rate timelines                                                                                                                                   | Medium      | Deinterlace policy follows the engine's decode; mixed-rate timelines covered by pts lookup; oracle rows added                                                                                                                                        | `09`       |
| P8  | Migration without a backup: a v21 project is rewritten in place                                                                                                             | High        | Before any schema migration the desktop app writes `project.v21.backup.fp.json` next to the project and keeps it until the user deletes it; newer-schema projects opened by an older app refuse with "Update FramePilot to open this project"        | `10`, `07` |
| P9  | Media replaced/relinked or proxy regenerated → content hash changes → mattes and tracks silently wrong or refused                                                           | High        | Relink compares decoded frame hashes over the matte coverage (sampled + first/last frame exact). Equal → keep, different → the mask goes STALE with "Media changed — recompute"                                                                      | `03`, `05` |
| P10 | Resource contention: pack inference, preview decode and export competing for GPU/RAM; multiple jobs at once                                                                 | High        | Host job scheduler: one GPU inference job at a time, queue with priorities, pause inference during export if memory pressure is detected, memory-pressure fallback to CPU with a notice                                                              | `03`       |
| P11 | Crash or quit during a long job loses work                                                                                                                                  | Medium      | Windowed jobs persist completed windows in staging; resume on restart; quit prompts "Background removal is running"                                                                                                                                  | `03`, `05` |
| P12 | Disk space: 4K FFV1 mattes are large; low disk mid-job                                                                                                                      | Medium      | Preflight estimate vs free space with 20% headroom; mid-job `output_unwritable` keeps completed windows; storage view per project                                                                                                                    | `03`, `05` |
| P13 | Export time with many masks and 4K mattes is unmeasured                                                                                                                     | Medium      | Budget: export with masks/mattes ≤ 1.5× the same timeline without, on the Scale fixture; regression guard                                                                                                                                            | `06`, `07` |
| P14 | Project archive / "collect files" and moving between Mac and Windows                                                                                                        | Medium      | Archive includes `.framepilot-derived/mattes` and `tracks`; paths relative; cross-platform reopen e2e                                                                                                                                                | `07`       |
| P15 | Face identity for "everyone except the host" is biometric processing (GDPR special category; BIPA-style laws)                                                               | High        | Identity matching is **opt-in per project** with a plain consent line, computed locally, stored only in the project brain, deletable in one action, never used when not consented (then the agent asks the user to pick faces)                       | `11`, `05` |
| P16 | PyAV/FFmpeg inside the pack: FFmpeg builds can include GPL components                                                                                                       | High        | Licence gate: LGPL-only FFmpeg build verified from the wheel's config; recorded in `LICENSES.md`                                                                                                                                                     | `02`       |
| P17 | Worker decodes untrusted media (FFmpeg attack surface)                                                                                                                      | Medium      | Worker already sandboxed with no network; add memory/time limits per job, crash isolation, and fuzzed-media tests in the security review                                                                                                             | `03`       |
| P18 | Rollout safety: no feature flag, kill switch or staged rollout                                                                                                              | High        | Feature flags for PX (new compositor), MK (mask stack UI) and AM (tools); pack versions delistable in the catalog; the old preview stays behind a flag until MD-5 conditions hold                                                                    | `07` RD    |
| P19 | Observability of failures in the field                                                                                                                                      | Medium      | Scoped logger events (job phase timings, failure codes, EP used, flagged ratios; never media or frames), opt-in diagnostic bundle export for support                                                                                                 | `03`, `07` |
| P20 | Undo history and autosave size with long roto path keyframes                                                                                                                | Medium      | Measured budget: 1,000 path keyframes × 200 vertices saves in ≤ 250 ms and stays under a set project size; path keyframes stored compactly (flat number arrays)                                                                                      | `10`, `06` |
| P21 | Pointer latency for drawing tools                                                                                                                                           | Medium      | Budget: pointer-to-paint ≤ 16 ms on the monitor for editing a 200-vertex path at 4K; measured in MK4                                                                                                                                                 | `06`       |
| P22 | Minimum hardware is unstated                                                                                                                                                | Medium      | Published minimums (Apple Silicon 16 GB recommended / 8 GB supported with CPU-offload notice; Windows x64 with a DX12 GPU and 16 GB) decided from BR0 measurements; Intel Macs unsupported for Smart Mask, stated in the install warning             | `02`, `05` |
| P23 | Phases too large for reviewable PRs (PX2, MK4, BR3)                                                                                                                         | Medium      | Split into sub-PRs listed in `07`, each independently tested                                                                                                                                                                                         | `07`       |
| P24 | No user docs for known limitations, keyboard shortcuts, or troubleshooting                                                                                                  | Low         | `docs/guides/masking.md` gains Limitations, Shortcuts and Troubleshooting sections; in-app "Learn how" links                                                                                                                                         | `07` DOC   |
| P25 | Manual QA and beta                                                                                                                                                          | Medium      | `MANUAL_TESTING.md` masking section; closed beta with real editors on real projects (≥ 10 projects, 3 platforms) before GA; issues triaged against gates                                                                                             | `07` RD    |

## C. What "production ready" means for this plan (release gate RD3)

All of the following, verified on the release build, not a dev build:

1. Every gate in [`06`](./06-PRECISION-AND-EVAL.md) passes on darwin-arm64 and win32-x64.
2. Every row of the [`09`](./09-PREVIEW-EXPORT-PARITY.md) oracle passes on both platforms.
3. E2E.1–E2E.7 pass against **signed packs installed from the real catalog**.
4. The security review of the sandbox broadening, fuzzed media and biometric consent is closed.
5. Licence gate closed for every weight, binary and runtime in both packs.
6. Beta: no open severity-1 issue; every severity-2 issue has a fix or a documented limitation.
7. Docs, changelogs and the limitations page are published.
8. Feature flags default on, and the rollback path (flag off, catalog delist) has been rehearsed once.

## D. Model and runtime decisions (2026-09-16)

The maintainer asked for the best, most reliable and most accurate choice instead of open options. Decided
from current sources; details and rejection reasons are in [`02`](./02-WORKER-PACK.md#model-choices-decided-2026-09-16-from-current-sources-br0-verifies-it-does-not-choose):

- **Tracker:** SAM 2.1 Hiera-Large, fp32 (Apache-2.0).
- **Edges and alpha:** BiRefNet_HR-matting, fp32 (MIT).
- **Text grounding for AI masking:** SAM 3.1 image mode in a separate pack (SAM License).
- **Flow:** OpenCV DIS.
- **Runtime:** onnxruntime. CoreML EP on macOS; Windows ML → DirectML → CPU on Windows. Per-pair parity gate.

Sources checked: facebookresearch/sam3 LICENSE and README; Meta's SAM 3.1 announcement; the
ZhengPeng7/BiRefNet_HR-matting model card; the MatAnyone2 repository licence; microsoft/DirectML README;
onnxruntime Windows docs; a community SAM 2.1 video ONNX export with published parity.
