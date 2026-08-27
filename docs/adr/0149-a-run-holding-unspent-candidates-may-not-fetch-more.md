# ADR 0149 — A run holding unspent candidates may not fetch more

**Status:** accepted
**Date:** 2026-08-27
**Amends:** ADR 0147 (a search is not a repeat) — narrows its "the whole `sourcing` role
survives a recovery turn" clause with one memo-derived condition
**Related:** ADR 0143 (sourcing is not reconnaissance), ADR 0075 (task memory / stage
policy / semantic loops), ADR 0080 (context manifest), ADR 0140 (stock media is placed as
a cutaway)

## Context

Captured run `e36235cc` (2026-08-27) is the same fifty-clip beat-synced montage brief as
`f1d5285e`, `f014f3ac`, `09529490` and `2131d2c5`, run after all four earlier rounds of
fixes. Those fixes worked: the run was not killed early, its nineteen stock searches all
succeeded, the recall trap was open, and the sourcing playbook was findable. It reached
`apply`, held a 121-beat grid and twelve downloaded clips, made 143 tool calls over 30
minutes and 367,398 billed tokens — and put **one clip on the timeline**, the music bed.

Sixty-two of those calls were `recall_evidence`. `loop-detector.ts`'s recovery imperative
("Make the next edit the request calls for … Do not read anything else first") fired from
run-state version 90 onward and the very next calls were `list_assets`, two recalls, seven
`describe_footage`, then nine more recalls. It is advisory text against a model that is
already ignoring advisory text — the fourth consecutive round in which the lever pulled was
a better sentence.

## The obvious structural version of this is wrong

The natural next lever is "make a recovery turn refuse a recall when the run has never
attempted a download." **That would re-open the trap ADR 0147's postscript closed.**

The agent log keeps payloads for `AGENT_LOG_PAYLOAD_FRESH` (2) turns, and a stock
`remoteId` exists nowhere else. A run holding twenty-one search handles can see the ids of
at most eighty of its candidates without recalling. Refusing a recall therefore does not
force commitment; it removes the only route to the argument `add_stock` takes, and the run
deadlocks with no legal move. That is precisely the ADR 0143 failure ADR 0147 was written
to reverse.

The run's pathology is not that it re-reads what it holds. It is that it keeps fetching
**more** while holding roughly six hundred unspent candidates and an empty picture track.
Nineteen searches, twelve downloads, zero picture placed.

## Decision

**Withhold the catalogue searches — never the recall, never inspection — and only from a
run that has banked results it has not spent.**

A new `commit-only` tool scope is `agent` minus `search_stock`, `search_music`,
`search_media`, `search_visual` and `find_similar`. It engages when **all** of:

1. the turn is at `apply` or later, or a recovery action has fired;
2. no picture placement (`add_clip`) has succeeded this run — an asset added to the media
   bin does not count, because that is the act the latch exists to distinguish from an edit;
3. the evidence store holds at least one catalogue-search handle.

Condition 3 is ADR 0147's case restated as a precondition rather than contradicted: on an
empty project nothing is withheld, because there is no `remoteId` to add by and the only
thing that mints one is the search that would be refused. The latch releases on the first
succeeded placement and does not re-engage.

Every other exclusion is a deadlock this would otherwise cause, and each has a test naming
it:

| Excluded                                           | The state it prevents                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `recall_evidence`                                  | the `remoteId` has aged out of the payload window and exists nowhere else                                                |
| `get_timeline`, `get_project_state`, `list_assets` | every download failed, or placement is refused for want of a free span, and the run must be able to read that and say so |
| `add_stock`, `add_music`, `add_clip`               | these SPEND a candidate; withholding them would withhold the act being demanded                                          |

Three further consequences follow, and none of them is optional:

- **`allowedToolNames` is now passed on every path.** It used to be threaded only for
  action recovery, so stage narrowing was advertised and never enforced — a stage-withheld
  tool called anyway simply executed. A withholding scope the model can step around is the
  same advisory lever that has failed four times.
- **A turn made entirely of harness refusals does not increment `noProgressStreak`.** A
  withheld call returns a `warning` with no payload, so it banks no fact and no novelty;
  without this, the gate that exists to save a stalling run would kill it in two turns.
- **The refusal names the way out.** A refusal that only says "no" is how ADR 0143 stranded
  a run. `ask_user` is deliberately not offered — no `askUser` host is wired, so naming it
  would advertise an escape that does not exist.

## The bound on gathering already existed, and its refund was wrong

ADR 0147's round-3 companion made a first-time recall count as progress, correctly: runs
were being killed for obeying an instruction to recall rather than re-read. The side effect
is that gathering became able to satisfy `madeMeaningfulProgress` indefinitely — novelty is
keyed per evidence handle, so a run can walk a hundred distinct handles and never once fail
the progress test. `e36235cc` did exactly that.
**A cap on novelty-only turns was the obvious answer and it was the wrong one.** It was
tried, and it duplicated `RESEARCH_BUDGET_TURNS`, which already bounds precisely this —
"this turn gathered without attempting an edit, so it spends research budget" — and is
tuned, tested, and reached through `actionRecoveryPending`. A second cap at a lower number
silently pre-empted both it and the diminishing-returns guard, and three conductor tests
immediately began asserting that a run stopped for a reason that was no longer the true
one. Five interacting run-stoppers is already the count at which one stops being reachable;
a sixth is not a fix.

The real defect was in that budget's **refund**. It read `turnOpCount > 0`, and stocking
the media bin produces operations — so the captured run's thirteen "Added asset"
operations, spread across the run, refunded the whole eight-turn budget again and again.
The guard built to force research→execute could not fire on a run that spent thirty minutes
researching, because downloading counted as executing.

`turnPlacementCount` now drives the refund. A turn that only puts material in the bin has
not left reconnaissance; it has restocked it. This is deliberately the **same line** the
commit-only latch draws — one rule about what counts as editing, applied in two places,
rather than two rules that can drift. A caller that does not report placements keeps the
old behaviour, so the change is additive.

## Consequences

**Good.** A run cannot spend a whole session gathering, and the guard that says so can
finally fire. The refusal is specific, names the
banked candidates, and points at the tool that spends them. Stage narrowing is enforced for
the first time. No new run-stopper was added — the existing one was repaired.

**Costs.** One more scope on `agentTools`, and a latch whose conditions must be read
together to understand any one of them. The withholding is narrow enough that a
mis-specified condition strands a run — which is why the deadlock table above is tested
rather than argued.

**Sequence, not flip-flop.** ADR 0143 withheld the sourcing role on a recovery turn. ADR
0147 reversed that for a run with **nothing** banked. This narrows 0147 for the opposite
state — a run with candidates it has not spent. All three are right about their own case;
this one names the discriminator, which is the memo rather than the role. A later agent
must be able to read the three in order and see a sequence of narrowing conditions.
