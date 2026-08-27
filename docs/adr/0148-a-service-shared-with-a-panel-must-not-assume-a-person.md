# ADR 0148 — A service shared with a panel must not assume a person is driving it

**Status:** accepted
**Date:** 2026-08-27
**Related:** ADR 0143 (sourcing is not reconnaissance), ADR 0144 (an edit that renders as
nothing is refused), ADR 0147 (a search is not a repeat)

## Context

Run `f014f3ac` is run `f1d5285e` after ADR 0147 landed, on the same brief and the same
empty project. The guards no longer ended it early: 28 model calls instead of 5, 71 tool
calls instead of 5, and it reached the `apply` stage. It still delivered no montage.

The reason was not in the agent kernel at all. It was in the two main-process services the
agent shares with the Stock and Sounds panels.

**`StockService.search` was single-flight, latest-wins.** `this.inFlightSearch?.abort()`,
with the comment "a superseded search is cancelled, not merely ignored — an abandoned
request still counts against the hourly limit". That is exactly right for a panel: a person
typing "waterfall" issues six searches and means the sixth.

The agent does not type. It batches concurrency-safe calls four at a time
(`DEFAULT_MAX_TOOL_CONCURRENCY`), so four deliberate, different queries arrive in the same
millisecond — and each aborted the one before it. In the captured run the fourth query of
every batch returned forty clips in ~1.8s while the first three came back `cancelled` in
~120ms. **Fifteen of twenty-one stock searches died that way**, and six of ten music
searches with them.

**And the failures were silent.** `stockErrorMessage('cancelled')` returns the empty
string, deliberately: a person who pressed Stop does not need to be told what they just
did, and both panels treat `''` as "return to idle". Handed to a MODEL, that empty string
became a tool card with a red cross and no reason, and a blank line in the action log the
run reads back. The only move available to a model told "this failed, no reason given" is
to ask the same question again, and the run did — "eagle flying mountain" three times —
until it gave up on footage and finished with the music bed alone.

Two more defects then reported that outcome as a different thing than it was:

- **`picture_present` passed.** It derives picture as "not an overlay clip", so the music
  bed counted, and the one check written to catch a video with nothing to look at (ADR 0144) reported _"pass: 1 picture clip on the timeline"_. `reframe_coverage` and
  `treatment_coverage` share the predicate; the latter told the run its audio clip was
  missing its reframe.
- **The duration target was invented from a pacing table.** The brief contained a `### BUILD`
  heading followed by `**0.3–0.6s per clip**`. `explicitDurationTargetSeconds` anchors on
  `build` (people do say "build me a 30-second reel"), skipped lazily past `0.3–`, and
  returned **0.6** as the deliverable length of a fifty-clip montage. The run was then
  failed for missing a target nobody set, by 202.468 seconds.

## Decision

**Superseding is the caller's declaration, not the service's policy.** `StockService.search`
and `MusicService.search` take an options argument carrying `supersedePrevious` (default
`true`, so the IPC path is untouched) and the caller's own `signal`. The agent hosts pass
`supersedePrevious: false` and the run's signal. Only a superseding search registers itself
in the in-flight slot, so a person browsing mid-run cannot cancel the agent's fetch or the
agent theirs.

**The agent boundary never reports a failure it cannot name.** `agentSearchFailureSummary`
substitutes a sentence whenever the provider vocabulary's message is empty, naming the tool
and the wire code. This is deliberately a rule about the whole class rather than about
`cancelled`: a harness that tells a model nothing is a harness that gets asked again.

**"Picture" excludes audio.** One `pictureClips(project)` helper, used by all three checks
that ask a question about the screen. An asset the project does not list stays picture — a
missing reference is `checkMissingAssets`'s finding to report, not something to hide behind
a skipped check.

**A per-unit figure is pacing and the far end of a range is not a target.** Two structural
guards in `explicitDurationTargetSeconds`, both reading what the text says rather than
adding another anchor word, and both generalising past this brief — every montage request
describes its rhythm as "N–M seconds per clip".

## Consequences

- An agent run can issue as many parallel catalogue searches as its request needs.
- The Stock and Sounds panels behave exactly as before: the default is unchanged, and the
  renderer's own generation guard (`searchGenerationRef` in `StockPanel`) was always the
  mechanism that actually decided which results the UI showed.
- Not superseding does not mean uncancellable — Stop reaches the provider through the
  caller's signal, which is about lifetime rather than replacement. Tested as its own case.
- A timeline of nothing but a music bed now fails `picture_present` honestly, and the
  per-clip checks skip rather than making a claim about a sound file.
- Sourcing is desktop-only, so both service fixes are desktop-only. That is the existing
  product boundary (`StockPanel` renders a desktop-only state at `!isDesktop()`), not a gap
  this ADR introduces.

## Alternatives considered

**Give the agent its own StockService instance.** It would fix the cancellation and lose
the shared cache and the shared quota meter — the two things that make "the agent and the
human see one catalogue" true (ADR 0143). The concurrency policy is the only thing the two
callers genuinely disagree about, so that is the only thing that should be parameterised.

**Make the agent search serially.** One line in `concurrencySafe`, and it would trade a
correctness bug for a latency bug: gathering 80–120 candidates is the shape of the request,
and doing it one round trip at a time is minutes of wall clock for no reason.

**Let `cancelled` keep its empty string everywhere and special-case the tool card.** The
card is not the only reader. The action log the model sees next turn is built from the same
summary, and fixing one surface would leave the model in exactly the state that caused the
retries.
