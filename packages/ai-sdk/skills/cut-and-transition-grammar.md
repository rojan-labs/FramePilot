---
name: cut-and-transition-grammar
description: Choose motivated cuts and a restrained transition vocabulary, place effects only on real eligible boundaries, and verify committed transition state.
tools: [get_timeline, list_edit_boundaries, discover_transitions, add_transition, split_clip, trim_clip, verify_transitions]
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
- Each effect sits on adjacent clips on the same track.
- The duration the timeline committed is the one you name to the editor — on short shots it is often shorter than the one you asked for.
- Duration and energy fit the scene.
- No effect obscures action or dialogue timing.
- Preview when visual quality matters.

## Recovery advice

If verification fails, remove or relocate the transition to a listed eligible boundary. If it feels cheap, restore the straight cut and improve timing or shot choice.

## Related skills

`beat-synced-editing`, `story-structure`, `motion-design`, `finishing-and-delivery`.
