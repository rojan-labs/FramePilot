# ADR 0039 — Editable Text Overlays via an Open-Param `set_effect_params` Op

- **Status:** Accepted
- **Date:** 2026-07-07

## Context

Text overlays existed only as a create-and-delete affordance: the Overlays panel
built an `add_text_overlay` patch, and "editing" text was a combined delete+add
(one undo). There was no way to style a text overlay (colour, font, size,
alignment, position, in/out animation), to edit it on the canvas, or to change
its text in place. Delivering a full text-overlay experience raised two design
questions:

1. **Where do styling values live?** A migration to add typed style fields to the
   text effect would be a schema change (migration + docs + tests + sign-off).
2. **How is an in-place edit expressed reversibly?** Every edit must be a typed,
   invertible timeline operation (AGENTS.md invariant 5) — delete+add is lossy
   and coarse.

## Decisions

### 1. Styling lives in the effect's open `params` bag — no schema migration

`EffectSchema.params` is already an open `z.record(z.string(), z.unknown())`.
Text styling (`color`, `fontFamily`, `fontWeight`, `fontSizePercent`, `align`,
`boxWidthPercent`, `xPercent`, `yPercent`, `background`, `inAnimation`,
`outAnimation`, `animDurationSeconds`) is stored there. This is schema-valid,
serializable, and reversible today with **no migration**. Sizes and positions are
percent-based (font size as a fraction of frame height, expressed in `cqh`) so an
overlay holds its look across orientation changes. `readTextParams` reads the bag
with defaults, so existing overlays render correctly without any stored style.

### 2. A new reversible `set_effect_params` engine operation

Rather than delete+add, a new `set_effect_params { clipId, effectId, params }`
operation shallow-merges params into an existing effect (a key set to `undefined`
clears it), preserving id/type/keyframes. Its inverse is the standard
track-snapshot restore used by `apply_color_grade` et al. It is generic (works
for any effect), so both text content edits and style edits — from the Inspector
**and** the on-canvas editor — flow through one validated, undoable path. 100%
apply/invert/validator coverage retained.

### 3. Preview renders styling; render-engine wiring is deferred

The program monitor draws overlays with their real params, and computes in/out
animations from the playhead (a pure `textOverlayStyle`), so they are
scrub-accurate. The Python render pass consuming these params is a follow-up; the
preview is the faithful approximation, and nothing is silently faked.

### 4. Program-monitor object selection is isolated from background selection

The WebCodecs monitor keeps ordinary text in the canvas compositor, but temporarily
represents the active selected text clip with the shared DOM editor. This avoids doubled
glyphs while making timeline selection visible and preserving the same reversible
move/resize/edit path as direct manipulation.

A single click over the monitor resolves to the background picture. Double-click selects
the topmost active text object under the pointer; Enter or Space is the accessible direct
selection equivalent. Selection chrome is neutral white with a dark contrast edge so it
does not borrow semantic accent colour and stays visible over arbitrary footage.

## Consequences

- Text overlays are fully editable (drag-to-timeline, on-canvas move/resize/edit,
  full Inspector) with no schema version bump.
- Timeline and preview selection stay visually synchronized; overlapping text objects are
  isolated in visual stacking order without changing rendered output.
- `set_effect_params` is available to any future effect-params editing (not just
  text), and to the AI tool layer if wired later.
- The only debt is the deferred render-engine mapping of the new style params.
