# 02 — Make a run that has committed nothing stop gathering

**Status:** `[ ]` not started
**Depends on:** 01 (until the gate can fail, this is unmeasurable).
**Blast radius:** `packages/ai-sdk/src/orchestrator.ts` (`agentTools`, `executeToolCalls`),
`packages/ai-sdk/src/kernel/conductor.ts` (stall accounting), one new ADR amending 0147.

---

## Outcome

A run that has banked search results and downloaded nothing **cannot run another search**.
It is refused with an instructive message naming the legal moves, and the refusal does not
count against it as a stall.

---

## ⚠️ The obvious version of this is wrong — read this first

The lever as originally stated was: _"make a recovery turn refuse a recall when the run has
never attempted a download."_

**Refusing `recall_evidence` would re-open the exact trap round 3 closed.** From
`plan/PLAN.md`, round 3: the agent log keeps payloads for only the two freshest entries
(`AGENT_LOG_PAYLOAD_FRESH`), and **a stock `remoteId` exists nowhere else**. A run holding
twenty-one search handles can see the ids of at most eighty candidates without recalling.
`recall_evidence` is the contract's own answer, and ADR 0147's postscript makes it
unconditional on a recovery turn.

Withholding recall does not force commitment. It removes the only route to the `remoteId`
that `add_stock` requires, and the run deadlocks with no legal move — which is precisely
the ADR 0143 failure that ADR 0147 was written to reverse.

**The correct target is the search, not the recall.** The run's pathology is not that it
re-reads what it has; it is that it keeps fetching _more_ while holding unconsumed results.
62 recalls is the symptom. 19 searches with 13 downloads is the disease.

**Rule:** withhold a sourcing **search** when the evidence store already holds at least one
`search_*` result whose candidates have not all been consumed by an `add_*`.
**Never withhold `recall_evidence`. Never withhold inspection tools.**

---

## Where it goes

**Seam:** `Orchestrator#agentTools(scope, stage)` — `orchestrator.ts:2813`. Its body is one
`toolDescriptors(predicate)` filter (`:2826`–`:2875`) already carrying every withholding
rule (implicit-only, vision, action-recovery, question scope, `stageAllowsRole`).

**Change:** extend the `scope` union at `:2814` with `'commit-only'` and add **one arm**
inside the existing predicate.

**Both call sites must pass it:** `:6352` (the advertised set) and `:6519` (`allowedToolNames`,
the execution enforcement). Deriving them separately is how advertise and enforce drift.

> **Pre-existing defect to fix here:** stage narrowing via `agentTools('agent', stage)` is
> **advertised but never enforced** — `allowedToolNames` is passed only on the
> action-recovery path (`:6518`–`:6520`). A stage-withheld tool called anyway executes
> normally today. This work must close that, or `commit-only` is advisory too and we have
> built the same thing that already failed.

**Refusal shape:** reuse `withheldCallOutcome` — `orchestrator.ts:6825`. It already returns
`status: 'warning'` with _"not available on this turn … make the edit, recall_evidence …,
or ask_user. It becomes available again on the next turn."_ Do not invent a new shape.
Extend its message for this arm to name the banked candidates the run should be placing.

---

## When it engages

Enter `commit-only` when **all** hold:

1. `stage` is `apply` or later, **or** a recovery action has fired;
2. zero operations of role `sourcing`/`placement` have **succeeded** this run
   (`state.operations.every(op => op.status !== 'succeeded')` is too weak — an "Added asset"
   with no clip placed must not count as committing; count _placement_ separately);
3. the evidence store holds ≥1 `search_*` entry with unconsumed candidates.

Withhold **only** `search_stock`, `search_music`, `search_media`, `search_visual`,
`find_similar`. Leave everything else exactly as it is.

Release immediately on the first succeeded placement. This is a one-way latch per run —
it must not oscillate turn to turn.

---

## Deadlock states and their escape hatches

Each of these is a state where a naive implementation leaves no legal move. Every one needs
its named escape in the code, not in a comment.

| #   | State                                                                                 | Escape (mandatory)                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Empty project, zero searches banked                                                   | Condition 3 — never withhold search before a search has landed. This is ADR 0147's exact case.                                                                                                                                                                                                                             |
| 2   | `remoteId` aged out of the log payload window                                         | `recall_evidence` is **never** withheld.                                                                                                                                                                                                                                                                                   |
| 3   | Every download failed; nothing placeable                                              | Never withhold `inspection` tools (`get_timeline`, `get_project_state`, `list_assets`). A failed-acquire run must be able to see that and say so.                                                                                                                                                                          |
| 4   | Placement refused for lack of a free span (`stock-host.ts:86-94`)                     | Same as 3 — the run must be able to read occupancy and re-place.                                                                                                                                                                                                                                                           |
| 5   | Bin-mode `add_stock` → `add_clip`; the `assetId` is in an aged-out result             | Same as 2.                                                                                                                                                                                                                                                                                                                 |
| 6   | **A turn made entirely of withheld calls**                                            | A `warning` outcome produces no callFact and no novelty, so `learnedSomethingNew = false` → `noProgressStreak++` (`conductor.ts:1598`) → death at `MAX_NO_PROGRESS_TURNS = 2`. **A turn whose refusals were harness-caused must not increment the stall streak.** Without this the gate kills the run it is meant to save. |
| 7   | `ask_user` is not a real escape — no `askUser` host is wired (`orchestrator.ts:4620`) | Do not count it as a legal move in the refusal message unless the host exists.                                                                                                                                                                                                                                             |

---

## The second half — stop crediting gathering as progress

`loop-detector.ts:madeMeaningfulProgress` returns true on `learnedSomethingNew` alone.
Round 3 made a first-time recall count as progress, correctly — the run was being killed for
obeying its instructions. The side effect is that **gathering now satisfies the progress test
indefinitely**: a run can recall its way through a hundred distinct handles and never stall.

**Change:** keep the round-3 credit, but **cap it**. A run that has committed no placement
may bank at most _N_ consecutive novelty-only turns (start at 3, tune with evidence) before
`madeMeaningfulProgress` stops crediting novelty alone. After the cap, only
`attemptedEdit`/`appliedEdit`/`recordedVerification`/`committedDecision` count.

This is deliberately not a hard ban: the guard round 3 removed must stay removed for runs
that are genuinely making headway. What must not survive is _unbounded_ headway-free
gathering.

---

## Verification

**Unit** — `orchestrator.test.ts` / a new `commit-only` suite:

1. Zero searches banked → search is **not** withheld (state 1).
2. One search banked, unconsumed, zero placements, stage `apply` → `search_stock` withheld
   with a `warning` outcome naming the banked candidates.
3. `recall_evidence` is **never** withheld in any `commit-only` state (states 2, 5).
4. `get_timeline` / `get_project_state` / `list_assets` never withheld (states 3, 4).
5. The advertised set at `:6352` and `allowedToolNames` at `:6519` are **identical** for
   every scope — a table test over the scope union. This is the drift guard.
6. Calling a withheld tool anyway is refused at execution, not silently executed. Assert
   this for stage narrowing too (the pre-existing gap).
7. First succeeded placement releases the latch; a later failed placement does not re-engage
   it.

**Unit** — `loop-detector.test.ts` / `conductor.test.ts`:

8. A turn of only-withheld calls does **not** increment `noProgressStreak` (state 6).
   Assert the run survives 3 such turns.
9. Novelty-only turns stop counting as progress after the cap, and resume counting once a
   placement lands.

**Integration** — a replay fixture built from run `e36235cc`:

10. Given the run's state at 11:24:06 (12 stock clips on disk, 121 beats, 0 picture clips), the next turn
    cannot call `search_stock`, and `add_clip` is available.

**Commands:** `pnpm --filter @framepilot/ai-sdk test`, `pnpm typecheck`, `pnpm lint`.

---

## ADR obligation — non-negotiable

This **directly contradicts ADR 0147**, decision clause `docs/adr/0147-a-search-is-not-a-repeat.md:64-67`:

> "The whole `sourcing` role survives a recovery turn. `agentTools('action-recovery')`
> admits `effectClass: 'mutation'`, `kind: 'ask'`, `recall_evidence`, and
> `toolRole(...) === 'sourcing'`."

Withholding `search_stock`/`search_music` reinstates verbatim the ADR 0143 clause
(`0143:52-56`) that ADR 0147 reversed (`0147:34-38`).

**Write a new ADR amending 0147.** It must state the amendment precisely: the withholding
condition is the **memo**, not the role. A sourcing search is withheld only when unconsumed
search results are already banked; `recall_evidence` remains unconditional; inspection tools
remain unconditional. Record _why_ — 0147 was written for a run with **nothing** banked, and
this is the opposite state. Both ADRs are right about their own case; the new one names the
discriminator.

Do not amend by deletion. A later agent must be able to see that 0143 → 0147 → this is a
sequence of narrowing conditions, not a flip-flop.

---

## Definition of done

- [ ] `commit-only` scope exists on `agentTools`, passed at both `:6352` and `:6519`.
- [ ] Advertise/enforce parity is table-tested across the whole scope union.
- [ ] Stage narrowing is enforced, not just advertised.
- [ ] All seven deadlock escapes have a test.
- [ ] Harness-caused refusals do not increment the stall streak.
- [ ] Novelty-only progress is capped and releases on placement.
- [ ] New ADR amending 0147 merged; 0147 cross-referenced.
- [ ] `pnpm verify` green; `plan/PLAN.md` and `CHANGELOG.md` updated.
