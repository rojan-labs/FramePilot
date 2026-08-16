# Skill: AI Safety

Add and review AI tools and orchestrator behavior safely. (PRD §14.4, §18.2, §8.3.)

## When to use

- Adding a new AI tool, changing the tool registry, or touching the orchestrator/context/memory.
- Reviewing any code path where the AI can affect files or the timeline.

## Rules / steps

1. **Tools only** — the AI may edit ONLY through registered tools. No free-form mutation; no shell/eval/process spawn from the agent runtime.
2. **Every tool needs a schema** — typed, validated input (Zod in TS / Pydantic in PY). Reject invalid input before doing anything.
3. **Every tool needs validation** — inputs and the resulting operations validated before apply (PRD §8.5).
4. **Reversible if it edits the timeline** — the tool produces operations with inverses; the patch is revertible.
5. **Returns a patch, never a raw mutation** of `project.fp.json`.
6. **No direct file mutation without permission** — destructive/file-writing actions require explicit human confirmation; never delete/overwrite originals.
7. **Sandbox to the project dir** — all file access via safe-path resolution; reject traversal.
8. **Tests** — unit tests for schema + behavior, covering the real branches and error paths; test the mock provider path.

## Definition of done

- Tool has schema + validation + reversibility (if it edits timeline) + tests.
- Tool is registered; the AI cannot reach state except through it.
- No arbitrary shell; file ops sandboxed; secrets untouched.
- `plan/PLAN.md` and `docs/api/` updated; agent rules updated if behavior changed.
