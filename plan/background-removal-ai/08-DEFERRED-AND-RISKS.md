# 08 — Deferred scope and risks

## Deferred (each needs its own scope gate)

| Item                                           | Why deferred                                                                                     | What it would reuse               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| Background replacement presets (colour, image) | Achievable today by placing media on the track below; a preset UI is convenience, not capability | Tracks + PX compositor            |
| Export with alpha (ProRes 4444, VP9 alpha)     | A new export format surface; this plan composites mattes, it does not deliver transparent files  | Engine compositor                 |
| Multiple subjects / multiple mattes per clip   | Doubles the UI and validation surface before one works                                           | Prompts already carry object sets |
| Browser build                                  | Desktop is product focus #1; no pack runtime in the browser                                      | —                                 |
| Cloud matting provider                         | ADR 0114 allows it only with media-egress consent; there is no demand yet                        | Same capability contract          |

### Deferred from professional masking (named so the gap is visible)

| Item                                                                                 | Why deferred                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic part masks (face skin, hair, clothing, arms; Resolve Magic Mask "features") | Needs a human-parsing model; the known ones are trained on non-commercial datasets (e.g. CelebAMask-HQ). Revisit when a permissively licensed model exists; SAM clicks cover parts manually today |
| Object removal / inpainting under a mask                                             | A generative capability with its own model, licence and precision questions                                                                                                                       |
| Mask motion blur                                                                     | Needs shutter-angle sampling in both renderers; add after PX5 performance evidence                                                                                                                |
| 3D camera solve / Mocha-style planar surface insertion                               | Tracking Lite provides planar homography; a full camera solve is its own domain                                                                                                                   |
| Mask exchange with After Effects / Resolve                                           | No current consumer                                                                                                                                                                               |
| Per-mask blend of different effects in one mask group                                | Effect-target masks cover the professional use; mask groups can come later                                                                                                                        |

### Deferred by the production audit

| Item                                                        | Why deferred                                                                                      | What users see meanwhile                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| HDR / 10-bit colour pipeline for masking, keying and export | The engine and preview are 8-bit SDR today; HDR is a pipeline-wide project, not a masking feature | "HDR footage is converted to SDR" notice on HDR clips |
| Stabilise-then-mask                                         | Stabilisation is its own domain                                                                   | Track the mask instead                                |
| Intel Mac support for Smart Mask                            | No supported accelerated EP at a usable speed (to confirm in BR0)                                 | Named in the install warning before download          |
| Linux packs                                                 | First pack targets are darwin-arm64 and win32-x64 (ADR 0114)                                      | Tools show "not available for this computer yet"      |

## Risks

| Risk                                                            | Likelihood | Impact | Mitigation                                                                                                                                                                              |
| --------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An execution provider fails parity for a model on some hardware | Medium     | Medium | Rule: the pair is disabled and the next EP (ending at CPU) runs the same fp32 model; slower, never less precise                                                                         |
| BiRefNet_HR-matting underperforms on a hair category            | Low        | Medium | The band gates in `06` measure it; tiling resolution and consensus band width are tuned first; the model choice is not reopened without a measured permissive alternative that beats it |
| Throughput too slow for minutes-long 4K clips                   | High       | Medium | Crop-based refinement, windowing, an honest ETA and a confirmation for long jobs; process only the clip's range + handles                                                               |
| Matte storage (FFV1 at 4K) surprises users                      | Medium     | Medium | Size estimate before running; per-project storage view; explicit cleanup                                                                                                                |
| Frame drift on VFR or edit-list media                           | Medium     | High   | pts-indexed mattes; VFR and edit-list fixtures in BR2 and BR3                                                                                                                           |
| Sandbox broadening becomes a write primitive                    | Low        | High   | One empty host-created directory, declared names, byte ceiling, host re-verification, security review                                                                                   |
| Preview two-layer decode drops frames on slower Macs            | Medium     | Medium | Proxy-resolution matte; performance-monitor budget; automatic fallback to the existing "preview differs" path                                                                           |
| Users read "precise" as "never wrong"                           | High       | Medium | Low-confidence ranges, matte view and corrections are first-class; guide and copy say how to fix a frame                                                                                |
| Pack size (0.4–1.2 GiB) deters install                          | Medium     | Low    | Size and on-device privacy shown in the warning; a smaller model tier considered only if BR0 data supports it                                                                           |

### Added with the precision and parity update

| Risk                                                                                      | Likelihood | Impact | Mitigation                                                                                                  |
| ----------------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Verification misses wrong frames (recall < 99.5%)                                         | Medium     | High   | Measured in BR0.4 before the pack is built; stage 10 redesigned first if it misses                          |
| Verification flags too much (review fatigue)                                              | Medium     | Medium | Review-load gate ≤ 10% on medium categories; self-correction runs before flagging                           |
| Full-resolution precision pipeline is slow (Hiera-L, 2048² refine, full-res band matting) | High       | Medium | Honest ETA and confirmation; partial-window re-runs for fixes; no lower-quality mode that ships worse edges |
| Extracting `frame_plan.py` from the compiler changes export output                        | Medium     | High   | Engine goldens must be unchanged in PX1; the extraction is decisions only, pixels stay in MoviePy           |
| Chromium colour conversion differs from ffmpeg's                                          | High       | Medium | Measured in PX0.3; fixed in the shader, never absorbed into the tolerance                                   |
| N-layer compositor misses the playback budget on 4K multi-layer timelines                 | Medium     | High   | Shared frames for same-source layers, decoder LRU, resolution-first load shedding; PX5 budgets              |
| Deleting the DOM monitor removes a fallback someone relies on                             | Low        | Medium | Only after every oracle row passes; MD-5; browser keeps an explicit unavailable state                       |

### Added with professional and AI masking

| Risk                                                                        | Likelihood | Impact | Mitigation                                                                                                                             |
| --------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| v22 migration changes how existing masked projects look                     | Medium     | High   | `gaussian-legacy` feather model; byte-identical export gate on v21 fixtures                                                            |
| TS rasteriser too slow for animated multi-mask stacks at preview resolution | Medium     | Medium | Band-limited evaluation, static-mask cache, WASM build of the same algorithm only if PX5 shows it is needed                            |
| Legal review rejects the SAM License (used only for text grounding)         | Low        | Medium | Smart Mask Text switches to OWLv2 (Apache-2.0); the ambiguity gate is re-measured and the agent asks more often; mattes are unaffected |
| The agent masks the wrong object confidently                                | Medium     | High   | Ambiguity threshold tuned on the eval with wrong-pick counted as failure; single-question visual spot check after apply                |
| Scope size delays everything                                                | High       | High   | Two independent tracks (PX, MK) ship usable value before any model; each phase ends in a tested editor capability                      |

### Added by the production audit

| Risk                                                                                         | Likelihood | Impact      | Mitigation                                                                                    |
| -------------------------------------------------------------------------------------------- | ---------- | ----------- | --------------------------------------------------------------------------------------------- |
| Release infrastructure (signing identities, CDN, catalog keys) is not ready when the code is | High       | **Blocker** | RD1 starts now, in parallel with PX/MK; nothing pack-backed is announced before RD1 is done   |
| Windows EP choice turns out slow on common GPUs                                              | Medium     | High        | Measured in BR0 across vendors; CPU fallback at the same precision; published minimums        |
| Competitor features move while this is built                                                 | High       | Medium      | RD0 re-checks the parity table before release; gaps are named, not hidden                     |
| Byte-equality breaks on a platform or browser update                                         | Low        | Medium      | Vectors in CI on three OSes; the determinism rules forbid the operations most likely to drift |
| Biometric consent requirements differ by jurisdiction                                        | Medium     | High        | Opt-in per project, local-only, deletable; legal review of the consent copy in RD2            |

## What would change this plan

- The maintainer rejects MD-3 → the worker streams alpha frames over a binary side channel to
  the host, which writes the files. That costs more protocol work (framing, backpressure) but
  keeps workers write-free.
- The maintainer rejects MD-5 → PX still ships the compositor and oracle, but the DOM monitor stays for timelines it covers; parity is then guaranteed only on the WebCodecs path.
- The maintainer rejects MD-1 → no feature. A raster matte has no place in the current schema,
  and faking it with polygon keyframes cannot represent hair or holes.
