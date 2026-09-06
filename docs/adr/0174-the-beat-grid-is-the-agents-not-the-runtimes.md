# ADR 0174 — The beat grid is the agent's, not the runtime's

- **Status:** Accepted
- **Date:** 2026-09-06
- **Supersedes:** ADR 0086 (beat-grid boundary rule), ADR 0132 (the beat grid
  has a caller), ADR 0157 (the grid follows the music under the picture).
- **Relates to:** ADR 0137 (the runtime measures, the agent decides), ADR 0126
  (one mutating AI runtime).

## Context

A 60-second GoPro highlight run (`cc907070`, 2026-09-06) asked for a driving
track underneath the picture with the cuts re-timed to land on the beat. The
agent called `detect_beats` with `hardSync: true` during reconnaissance —
before any music was on the timeline — and from that moment the runtime's
beat-grid validator refused **every proposal that placed a picture clip**:

- 126 proposed operations were rejected in the first turn with "you declared
  hard sync … but the analyzed audio asset is not on the timeline". The whole
  first assembly, the title, the cutaways and the ducking all failed together,
  because the gate ran before the patch and vetoed the turn.
- The agent then spent 20 of its 66 model calls, and roughly $6 of the turn's
  $13.80, telling the editor it was "dropping hardSync" — a declaration the
  runtime had made sticky by design (`BeatEvidence.hardSync` was write-once).
  There was no tool to withdraw it.
- The one turn that did place the music placed it *and* the picture, and the
  validator then snapped or refused boundaries against onsets translated
  through a placement the model had not yet seen.

This is the fourth incident on the same mechanism (`ea8e46ec`, `beat-sync` r1
and r3 in `session6`, and this run), each answered so far by narrowing the
rule: exempting outer boundaries, exempting audio, making `ungrounded` a
measurement, keying the guard on a stable reason, crediting a shrinking
off-grid count as progress. Every narrowing fixed one run and left the next
one a new way to be refused.

The maintainer's instruction for this branch was explicit: remove the custom
beat-grid alignment path so the model chooses and handles beat placement with
its own judgement, rather than through a separate enforcement path.

## Decision

**The runtime no longer holds any picture cut to any onset.** The module
`kernel/beat-grid/` (alignment, evidence ledger, `hardSync` declaration) is
deleted, `detect_beats` loses its `hardSync` argument, and `applyAgentTurn`
applies the turn's operations exactly as proposed.

What remains is the measurement, made as useful as it can be:

- `detect_beats` returns the onsets as before. Its digest to the model now
  leads with the onsets the engine marked as sitting on the tempo grid (the
  ones a "cut on the beat" wants), states the count of all detected onsets,
  and says in one sentence that the times are in the music's own seconds,
  that `map_time` converts them once the bed is placed, and that nothing will
  snap or refuse a cut for the model.
- The `beat-synced-editing` skill says the same thing where it used to explain
  `hardSync`.
- `detect_beats` stays reachable in execution stages
  (`EXECUTION_MEASUREMENT_TOOL_NAMES`, formerly `VALIDATOR_INPUT_TOOL_NAMES`),
  because a run chooses its music *while* it edits and needs to measure the bed
  it chose — the `ea8e46ec` lesson, kept on its own terms.

The golden `cuts-on-beats` rubric is unchanged and keeps scoring what the
model actually did; it is now a score of editorial accuracy rather than of a
validator.

## Consequences

- A cut a few frames off an onset is an ordinary edit again, and a run that
  places the picture before the music is not refused for it. The completion
  account no longer carries an "off-grid" measurement line.
- Frame-accurate beat sync is now the model's arithmetic. The digest hands it
  exact times, and the mission rubric measures the result; a model that rounds
  will score lower on `beat-sync` cases rather than being corrected silently.
  That trade is the decision: correction cost more runs than it saved.
- ADRs 0086, 0132 and 0157 are historical. Their incident analyses stand;
  their mechanism does not.
