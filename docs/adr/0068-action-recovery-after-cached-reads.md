# ADR 0068 — Action recovery after cached-only agent turns

- **Status:** Accepted
- **Date:** 2026-07-19
- **Relates to:** ADR 0055 (agent loop), ADR 0056 (per-turn diffs), ADR 0060
  (concurrent read batches)

## Context

The agent loop memoizes successful reads and analyses, but still advertised the full
tool surface after a model repeated those calls. Two repeated turns correctly tripped
the Conductor's no-progress guard, yet this could stop an editing request before any
timeline operation landed. A real beat-montage run exposed the failure: the
model-facing beat digest omitted the last five non-uniform onsets, the model repeatedly
asked for the missing grid, and the guard stopped the loop.

The plan ledger compounded the confusion by mapping model turns positionally to plan
steps. A cached read could therefore check off a mutation step despite an empty patch.

## Decision

- Beat analysis hands every detected timestamp to the model using a compact
  times-only representation. Average BPM is context, never a replacement for observed
  onsets.
- A successful turn made entirely of memo hits gets one bounded **action-recovery**
  turn before convergence. That turn advertises only mutation and `ask_user` tools and
  carries an explicit action-required instruction in the turn-varying prompt suffix.
- If recovery still cannot edit or ask, the existing convergence guard stops the run;
  recovery never becomes an unbounded retry loop.
- A drafted plan step is completed only when a validated patch applies. Read-only
  turns may keep a step running, but cannot display a completed edit.

## Consequences

- Repeating timeline/assets/analysis reads cannot consume another engine round trip;
  memoization remains authoritative, and the following model call cannot select those
  tools again.
- The normal run-stable prompt prefix and full tool surface remain unchanged. Only the
  exceptional recovery turn uses the smaller descriptor block and varying recovery
  suffix.
- Models receive exact timing evidence at a modest token cost because beat strength
  metadata is omitted. Very long grids consume more context, but retain correctness;
  context budgeting must never invent timestamps from average tempo.
- Checklist progress now reflects applied work instead of model-turn count.
