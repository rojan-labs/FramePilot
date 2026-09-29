---
name: podcast-editing
description: Edit spoken multi-speaker conversations for clarity, thought continuity, reaction value, natural cadence, and consistent audio without over-cutting.
tools: [get_mapped_transcript, get_timeline, analyze_silence, remove_silences, remove_filler_words, split_clip, ripple_delete, punch_in, adjust_audio, professional_audio, get_frame]
---

# Podcast editing

## Purpose

Create a concise conversation that still feels spontaneous, intelligible, and emotionally honest.

## When to use

Interviews, roundtables, remote calls, multicamera conversations, or podcast highlights.

## When not to use

Do not apply short-form density to the full episode or remove overlap/reactions that carry relationship and meaning.

## Required inputs

Mapped transcript, speaker/angle evidence when available, protected claims, target duration, and audio consistency.

## Expected outputs

Thought-level trims, preserved reactions, motivated angle/framing changes, matched dialogue, and an auditioned sequence.

## Core philosophy

Speech is the spine; reaction and cadence are story. Edit ideas, not isolated words.

## Professional heuristics

- An editor's keep list, cut list, target length or "leave the pauses in" outranks these norms.
- Remove repetition and abandoned starts while keeping breaths that support emphasis. Plain
  "um"/"uh" filler goes in one `remove_filler_words` pass; false starts are judgment cuts from
  the transcript.
- Cut on completed thoughts; preserve question→answer causality.
- Hold a listener reaction when it changes meaning; do not alternate cameras mechanically.
- Use punch-ins sparingly to emphasize a turning point or conceal a necessary seam.

## Decision framework

Map topics → select essential exchanges → remove redundant thought units → protect reactions → level dialogue (`adjust_audio`; EQ/compression with `professional_audio`) → preview continuity.

## Common mistakes

Sentence fragments, missing question context, machine-gun angle changes, removing every pause, or prioritizing visuals over intelligibility.

## Verification checklist

- Each answer retains its premise.
- Speaker cadence sounds natural.
- Reactions and eyelines remain coherent.
- Dialogue levels match and preview audio was heard.

## Recovery advice

Restore the smallest context line or pause that repairs meaning. If speaker/angle identity is unavailable, make audio-led cuts and avoid claims about who is on screen.

## Related skills

`silence-and-filler-cutting`, `audio-polish`, `story-structure`, `short-form-pacing`.
