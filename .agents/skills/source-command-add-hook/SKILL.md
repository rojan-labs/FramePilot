---
name: 'source-command-add-hook'
description: 'Find the strongest hook and restructure the opening as a reversible patch (PRD §5.2, §7.1)'
---

# source-command-add-hook

Use this skill when the user asks to run the migrated source command `add-hook`.

## Command Template

Find the strongest hook and make it the opening.

1. Read `plan/PLAN.md`. Build context (transcript, timeline). Identify the strongest hook
   moment (where the outcome/payoff is shown) and explain WHY.
2. Produce a **patch** of typed operations to lead with the hook: trim/move the opening,
   remove dead intro, optionally add a text overlay for the hook line. Never raw-mutate JSON.
3. **Validate** → **preview** the diff → human approves → **apply** transactionally.
4. If rendered, **validate the render** (PRD §9.4). Keep reversible.

Reference `.agents/skills/ai-safety/SKILL.md`. Update `plan/PLAN.md` and `docs/`.
