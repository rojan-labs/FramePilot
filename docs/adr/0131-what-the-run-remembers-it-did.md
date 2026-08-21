# ADR 0131 — What the run remembers it did

**Status:** accepted
**Date:** 2026-08-21
**Supersedes:** nothing. Corrects four records the run keeps about its own work — the
tool-result note, the outcome of a turn whose edit was already applied, the completion report,
and a verification that merely echoes the request. Companion to ADR 0130, from the same run.

## Context

The captured caption run ("hey can you enhance the experience of captions of this and if
possible add prper effects wth prper start and ed") ran for twenty-odd turns, called
`auto_emphasize_captions` **eight times — seven of them successfully** — and finished
without ever believing the emphasis had landed. Turn after turn it wrote some version of:

> The track style has been set multiple times — I need to focus on the failed emphasis
> (retry with ≤12 keywords) and verify the visual result.

It was wrong about its own history, and it was wrong because the run's memory told it so.
Four separate records were lying, and they compounded.

### 1. The note could not tell two different tools apart

`auto_emphasize_captions` is a semantic intent — read the transcript, pick the words that
carry the meaning, accent them. It compiles down to a single `set_track_caption_style`
operation, exactly like the plain `set_track_caption_style` tool.

`summarizeOperations` built the tool-result note from the **operation**, so both calls
produced the identical string:

```
Set track caption style Caption 1
```

That string appears 28 times in the capture. It is not merely a cosmetic mismatch with the
activity card (which correctly read "Emphasising key words in the captions"). It is what the
run REMEMBERS: this one note is the tool result, the agent-log line, and the
`ALREADY APPLIED — do not repeat` row in the state briefing. So the run's own history showed
a column of identical style changes and no emphasis at all — while the model, reading it,
concluded the styling had been redone many times and the emphasis never once.

### 2. An edit that was already applied was recorded as a failure

`applyAgentTurn` refuses a turn whose patch id it has already applied. The patch id is a hash
of the operations, so an identical id means the timeline already says what the turn is asking
it to say. That is a no-op, and refusing it is right.

But the reducer filed such a turn as a `failed` operation with the note as its
`failureReason`, and `buildStateBriefing` renders failures under:

```
FAILED — fix the cause, do not retry unchanged
```

The capture contains that record **twenty-four times**:

```json
"failureReason": "Set track caption style Caption 1; no progress (repeated edit)"
```

So the run was told, repeatedly, that work sitting correctly on its timeline had failed and
that it should find the cause and fix it. There was no cause. The model looked, found
nothing, and tried again — which produced the same patch id, which produced the same
"failure". The retry loop was not the model being stubborn; it was the run's memory
describing success as failure and instructing a fix.

### 3. The completion report was unreadable, and wrong about what it skipped

The run closed by telling the editor:

```
**Applied 8 edits** in 8 steps — review the proposed change below.

- Set track caption style:
- Set track caption style:
… eight times, each a dangling colon over nothing

**Skipped:** 2 proposed changes did not validate (…no progress (repeated edit)…).
```

Three faults in six lines. `describeOperation` returns an empty `detail` for any operation
with no start/end — every caption-style op — and the report rendered `${action}: ${detail}`
unconditionally, producing the colon over nothing. It never named the SUBJECT, so the editor
could not tell which track. And the "Skipped" tally counted the already-applied no-ops as
changes that "did not validate", when both had validated perfectly.

### 4. The run told itself the whole request had passed

The verify fold records one verification per objective with `criterion: objective.description`,
and objectives are seeded from `userPrompt`. So the run's memory ended with:

```json
{ "criterion": "hey can you enhance the experience of captions of this and if possible add
   prper effects wth prper start and ed", "passed": true, "detail": "All checks passed." }
```

That run called **no effect or transition tool at all**. The checks that passed are
timeline-consistency checks; they cannot know whether effects were added. `buildStateBriefing`
renders this to the model under `VERIFIED`, so the model was handed its own request back with
a PASS beside it — which is precisely the overclaim the agent contract's CLAIMS OF COMPLETION
rule forbids, arriving through the one channel that rule cannot reach.

`briefing.ts` already recognises this echo and suppresses it in three other sections
(`WHAT DONE LOOKS LIKE`, `DECIDED`, `OBJECTIVES`). `VERIFIED` was simply missed.

## Decision

**The note names the call when its operations cannot.** When a tool's own name is not among
the operation types it produced, the note leads with what was ASKED FOR and follows with what
CHANGED — the `intent → outcome` idiom the briefing's `distil` already uses:

```
Emphasising key words in the captions Caption 1 → Set track caption style Caption 1
```

When the tool and the operation are the same thing (`trim_clip` → `trim_clip`), naming both
would only restate it, and the line is unchanged. This is a general rule evaluated at
runtime, not a table of special cases: any current or future tool that is a higher-level
intent over a shared operation gets a distinguishable record for free.

**An already-satisfied edit is a success, not a failure.** `AgentTurnResult` carries a new
`satisfied` flag, set by `applyAgentTurn` on the repeated-patch branch alone. The reducer
records those turns as `succeeded` with no `failureReason`, so they land under
`ALREADY APPLIED — do not repeat` — which is both true and the instruction the run actually
needs. Genuine rejections are untouched and still carry their reason. The note changed with
it, from `no progress (repeated edit)` to `already in place — this exact change is already on
the timeline`.

The idempotency key now carries the outcome (`:satisfied` vs `:failed`) so a signature that
failed once and is later found already-satisfied does not overwrite its own failure record —
`recordOperation` keys updates on that string, and the two are different facts about the run.
It is also excluded from the rejection tally, so the completion report stops reporting valid
work as having failed validation.

**The completion report names what changed, and says each thing once.** A shared
`operationLine` helper renders action + subject + detail (no dangling colon, and the track is
named), used by both the tool-result note and the report so the two cannot drift. Lines that
render identically collapse to one row with a `(×N)` count: eight restyles of one caption
track are ONE outcome to the person reviewing them — the last is what they will see — and
eight identical sentences read as a malfunction. Only the rendered line is compared, so any
difference an editor could see still earns its own row.

**A verification that merely echoes the request is labelled as what it is.** When the
criterion is the request verbatim, the briefing renders it as
`the timeline consistency checks (NOT the request itself)`. The signal survives — the checks
did pass, and a FAIL still matters — without laundering it into a claim that a compound
natural-language request has been fulfilled. A real, specific criterion is left untouched.

## Consequences

The run can now distinguish its own actions, and is told the truth about which of them
landed. The two defects reinforced each other — indistinguishable notes made the model
uncertain what it had done, and mislabelled outcomes told it to redo it — so both had to go.

**What this does NOT claim.** That these two fixes alone would have produced a good edit from
the captured run. They remove two specific false statements the run was making to itself,
each traced to a line of code and each covered by a test that fails without the fix. Whether
the resulting run produces better captions is an editorial-quality question that needs a real
provider and real media to answer, and is not asserted here.

**Deliberately not changed.** The repeated-patch guard still keys on operation content alone,
so an edit that returns the timeline to an earlier state (style S → T → S) is still refused as
already-applied even though it is a real change. That is a genuine limitation — the guard
conflates "these ops were emitted before" with "this changes nothing" — but it was not the
cause of the captured failure, and fixing it means comparing against the working project
rather than a set of hashes. Recorded so a later reader does not mistake a known gap for an
oversight.

## Evidence

- `agent-call-note.test.ts` drives `streamAgent` end to end and asserts an emphasis call and
  a styling call no longer produce byte-identical notes, and that a tool whose name IS its
  operation is not restated.
- `kernel/already-satisfied.test.ts` folds turns through the real reducer and asserts the
  status, the absence of a failure reason, the briefing section it lands in, the rejection
  tally, that genuine rejections still record their reason, that a failure and a later
  satisfied result stay separate records, and the `VERIFIED` rendering in all three of its
  cases (echoed-pass, echoed-fail, real criterion).
- `orchestrator-stream.test.ts` covers the report: the 10-line cap now on genuinely distinct
  edits, and a new case asserting eight identical edits collapse to one row with no dangling
  colon.
- Every fix was mutation-tested: reverting each guard fails exactly the tests that cover it.
- 3111 ai-sdk tests pass; the whole workspace is green. The only golden-fixture movement is
  the completion report gaining its subject (`- Deleted range: 0s–3s` → `- Deleted range
Video 1 · 0s–3s`), which is the fix itself; no event, ordering or behavioural divergence.
