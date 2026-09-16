# 08 — Deferred scope and risks

## Deferred (each needs its own scope gate)

| Item                                           | Why deferred                                                                                     | What it would reuse               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| Background blur / "portrait mode"              | A second consumer of the matte; ships as an effect that reads the same artifact                  | `matte` effect + existing blur    |
| Background replacement presets (colour, image) | Achievable today by placing media on the track below; a preset UI is convenience, not capability | Tracks + BR5b                     |
| Export with alpha (ProRes 4444, VP9 alpha)     | A new export format surface; this plan composites mattes, it does not deliver transparent files  | Engine compositor                 |
| Chroma key (green screen)                      | Different, deterministic technique; no model, no pack                                            | Engine + preview shader           |
| Multiple subjects / multiple mattes per clip   | Doubles the UI and validation surface before one works                                           | Prompts already carry object sets |
| Matted clips in 3+ layer stacks in the preview | Needs the general compositor (PREVIEW-WEBCODECS-COMPOSITOR P4)                                   | BR5b relation                     |
| Browser build                                  | Desktop is product focus #1; no pack runtime in the browser                                      | —                                 |
| Cloud matting provider                         | ADR 0114 allows it only with media-egress consent; there is no demand yet                        | Same capability contract          |
| AI tool                                        | BR8, optional                                                                                    | Host job + `apply_matte`          |

## Risks

| Risk                                                                                         | Likelihood | Impact | Mitigation                                                                                                                |
| -------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| SAM 2 memory attention does not export cleanly to ONNX, or runs on CPU under CoreML/DirectML | Medium     | High   | BR0 go/no-go with a measured fallback pipeline; if both miss the gates, return to the maintainer                          |
| Alpha-matting weights fail the licence gate (training-data terms)                            | Medium     | Medium | Classical matting fallback; the hair-quality delta is measured and disclosed                                              |
| Throughput too slow for minutes-long 4K clips                                                | High       | Medium | Crop-based refinement, windowing, an honest ETA and a confirmation for long jobs; process only the clip's range + handles |
| Matte storage (FFV1 at 4K) surprises users                                                   | Medium     | Medium | Size estimate before running; per-project storage view; explicit cleanup                                                  |
| Frame drift on VFR or edit-list media                                                        | Medium     | High   | pts-indexed mattes; VFR and edit-list fixtures in BR2 and BR3                                                             |
| Sandbox broadening becomes a write primitive                                                 | Low        | High   | One empty host-created directory, declared names, byte ceiling, host re-verification, security review                     |
| Preview two-layer decode drops frames on slower Macs                                         | Medium     | Medium | Proxy-resolution matte; performance-monitor budget; automatic fallback to the existing "preview differs" path             |
| Users read "precise" as "never wrong"                                                        | High       | Medium | Low-confidence ranges, matte view and corrections are first-class; guide and copy say how to fix a frame                  |
| Pack size (0.4–1.2 GiB) deters install                                                       | Medium     | Low    | Size and on-device privacy shown in the warning; a smaller model tier considered only if BR0 data supports it             |

## What would change this plan

- BR0 shows the fallback pipeline meets the gates → drop SAM 2 video propagation and keep the
  simpler pipeline.
- The maintainer rejects MD-3 → the worker streams alpha frames over a binary side channel to
  the host, which writes the files. That costs more protocol work (framing, backpressure) but
  keeps workers write-free.
- The maintainer rejects MD-1 → no feature. A raster matte has no place in the current schema,
  and faking it with polygon keyframes cannot represent hair or holes.
