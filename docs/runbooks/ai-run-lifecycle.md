# AI run lifecycle diagnostics

Use this runbook when an AI task appears stuck, ends unexpectedly, or the desktop and
AI panel disagree about its status.

## Authority model

Electron main owns durable execution. React owns only a projection:

- **Stop** sends one validated `cancel` command carrying `source: user_stop`.
- Dismissing a model question sends `source: question_dismissed`.
- Sidebar unmount, page hide, navigation, tab/panel changes, and renderer destruction
  detach the projection. They do not cancel a durable run.
- Timeout, provider failure, application shutdown, and process restart are failures or
  interruptions, never user cancellation.

## Trace a run

Filter scoped logs by the durable `runId`, then follow:

1. `run.command_accepted` with `kind: start`.
2. `run.effect_requested` / `run.effect_settled` for model and tool boundaries.
3. `run.stream_event` for visible activity.
4. `run.patch_proposed` and `run.patch_committed` / `run.patch_stale`.
5. If cancellation occurred, find `run.command_accepted` with `kind: cancel`. Its payload
   must contain the source and reason, and the event carries its `commandId`.
6. `run.terminal` must contain a status, outcome kind, source, and useful reason for every
   non-successful ending.

If step 5 is absent, the run must not end as `cancelled`. Look for `timed_out`,
`interrupted`, or `failed`.

## Streaming and persistence

Every non-duplicate compatibility event is appended to the monotonic WAL before
publication. Full snapshots are written on status changes and every 50 WAL events.
Consequently, thousands of provider chunks can produce thousands of replayable deltas
without thousands of atomic snapshot replacements. Recovery deterministically folds the
bounded WAL tail after the last checkpoint.

The durable authority (`RunStore`) is host-neutral and exported by `@framepilot/ai-sdk`. It owns
schema migration, sequence/project consistency, event-id idempotency, WAL bounds, snapshot
checkpoints, corruption quarantine, cache limits, and retention policy. Hosts implement only
`RunStoreIO`: Electron retains its fsync/atomic-rename `FileRunStoreIO`, while browser durability
uses the same authority through its browser storage adapter. A host must not reimplement these
rules or persist lifecycle events outside this boundary.

The browser adapter stores each run's WAL and snapshot together in a transactional IndexedDB record,
with quarantine in a separate object store. If the browser has no IndexedDB implementation, the
compatibility adapter uses namespaced localStorage with hard limits of 1,000,000 characters per run
and 4,000,000 characters total; exceeding either fails the persistence call. It never evicts an
active run to make room. Both adapters implement recency listing, terminal-run deletion, and aged
quarantine pruning for the shared retention policy. Adapter availability alone is not recovery:
the browser route coordinator must persist its lifecycle and restore the sidebar projection before
browser durability can be called complete. Browser editing routes now record the canonical stage
events and a terminal snapshot through this adapter. These records are evidence/projection state,
not an executable patch command: reloading them never applies a patch. A small project-to-run handle
lets the existing sidebar recovery effect find interrupted work. Normal terminal consumption clears
the handle; after a reload, a nonterminal snapshot is first durably closed as `interrupted` with
`process_restart`, then its error/status projection is shown. Recovery never calls the orchestrator
or patch bridge.

The browser route matrix covers edit, recipe, planned edit, agent, and auto-routed editing. Each
must leave a terminal snapshot in the same store and clear its normally consumed recovery handle.
When a route releases a patch, the browser appends `run.patch_proposed` and stores a pending
decision. Accept/reject appends one idempotent decision event after the checked editor authority has
settled; the committed decision carries the resulting project revision. Reload recovery projects
that decision but never emits the diff or calls the patch bridge.

Desktop protects the project authority independently. If delivery retries the identical patch id
and byte-identical patch after it is already in persisted history, the command service returns the
current full project and revision without writing, checkpointing, advancing the revision, or
returning a compact transport the renderer could apply again. Reusing a patch id with different
content fails closed. The route matrix includes a deterministic planned-edit provider/executor
fixture that produces a real reversible proposal, so browser and desktop acceptance project the
same `completed_with_changes` outcome instead of treating a no-change mock as mutation coverage.

Exact consecutive duplicates are ignored and reuse the preceding sequence. Sequence
numbers must remain unique and gap-free for persisted events.

Tool results use two additional scale guards before they reach Electron IPC or the WAL:

- `get_project_state` returns current editable state with an empty `history` list. Undo entries
  stay in the authoritative editor project; they are recovery data, not AI evidence.
- Expandable `tool_result` input/result detail is replaced with an omission marker when its
  estimated JSON size exceeds 256 KiB. Event identity, status, summary, file/clip/track references,
  logs, and warnings remain replayable.

These guards apply only to the desktop/replay copy after the tool and model have consumed the full
result. They do not alter the project, patch history, or model execution value.

## Healthy long run

A long run may emit many reasoning deltas, but meaningful boundaries should continue:
model effect settles, tool starts/settles, a patch is proposed/committed, or the
Conductor advances toward verification. Repeated research without edit attempts is
bounded by the Conductor research budget; an action-only turn follows. Repeated identical
events are not persisted.

## Recovery checks

- Remount or close/reopen the AI panel: the durable snapshot must remain non-terminal and
  replay continues after the saved cursor in the same visibly selected conversation.
- Let a desktop run auto-commit a patch: the project refresh may remount the editor, but
  the running conversation must remain selected; the empty welcome screen must not appear.
- Reload the renderer: the main-process run continues and the new renderer re-subscribes.
- Restart the application: an orphaned non-terminal run becomes `failed/interrupted`
  with `source: process_restart`, never `cancelled`.
- Click Stop twice: the first sourced command is accepted; the terminal run rejects or
  idempotently ignores later cancellation rather than changing its cause.
- Trigger the runtime cap: outcome is `timed_out` with the configured limit in the reason.

### Symptom: the run keeps going with no UI attached

`renderer subscribed to durable run` immediately followed by
`renderer unsubscribed from durable run` (same subscription id, milliseconds apart) means
the renderer re-attached and then dropped the projection. Because the sidebar retries
re-attachment only once per conversation, the run then streams on with nothing observing
it, and Stop reaches nothing.

The known cause was the sidebar's re-attach effect depending on the `running` state it
sets, which made React tear the recovery down on the next render (fixed 2026-07-26; see
`AiSidebar.tsx`'s recovery effect and `DesktopAiSession`'s finalizers). If this pattern
reappears, check that:

- the recovery effect does not take state it sets as a dependency, and its cleanup
  releases the once-only retry guard;
- `DesktopAiSession` keeps `activeDurableRun` set when it detaches from a still-live run —
  clearing it turns Stop into a silent no-op.

Note the deliberate gap: a durable run has **no reattachment deadline**. Nothing in main
cancels a run that no renderer is watching, so any renderer-side detach bug becomes an
unstoppable background run rather than a stalled one.

### Symptom: a running conversation becomes the empty welcome screen

Desktop auto-commit writes the authoritative project and publishes `projectChanged`.
`App` handles that event like an external project-file edit: it reloads the project and
remounts `Editor` so the editor store is seeded from the committed timeline. That remount
also reconstructs the AI sidebar. Conversation hydration restores records but deliberately
does not guess an active selection, so recovery must explicitly open the durable run's
`conversationId` before reading further events.

If the welcome screen appears during a live run, verify all three recovery invariants:

- the durable run handle still carries the project-scoped `conversationId`;
- that conversation is loaded through project-scoped persistence before recovery starts;
- recovery calls the stable conversation `open` action before consuming the event stream.

Do not solve this by disabling the authoritative project refresh: the timeline still needs
to re-seed from the host-owned committed project. Conversation selection is part of the
run projection and must be restored alongside it.

### Symptom: Electron reaches the V8 heap limit during a run

Measure the run's `events.wal` before raising the heap limit. A captured failure reached roughly
3.3 GB of V8 old space because one `run.stream_event` was 116 MB: a `get_project_state`
`tool_result` whose `history` field contributed almost the entire payload. Each later event caused
the validating store to read, parse, and project that cumulative WAL again, multiplying transient
heap use.

For a healthy current build, `get_project_state` results must contain `history: []`, and no durable
tool-result detail should exceed the 256 KiB transport budget. If a new large WAL appears:

1. List event line sizes and identify the largest sequence; do not print the payload into logs.
2. Inspect only its event type, top-level keys, and per-field serialized sizes.
3. Add a source projection for editor/render bookkeeping the model cannot use, or a typed bounded
   summary for evidence it can use.
4. Keep the generic transport guard as the final defense; do not raise Electron's heap limit to
   hide an unbounded event.

`Render frame was disposed before WebFrameMain could be accessed` after a reload is a separate IPC
race. The main process now treats a thrown send as renderer detachment and removes that subscription;
durable execution continues and can be reattached from its last acknowledged cursor.

## Escalation evidence

Capture the run id, command id (if any), last sequence, last effect boundary, last patch
lifecycle event, terminal outcome/source/reason, provider, and timeout limit. Do not
remove the WAL or alter original media while investigating.
