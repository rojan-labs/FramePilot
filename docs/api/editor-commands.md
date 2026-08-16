# Professional editor commands

`EditorCommand` is the semantic boundary between an editor's intent and FramePilot's primitive
timeline operations. A command says **what edit to perform**; the deterministic compiler owns the
coupled trims/moves, operation order, source-handle checks, validation, and undo patch.

## Authority and time

Every command carries the `timelineRevision` at which its targets were resolved. Compilation fails
with `stale_timeline` if the timeline has changed. All deltas are integer frames paired with an
explicit rational frame rate:

```ts
interface FrameDelta<Domain extends 'sequence' | 'source'> {
  domain: Domain;
  frames: number;
  rate: { numerator: number; denominator: number };
}
```

Sequence commands must use the authoritative sequence rate supplied separately by the host. Source
commands carry the source-media rate, so a 24 fps source slip is not silently interpreted using a
29.97 fps sequence.

## Compiler outcome

`compileEditorCommand` is pure and returns one of:

- `compiled`: a validated forward patch, its inverse patch, and deterministic compiler facts.
- `rejected`: a typed code, editor-readable detail, and any relevant facts.

The compiler currently supports:

| Command             | Preserves                               | Primitive choreography                                              |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `roll_edit`         | Total sequence duration                 | Shrink-first paired `trim_clip` operations                          |
| `slip_edit`         | Clip sequence start/end                 | One `set_clip_source_range` operation                               |
| `slide_edit`        | Selected clip duration and source range | Neighbour trim → move → neighbour trim, ordered by direction        |
| `ripple_trim_edit`  | Gapless downstream sequence             | Direction-aware ripple delete or back-to-front moves plus trim      |
| `lift_edit`         | Other clips' sequence positions         | Back-to-front `delete_range` operations                             |
| `extract_edit`      | Gapless sequence after removal          | Back-to-front `ripple_delete` operations                            |
| `insert_edit`       | Existing footage and inserted range     | Split, back-to-front moves, then `add_clip`                         |
| `overwrite_edit`    | Downstream sequence positions           | Destination `delete_range`, then `add_clip`                         |
| `replace_edit`      | Clip identity and attached edit state   | One duration-preserving `set_clip_media` operation                  |
| `j_cut_edit`        | Picture cut and total sequence duration | Lead incoming audio via shrink-first paired trims                   |
| `l_cut_edit`        | Picture cut and total sequence duration | Trail outgoing audio via shrink-first paired trims                  |
| `switch_angle_edit` | Sequence placement, duration, and sound | Split at the playhead, then `set_clip_media` on the downstream half |

Rejections cover stale authority, invalid/zero frame deltas, missing or locked clips, different or
non-adjacent tracks, one-frame minimums, missing media duration, insufficient source handles,
unsupported retimed boundaries, and final patch validation failures. Boundary-changing commands
currently reject retimed neighbours until handle arithmetic can integrate their speed curves; this
is intentional fail-closed behavior, not a silent 1x assumption.

Insert and overwrite consume an explicit source-frame range and a sequence-frame destination.
Insert can land inside an existing clip: the compiler splits at the edit point before moving the
right-hand piece and downstream clips. Replace takes a source in-point and derives the required
source span from the existing clip, preserving its speed curve and all attached edit state.

J/L commands name both sides of the video cut and both sides of the audio cut. The compiler proves
the pairs share source assets, live on the correct track kinds, and begin at one aligned butt cut
before moving only the audio boundary. Their delta is always a positive magnitude: `j_cut_edit`
makes incoming sound lead picture; `l_cut_edit` lets outgoing sound trail picture. This makes
direction semantic instead of relying on the model to choose a sign.

The first public domain surface is `professional_edit`. It exposes roll, slip, ripple trim, slide,
lift, extract, insert, overwrite, replace, J-cut, L-cut, and camera switch as editorial
intents—not primitive operation arrays.
It requires a live interaction snapshot, resolves the requested clip, track, edit point, playhead,
and source state through trusted context, and only then calls `compileEditorCommand`. Missing,
stale, ambiguous, or inconsistent context emits no operations. The tool is currently host-UI-only
because MCP does not yet transport an editor interaction snapshot.

J/L cuts are exposed through the same surface. Their `linked_edit_point` target pairs one video and
one audio boundary only when they share cut time and both outgoing/incoming asset ids. Multiple
valid pairs are ambiguous; coincident but unlinked cuts are unresolved. The model supplies only a
positive frame magnitude and the J/L semantic direction.

`EditorInteractionContext` v2 supplies the source side of that boundary. Its `sourceMonitor` record
contains an asset id, rational monitor `rate`, frame-accurate playhead, and optional marked frame
range. The rate describes the monitor's source editing timebase; callers must not infer it from the
sequence. Invalid clocks or out-of-duration marks are rejected while capturing or parsing context.
Insert and overwrite require source marks and exactly one selected destination track. Replace uses
the source playhead and one selected timeline clip. Slip additionally proves the source monitor
asset matches the selected clip asset.

## Timeline controller

`resolveTimelineObjective` is the orchestration boundary above the command compiler. It accepts a
validated `TimelineEditObjective` plus the authoritative project and `EditorInteractionContext`,
then returns either:

- `resolved`: one or more `EditorCommand` values, target-evidence kinds, and controller facts; or
- `rejected`: a typed controller code, detail, and any facts collected before rejection.

The controller never emits primitive timeline operations. The `professional_edit` domain tool is
the adapter that compiles every returned command with `compileEditorCommand`; the ordinary patch
boundary still validates the combined operation set before application.

Objectives distinguish the source side (the source monitor asset, rational clock, playhead, and
marks) from the sequence side (the active sequence revision, playhead frame, selected destination,
and edit point). This keeps three-point edits and source slips deterministic without asking the
model to calculate seconds or clip IDs.

`syncPolicy` defaults to `preserve`. When FramePilot can prove a picture/sound relationship from a
shared asset plus exact sequence and source-range alignment, roll, slip, slide, ripple trim,
lift/extract, and replace objectives include the linked companion command. More than one matching
companion is a typed `linked_target_ambiguous` rejection. `allow_desync` is an explicit opt-out for
intentional split edits; J/L commands remain the preferred semantic operation for sound-leading or
sound-trailing cuts.

## Multicam: `switch_angle`

`switch_angle` cuts to another camera in the same synced group. It takes one field the other
objectives do not — `cameraAngleId`, the camera to cut to — and the schema binds the two together
in both directions: `switch_angle` without an angle is invalid, and an angle on any other command
is invalid.

Everything else is resolved from live state. The clip is the one under the playhead (or the primary
selection), and the cut lands on the playhead frame; the model never names a clip, an asset, or a
source position.

Which camera a clip is _currently_ showing is derived from the media it plays, against the project's
authored `angleGroups` (schema v18, ADR 0112). The compiler maps the switch position through both
cameras' sync offsets, so the incoming camera resumes at the same **instant** rather than the same
source timestamp:

```text
groupTime  = sourceTime - fromAngle.syncOffsetSeconds
sourceTime = groupTime  + toAngle.syncOffsetSeconds
```

The switch cuts the clip at the playhead and retargets only the downstream half
(`split_clip` + `set_clip_media`); landing on the clip's own head switches the whole clip with no
split. **Sound is untouched** — a camera change that also re-cut the audio would put an audible jump
in room tone at every switch — and because no edit point moves in time, nothing goes out of A/V sync.

Typed rejections, each naming its fix:

| Code                           | Cause                                                             |
| ------------------------------ | ----------------------------------------------------------------- |
| `ungrouped_angle_media`        | The clip's asset is in no camera group.                           |
| `ambiguous_angle_group`        | Two groups claim the asset, so the current angle is undecidable.  |
| `missing_angle`                | The group has no such angle (available ids are listed).           |
| `unsynced_angle`               | An angle has no `syncOffsetSeconds`; nothing is assumed.          |
| `source_range_out_of_bounds`   | The incoming camera was not rolling, or ran out of footage.       |
| `retimed_boundary_unsupported` | The clip is retimed, so source position is not a straight offset. |
| `switch_point_outside_clip`    | The playhead is not on a frame the clip shows.                    |

Automatic sync detection is deliberately absent: offsets are authored, never derived from waveforms,
timecode, or file times.
