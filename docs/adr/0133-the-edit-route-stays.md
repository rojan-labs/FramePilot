# ADR 0133 — The single-shot `edit` route stays

**Status:** accepted
**Date:** 2026-08-21
**Decision by:** maintainer, 2026-08-21
**Closes:** the "single-shot `edit` route is a second mutating entry point" follow-up ADR 0126
opened and `plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` carried out of Phase 1. Closed as
**won't do**, with the §4 criterion corrected instead.

## Context

The 9.5 convergence programme sets a benchmark target of **"1 mutating AI runtime"**. After
ADR 0126 retired `planned_edit`, one thing still made that sentence literally false: the
single-shot `edit` route (Cmd+K — "one quick reviewable edit"), plus its browser-only
`editVariations` A/B takes.

Phase 1 deliberately did not fold it in, and said so rather than claiming the box was ticked.
This ADR resolves the open question that deferral left behind: converge it, or keep it?

## What `edit` actually is

Worth stating precisely, because the criterion turned on it:

|                                  | agent runtime | `edit` route |
| -------------------------------- | ------------- | ------------ |
| multi-turn loop                  | yes           | no           |
| conductor / reducer              | yes           | no           |
| durable checkpointing            | yes           | no           |
| run ledger, plan state           | yes           | no           |
| tool registry                    | shared        | shared       |
| `assembleEdit` → validate → diff | shared        | shared       |
| authority the other lacks        | —             | none         |

`edit` makes one model call, turns its tool calls into typed operations, and runs them through
the **same** `assembleEdit` path — the same validator, the same patch authority, the same
invariants. It is a _proposal surface_ over the one runtime's machinery, not a parallel
implementation of it.

## Decision

**Keep the `edit` route. Correct the criterion.**

§4 now reads "1 mutating AI **RUNTIME** after convergence — one loop, one conductor, one
durable checkpointing authority", explicitly _not_ "one mutating entry point". The thing that
was wrong was the sentence, not the code.

## Why not converge it

Convergence exists to remove **parallel implementations of the same authority** — two things
that both decide how an edit executes, drift apart, and have to be kept in sync. That was
exactly `planned_edit`, which had its own intent parsing, planning, graph compilation and
execution machinery, and which ADR 0126 rightly deleted. `edit` is not that: it has no
execution authority at all.

Converging it anyway would have required choosing one of:

- **Delete `variations`.** A shipped, working browser capability removed to satisfy a
  sentence in a plan. That is the plan driving the product instead of the other way round.
- **Re-implement `variations` on top of a turn-bounded agent run.** The larger blast radius,
  for no user-visible gain — and with a real correctness hazard: `editVariations` deliberately
  uses `complete()` rather than `stream()` because a streaming transport has no way to carry
  real token `usage` on its terminal chunk, and the whole point of that method is an honest
  combined cost across every candidate. Rebuilding it on the streaming agent loop risks
  quietly reintroducing fabricated cost numbers, which is precisely what this codebase
  refuses to do.

Neither trade buys the user anything. A checkbox is not a user outcome.

## Consequences

The Phase-1 follow-up is closed, and the benchmark table now claims what is true rather than
what was aspirational. Nothing in the code changed.

**Recorded so a later agent does not "finish" this by deleting a feature.** An unticked box
next to a working capability is a standing invitation to remove the capability; this ADR is
the standing answer.

## What would reopen this

If `edit` ever grows execution authority the agent does not have — its own retry policy, its
own checkpointing, its own validation path, its own tool routing — it stops being a proposal
surface and becomes the second runtime this criterion is actually about. Converge it then.
