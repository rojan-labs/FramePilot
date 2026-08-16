---
description: Generate and add a styled caption track from the transcript as a reversible patch (PRD §6.2)
---

Add captions to the current project.

1. Read `plan/PLAN.md`. Ensure a transcript with word-level timestamps exists (generate via
   the transcription pipeline if needed).
2. Use the `add_caption_layer` tool to produce a **patch** that creates/updates a caption
   track: word-level timing, then `set_caption_style` with a caption-template id
   (`captionStyle: { templateId }`, schema v10 catalog — see the `caption-design` skill for
   the template menu and selection guidance; respect project memory for preferred caption
   style). Never mutate `project.fp.json` directly.
3. **Validate** (timing within clip bounds, references exist, layer order) → **preview** the
   diff and caption overlay → human approves → **apply**.
4. If burned-in captions are rendered, **validate the render** (caption timing, streams).
5. Keep reversible.

Reference `.agents/skills/timeline-editing/SKILL.md`. Update `plan/PLAN.md`, `docs/`, and `CHANGELOG.md`.
