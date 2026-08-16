---
description: Turn a raw recording into a short-form video (e.g. 45s Reel) via the full agent flow (PRD §5.4, §24)
---

Create a short-form video from the current project (the North Star flow, PRD §24).

Follow the agent flow and the patch → validate → preview → validate-render loop:

1. Read `plan/PLAN.md`; confirm the engine, render validation, and AI tools needed exist.
2. Build context (transcript, timeline, selection, target platform/aspect, target duration).
3. Plan: detect hook, cut weak/repeated segments, add captions, add zooms on key moments,
   add overlays/CTA, set the export preset (default 9:16). Present the plan for approval.
4. Produce a **patch** (typed operations only — never raw JSON mutation).
5. **Validate** the patch (PRD §8.5) → **preview** (diff + preview render) → human approves.
6. **Apply** transactionally → **validate the render** (PRD §9.4) → run **critic** checks
   (duration vs target, caption alignment, safe-area, clipping, black frames).
7. Keep everything reversible; offer one-click revert.

Reference `.agents/skills/ai-safety/SKILL.md` and `.agents/skills/correctness-verification/SKILL.md`.
Update `plan/PLAN.md`, `docs/`, and `CHANGELOG.md`.
