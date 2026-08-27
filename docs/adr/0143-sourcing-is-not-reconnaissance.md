# ADR 0143 — Sourcing is not reconnaissance

**Status:** accepted; amended by ADR 0147 (a recovery turn keeps the whole `sourcing`
role, not only its mutating half)
**Date:** 2026-08-26
**Related:** ADR 0068 (descriptor withholding), ADR 0074 (empty-run honesty), ADR 0075
(task memory / stage policy), ADR 0083 (never report an edit on an unchanged timeline),
ADR 0140 (stock media is placed as a cutaway), ADR 0142 (a run learns what the host did
with its patch)

## Context

A captured agent run (`e30c1fe9`, 2026-08-26) was asked for a 30-second vertical Reel on
an empty project. It searched a stock library eight times, found eighty usable clips,
recorded them all as evidence — and delivered thirty seconds of white text on black. Not
one frame of picture reached the timeline.

Every individual mechanism behaved as designed:

1. **`add_stock` and `add_music` are registered with `kind: 'analysis'`.** They are reached
   through a search, and the registry kind describes how a tool is called rather than what
   it does. Both, in fact, download a third-party file and place a clip through a
   reversible patch — which `tool-contract.ts` has always declared as
   `effectClass: 'mutation'` with `write` permission.
2. **`stageAllowsRole` closes an executing run to fresh reconnaissance** (ADR 0075 §3.6):
   once a patch has landed, analysis and guidance descriptors are withheld, because the
   evidence for the plan is already stored and the way to check a detail is
   `recall_evidence`. The run laid a spine of three empty tracks first, which put it in
   `apply` — and from that moment its tool list contained nothing that could fetch media.
3. **The action-recovery turn filtered on `kind === 'mutate'`.** That turn exists to force
   a run that has gathered enough to ACT; it refused the one call that acts, and reported
   it as `Skipped redundant add_stock call`.

The model was told the download it had never made was already in hand. It moved on and
built what it could: text.

## Decision

**A tool that brings new material into a project is neither reconnaissance nor an ordinary
edit. It gets its own role — `sourcing` — and the stage machine keeps it open.**

`search_stock`, `add_stock`, `search_music` and `add_music` are classified
`role: 'sourcing'`. `stageAllowsRole` withholds `analysis` and `guidance` in execution
stages and says nothing about `sourcing`, so an executing run can still shop.

**The gates that scope a turn read the execution contract, not the registry kind.**
`agentTools('action-recovery')` now admits anything whose `toolContract().effectClass` is
`'mutation'` — which is how `add_stock`/`add_music` survive a recovery turn while
`search_stock`/`search_music` correctly do not: that turn exists because the run has looked
enough, and a download is the act it is being asked for.

> **Amended by ADR 0147.** That last clause held for the run this ADR was written from,
> which had eighty clips in hand and was refused the download. It is false for a run that
> has found nothing yet: `add_stock` places a clip by `remoteId`, and only the search mints
> one, so on an empty project the recovery turn had no legal move at all. The surface now
> admits the whole `sourcing` role.

**A withheld tool is refused with the reason that is actually true.** The refusal consults
the run's memo: a result genuinely in hand names the handle that returns it; anything else
says the tool is unavailable on this turn, what the turn is for, and that it returns next
turn — as a warning, because a harness restriction is not the model's error.

## Why the stage rule does not simply apply here

The rule ADR 0075 states is "the evidence for the plan is already stored, so recall it
rather than gathering again". That is true of a transcript, a beat grid, a footage map —
things derived from material the project already owns. It is false of a stock library,
which holds material the project does _not_ own and which `recall_evidence` cannot
conjure. Withholding a search of the user's own footage during execution is a considered
constraint; withholding the only route to any footage at all is a run that cannot make a
video.

## Consequences

- An agent run on an empty project can acquire media at any point in its life, which is
  the ordinary shape of "make me a reel about X".
- The advertised surface grows in the two narrowed scopes: +827 tokens in `apply`, +775 on
  a recovery turn. The golden manifests carry that measurement.
- Three classification systems still exist — registry `kind`/`mutates`,
  `TOOL_CLASSIFICATION.role`, and `toolContract().effectClass`. They now agree about
  sourcing, and the contract is the one the scoping gates consult. Collapsing them is
  worth doing and is not done here.
- `stageAdvanceFor` closes `analyze` on an applied patch as well as on a mutation role, so
  a run whose only mutation is a download still advances.

## Alternatives considered

**Re-register `add_stock` as `kind: 'mutate'`.** It would fix the scoping and break the
call: `operationsForCall` builds ops for a mutating tool from its arguments alone, and
these tools produce theirs from what the host downloaded. The kind describes the dispatch
path and is right as it stands.

**Leave the stage rule and let the run gather everything up front.** This is what the
current design assumes, and it is how a careful editor works — but it makes the first
applied patch an irreversible commitment to whatever media the run happened to have, and
that patch is often the empty spine a run lays before it starts. One captured run is
enough evidence that the assumption does not hold.
