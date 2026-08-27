---
name: cut-and-transition-grammar
description: Choose motivated cuts and a restrained transition vocabulary, place effects only on real eligible boundaries, and verify committed transition state.
tools: [get_timeline, list_edit_boundaries, get_mapped_transcript, map_time, discover_transitions, add_transition, split_clip, trim_clip, professional_edit, verify_transitions]
---

# Cut and transition grammar

## Purpose

Use cuts as visual syntax and transitions as rare punctuation with a clear narrative meaning.

## When to use

Scene seams, chapter changes, montage accents, or a cut that feels visually harsh.

## When not to use

Do not add a transition to continuous unsplit footage, hide weak shot choice with effects, or decorate every cut.

## Required inputs

Current eligible boundaries, content tone, motion at both sides, and the relationship the transition should communicate.

## Expected outputs

Mostly straight cuts, a small consistent transition vocabulary, motivated durations, and verification evidence.

## Core philosophy

The cut is the default. A non-cut must communicate time, place, energy, memory, or chapter change.

## Frames, not seconds

Every edit point on this timeline is a frame. `list_edit_boundaries` gives each cut its
`frame` and its ceiling as `maxTransitionFrames`; `get_mapped_transcript` gives each word a
`startFrame`/`endFrame`; `map_time` answers in `sequenceFrame`. Say which frame you mean
and aim at it — a request in raw seconds is snapped to the nearest frame for you, so a
"cut at 12.3874s" is a cut you did not choose the frame of.

- **Cut on action.** The boundary sits on the frame the movement completes, not near it.
  Read the boundary's `frame`, decide how many frames early or late it is, and move it with
  `professional_edit` `roll` and that many `frames` — a roll changes where the cut is
  without changing how long either shot runs, which is the whole reason to use it instead
  of two trims.
- **Cut on the word, not through it.** A word occupies `startFrame` through `endFrame`.
  Land a cut on a word's `startFrame` (before it) or on the following word's `startFrame`
  (after it); a cut anywhere strictly inside that span severs the word, and no amount of
  audio work afterwards puts the consonant back.
- **Handles, honestly.** `outgoingHandle` and `incomingHandle` are informational HERE.
  This renderer ramps over the incoming clip's own first frames and borrows nothing from
  past the cut, so a dissolve never fails for want of footage — what the handles tell you
  is whether it will blend two shots or fade through black. The real ceiling is
  `maxTransitionFrames`: half the shorter shot. Check it before you promise a look.
- **J and L cuts** are `professional_edit` with `command: "j_cut"` (sound arrives before
  picture) or `"l_cut"` (sound runs on past it) and a positive `frames` magnitude. State
  the count: "audio leads by 8 frames", not "let the audio run on". They need a live
  selection and the desktop app; without one the call is refused rather than half-done.

## Professional heuristics

- First improve a rough cut point by a few frames or cut on action.
- Cross-dissolve blends ideas/time; fade closes a chapter; push/slide advances energetic steps; zoom marks a hype accent; blur/wipe signal a deliberate stylized shift.
- The library is 77 transitions, not seven. Call `discover_transitions` for real ids before naming one — searching by feel ("fast", "cinematic") or by direction ("left") is how you find the one you mean, and a kind this build does not know is refused outright rather than rendering as nothing.
- Reach past the basics only with a reason: `whip-pan-left` for two shots that already move that way, `punch-zoom` or `flash` on a beat, `light-leak` or `film-burn` for a warm section break, `luma-fade` between two shots with matched brightness. `glitch` and `kaleidoscope` are statements — one per piece at most.
- Alignment is a real choice: `centre` straddles the cut (what most editors expect), `end` puts the whole ramp on the outgoing shot, `start` on the incoming one. Absent means `start`, which is what this engine has always done.
- Keep energetic transitions short and section transitions slower; anything over one second is a statement.
- A cut carries at most half of its shorter shot, so a quick cutaway takes a quick transition — 0.16s across two 0.4s slivers, not the half-second you would use between two long takes. Ask for what the moment wants: too long is shortened to fit, never refused. Read the committed duration back before you describe it, or you will report a half-second dissolve the timeline never had.
- Pick one signature transition family per piece.

## Decision framework

Read real boundaries → name the relationship → test whether a cut expresses it → if not, choose the least conspicuous fitting transition → apply → verify.

## Common mistakes

Using narrative beats as if they were cut boundaries, mixing many transition types, repeating one effect mechanically, or claiming visibility from an applied response.

## Verification checklist

- Run `verify_transitions`.
- Every cut you moved is on the frame you named — re-read `list_edit_boundaries` and
  compare `frame`, not seconds.
- No cut lands strictly inside a word's `startFrame`–`endFrame` span.
- Each effect sits on adjacent clips on the same track.
- The duration the timeline committed is the one you name to the editor — on short shots it is often shorter than the one you asked for.
- Duration and energy fit the scene.
- No effect obscures action or dialogue timing.
- Preview when visual quality matters.

## Recovery advice

If verification fails, remove or relocate the transition to a listed eligible boundary. If it feels cheap, restore the straight cut and improve timing or shot choice.

## Related skills

`beat-synced-editing`, `story-structure`, `motion-design`, `finishing-and-delivery`.
