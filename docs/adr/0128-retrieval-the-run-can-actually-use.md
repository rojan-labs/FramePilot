# ADR 0128 — Retrieval the run can actually use

**Status:** accepted
**Date:** 2026-08-20
**Supersedes:** nothing. Extends ADR 0075 (the evidence store) and ADR 0127 (read digests),
and closes half of one item ADR 0127 recorded as explicitly NOT fixed.

## Context

A caption-restyling run stalled twice over two turns — 11 model calls, $0.48, **zero
mutations** — on a request with no ambiguity in it:

> "can you use differnt caption style and emphasize the captions as well"

The project held a caption track (`layer_caption_4`, 40 cues) whose committed style was
`templateId: 'headline'` with a 12-keyword gold italic accent already applied. The correct
edit is two calls: `set_track_caption_style` to a different template, then
`auto_emphasize_captions` with fresh anchors. The run made neither. It read the timeline,
the mapped transcript, the style catalog and one clip; then spent the rest of both runs
trying to establish the one fact it had already been handed, and stopped with
`VERIFICATION_INCONCLUSIVE`.

The maintainer's second message was "contine". That word then became the run's objective.

This is the third stalled run in the same family (ADR 0127 covers the first two), and the
same sentence describes all three: **the run was reasoning about data it had been given and
could no longer reach.** ADR 0127 fixed the reads that were cut off mid-payload. This one
fixes the two surfaces that were supposed to make a read durable — the digest that becomes
the run's memory of it, and the handle that gives the payload back — plus the objective
record that says why the run is working at all.

## Decision

### 1. A recall query matches words, not one literal substring

`EvidenceStore.recall` filtered with `part.toLowerCase().includes(needle)` where `needle`
was the **entire** query. Models do not write queries that way; they write keyword bags. The
run asked, correctly, for `captionStyle track layer_caption_4 style template` — which can
only match if that exact 47-character string appears inside a single record. It never does.
Five queried recalls across two runs returned `No part of ev_N matches` against payloads
that plainly contained the terms.

Queries are now tokenised and **scored** (`rank`): a part survives if it contains any term,
and a whole-phrase hit outranks scattered term hits, so the precise case stays best while
the keyword bag is answered at all. Ordering is stable, so a recall stays reproducible.

This is not cosmetic. `agentActionRecoveryBlock` withholds every read and analysis
descriptor and names `recall_evidence` as the one retrieval tool still in scope. On the
recovery turn — the mechanism whose whole job is to break a research loop — the only door
left open was locked.

### 2. Nothing stored is unreachable

An unqueried recall returned `slice(0, EVIDENCE_RECALL_CHARS)`. For any payload larger than
4,000 characters the tail could not be reached **by any argument**: the run recalled the
caption catalog three times and received the identical head, cut mid-template, each time.
Truncation the caller cannot page past is the same deadlock as a memo that refuses to return
its data — the defect ADR 0075 was written to end, still live in the paging dimension.

`recall_evidence` now takes `offset`, and every truncated answer states where it stopped and
what offset resumes it. `recordsOf` also stopped requiring *exactly one* array property:
two record lists sent a payload down the single-line JSON path, and that covered precisely
the two reads a caption run depends on — `discover_caption_styles` (`fonts` + `templates` +
`compositionFields`) and `get_mapped_transcript` (`words` + `runs`). Flattening every array
cannot drop half a payload the way *picking* one would, because nothing is excluded, and the
line split remains as a fallback so a query aimed at a scalar sibling still lands.

### 3. A digest that omits the field the request names is a loop

`timelineDigest` rendered track id, type, flags and clips. It never rendered `captionStyle`.
So the fact distilled from `get_timeline` — the run's durable memory of that read — was
`5 tracks, 87 clips: fx_track_4000(0), layer_caption_4(40), …`, while the payload that
produced it contained the answer. The raw payload lives only in the rolling last-N-steps log
window (`compactAgentLog`); two turns later it was gone, the fact said nothing about style,
and the run went looking for what it had already read.

`get_timeline` now carries a caption track's committed style (template, display, font,
accent mode and keyword count). Four more reads left the blind `previewJson` default for
record-bounded digests: `get_clip` (ids, both time pairs, cue, per-cue override),
`get_mapped_transcript` (every mapped word with its sequence timing), `get_timeline_summary`
(the per-track rows that are its only reason to exist over `get_timeline`), and
`discover_caption_styles` (every template id, grouped by family).

### 4. A catalog the model cannot see is a catalog it cannot use

`set_track_caption_style` rejects a template id that is not in the catalog — correctly. But
`discover_caption_styles` capped `limit` at 45 against a **51**-template catalog and
defaulted to 20, so no call could return everything, and `headline` — the style actually
applied to this project — sat past the cut. The run could neither name what it had nor pick
a deliberate alternative, and was right to refuse to guess.

Ceiling and default are now the catalog's own size, on both sides of the TS↔Python contract
(`domain-tools/captions.ts`, `ai_tools/registry.py`, `ai_tools/contract_overrides.py`).

### 5. "continue" is a nudge, not an objective

`onCommand` seeded the objective, its single acceptance criterion, the committed decision and
the pending objective from `userPrompt.trim()`. When the whole message was "contine", every
one of those became that word — so the run's durable record of WHY it was working was the
filler that asked it to keep working, and verification could only report inconclusive
because the criterion held nothing to check.

`kernel/continuation.ts` resolves a bare nudge to the request underneath it, from
`input.history`. Deliberately deterministic: no model call, no intent classification. A
message is a nudge only if it is at most four words, contains a continuation word, and
contains nothing outside the continuation/filler vocabulary — so "continue but make it
shorter" stays a new request, because it carries content and overwriting it would lose what
was asked. One edit of spell-tolerance is allowed on words long enough to be worth checking:
a run that loses its goal to a one-character typo is a run whose memory depends on the
editor's keyboard, and "typed it wrong" is not a different request. `objective.request` still
keeps what the editor actually typed.

### 6. The interpretation slot is open, not yet filled

ADR 0127 recorded the objective seed as an echo no turn could replace, because
`setObjective` is write-once and the seed occupied the field before the first turn. The
field cannot simply start empty: `stageEntryViolation` blocks every stage past `interpret`
on a missing outcome, so a blank objective is a run that cannot move.

`objective.provisional` distinguishes the two. A provisional outcome is the run's own
deterministic reading of the request; it holds the seat so the stage guards pass, and yields
to the first genuine interpretation. Write-once now protects the interpretation — which is
what it was always for — rather than protecting the placeholder from ever being improved. A
second placeholder cannot overwrite the first, so the objective is not a moving target.

**Still open, and still tracked:** no production caller writes an interpretation. The slot is
open; nothing fills it yet. `plan/PLAN.md` keeps that item at `[~]`, not `[x]`.

## Consequences

- A run can retrieve any part of anything it has read, by handle, with a query written the
  way a model actually writes one.
- The reads a caption request depends on carry their answer into the run's durable memory,
  so it survives the log window.
- The full template catalog is reachable in one call, on both language surfaces.
- A continuation message keeps the run pointed at the real goal, and verification has a
  criterion worth checking.
- Ten golden corpora and one snapshot were regenerated. The only behavioural deltas are the
  additive `objective.provisional` field, tool-definition token estimates (the
  `recall_evidence` schema grew `offset`), and pre-existing unregenerated drift in the
  `load_skill` unknown-skill finding. No event, operation or status changed.

## Evidence

- 3,030 ai-sdk tests and 2,581 engine tests green; `pnpm typecheck`, `pnpm lint`,
  `pnpm engine:lint`, `pnpm engine:typecheck` clean.
- Every file touched here is at 100% line and branch coverage for the new code:
  `kernel/continuation.ts`, `kernel/evidence-store.ts`, `kernel/working-state.ts`,
  `kernel/conductor.ts`, `domain-tools/captions.ts`, `tool-registry.ts` all 100%;
  `orchestrator.ts` branch coverage 95.12% → 96.44%.
- Each fix carries a regression test named after the failure it closes, so a reader can see
  the defect from the test alone: `evidence-store.test.ts` ("matches a keyword-bag query on
  ANY of its words", "pages past the recall budget instead of re-serving the same head"),
  `orchestrator.test.ts` ("carries a caption track's committed STYLE, not just its clip
  count", "lists every template id, grouped, because the ids ARE the deliverable"),
  `continuation.test.ts`, `conductor.test.ts` ("resolves a bare 'continue' to the request
  underneath it, not to the nudge"), `working-state.test.ts` ("lets a real interpretation
  replace a PROVISIONAL objective, once").

## What this ADR does NOT fix

- **Nothing writes an interpretation yet** (see §6). The seam is open; the caller does not
  exist.
- **`recordEvidence` still has no production caller.** `RunWorkingState.evidence` is
  therefore always empty, `liveEvidence` always returns nothing, and the context manifest
  reports `evidenceHandles: 0` while the action log shows `[ev_1 … ev_5]`. Facts cite handles
  that the durable record does not list. The live `EvidenceStore` makes retrieval work
  within a run; the durable half is unwired, and evidence does not survive into the next run.
- **The decision-recording seam is unwired** (carried over from ADR 0127): `addDecision`,
  `commitDecision`, `reviseDecision`, `recordObjective` and `setBlocker` have no production
  callers.
- **A continuation resolves against conversation history only.** It does not recover the
  previous run's working state — facts, evidence handles and stage all restart — so a
  "continue" still pays for its reconnaissance a second time. Resuming a run rather than
  re-deriving it is a separate slice.
