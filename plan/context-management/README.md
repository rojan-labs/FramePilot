# Context-aware professional editing — `[x]` five phases, all closed

> **Sub-plan index.** Created 2026-08-26; closed out 2026-08-26.
> Parent entry: `plan/PLAN.md` → **CTXBENCH** (diagnosis) and **CTX-P1…CTX-P5** (the work).
> **Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
>
> **Status: all five phases shipped.** Before/after evidence:
> `reports/context-benchmark-baseline.{txt,json}` → `reports/context-benchmark-after.{txt,json}`.
> One item is deliberately **not** shipped and says so with its reasoning — P5.3's
> behavioural half (see §4). One decision reversed a claim this plan made about the
> codebase: a frame grid already existed, and only ran for AI-authored edits (ADR 0146).

FramePilot's agent does not cut like a professional editor. This plan says why, in
measured terms, and what to build.

The diagnosis is in [`DIAGNOSIS-AND-BENCHMARK.md`](./DIAGNOSIS-AND-BENCHMARK.md). Its
headline:

> On a 60-minute project, one planning turn costs ~22,300 tokens. **1,346 of them (6.0%)
> describe the user's video.** The model is shown **2.1% of the clips and 6.7% of the
> dialogue** — while ~114,000 tokens of the model's window sit unused.

## The one idea

A professional editor's precision is not a separate skill from their knowledge of the
footage. It _is_ their knowledge of the footage. They cut on the frame where the hand
lands because they watched the take; they leave the audio running two frames past the
picture because they heard the line finish. Precision is what knowing the material looks
like when it reaches the timeline.

So "strongest context management" and "very precise professional edits" are not two
programmes. They are one, in five steps:

```
Phase 1  SEE       the model can see the footage at all
Phase 2  SELECT    it sees the part that matters, and knows what it is not seeing
Phase 3  PLACE     the cut lands on the frame it was aimed at, in preview and in export
Phase 4  JUDGE     it reviews its own cut the way an editor does, and repairs what it can
Phase 5  REMEMBER  it does not re-learn the footage, or the editor's taste, every turn
```

Each phase is a complete, stoppable unit that improves finished-edit quality on its own.
None of them is a foundation for a later payoff.

## Files

| File                                                                       | What it holds                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `README.md` (this)                                                         | Decision record, scope gates, sequencing, definition of done          |
| [`DIAGNOSIS-AND-BENCHMARK.md`](./DIAGNOSIS-AND-BENCHMARK.md)               | Findings F1–F10 with evidence, the benchmark, the target architecture |
| [`PHASE-1-see-the-footage.md`](./PHASE-1-see-the-footage.md)               | Honest reads · authoritative budget · budget-derived slices           |
| [`PHASE-2-select-what-matters.md`](./PHASE-2-select-what-matters.md)       | Ranked retrieval · declared omission · retrieval that widens          |
| [`PHASE-3-frame-accurate-edits.md`](./PHASE-3-frame-accurate-edits.md)     | The frame grid · edit-point vocabulary · preview/export agreement     |
| [`PHASE-4-editorial-judgement.md`](./PHASE-4-editorial-judgement.md)       | Continuity checks · craft checks · repair that can actually fix them  |
| [`PHASE-5-memory-across-sessions.md`](./PHASE-5-memory-across-sessions.md) | Cross-run run memory · taught preferences · a stable tool surface     |

---

## 1. Decision record

Recorded so a later agent does not silently reverse these
(`.agents/rules/product-discipline.mdc` §10).

### D1 — Context management is not being rebuilt. It is being connected.

The audit found the machinery already present and, in most respects, good: tiered
budgeting with a drop order, payload-clearing compaction, a distilled state briefing,
context invariants that refuse an amnesiac prompt, and a per-request manifest that already
accounts for tool schemas. Four things are hardcoded constants that should read a number
the codebase already computes, and one finished module (`semantic-index-slice.ts`) has no
caller.

**No new framework, runtime, protocol, store, provider layer or generalized abstraction
appears anywhere in these five phases.** Every phase names the existing module it extends.
If a phase's implementation starts creating a parallel system, that is the signal to stop
and re-read this line.

### D2 — Precision means a frame grid, and that is a schema decision

Timeline times are floating-point seconds. There is no frame quantization anywhere in
`packages/editor-core`, `packages/timeline-schema`, or the Python compiler — the compiler
carries a 1 ms `_CUT_ADJACENCY_TOLERANCE` specifically to absorb float noise
(`render/compiler.py:399`). A cut at `12.3874s` on a 30 fps timeline sits 0.4 of a frame
from any real frame boundary, and nothing in the stack decides which frame it means.

Phase 3 fixes this and is therefore **the one phase that touches the schema**. Per
`CLAUDE.md` §5 it requires maintainer approval, a migration, an ADR, and a
`product-scope-reviewer` pass **before** implementation begins. Phases 1, 2, 4 and 5 need
no schema change and no new dependency.

### D3 — Coverage is measured, not asserted

Every phase's exit criteria are rows in
`node packages/ai-sdk/scripts/context-benchmark.mjs`, a deterministic model-free harness,
against the frozen baseline in `reports/context-benchmark-baseline.json`. "The prompts
feel better" does not close a phase. A phase that cannot state its number does not ship.

### D4 — The north-star case is the acceptance case

`.agents/rules/product-discipline.mdc` §1: _given a real 5–15 minute source recording,
produce a polished 30–90 second short with a strong hook, coherent cuts, removed dead
time, accurate captions…_. That is a **10-minute project**, which the benchmark measures
directly. Every phase reports its effect on that row first, and on the 60-minute and
4-hour rows second. A phase that only improves the 4-hour case has optimized for a project
FramePilot's first niche does not have.

### D5 — Deferred, deliberately

Not in any of the five phases, so their absence is not read as an oversight:

- **Multicam, DAW-grade audio, advanced grading, sophisticated masking/tracking.**
  `product-discipline.mdc` §2 ranks these last, and none of them is what makes the current
  edits cheap.
- **A learned relevance model.** Phase 2's ranking is deterministic and inspectable.
  Training a ranker over editorial relevance is a research project, not a phase.
- **Cross-project retrieval.** Phase 5's memory stays scoped to project and user, matching
  the existing `scoped-memory.ts` precedence rule.
- **Replacing the Conductor, the briefing, the evidence store, or the tool registry's
  shape.** All four are working. Phases extend them; none rewrites them.
- **A new eval harness.** The golden corpus, the manifest, the cost meter and the
  benchmark already exist and are reused.

---

## 2. Sequencing

```
Phase 1 ──────────────→ Phase 2 ──────────────→ Phase 4
  see                    select                  judge
   │                       │                       ↑
   │                       └───────────────────────┤
   │                                               │
   └──────────────→ Phase 3 ──────────────────────┘
                    place (schema-gated)

                    Phase 5 ── depends on 1; multiplies 1–4; ship last
                    remember
```

- **1 before 2.** Ranking is how you choose what to send when not everything fits. Until
  the budget is authoritative (Phase 1), the system does not know what fits, so a ranker
  has no budget to rank against.
- **1 before 3.** A frame grid is worth having whether or not the model can see the
  footage — but the _reason_ to want one is a model precise enough to aim at a frame,
  which is Phase 1's output.
- **3 before 4.** Continuity checks measure distances between cut points. Without a frame
  grid those distances are float noise, and the checks would fire on rounding.
- **2 and 3 are independent of each other.** They may run in parallel by different owners.
  Phase 3 may be blocked on maintainer approval (D2) while Phase 2 proceeds.
- **5 last.** Memory multiplies whatever the agent does. Persisting judgements made
  before Phase 4 means persisting the wrong ones.

**Recommended shipping order if only some of this gets built:**
`Phase 1 → Phase 3 → Phase 4 → Phase 2 → Phase 5`. Phase 1 is the largest quality gain per
line changed; Phase 3+4 together are what turn "an AI that edits" into "an editor". Phase 2
matters most on long footage, which is the second niche, not the first.

---

## 3. Scope gate — the programme as a whole

Per `.agents/rules/product-discipline.mdc` §3. Each phase file repeats this for itself.

- **User outcome.** Given a 10-minute screen recording, the agent watches the whole thing,
  cuts on the frame it aimed at, checks its own cut for jump cuts and dead air, fixes what
  it finds, and remembers the editor's corrections next session. Today it sees 40% of the
  dialogue, cuts to arbitrary sub-frame times, checks duration and clipping, and forgets
  everything at the run boundary.
- **Current gap.** Measured in `DIAGNOSIS-AND-BENCHMARK.md` §2, findings F1–F10, plus the
  frame-grid gap recorded as D2 above.
- **Minimum vertical slice.** Phase 1 alone, and within Phase 1, **CTX1 alone** — one
  digest case for `get_transcript`. It is a few dozen lines and it is the difference
  between the model reading 25 words of a recording and reading all of them.
- **Reuse.** `capabilitiesFor`, `ContextBudget`, `getSlice`, `ContextManifest`,
  `boundedRecords`, `summarizeReadResult`, `critic.ts`, `acceptance.ts`,
  `memory-store.ts`, `RunSnapshot.workingState`, the golden corpus, the benchmark. All
  built; several unused.
- **Deferred.** D5 above.
- **Evidence.** Benchmark deltas per phase (§4), golden-corpus fixtures green or their
  diffs reviewed, and for Phases 3–4 a **rendered** before/after on a real recording —
  not a fixture. `product-discipline.mdc` forbids supporting a long-form claim with tiny
  fixtures alone.

---

## 4. Definition of done, by phase

Numbers are benchmark rows. `before` is
`reports/context-benchmark-baseline.json` (2026-08-26).

| Phase | Metric                                  | Before                      | Target                                 | **Measured**                                |
| ----- | --------------------------------------- | --------------------------- | -------------------------------------- | ------------------------------------------- |
| 1     | `get_transcript` fidelity               | 1.7%, undeclared            | 100% or declared omission              | **100%**                                    |
| 1     | Word coverage, 10-min project           | 40.0%                       | ≥ 95%                                  | **100%**                                    |
| 1     | Clip coverage, 10-min project           | 12.8%                       | ≥ 90%                                  | **100%**                                    |
| 1     | Budget over-assumption, worst model     | +159,328                    | ≤ 0 for every model                    | **−21,497 everywhere**                      |
| 1     | Unused capacity, 60-min, Opus           | 113,667                     | < 30,000                               | **88,308 — target retired, see below**      |
| 2     | Word coverage, 60-min project           | 6.7%                        | ≥ 60%, ranked                          | **100%**                                    |
| 2     | Omissions carrying a recall handle      | 0 of 9 fall-through reads   | all                                    | **9 of 9**                                  |
| 3     | Cut points off the frame grid           | unmeasured (no grid exists) | 0                                      | **0** (property test, 6 rates × 12 seeds)   |
| 3     | Preview/export cut-point divergence     | unmeasured                  | 0 frames                               | **0 at the delivery rate**; +1 if resampled |
| 4     | Critic checks covering continuity       | 0 of 14                     | ≥ 5, each repairable or honestly gated | **6 of 18**, 2 fixable, 4 gated             |
| 5     | Facts re-derived on turn 2 of a session | all                         | 0 for still-valid facts                | **0**                                       |
| 5     | Tool-set changes per run                | 2 (30,751 tokens re-billed) | 0                                      | **2 — not shipped, now measured**           |
| all   | Cacheable prefix share, steady state    | 81–86%                      | ≥ 85% — **must not regress**           | **91.6%**                                   |

Two rows did not land as written, and both are findings rather than shortfalls:

- **Unused capacity at 60 minutes (88,308, target < 30,000).** The target assumed unused
  room means unshown project. At 60 minutes the model now sees 100% of the clips and 100%
  of the dialogue: the rest of the window is genuinely spare, and padding the prompt to
  consume it would be a worse edit for more money. The benchmark now prints whether
  anything is left to show beside the figure, so it cannot be read as waste again.
- **Tool-set changes (still 2).** P5.3's behavioural half is deliberately not shipped —
  see that phase file. The cost is now reported per request as
  `ContextManifest.usage.toolSchemaTokensRebilled` instead of being invisible, and the
  trigger for revisiting is recorded.

Everything else met or beat its target. Note that the fixed per-turn overhead grew
slightly (21,005 → 21,237 tokens) — one new tool (`remember_preference`) and the frame
vocabulary added to two skills. That is the price of Phases 3 and 5 and it is 1.1%.

Plus, for every phase: `pnpm verify` clean, golden-corpus fixtures green or reviewed, and
the phase's own tests meaningful on behaviour and error paths (`AGENTS.md` §4).
