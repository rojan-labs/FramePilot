# Skill: Timeline Editing

Make safe, typed, reversible timeline changes in `packages/editor-core` and
`packages/timeline-schema`. (PRD §14.1, §8.4–8.5, §11.)

## When to use

- Adding or modifying a timeline operation (trim, split, delete, move, ripple, overlay, caption, keyframe, transition, mask, track).
- Anything that changes the shape of `project.fp.json` or how edits are applied/inverted.

## Rules / steps

1. **Inspect the schema first** — read `timeline-schema` (Zod) and the Python Pydantic models. Understand the current `Project/Timeline/Track/Clip/Effect/Keyframe` shape.
2. **Return a timeline patch, not a raw mutation.** Operations are pure: `apply(timeline, op) -> timeline` (immutable). The AI layer emits patches.
3. **Implement `apply` AND `invert`.** Every editing op needs an inverse (`invert(timeline, op) -> op[]`) so undo works and patches are reversible.
4. **Validate references** — clip/track/asset ids exist, no negative duration, valid layer order, no overlap error, engine supports the op (PRD §8.5). Validate before apply.
5. **Preserve originals** — never modify or delete source media; edits live only in the timeline.
6. **Schema changes need a migration** — bump the version, write the migration, keep TS and Python schemas in sync, update round-trip fixtures.
7. **Add tests** for the new operation and its inverse, covering their real branches.

## Definition of done

- Operation has typed schema, pure `apply`, working `invert`, and validation.
- `apply` + `invert` unit-tested across their branches; round-trip schema fixtures pass.
- Migration written if the schema changed; TS/PY schemas in sync.
- `plan/PLAN.md` and `docs/` updated.
