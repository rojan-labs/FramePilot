---
name: finishing-and-delivery
description: Final QA and export reference — timeline integrity, a request's own QA list, watching a preview, fixing observable defects, clean/alternate versions, and exporting only after the current revision passes review.
tools: [get_timeline, get_project_state, get_frame, render_preview, export_video, trim_clip, set_track_flags, verify_captions, verify_transitions]
---

# Finishing and delivery

**A QA list or delivery spec in the request is the checklist.** Verify each item, and report
each one as passed, fixed, or not checkable here — never fold them into "all checks passed".
The checks below are the default when the request brings none, and the floor when it does.

## Purpose

Convert an edited timeline into a reviewed deliverable rather than an unwatched export.

## When to use

Final QA, “is it done?”, platform delivery, or export requests.

## When not to use

Do not export while structural work, stale captions, or known verification failures remain.

## Required inputs

Current revision, delivery format, expected audio/captions/transitions, the request's QA list, and representative frames.

## Expected outputs

An integrity report, corrected defects, a watched preview, then a validated export request — and a plain list of any requested deliverable that could not be produced.

## Core philosophy

Nothing ships unwatched. Application proves state changed; verification proves specific facts; playback reveals craft.

## Professional heuristics

- Scan for gaps, flash frames, stray flags, orphaned overlays, tails, and missing coverage.
- Verify captions/transitions with their tools before visual review.
- `get_frame` spot-checks specific moments while you work; `render_preview` encodes the whole edit, so run it once the edit is settled.
- Watch the opening, every seam, audio balance, text readability, and ending.
- Re-preview after any non-trivial fix.
- Timeline checks prove structure and timing only. Lighting, colour, caption contrast, typography, and motion quality pass only after representative preview playback.
- `export_video` takes no settings: it renders the project's own frame size and rate. Codec, bitrate, loudness targets and sidecar files (.srt, a written shot list) are not set by the agent — say which deliverables exist and which remain.
- A clean version (no text, captions or stickers): hide the tracks that hold only those with `set_track_flags` `hidden`, export, then un-hide them. A different aspect ratio is a different project frame, not a flag — name it as remaining.

## Decision framework

Inspect state → run targeted verifiers → work through the request's QA list → render preview → watch end-to-end → fix smallest responsible region → repeat if needed → export.

## Common mistakes

Exporting first, trusting the timeline thumbnail, ignoring muted tracks, treating caption coverage as readability, calling an unwatched fix final, or reporting a requested deliverable as done when it was not produced.

## Verification checklist

- No unintended gaps or flash frames.
- Track flags are deliberate, and any tracks hidden for a clean export are visible again.
- Caption/transition checks pass when applicable.
- Every item on the request's QA list has an answer.
- Preview was watched for picture and sound.
- Aspect, duration, and destination match the request.

## Recovery advice

If preview/render fails, preserve the timeline and report the edit as visually unreviewed; explicitly name lighting/colour, caption readability, and motion as unchecked. Never substitute “all checks passed” for the missing playback review. If a fix causes a regression, revert that local fix rather than restarting the edit.

## Related skills

`audio-polish`, `caption-design`, `color-grading`, `cut-and-transition-grammar`.
