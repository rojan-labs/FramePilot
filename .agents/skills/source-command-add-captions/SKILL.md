---
name: 'source-command-add-captions'
description: 'Generate and add a styled caption track from the transcript as a reversible patch (PRD §6.2)'
---

# source-command-add-captions

Use this skill when the user asks to run the migrated source command `add-captions`.

## Command Template

Add captions to the current project.

1. Read `plan/PLAN.md`. Ensure a transcript with word-level timestamps exists (generate via
   the transcription pipeline if needed).
2. Segment with the canonical caption pipeline: map source words onto the edited timeline,
   split on sentence/clause/pause boundaries, enforce reading speed, and lay out explicit line
   breaks. Never use fixed-N or arbitrary word-by-word grouping unless the chosen template is
   explicitly a one-word design.
3. When invoked by the in-app agent, call `get_mapped_transcript` and submit its own sparse,
   contextual choices through `auto_emphasize_captions`; the tool grounds every term in real
   caption/transcript text and emits the same reversible `set_track_caption_style` operation as
   the manual UI. When invoked from the manual Captions panel, ask the configured AI provider for
   a sparse semantic emphasis set from meaning and delivery
   (pauses, stretched words, sentence position, contrast, confidence and emotional weight).
   Schema-validate the response, reject invented/non-transcript words and cap highlight density.
   When no provider is available or its response is invalid, use the deterministic local scorer
   and label that fallback honestly. Feed the validated anchors into segmentation so the cue
   reserves their larger visual width, then persist them through
   `captionStyle.accent.mode = "keywords"`. Keep the list reviewable and editable.
4. Call `discover_caption_styles`, then use `add_caption_layer`, `set_caption_cue`, and
   `set_track_caption_style` to produce one
   reversible **patch** that creates/updates the caption track. Respect project memory for the
   preferred template. Never mutate `project.fp.json` directly.
5. The AI may set the complete composition end to end: template, bundled font and accent font,
   weight/style/scale, colors/outline, x/y placement, rotation, maximum width, alignment, letter
   spacing, line height, background padding, shadow, animation and safe area. Treat generation as
   a starting point: preserve the user's ability to rewrite, merge, split,
   re-time, and restyle cues. Use `set_caption_style` for free placement (`xPercent`/`yPercent`),
   width, rotation, alignment, line height and safe-area behavior when requested. Choose caption
   and accent faces from the canonical bundled 22-family catalog so preview and export cannot drift
   with system-installed fonts.
6. **Validate** (timing within clip bounds, references exist, layer order) → **preview** the
   diff and caption overlay → human approves → **apply**.
7. If burned-in captions are rendered, **validate the render** (caption timing, placement,
   streams).
8. Keep reversible.

Reference `.agents/skills/timeline-editing/SKILL.md`. Update `plan/PLAN.md`, `docs/`, and `CHANGELOG.md`.
