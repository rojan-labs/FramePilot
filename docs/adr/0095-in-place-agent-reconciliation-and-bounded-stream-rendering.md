# ADR 0095: In-place agent reconciliation and bounded stream rendering

- Status: Accepted
- Date: 2026-08-03

## Context

Feature-length caption tracks can contain thousands of cues. The caption editor mounted an
interactive row for every cue, so typing or changing timing paid for the full movie. During an
agent run, each host-owned project commit changed the React key for the whole editor and remounted
the workspace, including the active conversation. Stream frames could also reach React at display
rate while Markdown was reparsed from an ever-growing partial response. Batched frames were then
appended one at a time, repeatedly copying the conversation log.

These costs grew with project and conversation size even though each interaction changed only a
small visible region.

## Decision

1. The editor workspace is keyed only by project identity. A same-project host snapshot is
   schema-validated and reconciled into the existing store through an explicit authoritative
   replacement action. Ephemeral UI state such as playhead, zoom, playback, active panel, and the
   mounted agent conversation remains intact.
2. The caption cue list is virtualized. It mounts the viewport plus a small overscan window and
   measures real row heights without treating zero-height test-environment measurements as layout.
3. Agent stream delivery is lossless but bounded to one React/store commit every 50 ms (20 Hz),
   including durable-run recovery. A batch is appended with one event-array allocation and one
   state-map replacement.
4. Streaming assistant and reasoning text renders as plain pre-wrapped text. Markdown parsing begins
   only after the event settles. Historical event nodes are memoized.
5. Continuous caption controls keep pointer-frequency values in local preview state and create one
   validated, reversible patch when the gesture ends. The WebCodecs caption layer queries the shared
   temporal index at frame cadence rather than filtering the complete cue lane.
6. The in-memory editor keeps its complete session undo stack. Persistence and host-side agent
   commits retain the newest contiguous suffix capped at 100 entries and approximately 4 MiB. A
   contiguous suffix preserves correct inverse ordering; if the newest entry alone exceeds the
   budget, no older entry is persisted. This is a storage/transport policy, not a timeline-schema
   change.

## Consequences

- Caption interaction cost is bounded by visible cues rather than total movie subtitle count.
- Agent project updates no longer reset the editor or conversation mid-run.
- Every streamed event remains durable and ordered, while render frequency is capped independently
  of provider chunk frequency.
- Markdown styling can appear when a response settles instead of progressively during generation.
- The caption cue editor has its own bounded vertical viewport so the rest of the panel remains
  reachable on very long tracks.
- A slider drag is one undo step and caption playback lookup is independent of total cue count.
- Undo remains complete until the app closes. After reopening, the recent bounded window is
  available; exceptionally large single edits remain undoable only in the session that created
  them. This tradeoff prevents autosave, Electron structured clone, and each agent tool commit from
  repeatedly carrying an unbounded project-sized inverse log.
