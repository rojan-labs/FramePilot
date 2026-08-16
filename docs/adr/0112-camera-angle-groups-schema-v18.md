# 0112. Camera angle groups are authored, and membership is derived

- Status: Accepted
- Date: 2026-08-12

## Context

Multicam was the largest professional capability FramePilot advertised nowhere. The
timeline controller already accepted a `cameraAngleId`, but rejected it outright with
`unsupported_multicam`, because nothing in the project schema could prove that two
assets recorded the same moment.

Cutting between cameras is not a media swap. "Switch to the tight camera here" means
_keep showing this instant, from a different lens_. Two cameras almost never start
rolling together, so the same instant sits at a different timestamp in each recording.
Without a per-camera offset, the only available implementation would reuse the current
source position — which produces a frame that is entirely plausible and simply wrong,
by however far apart the cameras started. Nothing about the result looks broken.

Two things therefore had to be decided: where the sync relationship lives, and how a
clip knows which camera it is currently showing.

## Decision

Add optional project-scoped `angleGroups` in schema v18, mirrored in the Python
Pydantic model, with a deliberately no-op migration.

```text
Project.angleGroups: [{ id, name?, angles: [{ id, name?, assetId, syncOffsetSeconds? }] }]

groupTime  = sourceTime - angle.syncOffsetSeconds
sourceTime = groupTime  + angle.syncOffsetSeconds
```

1. **Groups are project-scoped**, like markers. A group describes the footage, not any
   one clip or track, and must outlive every arrangement built from it.
2. **Membership is derived, never stored.** A clip shows the angle whose `assetId` it
   plays. A per-clip angle field would be a second copy of the same fact and could drift
   out of agreement with the media actually being rendered. The cost is that an asset
   must belong to at most one group; a clip whose asset is claimed by two groups is
   refused rather than resolved by picking one.
3. **Sync offsets are authored, and absent is not zero.** They come from the editor or an
   explicit instruction. Nothing derives them from waveform correlation, embedded
   timecode, file creation times, or folder layout. `syncOffsetSeconds` is optional
   rather than defaulting to `0`, because zero is not a neutral value — it is the claim
   "these cameras started together". An unsynced angle is refused with the missing offset
   named as the fix.
4. **Nothing is back-filled.** The v17 → v18 migration groups nothing. Two files in one
   folder with adjacent names and near-identical durations look exactly like an A/B
   shoot and are not evidence of one.
5. **The switch is picture-only.** It cuts at the playhead, splits the clip when the cut
   lands inside it, and retargets only the downstream half through
   `split_clip` + `set_clip_media` — primitives that already existed for replace edits.
   Sound is untouched: a camera change that also re-cut the audio would put an audible
   jump in room tone at every switch. Because no edit point moves in time, nothing goes
   out of A/V sync.

Retimed clips are refused: a speed change maps sequence time to source time
non-linearly, so the single-offset arithmetic above would land on the wrong frame.

## Consequences

Multicam becomes a first-class command (`switch_angle_edit`) with a deterministic
compiler, an exact inverse, a capability row, and an outcome eval — reachable from
ordinary language without the model naming a clip, an asset, or a source position.

The deliberate gap is automatic sync. Until offsets are authored, every switch fails
closed. That is the intended trade: a request to sync the cameras is recoverable, a
confident cut to the wrong moment is not, and it is invisible in the timeline.

What deterministic evidence can and cannot judge is drawn tightly. The reviewer checks
the new cut boundary for black and flash frames, which is the failure the compiler
cannot rule out (the incoming camera decoding to nothing at that source position).
Whether the switch landed on the same _moment_ is a semantic judgment that belongs to
vision review; it is not asserted from pixels here. The render-backed fixture in
`engine/python/tests/test_professional_objective_fixtures.py` proves the mapping the
only way pixels can: the second camera's content encodes when you are in its recording,
so the correct instant and the un-offset one are different colours.
