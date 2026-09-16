# Background Removal — a precise, correctable subject matte from a local pack

> **Sub-plan of [`plan/PLAN.md`](../PLAN.md).** Read `AGENTS.md`, `CLAUDE.md` and
> `.agents/rules/product-discipline.mdc` first.
> **Status:** `[ ]` proposed · **Created:** 2026-09-16 · **Owner:** maintainer · **Branch:** `plan/background-removal-ai`
> **Primary target:** the Electron desktop app. The browser build shows "needs the desktop app" and nothing more.
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

**One sentence:** the editor selects a clip, opens **Inspector → Mask → Background**, clicks
**Remove background**, and a local Capability Pack worker computes a temporally stable,
full-resolution alpha matte of the subject. The matte is stored as project-owned derived
media and attached as one reversible `matte` effect. The preview and the export both
composite it, frame for frame. If the pack is missing, the section says so before the
editor clicks anything, and the same section works once the pack is installed, with no
restart.

## About "100% precise"

No segmentation model is pixel-perfect on arbitrary footage. Hair against a busy
background, motion blur, glass and smoke defeat every model published today, open or
closed. This plan does not promise a model that is always right. It promises three
things, and each one can be measured:

1. **The best matte we can ship under a permissive licence.** Promptable video
   segmentation for temporal stability, high-resolution boundary refinement, and true
   alpha matting on the uncertain edge band. Measured against labelled fixtures, with gates
   in [`06-PRECISION-AND-EVAL.md`](./06-PRECISION-AND-EVAL.md).
2. **Precision the editor can finish by hand.** Include and exclude clicks on any frame
   re-propagate the matte through the whole clip. Edge controls (shift, feather) and a
   matte-view toggle let the editor check every frame. The result reaches 100% because the
   editor can fix it, not because a model was always right.
3. **No silent wrongness.** The worker reports low-confidence frame ranges and the
   Inspector lists them. Export refuses a matte that does not cover the clip, or whose
   digest does not match. It never renders an unmatted or misaligned frame without saying so.

## Product scope gate (`.agents/rules/product-discipline.mdc`)

| Question               | Answer                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User outcome           | Cut a person or object out of their background and put anything behind it (another clip, an image, a colour), and see it in the monitor before export.                                                                                                                                                                  |
| Current workflow gap   | Only rectangle, ellipse and polygon masks exist. `subject.segment` returns ≤512 px binary masks as inline RLE, is human-only, and cannot deliver a full clip. The preview cannot draw a non-opaque clip over another clip. See [`00-CURRENT-STATE.md`](./00-CURRENT-STATE.md).                                          |
| Minimum vertical slice | One clip, one subject, prompted by one click or the auto-detected main subject → pack computes the matte → `matte` effect applied through `applyPatchChecked` → preview composites it over the clip on the track below (or black) → export matches → undo removes it → missing-pack warning and install → re-run works. |
| Reuse                  | Capability Pack platform (ADR 0114): signed install, `usePackJob`, proposals, health check, `register-local`. onnxruntime pack runtime from `visual-embed` (ADR 0176). `subject.detect` for the auto prompt. `clip-mask.ts` destination-in painting. Engine clip-alpha compositing. `.framepilot-derived/` cache.       |
| Explicitly deferred    | Blur-the-background, AI background generation, green-screen chroma key, export with an alpha channel, more than one matte per clip, a model-facing AI tool (BR8 is optional and last), browser support, cloud matting. See [`08-DEFERRED-AND-RISKS.md`](./08-DEFERRED-AND-RISKS.md).                                    |
| Evidence required      | Precision gates on labelled fixtures, preview↔export pixel parity on real camera footage, a desktop e2e for missing pack → install → remove → undo, and a render-backed golden. Details in [`07-TASKS-AND-EVIDENCE.md`](./07-TASKS-AND-EVIDENCE.md).                                                                    |

## Maintainer decisions required before code (CLAUDE.md §5)

| #    | Decision                                                                                                     | Why it is gated                                        | Recommendation                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| MD-1 | **Schema v22:** new `matte` effect type plus a migration                                                     | Timeline schema change                                 | Approve. A separate effect type, not a fourth `mask` shape (see [`04`](./04-SCHEMA-RENDER-PREVIEW.md#why-a-new-effect-type)).                        |
| MD-2 | **New pack `framepilot.background-removal`** with SAM 2.1 + BiRefNet + an alpha-matting model on onnxruntime | New weights, licences, ~0.4–1.2 GiB download           | Approve after BR0 confirms licences and the ONNX export. Candidates and rejected models are in [`02`](./02-WORKER-PACK.md).                          |
| MD-3 | **Pack worker writes one host-created staging directory** under `<project>/.framepilot-derived/mattes/`      | Broadens the pack sandbox (today workers cannot write) | Approve, scoped to one empty directory per request, verified and renamed by the host. See [`03`](./03-PROTOCOL-AND-HOST.md#sandbox-broadening-md-3). |
| MD-4 | **Mattes are project-owned**, never evicted like a regenerable cache                                         | Storage and reproducibility policy                     | Approve. A matte records the editor's corrections and cannot be re-derived byte for byte from the model alone.                                       |

## Files

| File                                                           | Contents                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`00-CURRENT-STATE.md`](./00-CURRENT-STATE.md)                 | What exists today, with file references, and what blocks this feature                  |
| [`01-ARCHITECTURE.md`](./01-ARCHITECTURE.md)                   | End-to-end data flow, component ownership, and the invariants                          |
| [`02-WORKER-PACK.md`](./02-WORKER-PACK.md)                     | The pack: model pipeline, runtime, licences, the BR0 spike and its fallback            |
| [`03-PROTOCOL-AND-HOST.md`](./03-PROTOCOL-AND-HOST.md)         | The `subject.matte` capability, artifact handoff, desktop service, cache, cancellation |
| [`04-SCHEMA-RENDER-PREVIEW.md`](./04-SCHEMA-RENDER-PREVIEW.md) | Schema v22, operations and validation, engine compositing, preview compositing         |
| [`05-INSPECTOR-UX.md`](./05-INSPECTOR-UX.md)                   | Every Inspector state, including the missing-pack warning, install and corrections     |
| [`06-PRECISION-AND-EVAL.md`](./06-PRECISION-AND-EVAL.md)       | Metrics, fixtures, gates, and how precision claims are evidenced                       |
| [`07-TASKS-AND-EVIDENCE.md`](./07-TASKS-AND-EVIDENCE.md)       | Phased checklist BR0–BR8 with a Definition of Done for each phase                      |
| [`08-DEFERRED-AND-RISKS.md`](./08-DEFERRED-AND-RISKS.md)       | Deferred scope, risks, and what would change the plan                                  |

## Build order

`BR0 spike (models, ONNX, licences) → BR1 schema + ops → BR2 engine render → BR3 pack worker →
BR4 protocol + desktop host → BR5 preview → BR6 Inspector UX (warning, install, run, correct) →
BR7 precision eval + e2e → BR8 (optional) AI tool`

The engine comes before the AI (PRD §23). BR1–BR2 are tested against a matte **fixture video**,
so the render path is proven before any model exists. BR3 can run in parallel with BR1–BR2
once BR0 passes.
