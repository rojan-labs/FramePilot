# Professional editor interaction context

FramePilot now captures ephemeral editor interaction state at the instant an AI turn starts. The
contract is the first part of the professional-editor control plane described in
`plan/PROFESSIONAL-EDITOR-CONTROL-PLANE.md`.

## Why it is separate from the project

The playhead and current selection answer what an editor means by “this”, “these”, and “here”, but
they are not durable project content. Persisting them in `project.fp.json` would create schema churn
and make a saved edit depend on whichever panel happened to have focus. `EditorInteractionContext`
is therefore a versioned, serialisable turn snapshot.

The snapshot carries two different revisions:

- `projectRevision` is the host's optimistic-concurrency authority.
- `timelineRevision` is the timeline's structural timing revision.

The distinction matters: a styling edit may advance host authority without invalidating cut
structure, while a trim must invalidate an edit-point resolution even if the referenced IDs still
exist.

## Flow

1. The web editor reads the live playhead, primary clip, selected clip set, derived track set,
   effect-layer and keyframe selection, source-monitor playhead/marks, and selection range when the
   user submits the turn.
2. Browser runs pass the snapshot directly into `ContextInput`.
3. Desktop runs send the same shape through IPC. Electron validates the version, authority fields,
   finite time/frame values, ID lengths/counts, selection membership, source marks, and ranges, then
   checks every referenced clip, track, effect layer, keyframe, and source asset against the
   authoritative project before the SDK receives it.
4. The context builder adds a compact factual block for the model. The structured snapshot also
   enters `ToolContext`; tools and compilers must use the structured value, never parse prompt text.
5. `resolveEditorTarget` returns `resolved`, `ambiguous`, or `unresolved`. It refuses stale timeline
   state, missing explicit IDs, and equally authoritative candidates.

Resolver evidence currently ranks explicit IDs above direct selection and selection above playhead
hits. A selected primary clip disambiguates stacked clips; otherwise multiple clips under the
playhead produce an ambiguity result rather than a guessed z-order target. Edit points are derived
from `editor-core`'s real cut-boundary index and source-handle facts. Track queries resolve only
explicit or genuinely selected tracks; they do not infer semantic roles. Range queries distinguish
the selected range from the visible viewport and retain the selected-track scope.

Read-only resolution can use the structural timeline revision alone. Mutating call sites also pass
the current host project revision; a mismatch returns `stale_context` before IDs or ranges are
considered.

Effect/keyframe/source state stays owned by the UI that already edits it. `TimelineView` publishes
selected keyframe identities as `(clipId, property, clip-relative time)`, the lifted effect-layer
selection is captured beside clip selection, and `SourceMonitor` publishes its loaded asset,
playhead frame, and valid ordered in/out frames. These are observations only: none dispatch a patch
or enter undo history.

## Current boundary

This slice establishes and transports the contract. Existing legacy tools are not yet forbidden
from accepting explicit IDs supplied by the model. Enforcement lands with the professional command
compiler path: mutating professional commands will require a resolved target and reject stale,
ambiguous, or unresolved inputs before patch assembly.

The command-kernel work starts at the mechanics boundary. `set_clip_source_range` is now a typed,
reversible TypeScript/Python primitive that preserves sequence edges and refuses invalid source or
speed-duration ranges. This gives the forthcoming slip compiler an honest target operation instead
of approximating professional semantics with paired trims.

The first `EditorCommand` compiler vertical is also live in editor-core for roll, slip, and slide.
Commands are timeline-revision-bound and use integer frames with explicit rational source/sequence
rates. Compilation returns a validated forward patch, its inverse, and facts—or a typed rejection.
The compiler owns handle checks and shrink-first operation ordering, so callers cannot accidentally
create a transient overlap while constructing a coupled edit.

Ripple trim, lift, and extract now use that same kernel. Ripple trims shorten through a canonical
`ripple_delete`; extensions first move downstream clips back-to-front and only then extend the
source edge. Lift and extract are separate commands because leaving a deliberate gap and closing
time are different editorial decisions, even when both begin from the same selected clips.

Three-point insert and overwrite now compile from source-frame ranges into sequence-frame edit
points. An insert inside a shot splits that shot first, then shifts the right-hand piece and every
downstream clip back-to-front. Overwrite replaces only destination time. Replace uses
`set_clip_media`, preserving the existing clip's identity and attached grading, animation, masks,
and retime rather than approximating replacement with delete-plus-add.

J/L cuts complete the initial command family without introducing persisted link metadata. The
command asserts the four clips surrounding the picture and sound edits; the compiler then proves
each video/audio pair shares an asset and both tracks begin aligned at the same cut. A J-cut moves
the audio boundary earlier and an L-cut moves it later, while the picture clips remain untouched.
This explicit proof is stricter than proximity-based inference and can later consume durable link
groups through the same command contract when the project schema gains migration-backed linkage.

The first mutating enforcement point is now `professional_edit`, a timeline-domain tool module.
Roll, ripple trim, slide, lift, and extract requests must resolve a clip set or edit point from this
interaction context before their `EditorCommand` is constructed. The tool never accepts clip IDs or
primitive choreography from model output. It is intentionally host-only until external/MCP clients
can supply the same versioned interaction snapshot; the Python registry therefore does not
advertise a weaker parallel version.

Source-monitor state uses interaction context v2. In addition to the asset, playhead, and optional
marks, the snapshot carries the monitor's rational timebase (`numerator`/`denominator`). This is an
editing clock—not an inferred native media frame rate—and is the sole authority for turning source
frame positions into seconds. Capture and desktop IPC validation reject invalid rates,
frame/seconds disagreement, and ranges beyond known media duration. Insert, overwrite, replace,
and slip tools can therefore consume source positions without silently borrowing sequence FPS.

The source commands are enforced at `professional_edit`: insert/overwrite derive destination time
from the captured sequence playhead, destination track from one selected track, and media range
from source marks; replace derives its target from one selected clip and its source-in from the
source playhead; slip additionally requires that the source monitor holds the selected clip's
asset. The model cannot provide any of those identifiers or positions.

Linked edit points are a separate `TargetResolver` result rather than a special case in the tool.
The resolver groups picture and sound boundaries at the requested selection/playhead relation,
requires video/audio track roles, and proves outgoing and incoming asset linkage. It returns one
four-clip target, an explicit ambiguity, or no target. `professional_edit` maps that target to a
J/L command; editor-core independently revalidates linkage and moves only the sound boundary.
