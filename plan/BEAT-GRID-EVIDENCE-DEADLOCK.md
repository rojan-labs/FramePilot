# Beat-grid evidence deadlock — root-cause plan

> **Status: `[x]` done (2026-08-29, branch `fix/beat-grid-deadlock`, ADR 0157).** All six
> root causes are fixed, plus one misreport discovered while validating. See
> **Reconciliation** at the bottom for every observation in the run and where it landed.

> Incident: run `ea8e46ec-778f-4da2-9ba2-06e5557b9876` (conversation
> `a6e4868c-d33b-4b89-a7f9-d16ba8381598`, project `project_beat_sync_champadevi_mtbws6ztmw6v`,
> 2026-08-28). 35 minutes, 41 model calls, 645 769 tokens, $4.40, **zero picture clips
> delivered** on a 61-photo beat-synced montage request.

## What the run did

1. Searched music, downloaded three candidate tracks — exactly what the brief asked
   ("Evaluate multiple suitable tracks and select the strongest one").
2. Called `detect_beats` on all three **in one turn**. `detect_beats` is `pure_read` and
   therefore `concurrency: 'parallel'`, so the three calls ran through `mapBounded`.
3. Chose _Skyline run_ (`music_openverse_2052b163…`, 119 onsets, ~172 BPM) and placed it on
   `music_2`, `0 → 27.533s`. That clip is on the timeline at the end of the run.
4. Proposed the 61-photo montage **six times**. Every one was rejected:

   > rejected by the beat grid: this step cuts to detected beats, but the analyzed audio
   > asset `"music_openverse_4c9cb2da_3187_4c10_87e6_aa31bc709808"` is not on the timeline
   > and this proposal does not place it …

   `4c9cb2da` is _Epic Orchestral Adventure Theme_ — the **second** of the three parallel
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

_Affected architecture:_ `HostCallContext`, `applyAgentTurn`, `kernel/beat-grid`.

_Correct design:_ beat evidence is a **ledger keyed by `assetId`**. Concurrent writes to
distinct keys commute, so the race cannot exist; a re-analysis of one asset replaces only
that asset's entry.

### RC2 — The grid binds to the last asset ANALYZED, not the music the picture is cut against

`resolveGrid` (`kernel/beat-grid/beat-alignment.ts`) reads a single `assetId` off a single
payload and demands _that_ asset be on the timeline. The music the montage is actually cut
to — placed, analyzed, and sitting in the run's own evidence as `ev_5` — is never consulted.

_Correct design:_ resolve the grid by asking **which analyzed asset this proposal's picture
actually sits against**: an analyzed asset placed on the timeline, else one placed by this
same proposal, else ungrounded. Deterministic tie-break (most placed seconds, then assetId)
so two analyzed beds never make the outcome order-dependent.

### RC3 — Groundedness is an unconditional veto, against the module's own governing rule

The module already draws the correct line for off-grid interior cuts: **reject only when the
run declared `hardSync`, otherwise measure and report** — "quantising every interior cut is
one legitimate style among several" (ADR 0137). The ungrounded branch is the one place that
line is not drawn: it rejects whatever the run declared.

This run never declared `hardSync`. It was held to a promise it never made, forever.

_Correct design:_ ungrounded → reject only under `hardSync`; otherwise pass the proposal and
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

and it violates the invariant `stage-policy.test.ts` already asserts: _"a tool that says
'call X first' is offered no stage before X is."_

_Correct design:_ a tool whose stored output a **runtime validator consumes** may not be
withheld from a stage in which that validator runs. Declared once, enforced by a test.

### RC5 — An identical rejection, repeated forever, counts as progress

`conductor.ts` treats any turn that attempted an edit as progress ("a rejected op is a
bounded retry"). Nothing bounds it. Six turns, one verbatim rejection reason, 30 minutes.

_Correct design:_ a rejection that repeats the previous turn's rejection reason is **not**
progress. The bounded retry stays bounded.

### RC6 — A run that lands some ops never explains the ones it could not land

`emptyRunMessage` fires only when `cumulativeOps.length === 0`. This run landed two audio
operations, so the six vetoed montages produced **no user-facing account at all** — the
closing notice claimed no further edits _could be found_, when 61 had been found six times.

_Correct design:_ the stall/convergence notice names the standing rejection when the run has
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

| Change     | Proof                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------- |
| RC1        | Three analyses recorded in one turn; all three retrievable; order-independent.                  |
| RC2        | Analyze A, B, C; place C; cut picture → grid resolves from C, cuts snap to C's onsets.          |
| RC3        | Ungrounded + no `hardSync` → applied with a measurement note; + `hardSync` → rejected.          |
| RC4        | `agentTools('agent', 'apply')` contains `detect_beats`; invariant test over the whole registry. |
| RC5        | Two turns with the same rejection reason converge instead of retrying forever.                  |
| RC6        | A run with landed ops **and** a standing rejection surfaces the rejection to the editor.        |
| End to end | `beat-grid-wiring.test.ts` replays the incident: audition three, place one, montage lands.      |

---

# Reconciliation — every observation in the run

| #   | Run observation                                                                                                       | Root cause                                                                                       | Change                                                                                                             | Regression test                                                                                                | Class                                   |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | Six `add_clips` proposals rejected: "the analyzed audio asset `4c9cb2da` is not on the timeline"                      | RC1 + RC2 — one last-writer-wins slot; the grid bound to the last analysis, not the placed music | `kernel/beat-grid/beat-evidence.ts` (ledger + deterministic resolution); `beat-alignment.ts` takes a resolved grid | `beat-evidence.test.ts` (14 cases), `beat-grid-wiring.test.ts` "cuts to the track it PLACED" (mutation-tested) | **FIXED**                               |
| 2   | `detect_beats` → "Skipped redundant detect_beats call" (18:29:46)                                                     | RC4 — the guard's remedy is an `analysis` tool the execution stages withhold                     | `VALIDATOR_INPUT_TOOL_NAMES` + `stageAllowsTool`; `beat-grid/beat-tool.ts` as the shared name                      | `stage-policy.test.ts` — invariant asserted in both directions                                                 | **FIXED**                               |
| 3   | `detect_beats` → "detect_beats is unavailable this turn" (18:36:57)                                                   | RC4, same                                                                                        | as above                                                                                                           | as above                                                                                                       | **FIXED**                               |
| 4   | An ungrounded grid vetoing a run that never asked for hard sync                                                       | RC3 — the one branch that escaped the module's own `hardSync` split                              | groundedness reports by default, rejects only under `hardSync`                                                     | `beat-alignment.test.ts` × 3, `beat-grid-wiring.test.ts` × 2                                                   | **FIXED**                               |
| 5   | Six identical refusals over 30 minutes, each resetting the stall streak                                               | RC5 — "a bounded retry" with nothing bounding it                                                 | `lastRejectionReason` on `ConductorState`; a verbatim repeat is not progress                                       | `conductor.test.ts` × 3                                                                                        | **FIXED**                               |
| 6   | "The run stopped making progress — no further edits could be found for this request"                                  | RC6 — the notice ignored the run's own rejection tally                                           | `stalledRunMessage` names the standing refusal                                                                     | `conductor.test.ts` "names the standing refusal"                                                               | **FIXED**                               |
| 7   | Two audio ops landed; the six vetoed montages produced no user-facing account at all                                  | RC6 — the refusal account was gated on the run landing _nothing_                                 | `partialRunMessage`                                                                                                | `conductor.test.ts` "says what did NOT land"                                                                   | **FIXED**                               |
| 8   | 61 green "Added clip Video 1 · 0s–0.5s" cards for clips that never landed                                             | Cards settle before the turn gate runs                                                           | a whole-turn rejection re-settles its proposal cards as `failed`                                                   | `beat-grid-wiring.test.ts` × 2; `streamAgent-golden` per-turn-cap scenario                                     | **FIXED**                               |
| 9   | Self-check: "The timeline has 1 overlay/caption clip … renders as text on black" — there were no overlays and no text | `picture_present` counted `allClips` as overlays                                                 | count overlays as overlays; a distinct sentence for sound-with-no-picture                                          | `critic.test.ts` "a music bed alone is not picture"                                                            | **FIXED** (discovered while validating) |
| 10  | `search_music` × 2 → "withheld — place what this run already found"                                                   | The commit-only latch (ADR 0149): three tracks were already downloaded and unspent               | none                                                                                                               | —                                                                                                              | **EXPECTED BEHAVIOR**                   |
| 11  | `recall_evidence ev_9` → "no such handle"                                                                             | The model invented a handle; the refusal names the seven that exist                              | none                                                                                                               | —                                                                                                              | **EXPECTED BEHAVIOR**                   |
| 12  | Self-check: "The cut uses 0 shots but at least 61 were asked for"                                                     | The true consequence of #1                                                                       | resolved by #1                                                                                                     | —                                                                                                              | **FIXED** (downstream)                  |
| 13  | Acceptance criterion 6: sound effects cannot be sourced                                                               | The stock libraries cover music and picture, not SFX; the run said so up front                   | none                                                                                                               | —                                                                                                              | **EXPECTED BEHAVIOR**                   |
| 14  | No rendered file delivered (criterion 5)                                                                              | The panel does not render; the report says where to export                                       | none                                                                                                               | —                                                                                                              | **EXPECTED BEHAVIOR**                   |

## Validation run

| Check                                   | Result                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                        | 17/17 tasks                                                                                                                                                   |
| `pnpm test`                             | 18/18 tasks, incl. 83 Playwright e2e                                                                                                                          |
| ai-sdk suite                            | 3717 passed, 1 skipped                                                                                                                                        |
| `pnpm build`                            | 10/10 tasks                                                                                                                                                   |
| `pnpm engine:test`                      | 2696 passed, 1 skipped                                                                                                                                        |
| `pnpm engine:lint` / `engine:typecheck` | ruff clean; mypy clean, 207 files                                                                                                                             |
| `pnpm lint`                             | clean per package. The **whole-repo** invocation OOMs the linter — reproduced on `main` at `ad5a1b0`, so it is a pre-existing tooling limit, not this change. |
