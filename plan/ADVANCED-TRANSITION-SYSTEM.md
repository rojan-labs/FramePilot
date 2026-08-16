# Advanced Transition System

> Status: [x] DONE — started and completed 2026-08-01 (ADR 0091).
> Owner: Claude Code session. Branch: `feat/advanced-transition-system`.
> Parent: `plan/PLAN.md` Phase 6 (transitions).
> Predecessors: `plan/TRANSITIONS-PREVIEW-AND-KINDS.md` (ADR 0061, live preview +
> wipe/slide), `plan/PREVIEW-INSPECTOR-KEYFRAME-TRANSITION-REVAMP.md` Phases 8–9
> (timeline blocks, on-cut picker, look params).

## Why

Transitions ship end-to-end today — op, eligibility, validator, MoviePy render,
canvas + DOM preview, timeline blocks with resize handles, an on-cut picker, an
inspector section, AI/MCP tools. What they do **not** have is a library: seven
kinds, no browsable panel, no animated previews, no favourites/recents/presets,
no alignment, no audio pairing, no recommendations. An editor coming from CapCut
or Premiere opens FramePilot, finds seven greyed words in a popup, and concludes
the product has no transitions.

This plan turns the seven kinds into a **77-entry browsable library** built on a
closed set of render kinds, each with a GLSL pass and a numpy twin, and wraps it
in the discovery/appraisal/adjustment workflow the brief describes.

## Invariants (do not break these)

1. **No timeline-schema change, no migration.** A transition stays one
   `transition` effect on the _incoming_ clip, id `${toClipId}__transition`,
   params `{ kind, durationSeconds, fromClipId, ... }`. `Effect.params` is
   free-form, so every new param is additive. (Same reasoning as ADR 0061.)
2. **Every existing project renders byte-identically.** The seven legacy kinds
   (`fade`, `cross-dissolve`, `push`, `zoom`, `blur`, `wipe`, `slide`) keep their
   current compiler path and their current defaults. New kinds are new ids.
3. **The Python engine stays the source of truth for semantics.** Every render
   kind is a numpy pass in `render/transition_passes/` with a GLSL twin in
   `apps/web-editor/src/preview/transitions/glsl-transitions.ts`. Change them
   together; parity tests pin the pairing (mirrors ADR 0088's effect-layer rule).
4. **Nothing branches on a catalog entry id.** Renderers see a
   `TransitionRenderKind` + a numeric param bag. Adding transition #52 is a
   one-object change to the catalog with zero renderer work (ADR 0069/0088
   extensibility contract).
5. **No silent success.** `transitionEligibility` already refuses a transition
   where no cut exists; every new surface routes through the same validated
   patch builders, never a raw timeline mutation.

## The rendering model (read this before touching a renderer)

FramePilot models a transition as a treatment of the **incoming clip's first
`durationSeconds`**, composited over whatever is below it (the outgoing clip
where they overlap, black where they are sequential). Every render kind is
therefore one function:

```
transition(toTex, uv, p, params) -> vec4 rgba   // premultiplied incoming picture
```

— a UV remap, a colour transform, an alpha mask, or any combination. The
compositor is unchanged. This is what makes 29 render kinds tractable: wipes are
alpha, slides are UV + alpha, 3D is a perspective UV remap with alpha, glitch is
UV + colour.

Three application paths exist in the compiler, and each render kind declares
which it uses, because two of them are free:

| path                                         | used by                                        | cost                                         |
| -------------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| geometry (MoviePy `resized`/`with_position`) | slide, zoom                                    | no resample beyond what MoviePy already does |
| alpha mask (vectorized numpy row/column)     | dissolve, all wipes, luma/noise/pixel dissolve | one float mask per frame                     |
| frame transform (numpy per-pixel)            | everything else                                | full-frame numpy over `durationSeconds` only |

Legacy kinds map onto the first two paths exactly as they do today, which is how
invariant 2 is satisfied by construction.

**Known limitation (deliberate, documented):** on _sequential_ clips a dissolve
blends through black rather than through the outgoing shot, because this engine
borrows no source handles (ADR 0076's reasoning). True two-shot blending needs an
outgoing tail extension in both the compiler and the preview decoder; it is out
of scope here and tracked as a follow-up. The UI states which case a given cut is
in rather than pretending.

## Slices

Each slice is a commit. Tests ship with the slice that introduces the code.

- [x] **S0 — plan + branch.** This document; `plan/PLAN.md` pointer.
- [x] **S1 — catalog.** `packages/timeline-schema/src/transition-catalog.ts`
      (77 entries, 7 categories, search tags, thumbnail gradient pairs) +
      `transition-params.ts` (per-render-kind param descriptors, the uniform-order
      contract) + `TransitionRenderKind` union. Pure data, no renderer knowledge.
      JSON export for the Python engine + drift tests both sides.
- [x] **S2 — editor-core.** `AddTransitionOp.kind` accepts any catalog id;
      `alignment` + look params flow through `set_transition_params`; audio pairing
      op; eligibility unchanged. Tests.
- [x] **S3 — TS transition engine.** `preview/transitions/transition-engine.ts`:
      resolve a stored effect → `{ renderKind, params, progress, alignment }`.
      Pins against the Python constants.
- [x] **S4 — GLSL passes + chain.** 29 fragment passes and `GlTransitionChain`
      (one shared context, same lazy/failure-tolerant posture as `GlEffectChain`).
- [x] **S5 — Python render.** `render/transition_passes/` numpy twins +
      dispatcher + compiler wiring; parity tests against the GLSL param order.
- [x] **S6 — Transitions panel.** New left-rail tab: search, category rail,
      recents/favourites/recommended shelves, compact/expanded density, animated
      hover previews (the real shader over two synthetic frames), drag to timeline.
- [x] **S7 — Timeline + edit points.** Bigger hit targets, hover affordance,
      drop highlighting, auto-scroll, multi-select edit points, bulk apply summary,
      context-menu actions.
- [x] **S8 — Inspector.** Kind-aware controls from the param descriptors,
      alignment diagrams, duration presets, replace/remove, save-as-preset.
- [x] **S9 — Audio transitions.** Crossfade / fade-out-in / equal-power written
      as paired `audio_gain` fades; timeline + inspector surfaces.
- [x] **S10 — Personalisation + recommendations.** Favourites, recents, most
      used, user presets (persisted), context-aware suggestions with reasons.
- [x] **S11 — Preview UX.** Preview-transition action, loop around the cut,
      before/after compare, on-canvas centre handles.
- [x] **S12 — A11y, empty states, onboarding, performance pass.** Every tile is a
      button with the transition's name AND description as its accessible name; focus
      drives the hover preview so keyboard users see what pointer users see;
      `prefers-reduced-motion` replaces the loop with a held frame at the midpoint;
      every empty shelf says how to fill it; the on-cut target is announced as a
      `status` region rather than being left implicit. Only one preview animates at a
      time and the GL context is shared, so a 77-tile grid costs one context and one
      rAF.
- [x] **S13 — Docs, ADR, changelog, plan reconciliation, full verify.**

## What was deliberately left out

- **True two-shot blending on butt-joined clips.** A dissolve still blends through
  black where the clips do not overlap, because this engine borrows no source
  handles (ADR 0076). Closing it needs an outgoing tail extension in the compiler
  AND in the preview decoder — a change to how clips are decoded, not to how
  transitions are drawn. Tracked as a follow-up; the UI states which case a cut is
  in rather than pretending.
- **On-canvas handles for centre points.** `centreX`/`centreY` are inspector
  sliders. Dragging them on the preview needs the transform-overlay surface the
  preview already has for clip transforms, which is a separate integration.
- **Analysis-backed suggestions** (camera motion, scene brightness, music energy).
  Every one needs a pass that may not have run, which would make the shelf appear
  and disappear for reasons the user cannot see. They belong with the
  footage-understanding work, which already knows how to say when it is ready.

## Definition of Done

`pnpm verify` green; `pnpm engine:test` green; every render kind has a numpy pass,
a GLSL pass and a parity test; the panel lists 77 transitions each with a working
animated preview; drag-drop, click-a-cut, search, replace, remove, bulk apply,
presets and undo/redo all work from the UI; docs + ADR + CHANGELOG updated.
