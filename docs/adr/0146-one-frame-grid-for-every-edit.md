# ADR 0146 — One frame grid, for every edit

**Status:** accepted
**Date:** 2026-08-26
**Related:** ADR 0076 (canonical timeline mapping), ADR 0032 (type-agnostic
layers), `plan/context-management/PHASE-3-frame-accurate-edits.md`,
`CLAUDE.md` §5 (pause before a schema change)

## Context

`plan/context-management/PHASE-3-frame-accurate-edits.md` opens with a claim:

> FramePilot's timeline has no frame grid. […] There is no quantization step
> anywhere — no `snapToFrame`, no `frameDuration`, no rounding to `1/fps` — at
> any layer.

**That claim is wrong, and correcting it is most of this decision.**
`packages/ai-sdk/src/frame-time.ts` is a complete frame grid: rational frame
rates (23.976 resolves to 24000/1001, not to a float), `secondsToFrame` with an
explicit rounding policy, `frameToSeconds`, `snapSecondsToFrame`, and a
per-operation `normalizeOperationTime` that knows which fields are edit points
and which are evidence. It is wired into `assembleEdit`, before patch identity,
validation, preview and render can disagree about a fractional value.

The real gap is narrower and worse: **it only runs for edits the AI authors.**

A patch built by the UI — dragging a clip, trimming an edge, splitting at the
playhead — reaches `applyUserPatch` (`apps/web-editor/src/editor/store.ts`),
which validates and commits it through `commitProjectPatch` and never touches
`frame-time.ts`. So a human trim lands at `12.3874s` on a 30fps timeline, 0.4 of
a frame from any frame boundary, and nothing in the stack decides which frame it
means: the preview seeks an HTML video element to the decoder's nearest frame,
the export hands the float to MoviePy, and nothing guarantees the two agree.

That also means the three tolerances the phase file catalogues — `TIME_EPSILON`
(1e-6), `AUDIO_AUTOMATION_TIME_RESOLUTION_SECONDS` (1e-3),
`_CUT_ADJACENCY_TOLERANCE` (1e-3) — are absorbing float noise from a stack that
quantizes on one of its two authoring paths.

## Decision

**One grid, owned by `packages/editor-core`, applied at the canonical patch
authority — so a manual edit and an AI edit land on the same frame.**

1. The grid moves from `packages/ai-sdk/src/frame-time.ts` to
   `packages/editor-core/src/frame-grid.ts`, unchanged in behaviour.
   `editor-core` is where operations, `apply`, `invert` and the patch engine
   live; a grid that the patch engine cannot reach is a grid half the product
   does not have. `ai-sdk/frame-time.ts` becomes a re-export, so no consumer
   moves in this change.

2. `commitProjectPatch` quantizes the patch **first**, then inverts, applies and
   records the quantized patch. Not inside `applyOperation`, and not inside
   `applyProjectPatch`: the inverse is computed from the operation, so an apply
   that quantized privately would invert to a different state than it applied
   from. Quantizing the operation once, up front, means `apply`, `invert`,
   `validate` and the recorded history entry all see the same numbers, and the
   operation algebra is untouched.

3. `applyUserPatch` quantizes before it validates, so the UI validates the edit
   it will actually commit. Quantization is idempotent, so the second pass in
   `commitProjectPatch` is a no-op.

4. **Rounding is named: nearest frame, ties away from zero.**
   TS `Math.round(seconds * num / den)`; Python `math.floor(x + 0.5)`. Timeline
   times are non-negative, so the two agree by construction. A shared JSON
   fixture pins the mapping and a parity test runs it in both runtimes — the
   same pattern `captionStyle.ts` ↔ `captions.py` already uses.

5. **The Python compiler asserts the grid; it does not re-implement it.** A
   second rounding rule on the Python side is precisely how preview and export
   come to disagree.

### What is deliberately NOT quantized, and why

Already encoded in `normalizeOperationTime` and kept:

- **`restore_clips`, `restore_effect_layer`, seeded `add_layer`** — inverse
  primitives carrying exact prior state. Snapping them would make undo restore
  something other than what was there, which is the one thing undo may not do.
- **`set_transcript`, caption cue words, speed-ramp source points** — evidence
  and source observations, not edit decisions.
- **`add_clip`'s coupled source/sequence ranges** — a source asset may run at a
  different frame rate from the sequence, and this boundary is given only the
  project fps. Rewriting source timestamps against the sequence rate would be
  less precise, not more.
- **Audio genuinely is sub-frame.** This is a _picture_ edit-point grid. Audio
  fades keep their own resolution.

### The three tolerances

`TIME_EPSILON` (1e-6) survives: it is float-comparison slack in map lookups, not
quantization slack, and exact equality on IEEE doubles is not a thing to rely on
even on a grid. `AUDIO_AUTOMATION_TIME_RESOLUTION_SECONDS` survives for the same
reason the audio exemption exists. `_CUT_ADJACENCY_TOLERANCE` survives as a
**compatibility** allowance for projects authored before this ADR, whose times
are off-grid until the next edit touches them; its comment now says so rather
than implying a quantization step that had not run on that path.

## Alternatives considered

**(b) Frames become the stored unit** — integer frame counts against
`project.fps`, seconds derived. Unambiguous by construction and it makes every
downstream check exact. **Rejected for now**: it needs a real migration of every
`project.fp.json`, an fps-change operation that re-maps every time, and a blast
radius across the schema, the Python models and every test fixture — risk that
exceeds the bug's. Recorded as the deferred alternative with its trigger:
**variable-frame-rate source support, or a second precision bug that (a) cannot
reach.**

**Quantize inside `applyOperation`** — rejected above: it breaks the
apply/invert algebra.

**Leave the grid AI-only and document the gap** — rejected. "The AI cuts on
frames and you do not" is not a defensible product, and preview/export parity
(`.agents/rules/product-discipline.mdc` §2) is not an AI-mode feature.

## Consequences

- Manual and AI edits are on the same grid. A cut requested at a word boundary
  lands on the frame `get_mapped_transcript` reported for that word, whoever
  asked for it.
- No schema change. No migration. Projects authored earlier keep their times
  until an edit touches them, and then re-grid naturally — an existing project
  does not shift by a frame merely by being opened.
- The grid is now testable as one thing: an invert property test over random
  operation sequences, and a TS↔Python parity test over a shared fixture.
- Preview/export cut-point divergence becomes a number that can be reported.
  Until this ADR there was no grid to measure it against.
