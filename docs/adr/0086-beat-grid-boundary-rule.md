# 0086. Hold only interior picture cuts to the beat grid, and snap near-misses

- Status: Accepted
- Date: 2026-07-28

## Context

A beat-backed montage proposal was checked by a private assertion in the plan driver: every
`add_clip` boundary had to be within half a frame of a mapped onset from `detect_beats`, or
the proposal was rejected into the bounded correction loop. Three separate defects in that
one rule were observed on real "cut on every drum hit" runs.

**The rule could be unsatisfiable.** It applied to every `add_clip` regardless of track
type, so the music bed itself was checked. A 30-second song placed `0 → 30` can never be
on-grid — an onset at exactly 30.000 essentially never exists — so a step that placed the
music and cut the picture was a guaranteed dead end reported as `off-grid: 30`. The
sequence's own last boundary had the same problem: a montage that fills to the end of the
music was unrepresentable, and the user had to hand-write "do not force 30.000" into the
prompt to work around it.

**The rule silently did not run when it mattered most.** The grid is derived by translating
source-time onsets through clips of the analyzed asset that are already on the timeline.
When the music bed was placed by the same proposal, the derived grid was empty at validation
time and the assertion early-returned. A uniform, off-beat montage was therefore accepted
without complaint — the reported "clips placed uniformly, not on the beat" behavior was a
validator that was not looking, not a prompting failure.

**A near-miss was fatal and uninformative.** A boundary two frames from a real onset was
rejected, and the rejection named the offending times but not the legal ones, so the
correction budget was spent re-guessing numbers.

Separately, the proposal itself could not physically fit in a reply: the Anthropic adapter
hardcoded `max_tokens: 2048` for every request, and a ~60-call montage proposal is several
times that, so the JSON ended mid-object and surfaced as "model response was not valid
JSON" with no indication that truncation was the cause.

## Decision

The rule moves to `kernel/beat-grid/beat-alignment.ts` as a pure, tested function, and is
narrowed to what a viewer actually perceives as synchronization:

- **Only picture boundaries are structural** — `video` and `overlay` tracks. Audio and
  caption boundaries are never checked: a music bed's start and end are not editorial cuts,
  and a caption follows speech.
- **Coverage extends to `trim_clip` and `split_clip`**, not just `add_clip`, so the
  split-and-trim path is held to the same contract it was previously exempt from.
- **Outer boundaries are exempt only where the grid cannot speak** — the earliest start when
  it precedes the first onset, and the latest end when it follows the last one. A head or
  tail inside the grid's range is still a cut against the music. This makes "open at 0" and
  "run to the end of the music" representable without letting a one-clip proposal exempt
  itself from all checking.
- **An interior near-miss is snapped, not rejected.** A boundary within 80ms of an onset is
  rewritten to that onset; the runtime disposes. Snapping is a pure function of the time
  value, so two clips sharing a boundary always land on the same onset and the sequence
  stays continuous. `add_clip`'s `sourceEnd` is re-derived from the new span, because the
  operation plays at 1x and the two must agree.
- **A real miss is rejected with the nearest legal onset named**, which is what a correction
  turn needs in order to converge.
- **An unresolvable grid is a rejection, not a pass.** When the analyzed asset is not on the
  timeline, the grid is recovered from a placement inside the same proposal. When neither the
  project nor the proposal places it, the proposal is refused as ungrounded. No onset is ever
  fabricated.
- Beat alignment runs **before** the project-semantic validator, so the validator sees the
  operations that would actually be applied rather than the pre-snap ones.

`AiCompletionRequest` gains an optional `maxTokens`. The EditProposer reserves room sized to
its output, and the Anthropic adapter honors the request clamped to the selected model's real
output ceiling. Callers that ask for nothing keep the short conversational default.

## Consequences

A montage can now be both gapless to the end of the music and frame-accurate on every
interior drum hit — previously those two requirements were mutually exclusive. Cutting to a
music bed placed in the same proposal is enforced instead of silently waved through, so the
uniform-cut failure mode cannot recur. A proposal that is off by a couple of frames costs
nothing; one that is off by a musical event costs one correction turn and is told exactly
where to land.

The 80ms snap window is a deliberate judgment: it is inside the range where a cut still
reads as "on the hit", and below the spacing of consecutive onsets at a fast tempo, so a
snap can never cross into a neighbouring onset. Consecutive onsets closer together than one
frame are reported rather than emitted as an invisible clip.

Raising the reply reservation makes long proposals more expensive per attempt. That is the
correct trade: a truncated proposal costs the same tokens and produces nothing.
