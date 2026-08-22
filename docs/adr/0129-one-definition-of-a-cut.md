# ADR 0129 — One definition of a cut

**Status:** accepted
**Date:** 2026-08-20
**Supersedes:** nothing. Corrects the caption boundary and staleness rules introduced with
`verify.ts` in ADR 0076, and closes the retrieval economics ADR 0128 left open.

## Context

A caption run on a 20-second montage read the footage for nine turns, reasoned correctly
about what to do, and applied nothing. The request had no ambiguity in it:

> "hey / can you enhance the captions"

The project held one continuous 19.75s vocal bed, 46 video clips averaging 0.43s, and 40
caption cues. `verify_captions` returned `ok: false` with **68 issues across those 40
cues**. Not one of them was real.

This is the fourth stalled run in the family ADR 0127 and ADR 0128 document, and the first
whose cause is not retrieval. The model had the data. It read the transcript, the timeline,
the cut list, the style catalog and the verification report, and then spent 90 seconds of
reasoning arriving — correctly — at the conclusion that the task it had been given could
not be satisfied:

> "This is a genuine tension… to fully avoid spanning cuts, I'd need to end the cue at
> 4.209, truncating the word."

It was right. There was no placement that could pass.

### One pipeline held two definitions of a cut

`checkCueBoundaries` filtered `map.spans`. `buildTimelineMap` fills `spans` from every
**video and audio** clip (`TIMED_TRACK_TYPES`), so the rule flagged picture cuts.

The generator disagrees, and says so in its own docstring. `deriveCaptionCues` segments per
`MappedRun` and clamps every cue to `[run.start, run.end]`; `MappedRun` is grouped on
`word.clipId` — the **audio** clip carrying the word — and `derive.ts` calls runs "the unit
segmentation operates on, which is what guarantees no cue crosses a cut".

So the canonical generator's output was rejected by the canonical verifier on every project
whose picture is cut more finely than its audio: every montage, every B-roll edit, every
multicam. On this project it was unsatisfiable rather than merely strict — a 3–7 word cue
has nowhere to sit among 0.43s shots, and single words fail too (`heart,` runs 3.84–4.37s
across a cut at 4.209s).

The rule's own message named the reason it was wrong: *"its words were never spoken
together"*. That is true of a speech break and false of a picture cut. It tested the second
and justified itself with the first.

### `caption_stale` compared revision numbers

`derived !== map.revision` is not a staleness test; it is a change-detector for the whole
project. Sixty-five revisions of colour and effects between 684 and 749 moved nothing on
the audio track, so all 40 cues were reported stale — while `checkCueSync`, the test that
actually measures whether a cue sits on its word, passed on all 40, and `speechCoverage`
was 1.

### Why 68 false issues stop a run rather than merely annoying it

A run cannot act on a report it cannot triage. Told that every cue is broken in two ways,
with no way to distinguish the reports that matter, the honest move is the one the model
made: decline to edit. A verifier that reports 40 defects where there are none is not being
careful. It is unusable, and it converts a working generator into a run that produces
nothing.

## Decision

### 1. The generator's definition of a cut is the product's definition

A caption cue may sit over as many picture cuts as the editor likes, and may never bridge
audio the speaker did not say in one breath. `checkCueBoundaries` now tests
`mapTranscript(...).runs` — the stretches of continuous audio — and the code is
`caption_spans_speech_break`, so it names what it checks.

This is the definition grounded in what a viewer can read, and it is the one the generator
already enforces, so generator and verifier can no longer disagree.

`get_mapped_transcript` was taught to say the same thing: it returns the run bounds, its
description explains that a cue may cross any number of picture cuts and no run boundary,
and the bounds ride in the digest **head** so they reach the run's durable fact.

### 2. Staleness is measured, not inferred from a version number

`caption_stale` now compares the cue's recorded words against the words that currently play
across it — by count, by text, and by drift against the same tolerance `checkCueSync` uses,
one issue per cue. Strictly stronger than the revision compare: it catches a cue whose
words a later cut removed (which the revision test also caught) and a cue that drifted while
the revision happened not to change (which it did not).

Word ownership is by **midpoint**: a word belongs to the cue whose span contains its middle.
Overlap is right for "is any speech audible here" and wrong for "which words is this cue
answerable for" — a word straddling a boundary overlaps both neighbours, so an overlap count
reports one word too many on each side and every cue in a word-aligned track looks wrong.
Midpoint ownership partitions the words, and it is the rule `speechCoverage` already used,
so the two numbers cannot disagree.

`derivedFromRevision` is still recorded. It is provenance worth keeping; it is simply not
evidence of correctness. Its absence remains reportable (`caption_provenance_unknown`).

### 3. A read with no digest is a run with no memory

`briefing.ts#distil` keeps the **first line** of a read's digest as the run's durable fact.
Sixteen registered read tools had no digest arm and fell to `previewJson`'s 1200
escaped-character slice, so the run's memory of them was 180 characters of escaped JSON cut
mid-string. The caption run's memory of its own verification was literally
`{"ok":false,"issues":[{"code":"caption_spans_cut","clipId":"cap` — it knew something had
failed and not what.

Digests added for `verify_captions`, `verify_transitions` (verdict, issue kinds with counts,
one worked example each — 68 issues become three readable lines), `list_edit_boundaries`,
`analyze_silence`, `detect_scenes`, `discover_effects` and `discover_transitions`. The last
two are the same defect ADR 0128 fixed for `discover_caption_styles`, on its two siblings:
`apply_effect` and `add_transition` refuse an id outside the catalog, so a catalog the model
cannot read whole is one it cannot use, and it is right to refuse to guess.

Each falls back to `previewJson` on an unexpected shape. An absent `ranges` is not "no
silence", and saying so would be the dishonesty this layer exists to end.

The nine remaining reads are now an **explicit list with a stated reason each**, asserted
against the registry in both directions. Ten had reached the default arm by accident; that
cannot recur, because a new read tool fails CI until somebody writes its digest or says why
it needs none.

### 4. ADR 0128 §3 was half done

That decision added a caption track's committed style to the `get_timeline` digest so the
answer would survive the rolling log window. It did not, because the style rendered on the
per-track line and `distil` keeps only the head — so the fact still read
`5 tracks, 87 clips: layer_caption_4(40), …` and a run asked to restyle captions still went
looking for what it had been handed. `timelineDigest`'s own comment states that the first
line becomes the fact; the code below it did not honour that. The style now rides in the
head, and a test runs the digest through `distil` itself, because a digest nobody distils is
a digest the next turn never sees.

### 5. Reachable is not the same as affordable

ADR 0128 gave `recall_evidence` an `offset` so nothing stored is unreachable. That fixed
correctness and left the economics wrong. `get_mapped_transcript` returned
`MappedTranscript` verbatim, and `runs[].words` repeats every object already in `words[]`,
so the payload was exactly twice the size of the information in it: 81 words in 27,647
characters, seven pages at the 4,000-character recall budget. A round trip is a whole model
turn, so the caption run spent six of its nine turns paging a transcript it had already been
given.

Runs now describe themselves by bounds and word count. Nothing is lost — a run is a time
span and its words are the words whose midpoint falls in it, the same rule the verifier
applies. 27,647 → 13,885 characters. `EVIDENCE_RECALL_CHARS` rises 4,000 → 16,000, which
returns essentially every real read whole in one call and keeps the offset for the rest; the
cost is bounded and transient, because a recall rides in the action-log note whose payload
`compactAgentLog` clears after two turns.

## Consequences

- The caption generator and the caption verifier agree, so a montage can be captioned. The
  regression test asserts an `ok: true` report on cues that provably cross picture cuts.
- A caption is reported stale when it is wrong, not when the project moved on. A colour
  grade no longer invalidates the caption track.
- A verification report is three lines a run can triage instead of 68 it cannot.
- Every read tool either carries a digest or is listed, with a reason, as not needing one.
- A transcript recall costs one turn instead of four.
- `caption_spans_cut` is gone as a code. Nothing outside `verify.ts` and its tests consumed
  it — the engine, the MCP server and the editor were all checked — so no consumer breaks.

## Evidence

- 3,047 ai-sdk tests, 7,192 TS tests across 18 packages, and 2,581 engine tests green;
  `pnpm typecheck` and `pnpm lint` clean.
- `verify.ts` at 100% line and branch. `orchestrator.ts` branch coverage 96.44% → 96.61%,
  so this work lands above the baseline it started from.
- Ten golden corpora and one snapshot regenerated. Every divergence is the `tool_schemas`
  token estimate and the arithmetic derived from it (the two rewritten tool descriptions are
  longer); no event, operation or status changed.
- Each fix carries a test named after the failure it closes: "passes cues over a montage
  whose picture is cut finer than its audio", "does not call a correct cue stale just
  because the project revision moved on", "catches a cue whose words drifted off their
  timings, same text and count", "either has a digest arm or is listed as served by the JSON
  preview, with a reason", "the DISTILLED FACT carries the style, not just the digest",
  "describes each run by bounds and count, never by repeating its words".

## What this ADR does NOT fix

- **Nothing writes an interpretation yet.** `setObjective` still has exactly one production
  caller — the provisional seed in `onCommand` — so `objective.outcome`, its acceptance
  criterion, the committed decision and the verification criterion all remain the literal
  request text. This run's failure was reported honestly (`no traceable project mutation`)
  and the echo made the report vague rather than wrong, so it is a reporting defect rather
  than the cause. Carried over from ADR 0128 §6, still `[~]` in `plan/PLAN.md`.
- **`recordEvidence` still has no production caller**, so `RunWorkingState.evidence` stays
  empty and evidence does not survive into the next run. Carried over from ADR 0128.
- **`analyze` is still only left by attempting a mutation** (`stage-policy.ts`). A run that
  answers a recovery turn with recalls advances nothing and converges two turns later. This
  was examined and deliberately left alone: `recall_evidence` survives the recovery turn for
  a documented reason — withholding it once made the turn unsurvivable, and a run built 46
  clips on durations inferred from clip-id suffixes because the bin it had read twice was
  unreachable. The two-turn tail is the cost of that, and the convergence guard already
  bounds it.
- **The verifier still cannot see the picture.** `verify_captions` checks timing; whether a
  cue is legible, clipped by the frame edge or sitting on a face needs `get_frame`, and its
  description now says so.
