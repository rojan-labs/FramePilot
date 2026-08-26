# Phase 5 — The agent does not re-learn the footage, or the editor's taste — `[ ]`

> **Ships:** turn 2 of a session starts knowing what turn 1 found; the editor can teach a
> preference and have it stick; the tool surface stops churning mid-run.
> **Does not ship:** cross-project retrieval, a learned model of taste, any new store.
> **Depends on:** Phase 1 (the facts worth carrying forward have to be real ones), and
> ships **after** Phase 4 — memory multiplies whatever the agent does, so persisting
> judgements made before the editorial checks exist means persisting the wrong ones.
> **Schema/deps:** none. `Project.aiMemory` is already free-form; `RunSnapshot.workingState`
> is already persisted.

---

## 1. The gap

Three separate leaks, one symptom: the agent behaves like a contractor who has never seen
the project before, every single turn.

**Run memory dies at the run boundary (F6).** `historyFromEvents`
(`apps/web-editor/src/editor/ai.ts:370`) keeps only `user_message` and
`assistant_message` **text**. Everything the previous run _learned_ — the distilled facts,
the evidence handles, the committed plan, the verification records in `RunWorkingState` —
is created fresh by `initialWorkingState` on every command. The only restore path is
`agentOptions.resume`, which is a within-run crash checkpoint (`orchestrator.ts:5543`),
never a previous run's state.

So: turn 1 _"find the best moments in this recording"_ spends six turns reading the
transcript, mapping the footage, and distilling forty facts. Turn 2 _"now tighten the
middle"_ starts knowing the prose of what was said and nothing about what was found. On
desktop, `sessionContext` partially covers this — but only for _human decisions_ recorded
via `rememberDecision` and Accept/Reject, never for what the run discovered about the
footage. In the browser build there is no sidecar and nothing at all.

**Project memory is read-only to the agent (F7).** `readMemory` is injected into the
`memory` tier every turn under the heading _"Project memory (honour these preferences)"_.
No tool in the 85-tool registry writes it. The only writers are `style-presets.ts` and the
Settings dialog / Accept-Reject buttons. The agent can honour a preference and can never
learn one — an editor who says _"punchier than that"_ is teaching nothing durable.

**The tool surface churns mid-run (F5).** `stageAllowsRole`
(`kernel/stage-policy.ts:126`) withholds `analysis` and `guidance` descriptors once the run
is executing. The tool block is ~78% of the prompt and sits above the messages in the
provider's cache hierarchy, so changing it invalidates everything cached beneath. Measured:
**2 swaps per 9-turn run, 30,751 tokens re-billed at full price**, invisible to the cost
meter.

---

## P5.1 — A new run starts where the last one finished — `[ ]`

**Closes:** F6. **Touches:** `kernel/conductor.ts:928`,
`apps/desktop/electron/ai/run-coordinator-base.ts`.
**Reuses unchanged:** `RunSnapshot.workingState` (already persisted, already validated by
`parseWorkingState` with version-monotonicity and identity checks).

Seed a new run's `RunWorkingState` from the previous run's persisted state for the same
conversation **and** project, carrying forward only what is still true:

- **Facts** whose scope survives the intervening edits. A fact about the _source footage_
  ("asset*3 is 8:42, speech from 0:04") outlives any number of cuts. A fact about the
  \_timeline arrangement* ("46 clips, sequence duration 21.87s") does not survive a revision
  bump. `Fact` already carries a `FactScope` — that field is the filter, and it exists
  precisely so this distinction can be made.
- **Evidence handles** that still resolve. `recall_evidence` should work across the run
  boundary, or the carried-forward citations are the same broken promise
  `clearedWithHandle` was written to end.
- **Committed decisions** made with the editor ("vertical, 9:16, no music"). These are the
  answers that die with the run today and get re-asked next turn.

Explicitly **not** carried: `nextAction`, `stage`, `objective`, the plan, blockers,
verification records. Those belong to the run that made them. A new request gets a new
objective; inheriting the old one is how a run ends up executing the previous turn's plan.

**Evidence.** A two-run test: run 1 reads the transcript and files facts; run 2 issues a
follow-up and **does not** call `get_transcript` again — the fact is in its briefing.
Benchmark: facts re-derived on turn 2 → 0 for still-valid facts.

---

## P5.2 — The editor can teach a preference — `[ ]`

**Closes:** F7. **Touches:** `domain-tools/project.ts`, `tool-registry.ts`.
**Reuses unchanged:** `memory-store.ts` (`setPreference`, `setExportPlatforms` — built),
`scoped-memory.ts` (project-over-user precedence — built).

One tool. `remember_preference`, writing through the existing typed setters, constrained to
the existing `MemoryPreferenceKey` union (`targetAudience`, `brandStyle`, `captionStyle`,
`preferredPacing`) plus export platforms.

- **A closed key set, not free text.** `ProjectMemory` is Zod-parsed and read defensively
  because `aiMemory` round-trips through `project.fp.json` and is untrusted. A free-text
  memory tool would turn the "honour these preferences" block into an unbounded model-authored
  prompt injection surface, growing every turn. The typed union is the guard.
- **~120 tokens of schema.** The cost is real and small; the benchmark will show it.
- **Writes go through the patch/commit path**, not a side channel. Memory lives in the
  project file; the project file has one writer.

Deliberately **not** built: a general `remember(anything)` tool, a memory-editing UI beyond
the Settings fields that already exist, or a second store. The narrative tier
(`brain/memory.py` — `corrections.md` / `decisions.md` / `session_notes/`) already handles
prose and already has a writer in `createMemoryRecorder`; this is the _typed_ half, and the
two must not be merged.

**Evidence.** A run where the editor says _"punchier cuts than that"_, the agent records
`preferredPacing`, and the next run's context contains it — asserted on the assembled
prompt, not on the tool call.

---

## P5.3 — One tool surface for the whole run — `[ ]`

**Closes:** F5. **Touches:** `kernel/stage-policy.ts:126`, `orchestrator.ts#agentTools`.

Advertise one descriptor set for the whole run. Enforce the stage policy at **execution**
— refuse the call through the existing honest-failure path that `runAgentCall` already
implements for out-of-scope tools — instead of by withholding the schema.

The rationale for withholding is on the record and is good: _"Instruction has already been
tried… A tool that is absent cannot be called."_ This change keeps that guarantee's
outcome — the call still fails, and fails with a reason — and moves _where_ it is enforced.
What it buys is a stable prefix for the largest block in the prompt.

> **This is the one item in Phase 5 that trades a structural guarantee for a behavioural
> one, and it deserves its own scope review before implementation.** The counter-argument
> is real: a refused call still costs a turn, where an absent tool costs nothing. The
> measurable case for the change is 30,751 tokens re-billed per run against the cost of an
> occasional wasted call — but that trade should be checked against real run logs, not
> assumed. If the answer is no, the finding stands and the cost is a known, documented one.

**Evidence.** Benchmark section C: tool-set changes 2 → 0; cacheable prefix share ≥ 85% and
stable across every turn. Golden corpus green — the event stream must not move.

---

## Scope gate

- **User outcome.** A session accumulates. The second thing the editor asks for is faster,
  cheaper, and better-informed than the first, and the agent remembers how they like their
  cuts next time they open the project.
- **Current gap.** F5, F6, F7. Measured.
- **Minimum vertical slice.** P5.2 alone — one tool, existing setters, no new state. Or
  P5.1's facts-only subset. Either ships value independently.
- **Reuse.** `RunSnapshot.workingState` (built, persisted), `parseWorkingState` (built),
  `FactScope` (built, exactly the filter needed), `memory-store.ts` setters (built),
  `scoped-memory.ts` precedence (built), `stage-policy.ts` (built). **No new store, no
  schema change, no new dependency.**
- **Deferred.** Cross-project retrieval. A learned model of editorial taste. Merging the
  typed and narrative memory tiers. Memory in the browser build beyond what
  `Project.aiMemory` already gives it — the sidecar gap stays honest, as it does for
  proxies.
- **Evidence.** The two-run test; the preference round-trip on the assembled prompt;
  benchmark section C; `pnpm verify`.

## Risks

| Risk                                                     | Mitigation                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stale fact survives into a run where it is false       | `FactScope` filtering plus the revision check. When in doubt, drop it: re-reading is cheap and the run memo makes a repeat read free. A wrong carried-forward fact is worse than no fact — that is the whole reason `distil` refuses to record from failures, recalls and cache hits. |
| Carried context makes prompts grow every session         | Facts are bounded by construction (180-char statements, `briefing.ts`); evidence handles are references, not payloads. The benchmark's per-turn totals catch any drift.                                                                                                               |
| Model-authored memory becomes a prompt-injection surface | Closed key set, Zod-parsed, defensive read. No free-text memory tool.                                                                                                                                                                                                                 |
| P5.3 costs turns instead of tokens                       | Own scope review, checked against real run logs before implementation. If it does not hold up, the finding is documented and the cost is accepted knowingly.                                                                                                                          |
