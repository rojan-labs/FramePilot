# ADR 0074 — Research budget, coarse read novelty, and empty-run honesty

- **Status:** Accepted
- **Date:** 2026-07-25
- **Relates to:** ADR 0055 (agent loop), ADR 0068 (action recovery after cached reads),
  ADR 0073 (durable orchestration runtime)

## Context

A real run reported by a user asked to cut a ~6-minute video to about a minute with
captions, animations, and transitions. Across eight turns the agent read the transcript,
mapped the footage, analysed silence, and proposed edit candidates — repeatedly — and
then finished having applied **nothing**. The timeline was untouched and the run
displayed no warning saying so.

Every guard we already had was structurally blind to this shape of failure:

- **The stall guard** (`STALL_CONFIRM_TURNS`) stops a run that makes no progress, where
  progress includes "learned something new" — a first-seen novelty key. Novelty keys were
  coarsened for _analysis_ tools (`name + assetId`) precisely to defeat arg-varying spin,
  but **reads kept full-argument keys**. `get_transcript` takes a `start`/`end` window, so
  `{0,60}` → `{0,120}` → `{60,180}` produced three distinct keys. Each turn "learned
  something new", the streak reset every turn, and the guard never advanced. The model's
  own reasoning — _"let me get the transcript in chunks"_ — is what disarmed it.
- **The diminishing-returns guard** (`DIMINISHING_RETURNS_*`) requires consecutive turns
  under 120 output tokens. These turns carried minutes of reasoning, thousands of tokens
  each. Structurally unreachable.
- **The step cap** (`DEFAULT_MAX_AGENT_STEPS = 300`) was therefore the _only_ remaining
  rail — a resource ceiling doing a job it was explicitly documented not to do.
- **The empty-run notice** fired only when `rejectedOpCount > 0`. A run that never
  _attempted_ an edit has no rejections, so the worst outcome was also the quietest one:
  it finalized silently and read as a normal run with an empty diff.

Both existing detectors answer "is this run stuck?" Neither answers "is this run ever
going to act?" — and that was the actual question.

## Decision

**1. Novelty and memoization are separate keys.** `callNoveltyKey` (progress accounting)
drops _window_ arguments (`start`, `end`) for read tools and sorts the rest, so
re-reading a different slice of the same unchanged data is one question — the same rule
already applied to analysis tuning args. Identity-bearing arguments (`clipId`, `assetId`,
`name`) are kept, so reading a genuinely different subject stays novel. `callMemoKey`
(the read memo) keeps **full** arguments: novelty accounting may be approximate, cached
data may not. Sharing one coarse key would answer `{start:0.5}` with the words from
`{start:0}`.

**2. A research budget forces the research→execute transition.**
`RESEARCH_BUDGET_TURNS = 8` consecutive turns that gather information without _attempting_
an edit exhaust the budget, and the next turn runs with read and analysis descriptors
withheld — reusing ADR 0068's action-recovery mechanism, since the remedy is identical.
This is a budget, not another detector: past that point the run has enough to act on by
construction. Any edit attempt — applied _or_ rejected — refunds it in full, so a long
multi-step edit renews its allowance between every step and is never squeezed.

**3. A run that changed nothing says so.** Rejections are reported however the run ended.
The never-attempted notice is narrower: it fires only when a _guard_ stopped the run, not
when the model finished voluntarily (`modelDeclaredDone`) — "the silences were already
trimmed, nothing to do" is a legitimate outcome the model has already explained, and
contradicting it would be a false alarm. It also does not fire when ops were attempted and
lost to the per-turn cap (`attemptedAnyEdit`), which emits its own specific warning.

**4. The action-recovery prompt states no cause.** It previously asserted the last turn
"only requested information already present" — untrue of the budget trigger, whose reads
were novel, just unproductive. A false premise invites the model to argue with it rather
than act.

## Consequences

- The reported failure is now bounded: at worst eight reconnaissance turns, then a turn
  that can only mutate or ask. The guard that fires is behavioral, and the 300-step
  ceiling returns to being a true last resort.
- A legitimately thorough run is unaffected — eight turns comfortably covers orienting,
  reading a transcript, mapping footage, analysing silence, and loading skills. The
  budget was sized deliberately generously: cutting a thorough run short is worse than
  one extra turn of reconnaissance.
- Sectional transcript reading still returns correct per-window data; it simply stops
  buying unlimited runway. A run doing nothing _but_ that now converges.
- Runs that end without touching the timeline are visible to the user instead of silent.
  One golden scenario (`spin-guard`) gained the new warning; no applied-edit scenario
  changed.
- Forced action can produce a weaker first edit than more research might have. That is
  the intended trade: an edit the creator can see, undo, and refine beats a plan they
  never receive. Undo is a single step, and the run reports what it did.

## Alternatives considered

- **Lowering the 300-step cap.** Treats the symptom, not the cause, and would cut short
  legitimate long-form runs. The cap is a resource rail by design.
- **Raising the diminishing-returns token threshold** so verbose turns count. Would
  penalize genuine reasoning and misfire on careful runs; token volume is a poor proxy
  for usefulness.
- **Prompting harder** ("stop researching, start editing"). Explicitly rejected: the
  previous design already removed an escalating-nudge apparatus for being unreliable, and
  a prompt cannot make a loop structurally impossible. Withholding the descriptors can.
- **Coarsening the read memo to match the novelty key.** Simpler, and wrong — it serves
  incorrect data. Correctness is not a valid price for loop protection.
