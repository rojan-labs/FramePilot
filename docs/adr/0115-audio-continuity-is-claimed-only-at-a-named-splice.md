# 0115. Audio continuity is claimed only at a named splice

- Status: Accepted
- Date: 2026-08-14

## Context

Temporal review meters an edit's audio in short windows and fails the run when the mix
"jumps" across an edit boundary. The measurement was the difference in RMS level between
the first and second half of the requested window, and the window was centred on a frame
the planner considered interesting.

Two things were wrong with that, and together they discarded valid work.

The window did not know where the boundary was. It split down the middle regardless, so
a window clamped against the programme's edges — `[0, 3)` for a boundary at frame 0 —
compared the programme's first 50 ms against its next 50 ms. That is not a cut. Laying a
music bed across a montage plans exactly that window, and the music's own attack read as
a 12.6 dB discontinuity: `Temporal review failed: edit_audio_0: Audio discontinuity
12.62 dB exceeds 12 dB`. The run's diffs had already been applied and validated; review
failure discards them, so a complete 30-second montage was thrown away over the fact
that the music started.

The planner also could not distinguish a splice from a level move. It fed the same
continuity check the head, middle and tail of any clip whose mix changed, and the
extremes of a gain automation lane — the exact frames where the level is _supposed_ to
move. Any deliberate ride of more than 12 dB reported itself as a defect.

## Decision

`AudioEvidenceRequest` gains an optional `boundaryFrame`, in both the TypeScript
contract and the Python engine model, and it means one thing: this window is a
continuity claim about the cut on this frame. It must sit strictly inside the window, so
there is real audio on both sides of it.

- The engine splits at `boundaryFrame` and reports `boundaryJumpDb` **only** when one is
  given. A window without it carries peak and RMS alone.
- The reviewer judges continuity only when the request named a splice, so evidence from a
  producer that reports a jump anyway cannot fail a run.
- The planner marks clip edges on audio tracks as splices, using the **unclamped** frame:
  a clip that ends at the programme's end is not an interior cut, and clamping it to the
  last frame invented one. Mix changes, mute toggles and automation extremes stay level
  checks.

## Consequences

Every window is still requested and still metered for peak, so a clipped or unsafe mix
fails exactly as before. What no longer fails is the programme beginning, the programme
ending, and a fader moving on purpose.

Continuity is now a narrower claim than it was, and deliberately so: it is asserted only
where the timeline actually contains a cut. A hard cut between two loud, dissimilar music
sections can still exceed the 12 dB threshold; that is a real audible jump, and the
repair pass has a real frame to work with rather than an artefact of window clamping.

The contract change ships on both sides of the sidecar at once. `boundaryFrame` is
additive and optional, so an older reviewer talking to a newer engine simply receives no
jump — the fail-open direction, which is correct here: the alternative was failing runs
on measurements of nothing.
