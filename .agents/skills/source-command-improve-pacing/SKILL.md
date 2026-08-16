---
name: 'source-command-improve-pacing'
description: 'Improve pacing (tighten slow parts, speed ramps, punch-ins) as a reversible patch (PRD §5.3, §7.2)'
---

# source-command-improve-pacing

Use this skill when the user asks to run the migrated source command `improve-pacing`.

## Command Template

Improve the pacing of the selected range (or whole video).

1. Read `plan/PLAN.md`. Build context (transcript, timeline, selection). Diagnose slow
   segments (setup without visual change, long silences, repeats).
2. Produce a small, reviewable **patch** of typed operations: trims, silence removal,
   speed ramps, punch-in zooms, caption emphasis. Respect project memory (e.g. user rejects
   aggressive zooms). Never raw-mutate the project JSON.
3. **Validate** (PRD §8.5) → **preview** the diff (what/why/before-after) → human approves
   → **apply** transactionally.
4. If previewed/exported, **validate the render** (PRD §9.4). Keep reversible.

Reference `.agents/skills/ai-safety/SKILL.md` and `.agents/skills/timeline-editing/SKILL.md`.
Update `plan/PLAN.md` and `docs/`.
