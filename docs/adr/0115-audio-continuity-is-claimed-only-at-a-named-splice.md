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

## Amendment (2026-10-03): the spliced source, heard over what else plays, above a floor

Run x59-1 reported "Audio discontinuity 21.7 dB exceeds 12 dB" at a music bed's first frame,
three times. The model re-faded the bed each time and the number never moved. Measured per
track, the bed faded in correctly (-86.6 dBFS at its first frame). The jump was a radio call
starting inside the continuous clip on the picture track (-55 → -20 dBFS), read off the mix. The
bed's own fade also measured as a step up from digital silence (-120 dBFS).

- **The request names the source of the cut.** `splice: { trackIds, fromClipIds, toClipIds }`
  (TS `AudioSpliceSchema`, Python `AudioSplice`). It is optional, needs `boundaryFrame`, and
  needs `channels: 'mix'`. The planner fills it from the audio track whose clip edge made the
  boundary. The engine compiles those tracks alone (`_track_isolated_project`); the window's
  peak and RMS stay the mix's. A request without `splice` measures the mix, as before.
- **The source is judged over the background, held at its quieter side.** Measured alone, a
  lifted clip's stop read 36 dB on the professional lift fixture, but a cover shot's sound
  plays straight across the gap. That is the mirror image of x59-1. The background B is
  `mix - source`, sample by sample. That is exact: MoviePy's `CompositeAudioClip` is a plain
  broadcast sum with no limiter, each clip's chain is its own, and ducking reads clip
  positions. Measured on x59-1, `mix - music` matches a compile of the other tracks to
  7e-18. Each side is `dB(sqrt(S² + B_ref²))` with `B_ref = min(RMS(B before), RMS(B
  after))`, so B's own changes (the radio call) never count, and masking errs conservative.
- **Both sides are floored at `AUDIBLE_RMS_FLOOR_DBFS` (-60 dBFS RMS)**, after the power sum
  and before the difference is taken (`perceptual-thresholds.ts` gives the measurements behind the number). This applies
  to every boundary, old-shaped ones included, because it corrects the arithmetic, not the
  source.
- **An entry from silence is judged by its onset.** When one side is below the floor, the other
  side is read over its first (or last) `AUDIO_ONSET_SECONDS` (10 ms) at the splice. A hard
  entry is at its level there. A fade-in is still near silence. The result carries the two
  heard levels (`boundaryBeforeDbfs`/`boundaryAfterDbfs`). The finding takes entry, exit or
  cut from the splice's clips, names the clip, and gives the fix (fade in, fade out, crossfade
  or match gain). A step that masking hides is not reported.

On x59-1 the frame-540 boundary now measures 0.0 dB: -56.3 → -56.3 dBFS heard, the bed's first
10 ms (-116 dBFS) under v1's -56 dBFS. The old mix request still reads 21.7 dB. On the lift
fixture the stop and the re-entry measure 3.04 and 2.93 dB. Without the cover the same stop is
36 dB, and still flags.
