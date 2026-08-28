# Beat-grid evidence deadlock — root-cause plan

> Incident: run `ea8e46ec-778f-4da2-9ba2-06e5557b9876` (conversation
> `a6e4868c-d33b-4b89-a7f9-d16ba8381598`, project `project_beat_sync_champadevi_mtbws6ztmw6v`,
> 2026-08-28). 35 minutes, 41 model calls, 645 769 tokens, $4.40, **zero picture clips
> delivered** on a 61-photo beat-synced montage request.

## What the run did

1. Searched music, downloaded three candidate tracks — exactly what the brief asked
   ("Evaluate multiple suitable tracks and select the strongest one").
2. Called `detect_beats` on all three **in one turn**. `detect_beats` is `pure_read` and
   therefore `concurrency: 'parallel'`, so the three calls ran through `mapBounded`.
3. Chose *Skyline run* (`music_openverse_2052b163…`, 119 onsets, ~172 BPM) and placed it on
   `music_2`, `0 → 27.533s`. That clip is on the timeline at the end of the run.
4. Proposed the 61-photo montage **six times**. Every one was rejected:

   > rejected by the beat grid: this step cuts to detected beats, but the analyzed audio
   > asset `"music_openverse_4c9cb2da_3187_4c10_87e6_aa31bc709808"` is not on the timeline
   > and this proposal does not place it …

   `4c9cb2da` is *Epic Orchestral Adventure Theme* — the **second** of the three parallel
   analyses, and a track the editor never chose.
5. The model diagnosed it correctly, in its own words, at 18:12:56:

   > "I see — the system's beat grid is tracking a different audio asset than what's
   > actually placed on the timeline. Let me detect beats on the placed music."

   It called `detect_beats` on the placed track. The runtime refused: **"Skipped redundant
   detect_beats call"** (18:29:46) and **"detect_beats is unavailable this turn"** (18:36:57).
6. The run ended with `The run stopped making progress — no further edits could be found for
   this request.` The editor was never told a rule had vetoed the montage six times.

## Root causes

### RC1 — Beat evidence is one last-writer-wins slot

`HostCallContext.beatEvidence = { current?: unknown; hardSync?: boolean }`
(`orchestrator.ts`), written at `orchestrator.ts:3508` on every settled `detect_beats`.

Three concurrent analyses write the same field; the survivor is decided by completion order.
Even serialised the model is wrong: **auditioning candidate tracks is the requested
workflow**, and the run can only remember one of them.

*Affected architecture:* `HostCallContext`, `applyAgentTurn`, `kernel/beat-grid`.

*Correct design:* beat evidence is a **ledger keyed by `assetId`**. Concurrent writes to
distinct keys commute, so the race cannot exist; a re-analysis of one asset replaces only
that asset's entry.

### RC2 — The grid binds to the last asset ANALYZED, not the music the picture is cut against

`resolveGrid` (`kernel/beat-grid/beat-alignment.ts`) reads a single `assetId` off a single
payload and demands *that* asset be on the timeline. The music the montage is actually cut
to — placed, analyzed, and sitting in the run's own evidence as `ev_5` — is never consulted.

*Correct design:* resolve the grid by asking **which analyzed asset this proposal's picture
actually sits against**: an analyzed asset placed on the timeline, else one placed by this
same proposal, else ungrounded. Deterministic tie-break (most placed seconds, then assetId)
so two analyzed beds never make the outcome order-dependent.

### RC3 — Groundedness is an unconditional veto, against the module's own governing rule

The module already draws the correct line for off-grid interior cuts: **reject only when the
run declared `hardSync`, otherwise measure and report** — "quantising every interior cut is
one legitimate style among several" (ADR 0137). The ungrounded branch is the one place that
line is not drawn: it rejects whatever the run declared.

This run never declared `hardSync`. It was held to a promise it never made, forever.

*Correct design:* ungrounded → reject only under `hardSync`; otherwise pass the proposal and
report that the cuts were not checked against any onset. **No non-`hardSync` run can be
permanently blocked by the grid.**

### RC4 — The guard's remedy is a tool the stage forbids

`stageAllowsRole(stage, role)` closes every `analysis` tool once the run reaches an execution
stage. `detect_beats` is `analysis`. So from the first landed patch onwards, the run keeps
`add_clips` — **whose validation consumes the beat payload** — and loses the only sanctioned
way to establish that payload.

This is verbatim the defect this same file already fixed for `guidance`:

> "So the moment a run landed its first clip, it kept the tools that demand a real catalog
> id and lost the only sanctioned way to learn one."

and it violates the invariant `stage-policy.test.ts` already asserts: *"a tool that says
'call X first' is offered no stage before X is."*

*Correct design:* a tool whose stored output a **runtime validator consumes** may not be
withheld from a stage in which that validator runs. Declared once, enforced by a test.

### RC5 — An identical rejection, repeated forever, counts as progress

`conductor.ts` treats any turn that attempted an edit as progress ("a rejected op is a
bounded retry"). Nothing bounds it. Six turns, one verbatim rejection reason, 30 minutes.

*Correct design:* a rejection that repeats the previous turn's rejection reason is **not**
progress. The bounded retry stays bounded.

### RC6 — A run that lands some ops never explains the ones it could not land

`emptyRunMessage` fires only when `cumulativeOps.length === 0`. This run landed two audio
operations, so the six vetoed montages produced **no user-facing account at all** — the
closing notice claimed no further edits *could be found*, when 61 had been found six times.

*Correct design:* the stall/convergence notice names the standing rejection when the run has
one, whether or not other work landed.

## Structural change

```
Current
  detect_beats(A) ─┐
  detect_beats(B) ─┼─→ beatEvidence.current  (one slot, last writer wins)
  detect_beats(C) ─┘            │
                                ▼
                        resolveGrid: "is `current.assetId` placed?"  → veto
                                │
                        remedy: detect_beats  → withheld by stage policy → DEADLOCK

New
  detect_beats(A) ─┐
  detect_beats(B) ─┼─→ BeatEvidence ledger  (assetId → payload; writes commute)
  detect_beats(C) ─┘            │
                                ▼
                  resolveBeatGrid(project, ledger, proposal):
                     analyzed AND on the timeline   → grid
                     analyzed AND placed by this proposal → grid
                     otherwise → ungrounded → measure (or reject iff hardSync)
                                │
                        remedy is always reachable:
                          · a mutation (place the analyzed bed), or
                          · detect_beats, which execution stages now offer
```

## Implementation steps (dependency-ordered)

1. `kernel/beat-grid/beat-evidence.ts` — the ledger + deterministic grid resolution. New unit
   tests for the race, the audition, the tie-break, and the ungrounded classification.
2. `kernel/beat-grid/beat-alignment.ts` — take a resolved grid; `hardSync`-gated groundedness.
3. `orchestrator.ts` — `HostCallContext.beatEvidence` becomes the ledger; both turn loops and
   the repair pass thread it; `alignTurnToBeatGrid` delegates resolution.
4. `tool-classification.ts` + `kernel/stage-policy.ts` — declare validator-input tools; exempt
   them from the execution-stage analysis withhold; invariant test.
5. `kernel/conductor.ts` — a repeated rejection reason is not progress; the stall notice names
   the standing rejection.
6. Regression test reproducing the incident end-to-end through `streamAgent`.

## Validation

| Change | Proof |
| --- | --- |
| RC1 | Three analyses recorded in one turn; all three retrievable; order-independent. |
| RC2 | Analyze A, B, C; place C; cut picture → grid resolves from C, cuts snap to C's onsets. |
| RC3 | Ungrounded + no `hardSync` → applied with a measurement note; + `hardSync` → rejected. |
| RC4 | `agentTools('agent', 'apply')` contains `detect_beats`; invariant test over the whole registry. |
| RC5 | Two turns with the same rejection reason converge instead of retrying forever. |
| RC6 | A run with landed ops **and** a standing rejection surfaces the rejection to the editor. |
| End to end | `beat-grid-wiring.test.ts` replays the incident: audition three, place one, montage lands. |
