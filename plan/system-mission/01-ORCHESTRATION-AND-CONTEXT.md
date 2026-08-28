# Phase 1 — Orchestration and context — `[ ]`

> **Ships:** fewer, purposeful model calls per task; facts the model never rediscovers
> because they arrive as structured state; decisions that survive across turns with TTL
> and invalidation. Measured against the Phase 0 call ledger.
> **Does not ship:** new worker processes (Phase 5), reference media (Phase 3), prompt
> wording passes (Phase 2 — but Phase 1 may delete whole prompt blocks it makes
> redundant).
> **Depends on:** Phase 0 (P0.2 call ledger, P0.3 rubric).
> **Schema/deps:** none for P1.1–P1.4. **P1.5 may need a persisted `decisions` block** in
> the project file — if the existing Memory Store cannot carry it, that is a schema
> change → `[!]`, ADR + migration first.

The context-management sub-plan already fixed *what the model sees of the footage*. This
phase is about *how many times it is asked, with what*, and *what it is told instead of
having to infer*. Everything here is measured by re-running `mission-baseline.mjs`.

## P1.1 — Classify every call in the ledger and remove the ones that should not exist — `[ ]`

**Input:** the P0.2 call ledger. **Touches:** `kernel/conductor.ts` decisions,
`kernel/stage-policy.ts`, `orchestrator.ts` turn loop, `kernel/proposers/*`.
For each ledger row marked *deterministic* / *cache* / *keep-but-shrink*: implement in
code, not prompt. Expected candidates (verify against the ledger, do not assume):

- Analysis re-runs on unchanged assets → serve from the evidence store
  (`kernel/evidence-store.ts`) keyed by asset hash + tool args; a cache hit is not a turn.
- "Confirm the plan" rounds that never change the plan → drop; the Critic verifies after.
- A tool call whose only purpose is to learn a fact already in `working-state.ts` →
  put the fact in the structured state block (P1.3) and remove the call.
- Two consecutive turns that read the same transcript slice → one.

Each removal is one commit with the ledger row id in the message.
**Done when:** p50 model calls per scenario ≤ baseline − (count of rows classified
removable) and the P0.3 rubric score is unchanged or higher.

## P1.2 — Parallelize independent effects — `[ ]`

**Touches:** `kernel/agent-graph.ts` node fan-out, `kernel/effect-runtime.ts`,
`kernel/effects.ts`. ADR 0150 already parallelized acquisition (stock/music). Extend the
same mechanism to independent analysis effects the plan schedules (e.g. `detect_beats` on
the placed track and `analyze_silence` on the picture) and to per-asset reads. Keep the
GraphEventQueue ordering contract documented at the top of `agent-graph.ts`.
**Done when:** scenarios with ≥2 independent analyses show wall-time reduction equal to
the overlap, with call count unchanged.

## P1.3 — Structured state block replaces prose facts — `[ ]`

**Touches:** `context-builder.ts`, `kernel/context/manifest.ts`, `kernel/working-state.ts`,
`prompts.ts`. Introduce one compact, deterministic, cache-stable block at the head of the
system context:

```text
project  { id, aspect, fps, duration, resolution, tracks[] {id, kind, clipCount} }
timeline { selection, playhead, lastCommit, revision }
task     { goal, stage, budgetLeft, constraints[] }
memory   { style, pacing, references[], approved[], rejected[] }   ← from P1.5
```

Emit it as a fixed key order so the prompt-cache prefix stays stable (measure cache-read
tokens before/after). Delete every prose sentence in the prompt blocks that restated one
of these facts. Extend `kernel/context/invariants.ts` so a prompt missing the block is
refused.
**Done when:** token manifest shows the block ≤ 400 tokens on the montage fixture, cache
hit rate not lower than baseline, and no prompt block duplicates a field of it (grep-
tested).

## P1.4 — Refinement turns reuse the previous plan — `[ ]`

**Touches:** `kernel/continuation.ts`, `kernel/briefing.ts`, wipe guard. A second-turn
request ("tighten the middle") must start from the prior run's briefing + commit ledger,
not from a fresh plan. Feed the ledger's placed-clip list and the rubric outcome into the
new run's structured state; forbid a re-plan that discards the placed timeline unless the
user says so (the wipe guard already blocks full-track ripple delete — extend to
re-planning).
**Done when:** UC-08 call count ≤ UC-01 call count and the placed clips from UC-01 survive
except the ones the request named.

## P1.5 — Decision memory with TTL and invalidation — `[ ]`

**Touches:** the Memory Store in `packages/ai-sdk` (PRD §8.7 — reuse, do not fork),
`kernel/briefing.ts` (writes), `context-builder.ts` (reads into P1.3 `memory`).
Record per project: style decisions, pacing target, caption template, reference profiles
(Phase 3 fills these), selected media roles, approved/rejected approaches, current
objective, constraints. Each entry carries `source` (user statement / inferred /
reference), `turn`, `expiresAfterTurns` or `until: revision`, and `supersededBy`. Reads
filter expired/superseded entries; a superseded style decision is dropped, not merged.
If the store's persisted shape needs a new field → `[!]` schema gate.
**Done when:** UC-09 passes: turn 5 "same captions" applies the turn-2 template with no
re-explanation; a contradicting instruction on turn 3 supersedes turn 2 and turn 5 uses
turn 3.

## P1.6 — Measure and close — `[ ]`

Re-run P0.2/P0.3 with the same fixtures. Write `docs/reports/system-mission/01-after.md`
with the per-scenario before/after table (calls, rounds, tokens, cache %, wall, USD,
rubric score). ADR for the structured-state block. Update README/PLAN snapshot.

## Discovered

