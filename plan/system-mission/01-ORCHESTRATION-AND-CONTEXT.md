# Phase 1 — Orchestration and context — `[~]`

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

## P1.1 — Classify every call in the ledger and remove the ones that should not exist — `[~]`

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

Landed so far:
- **P1.1a — output room on every agent request** (`orchestrator.ts` `outputRoomFor`,
  `orchestrator.output-room.test.ts`). Root cause of 2/3 failed montage runs and the
  failed smoke run: no `maxTokens` on the wire → bridge default 8,192 → truncated tool
  batch → retry at the same cap → run failed. See `docs/reports/system-mission/01-leads.md` #7.
- **P1.1b — verification looks in execution stages** (`stage-policy.ts`
  `VERIFICATION_LOOK_TOOL_NAMES`): `get_frame` is allowed in apply/enhance/repair, bounded by
  analysis caps and the redundant-call memo. Ledger: 7 refused looks across 5 requests.
- **P1.1c — `get_frame` memo key ignores `maxDimension`** (`callMemoKey`): a smaller
  re-render of a frame the run holds is a memo hit. Ledger: 11 renders for 6 timestamps.
- **P1.3a — source-media facts block** (`summarizeSourceMedia`): file, dimensions,
  orientation vs the sequence, priced into the grounding allocation. Ledger: 5
  `recall_evidence` + 5 `describe_footage` requests for these facts.
- **P1.1e — a cut-off reply is retried with a hint, not verbatim** (`truncationRetryHint`):
  the retry says the last reply was cut off before any tool call and asks for at most four
  short tool calls now. Ledger: five 8,192-token cut-offs, each retried identically.
- Goldens (`golden-corpus`, `langchain-anthropic-sessions`, `streamAgent-golden`)
  regenerated after each; the diffs are the measured prompt/request deltas.
**Done when:** p50 model calls per scenario ≤ baseline − (count of rows classified
removable) and the P0.3 rubric score is unchanged or higher.

## P1.2 — Parallelize independent effects — `[~]`

**Touches:** `kernel/agent-graph.ts` node fan-out, `kernel/effect-runtime.ts`,
`kernel/effects.ts`. ADR 0150 already parallelized acquisition (stock/music). Extend the
same mechanism to independent analysis effects the plan schedules (e.g. `detect_beats` on
the placed track and `analyze_silence` on the picture) and to per-asset reads. Keep the
GraphEventQueue ordering contract documented at the top of `agent-graph.ts`.
**Done when:** scenarios with ≥2 independent analyses show wall-time reduction equal to
the overlap, with call count unchanged.

Finding (2026-08-29): read/analysis tool calls inside one request already run
concurrently (`partitionConcurrencyBatches`, pool 4, `concurrencySafe`); the montage
ledger's five `get_frame` calls overlapped in the sidecar log. The remaining wall cost is
per-frame decode of the 4K master (4–6 s each) — a sidecar item (leads #8), not an
orchestration one. Evidence lands with the P1.6 after-measurement.

## P1.3 — Structured state block replaces prose facts — `[x]`

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

Landed 2026-08-29 (ADR 0158): `src/state-block.ts` renders `STATE / project { … } /
timeline { … }` in a pinned key order as the first mandatory section; the prose header,
the droppable `Selected range` tier and the interaction summary's revision/playhead/range
lines are deleted. ≤ 400 tokens asserted on an 8×40 synthetic montage; old phrasings are
asserted absent. `task` stays in the briefing and `memory` in its own tier — reasons in the
ADR. P1.3a (earlier): the per-asset `source media` block. Cache-hit evidence rides the
P1.6 after-measurement.

## P1.4 — Refinement turns reuse the previous plan — `[~]`

**Touches:** `kernel/continuation.ts`, `kernel/briefing.ts`, wipe guard. A second-turn
request ("tighten the middle") must start from the prior run's briefing + commit ledger,
not from a fresh plan. Feed the ledger's placed-clip list and the rubric outcome into the
new run's structured state; forbid a re-plan that discards the placed timeline unless the
user says so (the wipe guard already blocks full-track ripple delete — extend to
re-planning).
**Done when:** UC-08 call count ≤ UC-01 call count and the placed clips from UC-01 survive
except the ones the request named.

State 2026-08-29: the mechanism exists and is tested — `carryForwardWorkingState` passes
the previous run's committed decisions and revision-independent facts into the new run's
briefing, and the wipe guard blocks a full-track ripple delete. The desktop hub reads it
from the run ledger; the browser does not (documented host difference, P2.4). The
**evidence** is the `refine-tighten` scenario, which is exactly one of the three the
provider rate-limit blocked — so this closes with P1.6's residual, on the same command.

## P1.5 — Decision memory with TTL and invalidation — `[~]`

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

Landed so far: engine memory tiers supersede an earlier entry with the same title
(`brain/memory.py` `supersede_by_title`, tested); `remember_preference` already replaces
by key; `carryForwardWorkingState` already carries only revision-independent facts and
committed decisions. Remaining: the UC-09 evidence from the after-measurement, and the
`source`/`until` metadata on entries.

## P1.6 — Measure and close — `[!]` (3 of 6 scenarios measured; the rest need provider headroom)

Re-run P0.2/P0.3 with the same fixtures. Write `docs/reports/system-mission/01-after.md`
with the per-scenario before/after table (calls, rounds, tokens, cache %, wall, USD,
rubric score). ADR for the structured-state block. Update README/PLAN snapshot.

Landed 2026-08-29: `docs/reports/system-mission/01-after.md` with the measured
before/after table. ADR 0158 covers the structured-state block.

**Measured (3 runs each, real sidecar, real media; from
`reports/system-mission/after-orchestration.json`, which the harness writes incrementally):**
- `podcast-highlight-60s`: 25 → 5 model calls, 804k → 173k prompt tokens, 1200s → 253s,
  $1.54 → $0.32, and 3/3 runs that never completed → 0/3. Cache 0.99 → 1.00.
- `remove-dead-air`: 0 → 54 operations, rubric 0.25 → 0.75. Still ends `failed` — the
  verify loop could not clear a mid-word-cut finding and settled honestly.
- `montage-30s`: 0 → 35 operations, rubric **1.00 on all three runs**, at a real cost
  increase (10 → 31 calls) — the baseline was cheap because it was failing. One run was
  cancelled at the harness's own 1200s cap and still scored 1.00 with 30 operations.
- Prompt-cache share held throughout (0.97–1.00); none of the gain came from losing cache.

**`[!]` residual:** `beat-sync`, `refine-tighten`, `memory-captions` have no after-numbers.
The auth2api bridge began 429ing after ~3h and the harness exhausted its retries mid-run.
Unblocking step, verbatim:
```
cd packages/ai-sdk && node scripts/mission-baseline.mjs --runs 3 --label after \
  --only beat-sync,refine-tighten,memory-captions \
  --dump-events ../../reports/system-mission/runs \
  --out ../../reports/system-mission/after-orchestration-rest.json
```
then `node scripts/mission-report.mjs ../../reports/system-mission/baseline-orchestration.json <merged>`
and replace the placeholder rows in `01-after.md`. Needs a provider with headroom.

Note on method: an earlier draft of `01-after.md` was rebuilt from the harness log by
`mission-salvage.mjs`, on the mistaken belief that the harness only writes its JSON at the
end. It writes incrementally. The corrected table comes from the real file; the salvage
script stays because it is still the right tool for a run killed before any write.

## Discovered

