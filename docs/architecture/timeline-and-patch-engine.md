# Timeline & Patch Engine

This is the **heart of FramePilot**. Everything else — manual editing, AI editing,
undo/redo, review, rendering — is built on top of it. It is deliberately built **before
the AI layer** (Phase 1, see [`../../plan/PLAN.md`](../../plan/PLAN.md) and
[ADR 0004](../adr/0004-timeline-patch-engine-before-ai.md)).

**Why:** the "Cursor for video" experience is only reliable if every edit — whether a
human dragged a clip edge or an AI proposed a 6-step plan — is a **concrete, reviewable,
reversible** operation. If AI could mutate the project freely, edits could not be
validated, diffed, previewed, or undone. So we make the _editing primitives_ trustworthy
first, then let AI use the exact same primitives.

Code lives in `packages/editor-core` (engine), `packages/timeline-schema` and
`packages/shared-types` (types).

---

## 1. Data model (PRD §11)

The full schema with JSON examples lives in
[../api/timeline-schema.md](../api/timeline-schema.md). Summary:

- **Project** `{ id, name, version, fps, resolution{width,height}, assets[], timeline,
transcript[], aiMemory, history[] }`
- **Timeline** `{ tracks: [{ id, type, clips[] }] }` — track `type` is one of
  `video | audio | caption | overlay`.
- **Clip** `{ id, assetId, trackId, start, end, sourceStart, sourceEnd, effects[],
keyframes[] }` — `start/end` are timeline-time; `sourceStart/sourceEnd` are media-time
  (this is how non-destructive trimming works).
- **Effect** `{ id, type, params, keyframes[] }`.
- **Keyframe** — time + value + easing, attached to a clip or effect.

The schema is mirrored in TypeScript (Zod) and Python (Pydantic), kept in sync via a
shared JSON Schema, so the same project document round-trips through the editor and the
render engine identically.

---

## 2. Typed operations

Every edit is one of a closed, typed set of **operations**. The UI and the AI both emit
these — there is no other way to change the timeline.

```
trim_clip · set_clip_source_range · set_clip_media · split_clip · delete_range · move_clip · ripple_delete · add_clip
add_text_overlay · add_caption_layer · add_keyframes · remove_keyframes
apply_color_grade · adjust_audio · add_transition · add_mask · track_object
```

Each operation is implemented as **two pure functions**:

```ts
// apply: deterministic, immutable — returns a new timeline, never mutates input
apply(timeline: Timeline, op: Operation): Timeline

// invert: returns the operation(s) that undo `op` given the prior timeline
invert(timeline: Timeline, op: Operation): Operation[]
```

Purity is non-negotiable: it makes operations testable, diffable, and trivially
reversible. Helpers handle snapping, ripple shifting, and overlap resolution.

Professional commands compile into this smaller primitive vocabulary. In particular, a slip edit
uses `set_clip_source_range`: modeling it as two trims would move sequence boundaries and violate
the editor command's promise even if the final duration happened to match.
Likewise, a replace edit uses `set_clip_media` instead of delete-plus-add, because clip identity and
attached editorial state are part of the edit and must survive a footage replacement.

Per-operation JSON examples are in [../api/patch-format.md](../api/patch-format.md).

---

## 3. Patch format & lifecycle (PRD §8.4)

Operations are never applied one at a time by callers; they are grouped into a **patch**
— the unit of review and the unit of undo.

```json
{
  "patchId": "patch_123",
  "createdBy": "agent",
  "reason": "Improve intro pacing",
  "operations": [{ "type": "delete_range", "trackId": "video_1", "start": 0, "end": 3.2 }]
}
```

- `createdBy` — `"user"` or `"agent"` (and optionally which agent/tool), so the history
  is auditable.
- `reason` — human-readable justification, surfaced in the review UI ("why it changed").

### Lifecycle state machine

```
proposed ──► validated ──► previewed ──► applied ──► reverted
    │            │             │            │
    └────────────┴─────────────┴────────────┴──► failed
```

- **proposed** — created by UI or an AI tool.
- **validated** — passed every validator check (§4).
- **previewed** — a preview render was produced (optional for trivial edits).
- **applied** — committed transactionally (all-or-nothing) to the timeline; inverse ops
  pushed to the undo stack; patch recorded in `project.history`.
- **reverted** — undone via its inverse operations.
- **failed** — validation or apply failed; the timeline is left untouched.

Applying a patch is **transactional**: if any operation fails, none are applied.

---

## 4. Patch validator (PRD §8.5)

Before a patch can be applied it must pass every check. The validator returns typed,
actionable errors (never a bare boolean):

- timeline **references exist** (track/clip/asset ids resolve)
- **no negative duration** (and `start < end`)
- **valid layer order** (e.g. text-behind-object compositing remains coherent)
- **no missing asset**
- **supported effect** only
- **no broken audio link**
- **no overlap error**
- **render engine supports the operation**
- **operation is reversible** (an `invert` exists)

The validator is held to **100% test coverage** — it is the safety gate for both manual
and AI edits. See [../guides/writing-tests.md](../guides/writing-tests.md).

---

## 5. Undo/redo via inverse operations

Undo/redo is _not_ implemented by snapshotting whole timelines. Instead, when a patch is
applied, its `invert(...)` result is pushed onto an undo stack. Undo applies the inverse
patch; redo re-applies the original. This is:

- **cheap** (no full-document copies),
- **exact** (inverses are derived from the prior state, so they restore it precisely),
- **uniform** (the same mechanism powers manual undo, AI patch revert, and crash
  recovery).

Concretely, `trim_clip`/`move_clip` invert to a compact same-shape op; every other
operation inverts to the internal `restore_clips { trackId, clips }` primitive — a
lossless snapshot of the _one track_ the operation touches (never the whole timeline).
The rationale and trade-offs are in
[ADR 0006](../adr/0006-reversible-operations-via-restore-clips.md). Implementation:
`packages/editor-core/src/{operations,patch,history}.ts`.

The undo/redo history is persisted in `project.history` so it survives save/load and
contributes to crash recovery (see [desktop-shell.md](desktop-shell.md)).

---

## 6. Diffing

For the review UI, the engine computes a **before/after diff** of the timeline given a
patch. The diff answers "what changed" at the level of tracks, clips, ranges, and
effects, and is paired with the patch's `reason` ("why") and a before/after preview. This
is what makes an AI edit reviewable rather than a black box (PRD §3.2). The diff UI lives
in the frontend; the diff _computation_ lives in `editor-core` so it is testable without
a UI.

---

## 7. Relationship to the rest of the system

- The **AI engine** ([ai-engine.md](ai-engine.md)) produces patches _through tools_; it
  never bypasses this engine.
- The **render engine** ([render-engine.md](render-engine.md)) consumes the _applied_
  timeline to produce previews and exports.
- Adding a new operation is a well-defined recipe — see
  [../guides/adding-a-timeline-operation.md](../guides/adding-a-timeline-operation.md)
  and the `timeline-editing` skill (`.agents/skills/timeline-editing/`).
