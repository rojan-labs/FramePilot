# ADR 0032 — Type-agnostic timeline layers + render order (Phase 2)

- **Status:** Accepted — **fully implemented** (milestones M1–M7 landed; see
  `plan/PHASE2-type-agnostic-layers.md`)
- **Date:** 2026-06-28 (implemented through 2026-06-29)
- **Builds on:** ADR 0001 (reversible operations), ADR 0031 (track flags, schema v4).

## Context

The timeline modelled four **typed** tracks (video / audio / caption / overlay) with
fixed roles: the validator forced text overlays onto an `overlay` track and captions
onto a `caption` track, the renderer only composited `video`/`audio` tracks (captions
special-cased), and the preview/UI branched on `track.type`. Users want a CapCut-style
model instead:

1. A **single, generic timeline** — layers are not typed.
2. Adding a **different-kind** clip creates a **new layer on top**.
3. **Overlapping** same-kind clips is allowed, but the overlap goes to a **new layer on
   top** (never an overlap within one layer).
4. **Render order is hierarchical with array index 0 in front** (composite first→last).

## Decision

- **A layer is a `Track`.** We keep the `Track` type name (to limit churn) and read it as
  "layer". `Track.type` is **retained but downgraded to an advisory role** — the default
  icon/label and the kind used by auto-layering — and is **no longer a content
  constraint**. Any clip kind may live on any layer. This avoids a disruptive removal of
  `type` and keeps the schema shape stable (**`SCHEMA_VERSION` stays 4**).
- **Clip kind is derived, not stored** — from the clip's asset `kind`
  (`video`/`audio`/`image`) or its synthetic asset id (`__text__`/`__caption__`). One pure
  helper per language routes all behavior; **no `kind` field is added to `Clip`**.
- **Index 0 = visual front.** The render compiler composites so the last array element is
  at the back and index 0 is on top (reversing MoviePy's default last-on-top). This is a
  _behavior_ change handled by re-rendering + golden-test updates, not a data migration.
- **New reversible operations:** `add_layer` and `remove_layer` (a lossless inverse pair —
  removing a non-empty layer inverts to an `add_layer` that restores its type, z-order
  index, and clips), and later `move_layer` (z-order reorder). Layers are an ordered list
  already, so no schema migration is required for them.
- **Auto-layering:** adding/dropping a clip whose kind differs from the target layer's
  content, or that would overlap an existing clip, **inserts a new layer at index 0** and
  places the clip there — so an overlap is never created on a single layer.

## Consequences

- Phased rollout (M1–M7) tracked in `plan/PHASE2-type-agnostic-layers.md`; each milestone
  is a separate, green, reviewable change. **M1** (the `add_layer`/`remove_layer`
  foundation + an "Add layer" UI control) has landed.
- The render-order flip (M3) changes existing renders and **must** ship with golden
  updates. It is semantically linked to auto-layering (M5): land them close together so the
  editor's "index 0 = top" matches the render.
- Validator relaxation (M4) removes the overlay/caption track-type constraints while
  keeping per-layer overlap and audio-link checks.
- The AI/MCP surface (M7) must describe layers generically (content + z-order) and place
  clips through the same auto-layering path.
- Deferred option: fully removing `Track.type` (a future schema v5 migration) — only if a
  later revision of this ADR decides the advisory field should go.
