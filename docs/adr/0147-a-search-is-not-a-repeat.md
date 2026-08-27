# ADR 0147 — A search is not a repeat, and consistent wording is not a loop

**Status:** accepted — narrowed by ADR 0149 (a run holding unspent candidates may not fetch
more), which withholds the catalogue searches from a run that has already banked results it
has not spent. `recall_evidence` and this ADR's empty-project case are untouched.
**Date:** 2026-08-27
**Amends:** ADR 0143 (sourcing is not reconnaissance) — the clause withholding
`search_stock`/`search_music` from a recovery turn is reversed
**Related:** ADR 0068 (descriptor withholding), ADR 0074 (empty-run honesty), ADR 0075
(task memory / stage policy / semantic loops), ADR 0080 (context manifest), ADR 0140
(stock media is placed as a cutaway)

## Context

Captured run `f1d5285e` (2026-08-27) was asked for a fifty-clip, beat-synced nature
montage on an empty project. It searched a music catalogue four times, was told it was
"going in circles", was switched onto the restricted recovery surface, and stopped with
"the run stopped making progress". Four turns. Forty-five seconds. **No edit.**

Four independent guards, each defensible on its own, composed into a run that could not
have succeeded:

1. **`callNoveltyKey` collapsed every search in the run to one key.** The analysis arm
   keys on `name + assetId`, on the sound premise that re-analysing the same media cannot
   reveal anything new about it. But five `analysis`-kind tools — `search_music`,
   `search_stock`, `search_media`, `search_visual`, `find_similar` — have no `assetId` at
   all; their identity is the `query`. All of them fell to `name:*`. The second search of
   any run was therefore scored "learned nothing new", whatever it returned.
2. **A failed call banked its key.** The first `search_music` was rejected upstream.
   `turnLearnedSomethingNew` correctly refused to credit it — and `mergeSeenKeys` recorded
   its key regardless, so the retry that actually returned a catalogue read as a repeat.
3. **The semantic loop detector reads prose.** `'find the'` is an `analyze` marker.
   "First, I need to find the right music", "Let me find the right energetic track" and
   "Let me find the right music first" are one intent repeated three times by that
   measure — and were three different searches returning three different catalogues.
4. **The recovery turn had no legal move.** ADR 0143 admitted `add_stock`/`add_music` to
   that surface and deliberately kept `search_stock`/`search_music` out. `add_stock` places
   a clip by `remoteId`; the only thing that mints a `remoteId` is the search. On an empty
   project the run could reach `recall_evidence` and nothing else — and a recall is
   `fromCache`, which is scored as no progress, which is what ended the run.

Underneath all four, the context manifest showed the editor's 2,672-token brief re-sent
below the prompt-cache boundary on every one of the four model calls, against
`assembleContext`'s own comment saying the request was cacheable prefix.

## Decision

**An analysis that names no asset is keyed by the arguments that carry its question.**
`callNoveltyKey` keeps the `name + assetId` arm exactly as it was — that is what catches
`detect_beats` at three sensitivities — and falls back to the call's identity-bearing
arguments (`query`, `kind`, `orientation`, …) minus `ANALYSIS_TUNING_ARG_KEYS` when there
is no asset. Repeating a query still collapses; an argument-free analysis still collapses;
a different query is a different question.

**Only a call that answered banks its key.** `mergeSeenKeys` applies the same predicate
`turnLearnedSomethingNew` grants novelty on. A key is a claim that the run holds this
call's answer; a failure holds nothing.

**The semantic-loop window holds turns that learned nothing.** A turn with a first-seen,
successful, uncached call empties `recentIntents` instead of extending it. The test is
`learnedSomethingNew` specifically, not `madeMeaningfulProgress` — the broader one would
make the detector unreachable, since anything else that counts as progress resets
`noProgressStreak`, and a turn that does not hits `MAX_NO_PROGRESS_TURNS` on its second
occurrence, before a three-turn window could fill.

**The whole `sourcing` role survives a recovery turn.** `agentTools('action-recovery')`
admits `effectClass: 'mutation'`, `kind: 'ask'`, `recall_evidence`, and
`toolRole(...) === 'sourcing'`. Reconnaissance over material the project already holds
stays withheld, which is what the turn is for.

**The request rides above the cache boundary.** `ContextSplit.stable` carries
`promptBlock`; the volatile tail keeps the timeline summary and the omission block, which
are the only parts that genuinely re-render.

## Why ADR 0143's reasoning does not survive contact with an empty project

ADR 0143 said the recovery turn "exists because the run has looked enough, and a download
is the act it is being asked for". That is true of a run that has already found its
footage — which is the run 0143 was written from (`e30c1fe9` had eighty clips in hand and
was refused the download). It is false of a run that has found nothing yet, and the guard
cannot tell the two apart from the tool list alone. Admitting the search costs one turn of
looking in the case 0143 worried about; withholding it costs the entire run in this one.
The asymmetry decides it.

## Postscript (2026-08-27): the same principle, one layer down

A later run on the same brief (`09529490`) searched successfully fifteen times and still
applied nothing — killed by the same `STALL_CONFIRM_TURNS`, for the same reason in a
different disguise.

The agent log keeps payloads for only the two freshest entries
(`AGENT_LOG_PAYLOAD_FRESH`), and a stock `remoteId` exists nowhere else, so a run holding
twenty-one search handles must reopen them to act. The contract tells it to: recall rather
than re-read. But `recall_evidence` is `fromCache` by construction — serving stored data is
the entire tool — and `callAnswered` read that flag as redundancy. Eighteen recalls, none
credited, run over.

This is the same mistake as the one above: a mechanical property of HOW an answer was
served, mistaken for evidence that the run already had it. `search_music:*` erased the
query; `fromCache` erased the difference between opening ev_1 and opening ev_7. The remedy
is the same too — let the novelty key decide, because it already keys a recall on its
`evidenceId`. A run reopening different handles is working; one reopening the same handle
is stuck, and still stalls.

## Consequences

- A run may search a catalogue as many times as its request needs. Repeating a query is
  still free of credit, so the spin guard is intact.
- The advertised surface on a recovery turn grows by **409 tokens** (the two search
  descriptors). The golden manifests carry the measurement.
- The editor's request is billed once per run rather than once per turn — on the captured
  run, ~8,000 tokens saved across four calls, and proportionally more on longer runs.
- The semantic loop detector now fires only on a run that repeats a purpose while
  discovering nothing. It is narrower, and the narrowing is the point.
- Five guards remain layered (stall, no-progress, semantic loop, research budget,
  diminishing returns). This ADR does not reduce their number; it corrects what each one
  measures. Consolidating them is worth doing and is not done here.

## Alternatives considered

**Re-register the search tools as `kind: 'read'`.** The read arm already keys on
identifying arguments, so this would fix the novelty key for free — and break dispatch:
`kind` selects the execution path, and these are host-executed analyses. The kind is right;
the key was wrong.

**Narrow the `'find the'` intent marker.** Whack-a-mole. Every editing run says "find the
gap", "find the hook", "find the strongest shot". The problem is not this phrase, it is
that a detector reading only prose cannot tell a working run from a stuck one.

**Raise `STALL_CONFIRM_TURNS`.** It would have bought this run more turns to fail in. The
turns were not being miscounted; they were being misjudged.
