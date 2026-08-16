# ADR 0061 — Live transition preview via a TS envelope mirror; wipe & slide kinds

- **Status:** Accepted
- **Date:** 2026-07-17
- **Phase:** 6 — Color, Sound & Transitions (PRD §6.9) / TIMELINE-REVAMP M3
- **Relates to:** ADR 0021 (transitions render), plan/TRANSITIONS-PREVIEW-AND-KINDS.md

## Context

Transitions shipped end-to-end (operation, validator, MoviePy render, pills,
AI/MCP tools — ADR 0021) **except the live preview**: neither the WebCodecs
canvas engine nor the DOM `PreviewPlayer` applied the transition envelope, so
editors only saw fades/pushes after an export or sidecar render. The kind set
also lacked the two standard kinds `wipe` and `slide` (`push` only enters from
the right). OpenCut was checked as a parity reference and has no transition
implementation at all, so this closes a gap identified by our own analysis.

The render-vs-preview rule (AGENTS.md) forbids reimplementing the render
client-side — but an _envelope_ (opacity/scale/offset/blur/wipe progress as a
function of clip-relative time) is pure math, and mirroring it is the only way
scrubbing can show what the export produces.

## Decision

1. **Python stays the source of truth.** `render/transitions.py` defines the
   envelope semantics; `apps/web-editor/src/preview/transition-envelope.ts` is
   a pure TS mirror with the same constants (`ZOOM_FROM` 1.6, push/slide
   fraction 1.0, `BLUR_FRACTION` 0.04, `WIPE_SOFTNESS` 0.05) and the same
   linear progress. Unit tests on both sides pin the values so drift breaks CI.
2. **No schema change, no migration.** The new kinds `wipe` and `slide` live
   only in the op-type unions (`AddTransitionOp` in editor-core, the Pydantic
   `Literal`s, the ai-sdk/MCP tool enums) and the transition effect's freeform
   params. `transition_overlap` validation is kind-agnostic and unchanged.
3. **Engine semantics for the new kinds:** `slide` reuses the geometry path
   (enter from below, mirroring push-from-right); `wipe` is a time-varying
   spatial alpha mask — a soft left→right reveal whose edge overshoots to
   `p * (1 + WIPE_SOFTNESS)` so the frame is fully revealed at progress 1. The
   compiler composes it as a vectorized per-column alpha row into the combined
   clip mask.
4. **WebCodecs canvas preview:** `clipCompositing` carries the incoming clip's
   parsed envelope; `drawSource` applies `globalAlpha` (fade/dissolve), extra
   scale (zoom), canvas-px offset (push/slide), `ctx.filter` blur, and a
   destination-out gradient band for wipe. Transitions never flip
   `canvasPreviewEligible` — the cheap identity path is preserved whenever no
   envelope is ramping.
5. **DOM `PreviewPlayer`:** the visible slot's style is derived per rendered
   frame from the same TS module — opacity multiplier, a
   `translate% → clip transform → scale` composition (percent translate equals
   frame fraction because the element fills the frame box), a `blur(px)`
   appended to the grade filter, and a `mask-image` linear-gradient that is
   the CSS analog of the engine's wipe band.
6. **Stills skip transitions in both previews** for export parity: the
   compiler defers transitions on image clips.

## Consequences

- Scrubbing/playing across a cut with any kind now shows the same envelope the
  export produces, on both preview paths (desktop-first: the WebCodecs canvas
  engine is the primary path).
- Two mirrored envelope implementations must stay in lockstep; the pinned
  constants and value tests are the guard. Any new kind must land in
  `render/transitions.py` first, then the TS mirror.
- `wipe`/`slide` are addable from the picker, the `add_transition` AI tool,
  and MCP; the `cut-and-transition-grammar` skill documents their vocabulary
  and duration taste.

## Alternatives considered

- _Rendering preview frames through the sidecar._ Rejected: seconds of latency
  per scrub position; the envelope mirror is ~100 lines of pure math.
- _A shared JSON "envelope spec" consumed by both languages._ Rejected as
  over-engineering for five constants and linear ramps; pinned unit tests give
  the same drift protection without a new artifact.
