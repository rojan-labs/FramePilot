# ADR 0157 — The grid follows the music under the picture

**Status:** accepted
**Date:** 2026-08-29
**Schema:** unchanged
**Related:** ADR 0126 (one mutating AI runtime), ADR 0132 (the beat grid has a caller),
ADR 0137 (the runtime measures, the agent decides), ADR 0143 / ADR 0147 (a refusal must name
a legal move), ADR 0156 (the sidecar sandbox-root outage — the same project, the turn before)

## Context

Run `ea8e46ec` was given 61 hiking photographs and a beat-synced Instagram Reel to build. It
spent 35 minutes, 41 model calls, 645 769 tokens and $4.40, and delivered **no picture at
all**. The timeline it ended with held one music clip.

The brief said, in so many words:

> Evaluate multiple suitable tracks and select the strongest one.

The run did exactly that. It downloaded three candidates and analysed all three in one turn:

```
Finding the beat in Uplifting_adventure_music.mp3 — completed · 231ms   → 53 beats, ~152 BPM
Finding the beat in Epic_Orchestral_Adventure_Theme.mp3 — completed · 249ms → 91 beats, ~162 BPM
Finding the beat in Skyline_run_….mp3 — completed · 132ms  → 119 beats, ~172 BPM
```

All three at `18:03:44.725` — one turn, three calls. It chose _Skyline run_, placed it on
`music_2` at `0 → 27.533s`, and proposed the 61-photo montage. Six times. Every one was
refused with the same sentence:

> rejected by the beat grid: this step cuts to detected beats, but the analyzed audio asset
> `"music_openverse_4c9cb2da…"` is not on the timeline and this proposal does not place it …

`4c9cb2da` is _Epic Orchestral Adventure Theme_ — the **middle** of the three parallel
analyses, and a track the editor had not chosen.

The model diagnosed its own situation exactly right, at `18:12:56`:

> I see — the system's beat grid is tracking a different audio asset than what's actually
> placed on the timeline. Let me detect beats on the placed music.

It called `detect_beats` on the track that was on the timeline. The runtime answered
**"Skipped redundant detect_beats call"**, and later **"detect_beats is unavailable this
turn"**, until the run died. The editor was told: _"The run stopped making progress — no
further edits could be found for this request."_

## The five things that had to be true at once

1. **Beat evidence was one field.** `HostCallContext.beatEvidence = { current?: unknown }`,
   written by every settled `detect_beats`. `detect_beats` is a `pure_read`, so
   `tool-contract.ts` declares it `concurrency: 'parallel'` and three calls in one turn go
   through `mapBounded` — three writers, one slot, survivor decided by completion order.
2. **The grid asked the wrong question.** It read one `assetId` off that one payload and
   demanded _that_ asset be on the timeline, rather than asking which analysed track the
   picture is actually cut against.
3. **Groundedness vetoed unconditionally.** The module's own governing rule — reject only
   what the run PROMISED via `hardSync`, otherwise measure and report — was applied to
   off-grid cuts and not to an ungrounded grid. This run never declared `hardSync`.
4. **The remedy was forbidden.** `stageAllowsRole` closes every `analysis` tool once a run is
   executing. `add_clips` (a mutation) stays open throughout `apply`, and its validation
   consumes `detect_beats`' payload — so the run kept the tool that is CHECKED and lost the
   only sanctioned way to establish what it is checked against.
5. **Nothing bounded the retry, and nothing explained it.** "A rejected op is a bounded
   retry" reset the stall streak on every attempt, so six identical refusals read as six
   attempts at progress; and the account of a refusal was gated on the run landing _nothing_,
   so a run with two audio operations on the board explained none of it.

## Decision

### Beat evidence is a ledger, keyed by the asset it describes

`kernel/beat-grid/beat-evidence.ts`. Concurrent writes land on distinct keys and commute, so
the race cannot exist. Re-analysing one track at a new sensitivity replaces that track's
entry and nothing else — "the grid the model is cutting to is the one it last saw", per
asset. An audition is remembered whole, because an audition is the workflow.

### Resolution is a separate question from alignment

"Which grid" is a fact about the project and the proposal; "do these cuts land on it" is the
boundary rule. Merging them is what let one arbitrary payload veto a whole run.
`resolveBeatGrid` asks, in the order an editor means it:

1. an analysed bed already **on the timeline** — the normal case once a montage is under way;
2. an analysed bed **this proposal places** — the step that drops the music and cuts in one go;
3. neither → **ungrounded**.

Where several analysed beds are placed, the ranking is by placed duration and then by
`assetId` — never by iteration or completion order, so the same project and proposal always
resolve to the same grid.

### Ungrounded is a measurement unless the run promised otherwise

Rejected only under `hardSync`, where the remedy (place the analysed bed) is a mutation every
execution stage offers. Otherwise the cuts stand and the state is reported. This is ADR 0137
applied to the one branch that had escaped it.

**No run that did not declare hard sync can be permanently blocked by the beat grid.**

### A tool whose output a validator consumes may not be withheld from that validator's stage

`VALIDATOR_INPUT_TOOL_NAMES` in `kernel/stage-policy.ts`, with `stageAllowsTool` as the
call-site predicate. Today it holds one name, and `beat-grid/beat-tool.ts` is the single
constant the guard, the capture site and the policy all read, so the three cannot drift.

This is the correction this same file already made for `guidance`, in its own words:

> the moment a run landed its first clip, it kept the tools that demand a real catalog id and
> lost the only sanctioned way to learn one

The reconnaissance lockout is intact. A genuinely redundant re-analysis is still refused by
name (`withheldCallOutcome`'s memo hit), still arms the action-recovery lockout via
`allFromCache`, and still climbs the no-progress streak; an action-recovery turn withholds the
tool outright. What was never justified was withholding the measurement a validator demands.

### A retry is bounded by being a different attempt

A turn refused with the exact reason that refused the last one has changed nothing the
runtime can see, so it no longer earns the attempt's progress credit — it must learn
something new to count. Any applied edit clears the memory, so a long multi-step edit that
hits one bad step and recovers is untouched.

### A run says what it could not do, whether or not it did something else

The stall notice names the standing refusal instead of claiming no edits could be found. A
run that landed some edits and had others refused reports both. And a whole-turn rejection
re-settles the cards that proposed it as `failed`: `reduceEvents` upserts tool cards by id,
so the card updates in place. Sixty-one green "Added clip Video 1 · 0s–0.5s" rows for clips
that never reached the timeline is the difference between watching a run and being told a
story about one.

## Consequences

A run may audition as many tracks as the brief asks for. The grid it is held to is the music
under the picture, resolved deterministically. When the grid cannot speak it says so instead
of vetoing, and when it does veto, the remedy is always something the run is allowed to do.

**Evidence.** `beat-grid-wiring.test.ts` replays the incident through the real `streamAgent`:
three `detect_beats` calls in one turn against three deliberately different grids, the chosen
bed placed, the montage cut to it. The clips land, no rejection appears, and every boundary
sits on an onset of the track that is actually under the picture. Mutation-tested — making
resolution pick a single arbitrary analysis, the old slot's behaviour, fails exactly the two
new cases and leaves the rest green.

`beat-evidence.test.ts` pins the ledger itself: the audition, order-independence, per-asset
replacement, sticky `hardSync`, and every branch of resolution including the tie-break.
`stage-policy.test.ts` asserts the validator-input invariant in both directions — every
member reachable in every stage, every other `analysis` tool still closed in execution.

3717 ai-sdk tests, 2696 engine tests, 83 e2e tests, typecheck, lint and build all pass.

## Cost of the change

Offering one more descriptor in the execution stages costs **+234 tokens** on that turn's tool
schema, measured by the regenerated goldens. That is the price of the run being able to
answer a question the runtime asks it.

## Limitations

The rule still governs only `add_clip`, `trim_clip` and `split_clip` boundaries on picture
tracks (ADR 0132's scope, unchanged here). A montage assembled by `move_clip` or ripple
operations is not held to the grid; widening that should follow a run that demonstrates the
gap, not speculation.
