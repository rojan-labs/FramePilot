# ADR 0006: Reversible operations via a single `restore_clips` inverse primitive

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Phase 1 timeline-engineer

## Context

Phase 1 (PLAN §1.2, PRD §8.4–8.5) requires every timeline operation to be
**reversible**: `invertOperation(timelineBefore, op)` must return operation(s)
that, applied after `op`, restore the prior timeline. This backs undo/redo
(PLAN §1.3) and the validator's "operation is reversible" check (PRD §8.5).

The operation vocabulary (PRD §8.3) is _additive and lossy_ by nature, and is
**not closed under inversion**:

- There is no `remove_clip`/`merge_clips` verb, so `add_clip`, `add_text_overlay`,
  `add_caption_layer`, and `split_clip` have no same-vocabulary inverse.
- `delete_range` and `ripple_delete` discard clip data (and shift neighbours), so
  reconstructing the prior state from forward verbs alone is lossy and complex.
- `apply_color_grade`, `add_keyframes`, `add_mask`, `track_object`, and
  `add_transition` mutate a clip's `effects`/`keyframes`; there is no "remove
  effect by identity" verb.

We needed reversibility without (a) bloating the op union with a mirror-image
inverse for every verb — multiplying the surface the validator, the Python
mirror, and the AI tool registry must support — or (b) snapshotting the entire
timeline per edit.

A key enabling observation: **every operation is confined to the clips of a
single track.** (Cross-track `move_clip` is the one exception and inverts to a
plain `move_clip` back.)

## Decision

We will add exactly **one internal inverse primitive**, `restore_clips
{ trackId, clips }`, which replaces a single track's clip list with a prior
snapshot. `invertOperation` produces:

- a same-shape inverse for the two operations that have an exact, compact one
  (`trim_clip` → `trim_clip`, `move_clip` → `move_clip`); and
- `restore_clips` (with the affected track's pre-image) for **every other
  operation**.

`restore_clips` is itself reversible (its inverse is another `restore_clips`),
and is a registered, validator-supported operation. The undo/redo stack
(`history.ts`) stores each forward patch **and** its inverse patch computed at
apply time against the pre-image, so undo applies the inverse and redo re-applies
the forward patch.

## Consequences

**Positive**

- Reversibility is **lossless and uniform** — effects, keyframes, source
  in/out points, and ordering are restored exactly, with no per-verb inverse
  logic to get subtly wrong.
- The op union grows by one, not by ~10 mirror verbs. The validator, the Python
  mirror, and (later) the AI tool registry each support one extra, simple op.
- The diff/review UI (PRD §3.2/§4.3) is unaffected: it renders before/after
  timelines (`diffTimeline`), not the inverse verbs.

**Negative / accepted costs**

- Undo-history entries for non-trim/move edits are **coarse** ("restore track
  X") rather than semantic ("removed clip Y"). Acceptable: the UI surfaces intent
  via the patch `reason` and the computed diff, not the inverse ops.
- An inverse `restore_clips` embeds a full track snapshot, so the persisted
  history can be larger than a minimal semantic inverse. Acceptable at Phase 1
  scale; revisit if history size becomes a problem (e.g. snapshot pruning).
- The inverse must be captured **at apply time** (it needs the pre-image), so
  `revertPatch` consumes a precomputed inverse rather than deriving it from the
  post-state. `history.commitPatch` enforces this.

## Alternatives Considered

- **A mirror inverse verb per operation** (`remove_clip`, `merge_clips`,
  `remove_effect`, …): rejected — multiplies the supported-op surface across
  validator/engine/AI-registry and concentrates fragile, lossy reconstruction
  logic in `delete_range`/`ripple_delete` inverses.
- **Whole-timeline snapshot per patch**: rejected — simplest but the least
  granular and the most storage-hungry; `restore_clips` gets the same losslessness
  scoped to the one track an op touches.
- **Command pattern with closures holding undo state**: rejected — undo data
  must be serialized into the project file's patch history (PRD §11.1); closures
  are not serializable.
