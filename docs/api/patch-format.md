# Patch Format & Operations

A **patch** is the unit of change in FramePilot — the unit of review _and_ the unit of
undo. Both manual edits and AI edits produce patches; nothing mutates the project
document any other way (PRD §8.4). This is the contract that makes every edit reviewable
and reversible.

Background: [../architecture/timeline-and-patch-engine.md](../architecture/timeline-and-patch-engine.md).
Data model referenced below: [timeline-schema.md](timeline-schema.md).

---

## Patch envelope

```json
{
  "patchId": "patch_123",
  "createdBy": "agent",
  "reason": "Improve intro pacing",
  "operations": [{ "type": "delete_range", "trackId": "video_1", "start": 0, "end": 3.2 }]
}
```

| Field        | Type        | Notes                                                                              |
| ------------ | ----------- | ---------------------------------------------------------------------------------- |
| `patchId`    | string      | Unique id.                                                                         |
| `createdBy`  | string      | `"user"` or `"agent"` (optionally the specific tool/agent) — auditable provenance. |
| `reason`     | string      | Human-readable justification, shown in the review UI ("why it changed").           |
| `operations` | Operation[] | One or more typed operations, applied **transactionally** (all-or-nothing).        |

---

## Lifecycle

```
proposed → validated → previewed → applied → reverted
                                          └→ failed   (validation or apply error)
```

See the patch-engine doc for the full state machine. Apply is transactional; a failure
leaves the timeline untouched.

---

## Validation rules (PRD §8.5)

Every patch must pass before it can be applied:

- references exist · no negative duration · valid layer order · no missing asset ·
  supported effect · no broken audio link · no overlap error · engine supports the op ·
  op is reversible.

Validation errors are typed and actionable (not booleans). The validator is held to 100%
coverage.

---

## Operation types

Each operation has a `type` and operation-specific fields. Every write operation has a
pure `apply` and an `invert` (for undo). Examples below.

### `trim_clip`

```json
{ "type": "trim_clip", "clipId": "clip_001", "start": 4.2, "end": 26.8 }
```

Adjusts a clip's in/out without touching source media (non-destructive).

### `set_clip_source_range`

```json
{
  "type": "set_clip_source_range",
  "clipId": "clip_001",
  "sourceStart": 6.2,
  "sourceEnd": 28.8
}
```

Changes which source frames play inside the clip while preserving its sequence start/end. The
source span must still match the clip's timeline duration at its configured speed. This is the
low-level reversible primitive used by a professional slip command; AI tools do not calculate the
range directly.

### `set_clip_media`

```json
{
  "type": "set_clip_media",
  "clipId": "clip_001",
  "assetId": "asset_replacement",
  "sourceStart": 8,
  "sourceEnd": 18
}
```

Replaces the footage used by an existing clip while preserving its identity, timeline position,
effects, keyframes, masks, crop, and speed configuration. The new source span must imply the same
timeline duration at the existing speed. This is the reversible primitive used by replace edits.

### `split_clip`

```json
{ "type": "split_clip", "clipId": "clip_001", "at": 12.5 }
```

Splits one clip into two at timeline time `at`.

### `delete_range`

```json
{ "type": "delete_range", "trackId": "video_1", "start": 0, "end": 3.2 }
```

Removes a time range on a track, leaving a gap (no ripple).

### `move_clip`

```json
{ "type": "move_clip", "clipId": "clip_001", "toTrackId": "video_2", "toStart": 8.0 }
```

Moves a clip to a new track and/or start time.

### `ripple_delete`

```json
{ "type": "ripple_delete", "trackId": "video_1", "start": 5.0, "end": 7.0 }
```

Deletes a range and shifts later clips left to close the gap.

### `add_clip`

```json
{
  "type": "add_clip",
  "trackId": "video_1",
  "assetId": "asset_002",
  "start": 12.5,
  "sourceStart": 0,
  "sourceEnd": 6.0
}
```

Adds a new clip referencing an existing asset.

### `add_text_overlay`

```json
{
  "type": "add_text_overlay",
  "trackId": "overlay_1",
  "text": "Launch faster",
  "start": 3.4,
  "end": 6.2
}
```

Adds a text overlay clip (style/position params optional).

### `add_caption_layer`

```json
{
  "type": "add_caption_layer",
  "trackId": "caption_1",
  "captions": [{ "text": "saves 3 hours", "start": 14.0, "end": 16.1, "highlight": ["3 hours"] }]
}
```

Adds caption clips (typically from word-level transcript timestamps).

### `add_keyframes`

```json
{
  "type": "add_keyframes",
  "clipId": "clip_001",
  "param": "scale",
  "keyframes": [
    { "time": 14.0, "value": 1.0, "easing": "ease-in" },
    { "time": 14.6, "value": 1.2, "easing": "ease-out" }
  ]
}
```

Adds animation keyframes (e.g. a punch-in zoom).

### `remove_keyframes`

```json
{
  "type": "remove_keyframes",
  "clipId": "clip_001",
  "targets": [{ "property": "scale", "time": 14.6 }, { "property": "opacity" }]
}
```

Removes keyframes from a clip. Each target names a `property` and, optionally, a
`time`; **a target with no `time` clears that property's animation entirely.**

Keyframes are matched by **property + time (±1ms — the same epsilon
`add_keyframes`' `replace` uses)**, not by `id`. Ids are generated by whichever
producer built the keyframe and are not a stable handle, whereas property-and-time is
what a user is pointing at when they click a diamond.

A removal that matches nothing returns the timeline unchanged. Composed with
`add_keyframes` in the **same patch**, this is how a keyframe _moves_ — a move is a
delete at the old time plus an add at the new — so a drag stays one undo step.

### `apply_color_grade`

```json
{
  "type": "apply_color_grade",
  "clipId": "clip_001",
  "params": { "exposure": 0.1, "contrast": 0.05, "temperature": -10 }
}
```

Applies a color-grade effect (MVP params per PRD §6.7).

### `adjust_audio`

```json
{
  "type": "adjust_audio",
  "clipId": "audio_1_clip_3",
  "params": { "volume": 0.8, "fadeIn": 0.5, "fadeOut": 0.5 }
}
```

Adjusts volume/fades/ducking on an audio clip.

### `add_transition`

```json
{
  "type": "add_transition",
  "trackId": "video_1",
  "betweenClips": ["clip_001", "clip_002"],
  "kind": "cross_dissolve",
  "duration": 0.5
}
```

Adds a transition between adjacent clips (`cut`, `fade`, `cross_dissolve`, `push`, `zoom`,
`blur`).

### `add_mask`

```json
{
  "type": "add_mask",
  "clipId": "clip_001",
  "mask": { "kind": "ellipse", "feather": 8, "opacity": 1, "keyframes": [] }
}
```

Adds a mask (`rectangle` | `ellipse` | `polygon` | `subject`) — used for blur, text-behind-object, etc.

### `track_object`

```json
{
  "type": "track_object",
  "clipId": "clip_001",
  "target": { "kind": "face", "bbox": [820, 240, 180, 220] }
}
```

Attaches an object/face track (produces a tracked path other ops can bind to: tracked
text, callouts, blur). Tracking carries a confidence score and supports manual correction.

---

## Notes

- New operations follow the recipe in
  [../guides/adding-a-timeline-operation.md](../guides/adding-a-timeline-operation.md):
  schema → `apply` + `invert` → validator rule → 100% tests → expose as AI tool if needed
  → update these docs and the plan.
- AI tools that write must return these operations inside a patch — they never mutate the
  project directly ([ai-tools.md](ai-tools.md)).
