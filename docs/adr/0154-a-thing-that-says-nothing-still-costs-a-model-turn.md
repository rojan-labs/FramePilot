# ADR 0154 — A thing that says nothing still costs a model turn

**Status:** accepted
**Date:** 2026-08-28
**Related:** ADR 0128 (recall offset), ADR 0151 (the findings budget scales with the
window), ADR 0153 (a run may not declare itself done over a condition the request stated)

## Context

Run `accd014d` is the re-run of the montage ADR 0153 was written for. Its verdict was
right this time: `failed`, with three deterministic checks naming exactly what was wrong —
28.489s of a 36.5s programme with no picture, 14 shots against 61 asked for, 36.5s against
a 27.5s target. The run reported honestly instead of claiming success.

It still only placed 14 of 61 photos, and it ran out of turns doing something it should
never have had to do at all.

Its last four turns, in order:

| Turn | What it did                             | Edits |
| ---- | --------------------------------------- | ----- |
| 12   | `get_timeline`, `recall_evidence(ev_5)` | 0     |
| 13   | `recall_evidence(ev_4)`, `recall(ev_5)` | 0     |
| 14   | `recall_evidence(ev_4, offset: 16000)`  | 0     |
| 15   | → verify                                | —     |

The model said what it was doing: _"Let me first recall the detailed footage descriptions
so I can organize the journey properly"_, then _"Let me recall the full chapter map to plan
the remaining placements"_. It was not confused. It was fetching the descriptions of the
photographs it had been asked to edit, and the fetch cost more turns than it had left.

Four consecutive turns without an applied edit is the research budget
(`RESEARCH_BUDGET_TURNS`), which forced an action turn and then settled the run. Those
guards are correctly sized — a placement turn resets them, so a long multi-step edit renews
its budget between every step. The guards were not the fault. The fetch was.

## Three measurements, one shape

Measured on that run's own 61-photo map:

| Fact                                                    | Cost                             |
| ------------------------------------------------------- | -------------------------------- |
| All 61 chapters had `title` byte-identical to `summary` | 10,491 of 28,264 chars (**37%**) |
| `summary: ""` and `similarGroup: null` serialised       | 1,933 chars                      |
| The digest showed 24 of 61 chapters                     | the fetch itself                 |

Each is a thing that says nothing, and each costs characters — and `recall_evidence`
returns {@link EVIDENCE_RECALL_CHARS} = 16,000 characters per call, where **a call is a
whole model turn**. 28,264 characters is a two-turn read. That is why the arithmetic
matters: it is not prompt bloat, it is wall-clock turns out of a bounded budget.

### The duplication is structural, not a glitch

A still photograph has one chapter, and the generative backend answers `chapter_title` and
`chapter_summary` with the same generated sentence. Not sometimes: 61 of 61.

### The tool settled past its own contract

`footageMapSchema` is what every reader of a footage map goes through — the context digest,
the understanding panel. `unwrapFootageMap` did not: it forwarded the wire record verbatim.
So the model, the reader whose context is metered and whose reads cost turns, was the only
one getting the un-normalised map.

### The digest cap was a count

`MAX_DIGEST_CHAPTERS = 24` was sized when a chapter meant a SCENE in long video, where
twenty-four scenes is a good reading of an hour and the rest is detail to retrieve on
demand. On a project of stills each chapter is one photograph the editor handed over. The
digest showed 24 and ended `+37 more chapters (use describe_footage to read them)` — and
the model did exactly what that line told it to.

## Decision

**1. A chapter whose summary repeats its title carries one sentence.** Normalised in
`footageChapterSchema`, so there is one answer to "what does this chapter say" for the
digest, the payload and the UI alike. When the two genuinely differ, both are kept.

**2. `map_footage` settles through the contract.** `unwrapFootageMap` parses with
`footageMapSchema` and emits `compactFootageChapters` — the fields that say something.
`safeParse`, not `parse`: an engine shape the schema has not learned yet must still reach
the model. Normalisation is an improvement on the payload, never a gate on it.

**3. The digest is bounded by a character budget, not a row count.** `MAX_DIGEST_CHARS =
12_000`. A count cannot express "show the editor's whole library when the library is
small"; a budget can, and it bounds long footage exactly as the count did.

## Consequences

Measured on the same map:

|                  |                   Before |                     After |
| ---------------- | -----------------------: | ------------------------: |
| Evidence payload | 28,264 chars (2 recalls) |     **15,794 (1 recall)** |
| Digest           |      24 rows, `+37 more` | **61 rows, no more-line** |
| Digest cost      |              6,144 chars |              11,148 chars |

The digest costs about a third more and removes the fetch entirely: the model holds all 61
descriptions from its first turn and never needs `map_footage` for this project at all. For
scale, the tool definitions in that run's every request were 13,814 tokens — the digest
describing what the editor actually gave us stays a fifth of what it costs to list the
tools we might call.

Not changed: the research budget, the no-progress guard, and the semantic-loop detector.
They fired correctly on four consecutive turns that applied nothing, and their own
contract — "attempting an edit resets it, so a long multi-step edit renews its budget
between every applied step" — is right. Loosening them would have bought this run more
turns to keep fetching. Removing the fetch is the fix.

Still unmeasured: whether a run that holds all 61 descriptions from turn one places all 61
photos. That is what the next run settles.
