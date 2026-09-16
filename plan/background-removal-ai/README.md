# Masking, Background Removal and AI Masking, on a preview that matches the export

> **Sub-plan of [`plan/PLAN.md`](../PLAN.md).** Read `AGENTS.md`, `CLAUDE.md` and
> `.agents/rules/product-discipline.mdc` first.
> **Status:** `[ ]` proposed · **Created:** 2026-09-16 · **Updated:** 2026-09-16 (preview parity; precision pipeline; professional + AI masking; parity and production audit) · **Owner:** maintainer · **Branch:** `plan/background-removal-ai`
> **Primary target:** the Electron desktop app. Browser gaps are named, never silent.
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

**One sentence:** FramePilot gets a professional mask system:

- **Mask stack:** any number of rectangle, ellipse, Bezier path, split, mirror, gradient, shape-preset,
  colour-key, track-matte (including text as a mask) and AI matte masks per clip and per adjustment lane, with modes, inner/outer and per-vertex feather, expansion, source-time path animation, and
  planar/shape tracking. A mask can cut the clip's alpha or limit any effect.
- **Tools:** drawn on the monitor with professional tools, and edited in a mask panel.
- **Background removal:** one click. A local pack cross-checks every frame and hands the editor a short
  review list with brush fixes.
- **AI masking:** the agent does all of this from plain requests through the same operations, asking
  instead of guessing when a request is ambiguous.
- **Preview:** the monitor renders the same frame plan the export renders, so what the editor sees is
  what the file contains.

## Maintainer scope decision (2026-09-16, CLAUDE.md §5)

The maintainer asked for, in order:

1. background removal as a worker with an Inspector option and a missing-plugin warning;
2. the preview fixed at the core to render like the export;
3. professional-editor-level masking;
4. AI able to do masking;
5. everything precise, accurate, professional and production ready.

This plan is that scope. The product-scope gate applies **inside** it: every phase ends in a usable,
tested editor capability, and the four tracks ship value independently (PX and MK need no model).

## Is this production ready?

**Not until RD3 passes.** The audit in [`12`](./12-PARITY-AND-PRODUCTION-AUDIT.md) compared this plan with
Premiere Pro, DaVinci Resolve and CapCut and found 25 production gaps. Every gap now has a fix in this
plan or a named deferral. The largest was that **no build can install packs yet**: no signed catalog,
keys or CDN. That work (RD1) starts immediately, in parallel with code. "Production ready" is defined as
the RD3 checklist on the release build, not as a feeling at plan time.

## What "100% precise and accurate" means here

No segmentation model or tracker is right on every frame of arbitrary footage, and this plan does not
promise one. It makes the **delivered result** exact, and every claim is a gate in
[`06`](./06-PRECISION-AND-EVAL.md):

1. **Deterministic parts are exact, not approximately right.** The mask rasteriser uses exact area
   coverage and exact distance-field feathering, and it is **byte-identical** in the engine and the
   preview. Migrated projects export byte-identically. Masks stay glued to source frames through every edit.
2. **Measured parts are as accurate as permissive models allow.** Bidirectional SAM 2.1, a
   high-resolution refiner, consensus, self-correction, full-resolution matting, edge colour cleanup,
   and planar tracking at sub-pixel gates.
3. **No silent errors.** Independent verification catches ≥ 99.5% of wrong matte frames and ≥ 99.5% of
   bad track frames, and puts them on one review list.
4. **Every flagged frame can be made exact** with brushes, constraint frames and locks, which later
   runs can never overwrite. **Verified** shows only when every frame has been checked by the pipeline
   or approved by the editor.
5. **AI never guesses.** Geometry always traces to a measurement or a user number, and an ambiguous
   target is a question to the user. A confident wrong pick counts as a failure in the eval.

## Product scope gate

| Question              | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User outcome          | Isolate, hide, cut out, restyle or track any part of the picture by hand or by asking the AI, see the exact result in the monitor, and export it.                                                                                                                                                                                                                                                                                                     |
| Current workflow gap  | Masks are one hardcoded box per clip with no handles, no paths, no modes, no effect scoping, and tracking only of bounds. There is no raster matte and no usable AI mask (`generate_mask` is unavailable). The monitor switches renderers by content and draws text above everything. See [`00`](./00-CURRENT-STATE.md), [`09`](./09-PREVIEW-EXPORT-PARITY.md) and [`10`](./10-PROFESSIONAL-MASKING.md#current-state-audited-2026-09-16-at-8889d605). |
| First vertical slices | **PX:** the pixel oracle and N-layer compositor on existing features. **MK:** draw → animate → export a path mask with preview == export. **BR:** remove background → review → text behind subject. **AM:** "blur the faces except the host".                                                                                                                                                                                                         |
| Reuse                 | Capability Packs (ADR 0114) and `register-local`; Tracking Lite; Subject Intelligence; visual-embed identity; onnxruntime pack runtime (ADR 0176); WebCodecs decode/clock/effect/transition chains; `frame_grab.py`; keyframe easing (ADR 0089); `PackInstallInlineCard`; vision-review; the domain-tools registry.                                                                                                                                   |
| Explicitly deferred   | Semantic part masks, inpainting, mask motion blur, 3D camera solve, AE/Resolve mask exchange, export with alpha, browser removal, cloud matting. See [`08`](./08-DEFERRED-AND-RISKS.md).                                                                                                                                                                                                                                                              |
| Evidence required     | The RD3 release gate in [`12`](./12-PARITY-AND-PRODUCTION-AUDIT.md#c-what-production-ready-means-for-this-plan-release-gate-rd3): every gate in `06` and every `09` oracle row on both platforms, E2E.1–E2E.8 against signed packs from the real catalog, security, licence and beta sign-off.                                                                                                                                                        |

## Maintainer decisions

**Approved by the maintainer on 2026-09-16** ("i am ready to go with any changes"), recorded per
CLAUDE.md §5. Models and runtimes are decided (MD-2, MD-6); BR0 verifies parity and records numbers, and the measured
gates still apply.

| #    | Decision                                                                                                                | Status                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| MD-1 | Schema v22 mask stack (`Clip.masks`, `EffectLayer.masks`) replacing `mask` effects, with migration and backup           | **Approved**                                                                                       |
| MD-2 | Smart Mask models: **SAM 2.1 Hiera-L + BiRefNet_HR-matting**, fp32 onnxruntime (CoreML EP; Windows ML → DirectML → CPU) | **Approved and decided** (2026-09-16); BR0 verifies parity, it does not choose                     |
| MD-3 | Pack worker writes one host-created staging directory                                                                   | **Approved** (security review in BR4 still required)                                               |
| MD-4 | Mattes, tracks and correction inputs are project-owned                                                                  | **Approved**                                                                                       |
| MD-5 | Delete the DOM program monitor and eligibility gates once every oracle row passes                                       | **Approved** (behind a flag until RD3)                                                             |
| MD-6 | Text grounding: **SAM 3.1** image mode in a separate Smart Mask Text pack                                               | **Approved and decided** (legal review of the SAM License in RD2.3; OWLv2 is the only contingency) |
| MD-7 | Per-project, opt-in face recognition for identity-aware AI masking                                                      | **Approved** (legal review of copy in RD2)                                                         |

**Maintainer actions (not decisions; nothing ships to users without them):** Apple Developer ID and
notarisation, a Windows Authenticode certificate, offline catalog root keys, and a CDN account for
multi-GiB packs (RD1.1–RD1.2). Today no build can install a pack from a catalog
(`service.ts:547`, `catalog_unconfigured`).

## Files

| File                                                           | Contents                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`00-CURRENT-STATE.md`](./00-CURRENT-STATE.md)                 | Pack, segmentation and preview state with file references                                            |
| [`01-ARCHITECTURE.md`](./01-ARCHITECTURE.md)                   | End-to-end flow, ownership, invariants                                                               |
| [`02-WORKER-PACK.md`](./02-WORKER-PACK.md)                     | Smart Mask precision pipeline, models, licences, BR0                                                 |
| [`03-PROTOCOL-AND-HOST.md`](./03-PROTOCOL-AND-HOST.md)         | `subject.matte`, `subject.ground`, sandbox, host IPC, cache, retention                               |
| [`04-SCHEMA-RENDER-PREVIEW.md`](./04-SCHEMA-RENDER-PREVIEW.md) | The `matte` mask kind: fields, ops, engine reader, preview source                                    |
| [`05-INSPECTOR-UX.md`](./05-INSPECTOR-UX.md)                   | Mask tab placement, pack warnings per tool, background removal states, review, brush, lock, Verified |
| [`06-PRECISION-AND-EVAL.md`](./06-PRECISION-AND-EVAL.md)       | Gates for mattes, rasteriser, tracking and AI masking                                                |
| [`07-TASKS-AND-EVIDENCE.md`](./07-TASKS-AND-EVIDENCE.md)       | PX, MK, BR, AM phases and E2E with a DoD per phase                                                   |
| [`08-DEFERRED-AND-RISKS.md`](./08-DEFERRED-AND-RISKS.md)       | Deferred scope, risks, what would change the plan                                                    |
| [`09-PREVIEW-EXPORT-PARITY.md`](./09-PREVIEW-EXPORT-PARITY.md) | Core preview fix: frame plan, pixel oracle, N-layer compositor, gates deleted                        |
| [`10-PROFESSIONAL-MASKING.md`](./10-PROFESSIONAL-MASKING.md)   | Mask stack, kinds, modes, feather, animation, tracking, tools, schema v22, rasteriser                |
| [`11-AI-MASKING.md`](./11-AI-MASKING.md)                       | Target resolution, tools, verification, surfaces, evals                                              |

## Build order

```
PX0 → PX1 → PX4 → PX2 → PX3 → PX5
MK1 → MK2 → MK3 (needs PX2) → MK4 → MK5 → MK6 → MK7
BR0 → MD-1..6 → BR2 (needs MK2) ─┬─ BR4 → BR5 (needs MK3) → BR6 → BR7
                         BR3 ────┘
AM1 (needs MK7, BR6) → AM2 → AM3 → AM4 → AM5
MK8 → MK9 (after MK3)
RD0 · RD1 (starts now) · RD2 → E2E.1–E2E.8 + DOC.1 → RD3 release gate
```

The engine comes before the AI (PRD §23): AM starts only when the operations, renderers and pack jobs
it drives are complete and gated.
