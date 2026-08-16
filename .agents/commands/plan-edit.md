---
description: Produce a structured edit plan for the current video — no mutation, no render (PRD §5.5, §7.3)
---

Run **Plan mode** (PRD §5.5, §7.3): create an edit strategy WITHOUT mutating the timeline
and WITHOUT rendering.

1. Read `plan/PLAN.md` and confirm the timeline/patch engine and context builder exist.
2. Build context: transcript, timeline state, clip metadata, current selection, target platform.
3. Return a structured plan only: which segment is the hook, what to cut, captions, zooms,
   overlays, CTA, export target — each step phrased as a candidate typed operation.
4. Do NOT apply anything and do NOT render. Offer "Apply this plan" as the next step,
   which would go through the patch → validate → preview → validate-render flow.

Reference `.agents/rules/ai-agent-system.mdc` and `.agents/skills/ai-safety/SKILL.md`.
Update `plan/PLAN.md` and `docs/` if this surfaces new tasks or decisions.
