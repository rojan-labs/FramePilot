# 00 — Current state (audited 2026-09-16 at `8889d605`)

Everything below was read from the tree, not assumed. Re-verify line references before
building on them; this repo moves fast.

## What exists and will be reused

| Area                     | Where                                                                                                                                        | State                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pack platform            | `packages/capability-packs/src/{contracts,install-contracts,worker-protocol}.ts`, `src/node/*`                                               | Signed catalog, resumable download, SHA-256, sandboxed extraction, executable verification, health check, atomic install, storage manager, relocation. **Done (ADR 0114).**          |
| Local dev install        | `framepilot-pack register-local`, `scripts/dev-register-*.sh`, `pnpm packs:register`                                                         | Same health check as a signed install. Needs `FRAMEPILOT_DEV_PACK_REGISTRATION=1`.                                                                                                   |
| Desktop pack host        | `apps/desktop/electron/capability-packs/{service,tracking,tracking-request,visual-packs}.ts`                                                 | Resolves installed + healthy packs, runs jobs, forwards progress, returns a signed install proposal on a missing pack.                                                               |
| Renderer job hook        | `apps/web-editor/src/components/inspector/usePackJob.ts`                                                                                     | Subscribe-before-run progress, cancel, `pack_missing` → proposal → `approveInstall` → **re-runs the original job**. Only fires after the user clicks run; it never warns in advance. |
| Install UI               | `inspector/useProposalInstall.ts`, `ai/PackInstallInlineCard.tsx`, `CapabilityPackDependencyDialog.tsx`, `CapabilityPackStorageSettings.tsx` | Approval matches the displayed proposal byte for byte. `bridge.capabilityPackStorage()` lists what is installed.                                                                     |
| Segmentation pack        | `workers/subject-intelligence` (`framepilot.subject-intelligence` 1.0.0)                                                                     | `subject.detect` (YuNet, YOLOX-S) and `subject.segment` (PPHumanSeg) on OpenCV `dnn`, ~42 MiB, MIT/Apache-2.0.                                                                       |
| onnxruntime pack runtime | `workers/visual-embed` (ADR 0176)                                                                                                            | onnxruntime is already an accepted pack runtime, with CoreML batch-size findings recorded. A new pack on onnxruntime adds **no new runtime to the platform**.                        |
| Shape masks, engine      | `engine/python/framepilot_engine/render/masks.py`, `compiler.py#_attach_mask`                                                                | Rectangle, ellipse and polygon; feather, opacity, invert, keyframes; folded into per-frame clip alpha.                                                                               |
| Shape masks, preview     | `apps/web-editor/src/preview/clip-mask.ts` (`paintClipMask`, `destination-in`)                                                               | Parity with the engine, documented point by point.                                                                                                                                   |
| Mask tab                 | `components/Inspector.tsx` (`mask` tab), `inspector/MaskPackActions.tsx`                                                                     | "Measure and follow" runs `tracking.*` / `subject.segment` and converts the result to a tracked shape mask.                                                                          |
| Layer compositing        | `render/compiler.py` (blend modes, clip alpha over lower tracks)                                                                             | The export already composites a non-opaque clip over the tracks beneath it.                                                                                                          |
| Derived media            | `apps/desktop/electron/media/derived-media-cache.ts`, `fp-media://`                                                                          | `fp-media://` resolves only inside `projectsRoot`, so artifacts the preview reads must live under `.framepilot-derived/`.                                                            |

## What blocks the feature

1. **`subject.segment` cannot deliver a clip matte.** Its result is per-frame RLE inline on a
   JSON line capped at `CAPABILITY_PACK_WORKER_MAX_LINE_BYTES` = 1 MiB
   (`worker-protocol.ts:8`). The mask is binary, and it is upsampled from a 192×192 inference
   to at most 512 px. Hair and fine edges are impossible at that resolution.
2. **PPHumanSeg is human-only.** A non-person prompt raises `SubjectNotFoundError`.
   Background removal must also work for products, pets and objects.
3. **No frame-to-frame memory.** Per-frame segmentation flickers at the boundary, and a
   still-looking matte crawls during playback. That flicker is the main quality failure in
   video background removal.
4. **No schema for a raster matte.** `mask` params are geometric (`bounds`, `points`). There is
   nowhere to reference a per-frame alpha video.
5. **Workers cannot write files.** ADR 0114: "cannot write project files". A full-resolution
   matte for a minutes-long clip is gigabytes of raw alpha, so it has to go to disk, not
   through stdout.
6. **The preview cannot show the result.** `webcodecs-preview-engine.ts` header: "Still no
   overlapping picture clips … one picture segment active at a time".
   `canvasPreviewEligible` (`editor/selectors-base.ts:351`) admits overlap only when every
   clip in it is full-frame opaque (ADR 0169/0170). A matted clip is, by definition, not
   opaque, so a cut-out over another clip is unpreviewable today.
7. **No proactive pack-state UI in the Inspector.** `usePackJob` discovers a missing pack
   only after the user clicks. The requested behaviour, a warning **before** use, needs a
   status read on mount and a refresh after install.

## Latent traps found on the way

- `applySplit` re-bases `clip.keyframes` but not `clip.effects[].keyframes`, and
  `truncateClip` ignores `effects`. A `matte` effect must therefore reference **source time**
  and carry no timeline-relative keyframes, which makes it split- and trim-safe by construction.
- The compiler and `clipMaskEffect` both pick the **first** `mask` effect. Adding the matte as
  another `mask` would either shadow the editor's drawn mask or be shadowed by it.
- OpenCV `VideoCapture` frame indices and ffmpeg's decode order disagree on VFR footage and on
  files with edit lists. A matte indexed by frame number alone will drift. See
  [`03`](./03-PROTOCOL-AND-HOST.md#frame-identity).
