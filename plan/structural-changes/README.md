# Structural changes — montage run gap analysis, round 5

**Created:** 2026-08-27 · **Source evidence:** `run.md` (conversation `0049aed5`, runs
`e36235cc` + `4aa31c96`) · **Status:** `[ ]` not started

---

## The problem in one paragraph

The same 50-clip beat-synced montage brief has now been captured five times. Rounds 1–4
closed harness defects and **they worked**: the run no longer dies early, its searches
succeed, the recall trap is open, the sourcing playbook is findable. Run `e36235cc` reached
`apply`, held a 121-beat grid and 12 downloaded clips, spent 30 minutes and $1.43 — and
delivered a timeline with **one clip on it**, the music bed. Then it reported
**`completed`**. What remains is not the harness.

## Reading order

| Doc                                                        | What it settles                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`00-DIAGNOSIS.md`](00-DIAGNOSIS.md)                       | The forensics. What the run did, what it cost, and the core issues, each traced to a file and line.                   |
| [`01-ACCEPTANCE-GATE.md`](01-ACCEPTANCE-GATE.md)           | **Do this first.** One regex disabled the entire quality gate.                                                        |
| [`02-COMMITMENT-GATE.md`](02-COMMITMENT-GATE.md)           | Make a run that has committed nothing stop gathering. Includes why the obvious version of this is wrong.              |
| [`03-PARALLEL-ACQUISITION.md`](03-PARALLEL-ACQUISITION.md) | Split `add_stock` into parallel acquire + serial commit. ≈960s → ≈250s.                                               |
| [`04-SUPPORTING-DEFECTS.md`](04-SUPPORTING-DEFECTS.md)     | D1–D5: blind selection, wrong orientation, degraded queries, duplicated brief, lost objective on continuation.        |
| [`05-CONTEXT-ECONOMICS.md`](05-CONTEXT-ECONOMICS.md)       | 52 context rebuilds, 1.22M input tokens, 60% of it tool definitions. Why the recall loop is architecturally mandated. |

## The five core issues

**A. One regex disabled the entire quality gate.**
`acceptance.ts:explicitMinShotCount` correctly reads `50` from `50+ visually distinct clips`,
then discards it: a guard meant to reject _"30 second cuts"_ also matches `0.50s` in the
brief's own beat-map **example table** (`.` is a non-word character, so `\b` matches inside
`0.50s`). With no `minShotCount`, `critic.ts:checkShotCount` reports `skipped`, `r.ok` stays
true, and `conductor.ts:1783` folds a 1-clip timeline to `complete`. **The gate was built,
wired and correct. A false positive switched it off.**

**B. Sequential downloads consumed half the run.**
All 18 `add_stock` calls ran strictly serially (verified by timestamp) — ≈960s, 16 of 30
minutes, 33% failing. `search_stock` is already parallel; `add_stock` is excluded by one
contract row that conflates a network fetch with a timeline patch.

**C. The model gathers instead of committing.**
62 `recall_evidence` calls. The recovery action fired and was ignored — it is advisory text
against a model already ignoring advisory text. Round 3 made a first-time recall count as
progress (correctly), and the side effect is that gathering now satisfies the progress test
without bound.

**E. Context is rebuilt 52 times and 60% of it is a tool catalogue.**
1,223,811 input tokens across 52 model calls. `tool_schemas` alone is **736,595 (60.2%)**.
Context per call never grows and never compacts — it oscillates 19k–42k against a 128k window
that peaked at 33% used. Meanwhile the findings budget is capped at **1,000 tokens**
(`AGENT_LOG_CLEAR_THRESHOLD_TOKENS`), so the model is given ~17× more context about tools it
could call than about what it has found. A `remoteId` lives only in a payload that survives
two turns — which is why the 62 recalls are _mandated_, not chosen.

**D. Supporting defects.** `describe_footage` returns `not_indexed` for every downloaded
clip, so selection was blind; searches asked for `landscape` on a 9:16 brief; music queries
silently degrade to the first two words; the brief is serialized twice per turn; and
`continue from here` discarded the 50-clip requirement outright.

## Three findings that invert stated assumptions

**Recalls are cheap in latency, not in tokens.** Every `recall_evidence` completes in 0ms.
The 62 of them cost **≈289,370 tokens — 37% of all tool output in the run**, the single
largest line item. Round 4 shrank the stored payload and was right to; the count is what
remains. Any fix that only makes recall _faster_ makes this worse.

**The context is not growing — it is being rebuilt.** The UI shows a small per-call number
because each call genuinely is small (~23.5k of 128k). Nothing aggregates them, and nothing
reports the schema share or the cached share, so a 1.22M-token run looks like 52 healthy
ones. See `05`.

**Refusing a recall would re-break what round 3 fixed.** The lever as first stated —
_"make a recovery turn refuse a recall when the run has never attempted a download"_ — is the
wrong target. A stock `remoteId` exists nowhere but the recalled payload
(`AGENT_LOG_PAYLOAD_FRESH` keeps only the two freshest), so refusing recall does not force
commitment; it removes the only route to the argument `add_stock` requires, and the run
deadlocks. That is the ADR 0143 failure ADR 0147 was written to reverse. **The correct target
is the next search, not the recall** — withhold a sourcing search when unconsumed results are
already banked. See `02` for the full argument and the seven deadlock states that must have
escapes.

## Sequencing

```
01 ACCEPTANCE GATE  ─────────────┐   (must be first — nothing else is measurable until
                                 │    a 1-clip run stops reporting success)
                                 ├──► 02 COMMITMENT GATE  ──┐
                                 │    + D1, D2               │
                                 ├──► 03 PARALLEL ACQUIRE  ──┼──► round-5 re-run
                                 │    (independent of 02)    │
                                 └──► 05 CONTEXT ECONOMICS ──┘
                                      05 Change 2 step 1 first
                                                             └──► D3, D4, D5
```

**Do `05`'s Change 2 step 1 early and on its own**: measure whether the OpenRouter path
honours the cache breakpoint. If it does not, 736,595 tokens were billed at full price and
that finding outranks everything else here.

**01 gates everything.** A run that reports success at 1 clip gives no signal about whether
02 or 03 helped. 01 converts the outcome into a blocked run with a named reason — that is the
instrument the rest of the work is measured with.

**02 and 03 are independent** and can land in parallel. **D1 and D2 ship with 02**: a run
forced to commit will otherwise commit blindly, from landscape plates, which is a different
bad outcome rather than a fixed one.

## Success criteria for the round-5 re-run

Same brief, same project shape. The run must satisfy **all** of:

- [ ] The timeline holds **≥50 picture clips**, or the run reports `failed` naming the
      shortfall. Either is a pass for this programme; today's silent `completed` at 1 clip
      is the failure.
- [ ] `add_stock` wall clock for ~18 downloads is **≤300s** (from ≈960s), failures **<33%**.
- [ ] `recall_evidence` calls **<20** (from 62); billed run tokens **<200k** (from 367k).
- [ ] Model calls **<25** (from 52); total assembled input **<400k** (from 1.22M); mean tool
      calls per turn **>5** (from 2.82); cached share on the live provider path measured and
      non-zero.
- [ ] `describe_footage` returns packets for downloaded stock, or a clean `not_indexed` when
      no API key is configured.
- [ ] The acceptance criteria recorded on the objective include
      `The cut uses at least 50 distinct shots.`
- [ ] No run terminates needing the user to type "continue from here".

Publish the measured numbers in `plan/PLAN.md` alongside rounds 1–4. **If the clip count does
not move, do not add another advisory prompt** — that lever has now been pulled four times.
Re-read what the run held at the moment it stopped, as `00-DIAGNOSIS.md` does.

## Constraints carried from `CLAUDE.md` / `AGENTS.md`

- Desktop is the priority path (`fp-media://`, sidecar proxies, on-disk media).
- No schema change without a migration. None of 01–04 needs one.
- **Ask before** changing the tool contract's `permissions`, broadening the path sandbox or
  the agent tool surface, or adding a dependency.
- ADR obligations: **02 requires a new ADR amending 0147** (do not amend by deletion — the
  0143 → 0147 → new sequence must stay legible). **03 requires an ADR** for the two-phase
  execution model.
- Long-form performance claims need desktop-scale evidence, not fixtures (`CLAUDE.md` §3).
- Skill and tool-descriptor edits shift `ai-sdk` token goldens; the diff **is** the measured
  token delta.
