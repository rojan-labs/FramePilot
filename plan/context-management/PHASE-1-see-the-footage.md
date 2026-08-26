# Phase 1 — The model can see the footage — `[x]`

> **Ships:** the agent reads the whole transcript and the whole timeline, on any model,
> without overflowing anyone's window.
> **Does not ship:** ranking, frame accuracy, new checks, memory. Selection is still
> head-of-list; it just stops being a keyhole.
> **Depends on:** nothing. This is the first thing to build.
> **Schema/deps:** none.

Today, an agent asked to find the strongest hook in a ten-minute recording can see 40% of
what was said. When it does the right thing and calls `get_transcript`, it gets **25 words
back out of 1,500**, cut mid-JSON, with no count and no instruction to narrow. It then
picks a hook from the first two minutes, because that is the only material it has.

Nothing about that is a reasoning failure. Phase 1 is the fix.

---

## P1.1 — `get_transcript` returns the transcript — `[x]`

**Closes:** F4. **Touches:** `packages/ai-sdk/src/orchestrator.ts:1499`
(`summarizeReadResult`).

`summarizeReadResult` has hand-written digests for 29 tools that keep every id and append
an explicit `(… N more <noun> not shown; <how to narrow>)` tail. Nine read/analysis tools
have **no case** and fall through to `previewJson(value, ANALYSIS_PREVIEW_MAX)` — a blind
1,200-character slice of the raw JSON that ends in a bare `…` and cuts mid-record:

`get_transcript`, `map_footage`, `read_edit_signals`, `transcribe`, `get_frame`,
`index_media`, `measure_color`, `get_selected_range`, `track_subject_automatically`.

Add a digest case for each, following the pattern the file already establishes.

- **`get_transcript`** — the load-bearing one. Words, not JSON:
  `12.34–12.61s but` per line, through `boundedRecords` with
  `READ_DIGEST_MAX_ITEMS`, tail `narrow get_transcript to a start/end window`. Mirror the
  `get_mapped_transcript` digest that already exists two cases away — same shape, source
  time instead of sequence time, and say which it is in the head line, because the
  distinction is exactly what the tool description warns about.
- **`map_footage`** — chapters and highlights in time order, whole records, count in the
  head. The head line becomes the run's durable fact (`briefing.ts#distil` keeps the first
  line), so it must carry the chapter count and the span.
- **`read_edit_signals`** — one line per signal, whole records, `kind t0–t1 observation
(from)`. Measured 18.3% fidelity today.
- The remaining six — smaller payloads; give them a head line and whole records so the
  digest is honest rather than merely shorter.

**Rules this must follow, from the file's own docstring:** bound by **record count, never
by characters**, so an id is never cut mid-token; drop **whole records** with an explicit
count; never a silent mid-list cut. The full untruncated object still reaches the UI popup
via the call's `data` — that path is unchanged.

**Evidence.** Benchmark section E: `get_transcript` 25/1,500 → 1,500/1,500 (or a declared
`N more`); `read_edit_signals` 11/60 → 60/60. A unit test per new case asserting the tail
appears when and only when records were dropped.

> Ship this on its own, first. It is the smallest change in the whole plan and the one
> most directly responsible for "the AI only ever finds a hook in the first thirty
> seconds".

**Shipped 2026-08-26.** All nine reads have a digest;
`READS_SERVED_BY_JSON_PREVIEW` is down to `detect_faces` (a refusal, no payload). Benchmark
section E: `get_transcript` **25/1,500 → 1,500/1,500 (1.7% → 100%)**, `read_edit_signals`
**11/60 → 60/60 (18.3% → 100%)**, both with no drop tail because nothing was dropped.

Two judgement calls the plan did not pre-decide:

- **Word-level reads get their own cap.** `READ_DIGEST_MAX_ITEMS` is 300, which is right
  for ids and would have swapped a 25-word keyhole for a 300-word one. `WORD_DIGEST_MAX_ITEMS`
  = 2,000 covers the north-star 5–15 minute recording in full (750–2,250 words) and applies
  to `get_transcript` and `get_mapped_transcript` alike; past it the tail declares the drop
  and names the narrowing argument.
- **Three digests deliberately withhold their payload, with the reason and the recovery
  call stated inline** — `transcribe` (the words are on the project; `get_transcript`
  returns them, and repeating them bills the transcript twice in one run),
  `measure_color` (the contract is that the model passes the handle and never retypes the
  numbers — printing them invites the forbidden move) and `track_subject_automatically`
  (per-frame geometry the tracked patch applies; the model never authors it). Each is a
  *declared* omission, which is P2.3's standard arriving early rather than a silent cut.

---

## P1.2 — The budget knows which model it is talking to — `[x]`

**Closes:** F2, F3, F8. **Touches:** `orchestrator.ts:273` (`contextWindowFor`), the four
`assembleContext` call sites (`:4480, :4661, :5139, :5208`), `context-builder.ts`.

Two independent bugs, one fix.

**No production caller sets `budget`.** Grepping `packages` and `apps` for `ContextBudget`
returns only test files. Every request therefore trims against `DEFAULT_CONTEXT_BUDGET`
(190,000 − 4,096 − 2,000 = **183,904 tokens**) whatever model is selected — +159,328 more
room than `ollama/qwen2.5-coder` has, and 799,136 less than Gemini's.

`providers/model-capabilities.ts` exists to end exactly this; its docstring calls the
hardcoded 190,000 "wrong in both directions". `contextWindowFor()` already resolves the
real window — **for the manifest, not for the trimmer.**

**The budgeter cannot see ~80% of the prompt.** `assembleContext`'s `cost()` sums the
system prompt, tier blocks, history and request. It omits tool schemas (17,490 tokens in
planning stages), the agent contract (1,775), and pinned skill bodies (up to 6,728).
`kernel/context/manifest.ts` _does_ count tool schemas, and says why: _"a tool set is real
prompt cost, and leaving it out was one reason the old indicator under-reported."_ The
reporting layer was fixed; the deciding layer was not.

Do:

- Resolve `ContextBudget` from `capabilitiesFor(provider, modelId)` at every
  `assembleContext` call site, and thread it on `ContextInput.budget`. An explicitly
  supplied budget still wins — `contextWindowFor`'s existing precedence rule is correct
  and stays.
- Subtract the **fixed prompt cost the budgeter does not assemble** — tool schemas, agent
  contract, pinned skills — before computing spendable room. The manifest already computes
  the tool-schema figure; do not compute it twice, and do not let the two disagree.
- Keep `DROP_ORDER` exactly as it is. It becomes a correct last resort instead of an
  incorrect one.

**Land this before P1.3.** P1.3 makes prompts bigger; without P1.2 the bigger prompts
overflow small windows and the failure is a provider error, not a trim.

**Evidence.** Benchmark section D: over-assumption ≤ 0 for every probed model. A test that
switching provider/model changes the room the trimmer uses. `withRemainder` in the
manifest should now find little or no unaccounted remainder — that gap closing is itself
the proof the two layers agree.

**Shipped 2026-08-26.** `ContextBudget` gains `reservedPromptTokens` — the prompt cost the
assembler does not build — and `budgetTokens` subtracts it. `resolveContextBudget(input,
provider, reserved)` (exported from `orchestrator.ts`) resolves window and output
reservation from `capabilitiesFor`, field by field, with an explicitly supplied budget
still winning per field. Every route now goes through it: `chat`, `plan`, `edit`,
`editVariations`, `autocomplete`, `generateAgentPlan`, `streamChat`, `streamPlan`,
`streamEdit`, `streamEditVariations`, and the agent loop's `agentMessages`.

Benchmark section D, over-assumption (trimmer room − real room):

| model                     | before   | after   |
| ------------------------- | -------- | ------- |
| ollama/qwen2.5-coder      | +159,328 | −21,265 |
| anthropic/claude-opus-4-5 | +47,904  | −21,265 |
| google/gemini-2.5-pro     | −799,136 | −21,265 |

Two judgement calls:

- **The tool-schema figure has one owner.** `manifest.ts` exports `toolSchemaCost` and the
  budgeter imports it, rather than computing the same number twice — a budget that
  disagrees with the manifest is exactly the condition ADR 0080 was written to end.
- **An agent run reserves the WIDEST tool set it can advertise, not the current stage's.**
  The stage policy narrows the set mid-run (F5), and a reservation that shrank and grew
  with it would let one turn fit under a budget the next turn exceeds. Reserving the
  maximum keeps the room stable for the whole run — which is also what P5.3 makes
  literally true.

---

## P1.3 — The slice grows into the room it has — `[x]`

**Closes:** F1. **Touches:** `context-builder.ts:127` (`MAX_TRANSCRIPT_WORDS = 600`),
`:135` (`MAX_CLIPS_PER_LAYER = 12`), `:430` (`assembleContext`).

Both are compile-time constants. They do not consult `ContextBudget`, the model, or the
capacity the manifest computes. The result is a project view that is **flat in project
size** — ~1,350 tokens whether the video is ten minutes or four hours:

| Scale  | Clips shown | Coverage  | Words shown  | Coverage  |
| ------ | ----------- | --------- | ------------ | --------- |
| 1 min  | 16 / 19     | 84.2%     | 150 / 150    | 100%      |
| 10 min | 24 / 188    | **12.8%** | 600 / 1,500  | **40.0%** |
| 60 min | 24 / 1,125  | 2.1%      | 600 / 9,000  | 6.7%      |
| 4 h    | 24 / 4,500  | 0.5%      | 600 / 36,000 | 1.7%      |

Plan `AI-ORCHESTRATION-REDESIGN.md` K2.2 set out to make the slice `O(slice)` rather than
`O(timeline)` and succeeded. What it never added is the other half: letting the slice grow
when there is room. On Opus at 60 minutes there are ~114,000 unused tokens while the model
is shown 2.1% of the cuts.

Do:

- Replace both constants with allocations derived from the spendable room P1.2 computes.
- **Floor at today's values.** A 32K-window model must behave exactly as it does now; this
  change may only ever add coverage, never remove it. That floor is what makes the change
  safe to ship without a per-model matrix of regressions.
- Allocate between the timeline and transcript tiers rather than letting one starve the
  other — a transcript that consumed the whole budget would leave the model unable to name
  a clip it wants to trim.
- Leave `DROP_ORDER` untouched.

**Evidence.** Benchmark section B: 10-min row ≥ 95% words, ≥ 90% clips; unused capacity at
60 min < 30,000. Section C: cacheable prefix share **stays ≥ 85%** — all growth lands in
the volatile tail, which was never cacheable, and the stable prefix must not move.

**Shipped 2026-08-26.** `MAX_TRANSCRIPT_WORDS` and `MAX_CLIPS_PER_LAYER` became
`MIN_TRANSCRIPT_WORDS` / `MIN_CLIPS_PER_LAYER` — floors, not caps — and
`allocateGroundingSlice` sizes both tiers from the room the budget leaves. The search is a
binary search whose oracle is the **real renderer**, not a per-item token estimate: a clip
line's cost depends on id length and time formatting, and an approximation that comes back
a few tokens over is how an allocation gets its whole tier dropped by the budgeter.
Neither tier can starve the other — each is guaranteed half, and whichever needs less
hands the rest back, in both directions.

Benchmark section B, against the model's **real** resolved budget (the benchmark used to
measure against the hardcoded 190K):

| scale       | clips before | after      | words before | after      |
| ----------- | ------------ | ---------- | ------------ | ---------- |
| 1 min       | 84.2%        | **100%**   | 100%         | **100%**   |
| 10 min ★    | 12.8%        | **100%**   | 40.0%        | **100%**   |
| 60 min      | 2.1%         | **100%**   | 6.7%         | **100%**   |
| 4 h         | 0.5%         | **100%**   | 1.7%         | **99.4%**  |

★ the north-star scale (D4). Both exit criteria (≥ 90% clips, ≥ 95% words) are met with
room to spare, and the 4-hour row is the allocator honestly bounding a project that
genuinely does not fit.

**Two things the plan got wrong, recorded rather than quietly fixed:**

- **"Unused capacity at 60 min < 30,000" is the wrong target, and is not met (88,563).**
  It was written assuming unused room means unshown project. At 60 minutes the model now
  sees 100% of the clips and 100% of the dialogue: the remaining window is genuinely
  spare, and padding the prompt to consume it would be a worse edit for more money. The
  benchmark now prints whether there is anything left to show alongside the figure, so
  the number cannot be read as waste again.
- **"All growth lands in the volatile tail, which was never cacheable" was true and was
  the problem.** Growing the slice put ~9,000 more tokens into the per-turn message and
  the cacheable share fell **85% → 45%** — coverage bought with cache, which the risk
  table forbids. The fix: only the TIMELINE summary actually varies per turn (it renders
  from the mutating working copy). The transcript, footage map, visual status, memory
  tiers and skills manifest are fixed for the run, so `AssembledContext.split` draws that
  line and the agent loop puts the stable half **above** its cache boundary.
  Steady-state cacheable share is now **91.5%** (baseline 81.1%). The two turns that read
  the transcript dip to 69%, which is inherent: P1.1 makes `get_transcript` return the
  whole transcript, and a tool result is turn-varying by definition.
  `assembleContext().messages` is unchanged, so every non-agent route keeps the prompt it
  had.

Golden fixtures moved as the plan predicted (an extra message in the agent request);
regenerated and reviewed in the same commit.

---

## Scope gate

- **User outcome.** The agent picks its hook and its cuts from the whole recording rather
  than from its first 40%.
- **Current gap.** F1–F4, F8. Measured; table above.
- **Minimum vertical slice.** P1.1 alone ships value on its own.
- **Reuse.** `capabilitiesFor` (built), `ContextBudget` (built, unused), `boundedRecords`
  (built), `ContextManifest` (built), the benchmark (built). **Nothing new is created.**
- **Deferred.** Ranking (Phase 2) — this phase still selects head-of-list, just far more
  of it. Summarizing a dropped tier instead of dropping it whole stays deferred: with the
  budget correct, tier-dropping stops firing in normal operation.
- **Evidence.** The benchmark rows above; golden-corpus fixtures green or their diffs
  reviewed as behaviour changes; `pnpm verify` clean.

## Risks

| Risk                                  | Mitigation                                                                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bigger prompts cost more per turn     | Growth is bounded by the _real_ window minus reservation, which is the money already paid for. Section C's cost columns make the delta explicit rather than a surprise on a bill.                                                             |
| Prompt-cache prefix destabilised      | All growth is in the volatile tail by construction. The benchmark's cacheable-share column fails loudly if not.                                                                                                                               |
| Golden fixtures move                  | Expected — prompt text changes. Per repo convention a regenerated fixture is a reviewed behaviour change in its own commit, never a silent one.                                                                                               |
| A model degrades on a long transcript | Real, and the reason the floor exists: coverage is capped by budget, and the benchmark makes any regression attributable. If a model reasons worse with full context, that is a model-selection finding, not a reason to keep showing it 40%. |
