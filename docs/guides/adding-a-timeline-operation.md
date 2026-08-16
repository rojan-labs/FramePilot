# Adding a Timeline Operation

A "timeline operation" is the atomic unit of every edit in FramePilot (manual _or_ AI).
Adding one correctly is what keeps the whole system reliable: typed, validated, reversible,
tested. Follow this recipe exactly — and see the `timeline-editing` skill
(`.agents/skills/timeline-editing/`).

Background reading:
[../architecture/timeline-and-patch-engine.md](../architecture/timeline-and-patch-engine.md),
[../api/patch-format.md](../api/patch-format.md).

> **Rule (CI-enforced):** no unvalidated timeline operation may reach `apply`, and no
> operation ships without its inverse and full tests.

---

## Step 1 — Define the operation type (schema)

In `packages/timeline-schema` (and `packages/shared-types`), add the new operation to the
operation union with a strict schema (Zod on the TS side, Pydantic on the Python side,
kept in sync via the shared JSON Schema). Define exactly the fields it needs — no loose
`any`. Add a JSON example to [../api/patch-format.md](../api/patch-format.md).

## Step 2 — Implement `apply` and `invert`

In `packages/editor-core`, implement the operation as **two pure functions**:

```ts
apply(timeline: Timeline, op: Op): Timeline       // immutable, deterministic
invert(timeline: Timeline, op: Op): Operation[]   // ops that undo `op` given prior state
```

- `apply` must not mutate its input and must be deterministic.
- `invert` must restore the _exact_ prior state (this is how undo/redo works). If an
  operation cannot be inverted, it is not allowed — reversibility is non-negotiable.
- Reuse snapping / ripple / overlap helpers rather than re-implementing them.

## Step 3 — Add a validator rule

In the patch validator, add the checks this operation needs (per PRD §8.5): references
exist, no negative duration, valid layer order, no missing asset, supported effect, no
broken audio link, no overlap, engine supports the op, op is reversible. Return **typed,
actionable errors**, never a bare boolean.

## Step 4 — Tests

Timeline operations and the validator carry the correctness burden (PRD §16.1) — test
their real branches, not a percentage. Add:

- unit tests for `apply` (happy path + edge cases),
- **round-trip tests**: `invert(apply(t, op))` restores `t` exactly,
- validator tests: each failure mode produces the right typed error,
- if it produces media output, a golden-media test with tolerances
  ([writing-tests.md](writing-tests.md)).

## Step 5 — Expose as an AI tool (if AI should use it)

If the AI should be able to perform this edit, add a corresponding **write tool** to the
Tool Registry ([../api/ai-tools.md](../api/ai-tools.md)):

- strict input schema (reject invalid input),
- the tool **returns a patch** containing the new operation — it never mutates the project,
- add tests using the `mock` provider for deterministic end-to-end coverage,
- ensure the operation is reversible (already guaranteed by Step 2).

## Step 6 — Update docs and the plan

- Add/refresh the JSON example in [../api/patch-format.md](../api/patch-format.md).
- Update the tool table in [../api/ai-tools.md](../api/ai-tools.md) (if Step 5 applied).
- If the schema changed shape, note migration in
  [../api/timeline-schema.md](../api/timeline-schema.md) (no breaking change without a
  migration).
- Check the relevant item in [../../plan/PLAN.md](../../plan/PLAN.md).

---

## Definition of done (PRD §20)

The operation is done only when: it works manually; it works via an AI tool (if
applicable); it is reversible; the schema is documented; unit + integration tests exist;
an e2e test covers the flow if it's a critical path; coverage passes; render output (if
any) is validated; and user-facing errors are clear.
