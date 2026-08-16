# ADR 0109: The durable run log is an audit record, not a document store

Status: **Accepted** · Date: 2026-08-11 ·
Constrains the durable orchestration protocol behind
[ADR 0033](./0033-streaming-ai-sidebar-architecture.md)

## Context

A user reported that the desktop app exhausted system memory — "more than 50 GB on the
popup" — whenever they ran an AI task, and had to force-quit the machine's applications to
recover. The failure reproduced on every run, on an ordinary project.

The diagnosis came from the reporter's own durable store rather than from reading code.
`~/Library/Application Support/@framepilot/desktop/orchestration/` held **242 runs and
1.1 GB**, roughly half of it in `quarantine/`. One run's write-ahead log was **36 MB across
196 events**, and the distribution was not flat: thirteen `run.effect_requested` records
averaged **2.78 MB** each, one of them **35 MB**. Inspecting that record:

```
detail.project        39.02 MB
  .history            38.96 MB   ← inverse patches
  .transcript          0.06 MB
  .assets              0.01 MB
```

The durable effect observer in `main.ts` recorded the effect verbatim:

```ts
const asJson = (value: unknown) => JsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
onRequested: (effect) => record(effect, 'requested', effect),
```

A `HostToolEffect` carries `effect.project` because the tool must execute against the run's
in-flight document. In-process that is one reference. Recorded, it is the whole project —
and `Project.history` is the one unbounded field in the format (the same field
`readProjectFile` already refuses to parse past 64 MB, for the same reason). Every host tool
call therefore paid, on the Electron **main** process:

1. `JSON.stringify` → a 39 MB string, then `JSON.parse` → a full object graph;
2. `JsonValueSchema.parse` — a recursive lazy union walked over every node — a third copy;
3. a WAL append, plus retention in `RunStore`'s cache as **both** a parsed graph and its
   JSON signature string, for the life of the process;
4. a structured clone across the IPC bridge to every subscribed renderer.

Replaying the reporter's captured payload through the old path: **13.0 s of fully blocked
main process and 2.3 GB retained** for one run's thirteen tool calls, before the renderer's
copy. Two compounding conditions made it worse: `RunStore`'s cache had no bound, and startup
reconciliation full-loads every run on disk to read its status — measured at ~2 GB of
permanently resident heap for 242 runs, growing with every run the user ever made, since
nothing deleted a finished run either.

Notably, the surrounding code already knew this shape of hazard and had guarded three other
boundaries against it: `prepareAiEventForTransport` bounds tool results at 256 KB,
`readProjectFile` strips oversized history, and `projectForAi` sends `history: []` over IPC.
The effect observer was the one boundary with no rule, and it was the hottest.

## Decision

**The durable run log records what happened, never the documents it happened to.**

An entry must be sufficient to answer: which effect ran, against which project at which
revision, with which arguments, and how did it settle. It must never carry a value whose
size is a function of the user's media or editing history — the project, the model prompt,
decoded frames, raw stream chunks. Every one of those has an authoritative home already
(`project.fp.json` and `ProjectCommandService`; the conversation log; the tool-result
stream), and the run log is addressed _into_ them by id and revision.

Three rules implement it:

1. **Callers record a projection, not an object.** `apps/desktop/electron/ai/effect-record.ts`
   owns `describeRuntimeEffect` / `describeEffectResult`. A host tool becomes its call
   identity, its arguments, and `{ project: { id, revision } }`. A model call becomes its
   shape — message count, tool count, prompt length — never its content. A tool outcome
   becomes status, summary, and bounded data, with produced images **counted** rather than
   carried. Any remaining free-form field passes through `boundedJson` at 16 KB.

2. **The boundary enforces it regardless of the caller.** `RunCoordinator.recordRuntimeEffect`
   replaces any `detail`/`outcome` over 256 KB with an explicit omission marker and logs a
   warning. A projection is a convention; this is the invariant. It is deliberately **not**
   applied to `run.stream_event`, whose payloads are the renderer's UI contract (a `diff`
   carries the patch the review pane renders) and are already bounded in transport.

3. **The log is bounded in memory and on disk.** `RunStore`'s parsed-WAL cache is LRU-bound
   (`MAX_CACHED_RUNS = 8`); `reconcileInterruptedRuns` classifies runs from the few-KB
   snapshot via `peekSnapshot` and full-loads only the genuinely unfinished; `RunStore.prune`
   keeps 50 finished runs and 14 days of quarantine evidence.

## Consequences

**The reported failure is gone.** The same captured 34 MB payload now produces a **295-byte**
record in **1.1 ms** — versus 34 MB and 1 s each — and nothing is retained past the run.
Startup no longer hydrates a session's whole history, and existing oversized stores are
pruned on the next launch without user action.

**Debuggability changes shape, not degree.** A WAL entry no longer lets you reconstruct the
project as it was at that instant. That was never a reliable capability anyway — the record
was written before the effect ran and would have been silently dropped for any project over
the transport limit — and the project's own revision history is the honest source. What the
log gains is that it can actually be read: a run is now KBs, not tens of MB.

**Cache eviction is safe by construction.** The WAL on disk is authoritative and every
mutation appends to it before touching the in-memory copy, so an evicted entry rebuilds
identically on the next read. The cost of a wrong bound is a re-read, never a lost event.

**Retention deletes finished runs.** Only runs with a committed terminal snapshot are
removed, and only after reconciliation has closed out anything the previous session left
open. Recovery targets the run a renderer still holds a handle for, which is by definition
recent; a user cannot reach a 51-runs-ago run from the UI.

**The rule generalises.** Anything appended to the run log in future — new effect kinds,
new phases — inherits both the projection helpers and the boundary check. The failure mode
this ADR closes is not "one field was too big"; it is "a durable, cached, IPC-published log
accepted an unbounded value", and that is now impossible to reintroduce by accident.

## Alternatives considered

**Bound `Project.history` itself.** The persisted form is already capped
(`DEFAULT_DURABLE_HISTORY_LIMITS`: 100 entries / 4 MB); the live in-memory history is not,
because capping it silently discards undo the user can still see. Even at 4 MB, recording a
project per tool call is wrong — the log would still be ~50 MB per run and still blocking.
Fixing the log is the correct layer; the history's live bound remains a separate product
question.

**Compress the WAL.** This trades CPU for disk and does nothing about the three in-memory
copies or the IPC clone, which is where the failure actually lived.

**Skip the effect log entirely.** Effect records are what make a run auditable and are the
substrate for replay. The problem was never that they exist.
