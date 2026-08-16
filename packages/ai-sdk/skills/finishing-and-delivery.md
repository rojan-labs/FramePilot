---
name: finishing-and-delivery
description: Audit timeline integrity, watch a rendered preview, correct observable defects, and export only after the current revision passes review.
tools: [get_timeline, get_project_state, render_preview, export_video, trim_clip, set_track_flags, verify_captions, verify_transitions]
---

# Finishing and delivery

## Purpose

Convert an edited timeline into a reviewed deliverable rather than an unwatched export.

## When to use

Final QA, “is it done?”, platform delivery, or export requests.

## When not to use

Do not export while structural work, stale captions, or known verification failures remain.

## Required inputs

Current revision, delivery format, expected audio/captions/transitions, and a representative preview.

## Expected outputs

An integrity report, corrected defects, a watched preview, then a validated export request.

## Core philosophy

Nothing ships unwatched. Application proves state changed; verification proves specific facts; playback reveals craft.

## Professional heuristics

- Scan for gaps, flash frames, stray flags, orphaned overlays, tails, and missing coverage.
- Verify captions/transitions with their tools before visual review.
- Watch the opening, every seam, audio balance, text readability, and ending.
- Re-preview after any non-trivial fix.
- Timeline checks prove structure and timing only. Lighting, colour, caption contrast, typography, and motion quality pass only after representative preview playback.

## Decision framework

Inspect state → run targeted verifiers → render preview → watch end-to-end → fix smallest responsible region → repeat if needed → export.

## Common mistakes

Exporting first, trusting the timeline thumbnail, ignoring muted tracks, treating caption coverage as readability, or calling an unwatched fix final.

## Verification checklist

- No unintended gaps or flash frames.
- Track flags are deliberate.
- Caption/transition checks pass when applicable.
- Preview was watched for picture and sound.
- Aspect, duration, and destination match the request.

## Recovery advice

If preview/render fails, preserve the timeline and report the edit as visually unreviewed; explicitly name lighting/colour, caption readability, and motion as unchecked. Never substitute “all checks passed” for the missing playback review. If a fix causes a regression, revert that local fix rather than restarting the edit.

## Related skills

`audio-polish`, `caption-design`, `color-grading`, `cut-and-transition-grammar`.
