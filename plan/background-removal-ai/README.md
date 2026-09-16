# Background Removal — a verified, correctable subject matte, and a preview that matches the export

> **Sub-plan of [`plan/PLAN.md`](../PLAN.md).** Read `AGENTS.md`, `CLAUDE.md` and
> `.agents/rules/product-discipline.mdc` first.
> **Status:** `[ ]` proposed · **Created:** 2026-09-16 · **Updated:** 2026-09-16 (preview parity core fix; precision pipeline) · **Owner:** maintainer · **Branch:** `plan/background-removal-ai`
> **Primary target:** the Electron desktop app. The browser build shows "needs the desktop app" for removal.
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

**One sentence:** the editor selects a clip, opens **Inspector → Mask → Background**, clicks
**Remove background**, and a local Capability Pack worker computes a full-resolution alpha matte.
The worker cross-checks every frame with independent estimates, corrects itself, and hands the
editor a short list of moments to confirm or fix with a brush. The matte is stored as project-owned
media and attached as one reversible `matte` effect. The monitor composites it **through the same
frame plan the export uses**, so text behind a person, or anything else layered, looks the same in
the preview and the file. If the pack is missing, the section warns before anything is clicked,
and it works as soon as the pack is installed, with no restart.

## What "100% precise and accurate" means here

No segmentation model is right on every frame of arbitrary footage, open or closed. A plan that
promised that would be promising something no one can build. This plan makes the **delivered
result** 100%, in a way that can be measured:

1. **Maximum automatic accuracy.** The largest permissively licensed models, at full source
   resolution. Forward and backward propagation plus a high-resolution refiner, whose disagreements
   define exactly where more work goes. A self-correction loop re-prompts from confident frames.
   Real alpha matting on the edge band, and edge colour decontamination.
2. **No silent errors.** An independent verification stage must catch **≥ 99.5%** of frames that are
   actually wrong (a gate in [`06`](./06-PRECISION-AND-EVAL.md)). Those frames go on a review list
   instead of into the export unnoticed.
3. **Every frame can be made exact.** Keep, Remove and Edge brushes fix a flagged frame in ≤ 3
   actions to IoU ≥ 0.995. The fix propagates to neighbours, and **locked** frames are hard
   constraints no later run may change.
4. **Verified** shows only when every frame has been checked by the pipeline or approved by the
   editor. Export tells the editor if any moment is unchecked.

## Product scope gate (`.agents/rules/product-discipline.mdc`)

| Question               | Answer                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User outcome           | Cut a subject out of its background, put anything behind it (another clip, an image, a colour, **text behind the person**), and see exactly the exported result in the monitor.                                                                                                                                                                                                           |
| Current workflow gap   | Only geometric masks exist. `subject.segment` returns ≤ 512 px binary RLE on a 1 MiB JSON line and is human-only. The monitor uses a different renderer depending on timeline content, paints text above every picture, and cannot composite overlapping pictures. See [`00`](./00-CURRENT-STATE.md) and [`09`](./09-PREVIEW-EXPORT-PARITY.md#root-cause-audited-2026-09-16-at-8889d605). |
| Minimum vertical slice | One clip, one subject → pack computes and verifies the matte → `matte` effect applied (undoable) → review list resolved with approve/brush/lock → preview shows video → text → cut-out copy identical to the export → export → reopen without the pack → missing-pack warning and install → re-run.                                                                                       |
| Reuse                  | Capability Pack platform (ADR 0114), `usePackJob`/proposals/health/`register-local`; onnxruntime pack runtime (ADR 0176); `subject.detect`; WebCodecs decode/clock/effect/transition chains; `frame_grab.py` as the export-truth oracle; engine clip-alpha compositing; `.framepilot-derived/`.                                                                                           |
| Explicitly deferred    | Background blur, AI background generation, chroma key, export with alpha, multiple mattes per clip, browser removal, cloud matting, the AI tool (BR8 optional). See [`08`](./08-DEFERRED-AND-RISKS.md).                                                                                                                                                                                   |
| Evidence required      | Every gate in `06` on both platforms; every row of the `09` pixel oracle; desktop e2e for install → remove → review/fix → text behind subject → preview == export → undo → reopen.                                                                                                                                                                                                        |

The preview parity work (PX) is a core fix to the program monitor, not a matte feature. It is in
this plan because background removal is the first feature that cannot be shipped without it, and
the maintainer asked for it to be fixed at the root (2026-09-16).

## Maintainer decisions required before code (CLAUDE.md §5)

| #    | Decision                                                                                                     | Why it is gated                                                              | Recommendation                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| MD-1 | **Schema v22:** new `matte` effect type plus a migration                                                     | Timeline schema change                                                       | Approve. A separate effect type (see [`04`](./04-SCHEMA-RENDER-PREVIEW.md#why-a-new-effect-type)). |
| MD-2 | **New pack `framepilot.background-removal`**: SAM 2.1 Hiera-L + BiRefNet HR + a matting model on onnxruntime | New weights and licences; large download                                     | Approve after BR0 confirms licences, the ONNX export and error-detection recall.                   |
| MD-3 | **Pack worker writes one host-created staging directory** under `.framepilot-derived/mattes/`                | Broadens the pack sandbox                                                    | Approve, scoped as in [`03`](./03-PROTOCOL-AND-HOST.md#sandbox-broadening-md-3).                   |
| MD-4 | **Mattes and correction inputs are project-owned**                                                           | Storage and reproducibility policy                                           | Approve; corrections are editor work and cannot be re-derived.                                     |
| MD-5 | **Delete the DOM program monitor and the eligibility gates** once the oracle passes                          | Removes a user-visible fallback; supersedes the gating role of ADR 0169/0170 | Approve; a second renderer chosen by content is the root cause of preview/export drift.            |

## Files

| File                                                           | Contents                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`00-CURRENT-STATE.md`](./00-CURRENT-STATE.md)                 | What exists today, with file references, and what blocks the feature                                     |
| [`01-ARCHITECTURE.md`](./01-ARCHITECTURE.md)                   | End-to-end data flow, ownership, invariants                                                              |
| [`02-WORKER-PACK.md`](./02-WORKER-PACK.md)                     | Precision pipeline, models, licences, BR0 spike                                                          |
| [`03-PROTOCOL-AND-HOST.md`](./03-PROTOCOL-AND-HOST.md)         | `subject.matte`, corrections and locked frames, sandbox, host, cache                                     |
| [`04-SCHEMA-RENDER-PREVIEW.md`](./04-SCHEMA-RENDER-PREVIEW.md) | Schema v22, ops, engine render, the matte preview pass                                                   |
| [`05-INSPECTOR-UX.md`](./05-INSPECTOR-UX.md)                   | Every Inspector state: missing-pack warning, install, review, brush, lock, Verified, text behind subject |
| [`06-PRECISION-AND-EVAL.md`](./06-PRECISION-AND-EVAL.md)       | Metrics, fixtures, gates, and what "100%" means in numbers                                               |
| [`07-TASKS-AND-EVIDENCE.md`](./07-TASKS-AND-EVIDENCE.md)       | PX0–PX5 and BR0–BR8 with a DoD per phase                                                                 |
| [`08-DEFERRED-AND-RISKS.md`](./08-DEFERRED-AND-RISKS.md)       | Deferred scope, risks, what would change the plan                                                        |
| [`09-PREVIEW-EXPORT-PARITY.md`](./09-PREVIEW-EXPORT-PARITY.md) | The core preview fix: one frame plan, N-layer compositor, pixel oracle, gates deleted                    |

## Build order

Two tracks start together and meet at BR5:

```
PX0 inventory → PX1 frame plan → PX4 pixel oracle → PX2 N-layer compositor → PX3 delete gates → PX5 perf
BR0 spike → MD-1..5 → BR1 schema/ops → BR2 engine ─┬─ BR4 host → BR5 matte pass (needs PX2) → BR6 Inspector → BR7 eval + e2e → BR8?
                                  BR3 worker pack ─┘
```

The engine comes before the AI (PRD §23). BR1–BR2 are tested against a matte **fixture video**, and
PX is tested against the export oracle, so neither waits for a model.
