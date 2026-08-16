---
name: 'source-command-remove-silence'
description: 'Detect and remove silent gaps as a reversible timeline patch (PRD §8.3 analyze_silence)'
---

# source-command-remove-silence

Use this skill when the user asks to run the migrated source command `remove-silence`.

## Command Template

Remove silence from the selected range (or whole timeline) as a reversible patch.

1. Read `plan/PLAN.md`. Use the `analyze_silence` tool to detect silent segments
   (threshold + min duration). Do not guess from raw audio yourself.
2. Produce a **patch** of typed `delete_range` / `ripple_delete` operations — never a raw
   mutation. Preserve originals (non-destructive).
3. **Validate** (no negative duration, references exist, no overlap) → **preview** the diff
   → human approves → **apply** transactionally.
4. If a preview render is produced, **validate the render** (duration, streams, clipping).
5. Ensure the patch is reversible (undo restores the gaps).

Reference `.agents/skills/timeline-editing/SKILL.md`. Update `plan/PLAN.md` and `docs/`.
