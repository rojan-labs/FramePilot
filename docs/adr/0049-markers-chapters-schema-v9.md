# ADR 0049 — Markers/chapters (schema v9)

- **Status:** Accepted
- **Date:** 2026-07-11
- **Builds on:** ADR 0026 (media-bin folders — the precedent for a
  project-scoped operation family living outside the timeline), ADR 0045–0048
  (caption style/speed/crop/blend-mode — the four prior H1.2 schema bumps).
- **Part of:** Horizon 1 (`plan/FRAMEPILOT-AI-PRODUCT-PLAN.md` C21, WS-C), H1.2
  — the last of five pre-authorized schema bumps (v5–v9).

## Context

The plan's capability table lists "markers/chapters" — named/unnamed points on
the timeline a user can jump to, snap to, or use to structure a long-form edit
into sections. Before this ADR, markers exist **only** as ephemeral,
non-persisted UI state: `apps/web-editor/src/editor/store.ts`'s
`EditorState.markers: readonly number[]` (bare numbers, no id/title/color), a
`toggleMarker(state, time)` function, and `toProject()` deliberately excludes
`markers` when building the `Project` sent through the patch engine. There is
no schema field and no editor-core operation — this is greenfield, unlike
caption style (v5) which migrated a rich preview-only UI.

## Decision 1 — one `Marker` shape, not two parallel concepts

**"Markers" and "chapters" are the same shape**, not two schemas: `{ id, time,
label?, color? }`. An unlabeled marker is exactly what pressing "M" at the
playhead produces today (minus persistence); filling in `label` (optionally
`color`, for a scrub-bar swatch) promotes the same object to a named "chapter"
point. This mirrors how `CaptionStyle` (ADR 0045) and `CropRect` (ADR 0047)
each earned one real field/shape rather than a family of variants — the task
instructions explicitly invited "two parallel concepts" as an option, but nothing
in the plan's capability table or in FramePilot's existing patterns
distinguishes a "chapter" from "a marker with a title" at the data-model level:
both are a single point in time, both render as a landmark on the scrub bar,
and both are useful for AI/keyboard-driven navigation regardless of whether
they carry a label. Two schemas would force every consumer (scrub-bar
renderer, "jump to next marker" navigation, an AI `add_chapter` tool) to
special-case which array to read, for zero behavioral gain. `color` is a free
CSS-color string (not an enum) — there is no existing app-wide marker/chapter
color-token convention to reuse (the `clip-video`/`clip-audio` tokens
`ui/tokens.css` mentions are clip-*kind* colors, an unrelated concept), and a
free string keeps this additive slice from having to also design and freeze a
palette.

### `Project.markers` — project-scoped, not per-track

```ts
export const MarkerSchema = z.object({
  id: z.string(),
  time: z.number().nonnegative(),
  label: z.string().min(1).optional(),
  color: z.string().min(1).optional(),
});

// on ProjectSchema:
markers: z.array(MarkerSchema).default([]);
```

Lives at `Project.markers`, sibling to `Project.transcript` — both are global
timeline positions/annotations, not an attribute of any one clip or track
(unlike `blendMode`/`crop`/`speed`, which are per-`Clip`). `time >= 0`; ids
unique (enforced by the validator, the same "structural invariant across the
whole array" split ADR 0026 already uses for duplicate asset/folder ids rather
than a Zod-level array refinement — Zod's per-element schema has no way to see
its siblings). Optional/absent-defaults-to-`[]` so v8 projects migrate cleanly
(a v8 project has no markers, which is exactly "none placed").

## Decision 2 — granular `add_marker`/`remove_marker`, not a whole-array replace

The natural unit of undo is what a user action actually does: pressing "M" at
the playhead adds **one** marker. A single `set_markers(markers: Marker[])`
replace-the-whole-array op (the `set_transcript` pattern) would make every
individual marker add/remove undo the *entire* current marker set back to
whatever it was before that one action — coarse, and inconsistent with how
every other single-entity add in this codebase works (`add_asset`/
`create_folder` are also one-entity, granular ops with a same-shape or
symmetric inverse, not whole-list replaces). So markers get the **granular
pair**, mirroring `add_asset`/`remove_asset`'s reversibility design exactly:

```ts
interface AddMarkerOp {
  type: 'add_marker';
  id: string;
  time: number;
  label?: string;
  color?: string;
}

interface RemoveMarkerOp {
  type: 'remove_marker';
  id: string;
}
```

Flat fields (not a nested `marker: Marker` object) because a marker is
authored field-by-field at the moment it's created (an id FramePilot mints +
the current playhead time), unlike `add_asset`'s `asset: Asset`, which is
typically assembled elsewhere (import/derive pipeline) before the op is built
— flat fields keep `add_marker(id, time, label?, color?)` a natural one-line
AI-tool/keyboard-shortcut call, matching `create_folder`'s flat
`folderId`/`name`/`parentId` shape rather than `add_asset`'s nested one.

### Reversibility: real inverses, not a snapshot-restore primitive

- `add_marker`'s inverse is `remove_marker` with the same id — a brand-new
  marker has nothing else referencing it (unlike, say, `delete_folder`, which
  reparents children), so removing it is an exact, lossless inverse. No
  `restore_markers` primitive is needed for this direction.
- `remove_marker`'s inverse is `add_marker` carrying the **removed marker's
  own snapshotted fields** (`id`/`time`/`label`/`color`), re-adding it exactly
  as it was — not a whole-array `restore_markers`. This is the one place this
  ADR's design deliberately diverges from `remove_asset`
  (whose inverse *is* `restore_assets`, the whole-list snapshot): `remove_asset`
  restores via the full list because assets are also addressed by
  cross-references from clips and folders that a partial re-insert could
  subtly reorder relative to *other* concurrent mutations in a wider patch;
  markers have no downstream reference at all (nothing else in the schema
  points at a `Marker.id`), so `remove_marker`'s inverse only needs to restore
  the one row it deleted, and staying single-op keeps a plain
  add-then-remove-then-undo history readable as two matched ops instead of
  introducing a fourth op type.
  **Caveat (documented, not fixed):** because `add_marker` always *appends*,
  re-adding a removed marker lands at the **end** of `Project.markers` rather
  than at its original array index if other markers exist on both sides of it.
  This is intentionally not treated as a defect: markers have no order
  semantic in the schema (order is not currently significant to any consumer —
  the UI is expected to sort markers by `time` for display, not array
  position, exactly like clips are ordered by `start` within a track, not
  array index). `packages/editor-core/src/project-operations.test.ts` proves
  the roundtrip is exact **as a set** and separately proves exact-order
  roundtrip for the common "delete the last one" case.

No `rename_marker`/`set_marker_label` op ships in this slice — over-building
beyond the stated acceptance bar ("markers/chapters exist and persist"). If a
later UI wants to promote a marker to a chapter by editing its label after
creation (rather than at creation time), that is a small, separately-reviewed
follow-up (`remove_marker` + `add_marker` with the new label already composes
it losslessly today, at the cost of a two-op patch instead of one).

### Validator

New `ValidationCode`s: `duplicate_marker`, `missing_marker`,
`invalid_marker_time`. `add_marker` is rejected when its id already exists in
the working marker set or when `time` is negative/non-finite; `remove_marker`
is rejected when its id is unknown. Like every other project-op reference
check (`assetIds`/`folders` in `ValidateOptions`), a new `markers` option gates
these — omitted context means "can't prove it, don't block it," the same
stance `add_clip`'s asset check already takes. `add_marker`/`remove_marker`
are registered in `PROJECT_OPERATION_TYPES`; project-scoped ops don't go
through `SUPPORTED_OPERATIONS` (that set is for timeline ops only — the
validator dispatches project ops to `projectChecks` before ever consulting it).

### Migration: v8 → v9

Purely additive, like every prior step: a v8 project has no `markers`, which
*is* `[]` (no markers placed), so `migrate: (raw) => raw` — the step exists
only to stamp the new envelope version.

## Consequences

- Schema bumps to **v9**; `schema/project.schema.json` is regenerated from the
  Zod source (`pnpm --filter @framepilot/timeline-schema build && pnpm
  --filter @framepilot/timeline-schema schema:generate`).
- `packages/editor-core` gains `add_marker`/`remove_marker` (apply/invert/
  validate, 100% branch/line/func coverage on `project-operations.ts` and
  `validator.ts`).
- The web-editor's `PLACEHOLDER_META` object in `store.ts` (the Project view
  the patch engine's project-op tests build) gained the now-required
  `markers: []` field so the package still typechecks — a purely mechanical
  fix to a pre-existing placeholder-metadata object (it already stubs
  `transcript`/`aiMemory`/`history` the same way), **not** a wiring of the
  markers feature into the store; `toggleMarker`, the ephemeral
  `EditorState.markers: readonly number[]`, and `TimelineView.tsx`'s marker
  ticks are untouched.
- **Python engine, AI tool registry, and UI wiring are explicitly out of scope
  for this commit** — this is a schema + patch-engine-only slice (build
  order: engine before AI/UI; per this task's explicit instruction not to
  touch the Python engine or the UI's marker/store code). Until the Python
  `Project` Pydantic model gains a matching `markers: list[Marker]` field,
  `engine/python/tests/test_schema_parity.py` will report a field mismatch on
  `Project` — a known, tracked gap for the follow-up that ports
  `add_marker`/`remove_marker` to `engine/python/.../timeline/operations.py`,
  mirrors the Pydantic model, and only then wires the web editor's
  `store.ts`/`toggleMarker`/`TimelineView.tsx` to actually persist markers
  through the validate→apply→record pipeline instead of local component
  state — exactly like ADR 0046/0047/0048's original scope notes tracked
  their own engine-mirror follow-ups.

## Follow-up closed (2026-07-11)

Both tracked gaps above are closed. **Python parity:** `engine/python/.../timeline/models.py`
gained a `Marker` Pydantic model + `Project.markers: list[Marker]`; `SCHEMA_VERSION`
bumped 8→9; `test_schema_parity.py` green. **UI wiring:** `EditorState.markers` is now
`readonly Marker[]` sourced from (and lifted back into) `Project.markers` — `toProject`/
`applyUserPatch`/`undoEdit`/`redoEdit` all carry it, exactly like `assets`/`folders`.
The "M" toggle (`Toolbar.tsx`, `shortcuts.ts` — unchanged call sites) now resolves through
a new `patch-builders.ts#toggleMarkerPatch` (`findNearbyMarker` within the same epsilon the
old local-only toggle used, then `addMarkerPatch`/`removeMarkerPatch`) instead of
`store.ts`'s old local `toggleMarker`, which is deleted. New marker ids are minted with
`nextMarkerId()` (`marker_<Date.now().toString(36)>_<counter>`), mirroring `MediaBin.tsx`'s
`nextFolderId` convention exactly (not a UUID) — consistent with `createFolderPatch`'s
caller-supplied-id shape. `TimelineView.tsx`'s marker ticks now read the real `Marker[]`
(id-keyed, not value-keyed), show a labeled marker's title as a native tooltip, and tint
by `color` when set; `snapTargets`/`adjacentMarker` keep their existing `number[]`
signatures, fed `markers.map(m => m.time)` at the two call sites. **Deferred, not silent:**
a click-to-rename affordance (promoting a marker to a titled chapter after creation) is
real UI work beyond this slice's acceptance bar ("markers/chapters persist and appear on
the timeline") — `removeMarkerPatch` + `addMarkerPatch` with a label already composes a
rename losslessly today at the cost of two ops instead of one, same as this ADR's original
note. Auto-chapter generation from the transcript is a separate AI-tool concern, untouched.
