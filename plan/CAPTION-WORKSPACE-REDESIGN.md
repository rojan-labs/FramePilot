# Caption Workspace Redesign Plan

Status: Implemented on `feat/caption-workspace-redesign`

## Goal

Replace the long, monolithic caption panel with one performance-first workspace for review, timing, styling, emphasis, generation, and recovery. Preserve FramePilot's patch-engine invariants, preview synchronization, export behavior, and existing caption data model.

## Findings

### Performance

- Template filtering, hover previews, cue editing, generation settings, and the virtualized transcript were owned by one component.
- Template hover state could reconcile the entire caption panel even though only one preview tile changed.
- The cue list already had the correct foundations: virtualization, logarithmic active-cue lookup, playhead subscription by active cue id, off-screen gallery pausing, and one patch per completed continuous gesture.
- Long-list navigation had no explicit manual-scroll mode. Playback following could compete with a user reviewing another part of the transcript.
- Caption search did not exist. Finding one cue required manual scrolling.
- Multi-caption operations required repeating single-cue actions.

### Workflow

- Generation, styling, and cue review appeared as one continuous control stack without a clear task order.
- Styling scope was implicit. Users could not immediately tell whether a control affected one cue or the full track.
- Caption timing could be changed on the timeline, but the caption panel had no precise start/end editor or reading-time diagnostics.
- Selection supported the editor store's multi-selection model, but the caption panel exposed only its primary selection.
- Empty, filtered-empty, validation-failure, and review-warning states were incomplete.

## Implementation

### 1. Unified workspace

The caption panel is organized into three connected stages:

1. Review and edit
2. Style and emphasis
3. Generate or regenerate

All stages remain mounted. This keeps controls discoverable, preserves existing test and keyboard contracts, and avoids remounting caption state while moving through the workflow.

### 2. Isolated render domains

- Template browser state is isolated from the cue workspace.
- Each template tile owns its hover/focus preview clock.
- Only the inspected template animates.
- Off-screen template animation remains paused.
- Caption search uses deferred filtering.
- The transcript continues to mount only a small virtual window.
- Playback updates continue to re-render only when the active cue id changes.

### 3. Review workflow

- Search captions by authored cue text.
- Select one cue, toggle cues, select ranges, or select all filtered results.
- Delete selected cues in one validated reversible patch.
- Pause automatic playback following after manual list navigation.
- Return to the currently playing caption with one action.
- Keep selection and playback position stable during search and styling.

### 4. Timing and review

- Edit precise start and end values for the primary selected cue.
- Move the full selected caption set by 0.1 seconds.
- Commit timing only when the field is completed.
- Surface non-blocking warnings for overlap, very short duration, long duration, dense text, and high reading speed.
- Route timing changes through `trim_clip` patches and checked validation.

### 5. Styling scope

- Explicitly choose Selected captions or All captions.
- Batch per-cue styling is combined into one history entry.
- Track styling continues to use the track caption style operation.
- Mixed per-cue values are communicated.
- Template application remains track-wide.
- Continuous sliders preview locally and write one final patch.

### 6. Error and accessibility behavior

- Rejected patches display the validation message and leave project state unchanged.
- Focus states, keyboard navigation, screen-reader labels, reduced motion, forced-colors states, and narrow rail layouts are covered.
- Existing slash-to-style-search and generation shortcuts are preserved.

## Verification

Focused tests cover:

- Long-list virtualization
- Cue text editing and undo
- Split, merge, and delete
- Track and selected-cue styling
- Continuous-control commit behavior
- Template filtering and bounded preview animation
- Generation and regeneration
- Caption search
- Range selection
- Batch deletion
- Batch styling
- Timing commit behavior
- Manual-scroll follow suspension

## Non-goals

- No second caption storage model
- No placeholder import/export controls
- No schema migration
- No provider-specific transcription redesign
- No unrelated editor chrome redesign
