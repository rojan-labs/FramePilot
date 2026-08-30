---
name: silence-and-filler-cutting
description: Remove hesitation, filler, and false starts while protecting performance, word boundaries, breaths, and speech continuity.
tools: [remove_silences, analyze_silence, get_transcript, get_mapped_transcript, get_timeline_map, map_time, ripple_delete, punch_in]
---

# Silence and filler cutting

## Purpose

Make the speaker sound like their best natural take, not a machine-cut transcript.

## When to use

Dead-air cleanup, filler removal, false starts, or a first dialogue pass.

## When not to use

Do not remove dramatic pauses, emotional breaths, or gaps whose visual action matters.

## Required inputs

Source-time silence/transcript evidence, current source→sequence mapping, format, and protected beats.

## Expected outputs

A mapped cut list applied from the current revision, with jump-cut consequences reviewed.

## Core philosophy

Remove hesitation; preserve intention.

## Professional heuristics

- Start around 0.4–0.5s for short-form and 0.8–1.0s for long-form, then tune once from evidence.
- Leave roughly 0.05–0.08s around kept words — that is 2 frames at 30fps and 1 at 24fps,
  so say it in frames when you name it. `get_mapped_transcript` gives every word a
  `startFrame` and an `endFrame`; a cut that lands strictly inside that span severs the
  word, and no audio work afterwards puts the consonant back.
- Keep pauses after key claims and before punchlines.
- Map source times with tools; never calculate offsets.
- Ripple later ranges first when executing a prepared list.

## Decision framework

For dead air, call `remove_silences` once: it measures the recording and ripple-deletes every
silence longer than `minSilenceSeconds` where that asset plays, keeping `keepSeconds` of
breath on each side, in one reversible patch. Do not `analyze_silence` and then echo the
ranges back as dozens of `delete_range` calls — that is the failure this tool exists to
prevent. Reserve the manual route (detect → classify keep/cut → map current times → protect
word edges → ripple from latest to earliest) for filler words and false starts, where the
transcript decides what goes.

## Common mistakes

Cutting every breath, using raw source times, repeated analysis, or dissolving every jump cut.

## Verification checklist

- No clipped consonants or incomplete thoughts — check that no cut frame falls inside a
  word's `startFrame`–`endFrame` span, rather than listening for it after the fact.
- Protected pauses remain.
- No micro-clips or stale mappings remain.
- Speech still sounds human.

## Recovery advice

If the result feels frantic, restore the most meaningful pause or reduce the threshold; repair the local region, not the whole timeline.

## Related skills

`podcast-editing`, `short-form-pacing`, `audio-polish`, `broll-and-layering`.
