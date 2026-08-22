# ADR 0137 — The runtime measures, the agent decides

**Status:** accepted
**Date:** 2026-08-22
**Supersedes:** the candidate-scoring half of plan FI4.1 (`candidate-proposer.ts`); narrows
ADR 0132's beat-grid enforcement to a declared intent.
**Closes:** the "individual files doing beat grid and things like that should be taken care of
by the agent instead of defining if/else paths" objection, raised by the maintainer against
run 2 (`run.md`, conversation `e6d5ba92`).

## Context

Two modules decided editorial questions in code.

**`propose_edits` → `candidate-proposer.ts`** took footage signals and emitted moves, each with
a hand-tuned score and a canned rationale:

| Trigger | Emitted | Score |
|---|---|---|
| every highlight | `punch_in` | `(h.score ?? 0.5) + 0.5` |
| chapter title matching a reveal-word regex | `punch_in` | `0.7` |
| transcript emphasis word | `punch_in` | `0.6` |
| long chapter with no highlight | `speed` ramp | `0.5` |
| long chapter matching a narration-word regex | `broll` | `0.4` |
| `verticalTarget` set | `reframe` on every highlight | `+0.3` |
| silence over a threshold | `cut` | `min(1, dur/5) + 1` |

**`beat-alignment.ts`** rejected any interior picture cut more than 80ms from a detected onset,
for any run that had called `detect_beats` at all.

Run 2 showed what each costs.

The proposer returned five candidates carrying one rationale between them — *"salient highlight
— a push-in makes it land"*, scored 1.45 down to 1.30 — because no rule can express a choice
its author did not anticipate. That is the ceiling. The floor is worse: the scores read as
evidence, so the model deferred to them instead of exercising the judgement it is there for.
And because the signals are passed IN, a run that had never called `map_footage` handed the
tool a chapter list it had invented and received it back with `cite:` stamped on it — which it
then narrated to the editor as what was in the footage.

The beat grid, meanwhile, refused four cuts for sitting 124ms and 215ms from an onset, in a run
whose brief asked for cuts on *visual* motion peaks — "so the edit is ready to beat-sync once
music is dropped in". The agent complied, and the rhythm it delivered was the grid's: a 2.206s
opening hold in a cut whose stated average was 0.4–1.2s.

Both modules were doing something real. ADR 0132 records the defect the grid closed — a
montage placed uniformly, off every beat, because nothing was checking. FI4.1 records the
defect the proposer closed — the model inventing placement "from vibes". Neither should be
deleted. Both were on the wrong side of a line nobody had drawn.

## Decision

Draw the line. Every editorial concern belongs to exactly one of three categories:

**1. Facts the runtime supplies.** Things the model cannot compute and must never guess: onset
times, silence ranges, scene cuts, source↔sequence mapping, clip geometry, a chapter's length
and how many highlights sit inside it, how far a cut is from the nearest onset. These are
tools, and where the model has been inferring them we add the measurement.

**2. Guarantees the runtime enforces.** Things that are broken regardless of taste: invalid
ranges, overlaps, missing assets, a transition on a non-cut, a clip shorter than a frame, a
crop outside 0..1, a letterboxed clip in a vertical delivery. Rejection here is correct and
stays.

**3. Judgements only the agent makes.** Which moment is best, which move suits it, whether
124ms off an onset matters *here*, whether this shot earns a push-in. The runtime's job is to
make these decisions cheap, visible and reversible — never to make them.

Applied:

- `candidate-proposer.ts` becomes **`edit-signals.ts`**, and `propose_edits` becomes
  **`read_edit_signals`**. It reports what is measurably there, in time order, with no `kind`,
  no `score` and no canned `why`: a highlight's label, length and *supplied* salience; a
  chapter's shape (length, highlights inside, words spoken) in place of a regex reading of its
  title; silences long enough to notice; scene changes; spoken emphasis. Each entry carries
  `from`, saying whether it was supplied by the caller or measured here — because a tool cannot
  certify evidence it was merely passed, and pretending otherwise is how a hallucination became
  a citation.
- `verticalTarget` is still accepted and now ignored. Which move a vertical target deserves is
  precisely the judgement that moved.
- `beat-alignment.ts` keeps snapping near-misses — that is category 1 accuracy the model cannot
  reach by arithmetic, and it is free — but a cut too far to snap is now **reported with the
  nearest onset named**, not refused, unless the run *declared* `hardSync` on `detect_beats`.
  The declaration is an editorial statement, not an analysis parameter; the engine never sees
  it.

## Consequences

The agent has more facts and fewer verdicts. A brief that wants cuts on visual peaks gets them;
a brief that wants hard quantisation says so and is held to it. ADR 0132's original defect still
surfaces — as a reported measurement in the turn note and the completion report rather than as
silence.

Two things this deliberately does NOT do. It does not add a request classifier: no code reads a
brief and decides "this is a beat-sync job". And it does not remove the deterministic layer —
the same numbers are computed by the same pure functions; only the authority over what they
mean has moved.

**Evidence.** `proposers/edit-signals.test.ts` pins that no move, score or rationale survives
in the payload, that reporting is in time order rather than ranked (the strongest highlight is
not hoisted), that a chapter is described by shape rather than by title, and that a supplied
signal says it was supplied. `kernel/beat-grid/beat-alignment.test.ts` covers both modes for
every case that used to reject. `beat-grid-wiring.test.ts` drives real runs: with `hardSync` an
off-grid cut is refused naming the onset; without it the cut lands and the miss is reported, and
nothing tells the editor a change failed to validate. 3167 ai-sdk, 2597 engine and 2435
web-editor tests pass.

## Limitations

`read_edit_signals` still takes its signals as arguments, so `from: 'supplied'` is an honest
label rather than an enforced provenance. Reading them from the run's evidence store by handle
— so an unread chapter simply cannot be cited — needs the evidence store threaded into the read
tools' context, which is a larger change than this warranted and is the natural next step.

The name mismatch between the manifest capability (`plan_edit_candidates`) and the registry
route (`read_edit_signals`) is retained: the capability name is part of the autonomous/MCP
public surface, and renaming it is a separate, mechanical change with its own compatibility
question.

Emphasis detection (ALL-CAPS, exclamation, elongation) remains a heuristic. It is reported as a
measurement of the transcript rather than as a reason to push in, which is the distinction this
ADR is about — but it is still a heuristic about what emphasis looks like in text.
