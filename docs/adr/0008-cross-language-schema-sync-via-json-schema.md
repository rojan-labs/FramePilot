# ADR 0008: Cross-language schema sync via an exported JSON Schema

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Phase 2 / schema-sync work

## Context

FramePilot's project/timeline data model lives twice: as the TypeScript Zod
schema in `packages/timeline-schema` (used by the editor, patch engine, and
desktop shell) and as Python Pydantic models in `engine/python` (used by the
render engine and the Python operation/validator mirror). `project.fp.json` is
the canonical document both sides read and write, so the two definitions **must
agree byte-for-byte on field names and structure** (PRD §11, AGENTS invariant 3:
"keep `timeline-schema` and the Python Pydantic schemas in sync; no schema change
without a migration").

The previous arrangement kept both schemas by hand. That is exactly the kind of
drift the project treats as a bug — and it had in fact already drifted (see
Consequences). We needed a **machine-checkable contract** between the two
languages, without:

- adding a new dependency or migrating the existing Zod data shapes, and
- hand-maintaining a third parallel artifact that can itself rot.

A key enabling observation: Zod 3.25 bundles the **Zod v4 API under the `zod/v4`
subpath**, which ships a native `z.toJSONSchema` exporter. We already import from
`zod/v4`, so a JSON Schema can be _derived_ from the single Zod source of truth
at zero dependency cost.

## Decision

We will treat the **TS Zod schema (`packages/timeline-schema`) as the single
source of truth** for the data model, and define the cross-language contract as a
**JSON Schema exported from it** — never hand-maintained. The Python Pydantic
models are kept in sync _against that exported schema_, not against the Zod code
directly.

Specifics:

- `buildProjectJsonSchema()` in `packages/timeline-schema/src/index.ts` calls
  `zod/v4`'s native `z.toJSONSchema(ProjectSchema)`. **No new dependency, no
  migration of the data shapes.**
- The generated contract is committed at
  `packages/timeline-schema/schema/project.schema.json` and regenerated via
  `pnpm --filter @framepilot/timeline-schema schema:generate`.
- **Drift guard (TS):** `packages/timeline-schema/src/json-schema.test.ts`
  regenerates the schema and asserts it equals the committed file, so a Zod change
  without a regenerated artifact fails CI.
- **Parity guard (Python):** `engine/python/tests/test_schema_parity.py` asserts
  the Pydantic models' field-name sets (using their serialization aliases) equal
  the JSON Schema property sets at **every level** — `Project`, `Resolution`,
  `Asset`, `TranscriptWord`, `Timeline`, `Track`, `Clip`, `Effect`, `Keyframe`.
- **Scope boundary:** `.refine()` invariants (e.g. clip `end > start`,
  `sourceEnd > sourceStart`) are **intentionally NOT** in the JSON Schema —
  JSON Schema cannot express them cleanly, and they are not part of the
  _data-shape_ contract. They are enforced by the patch validator (PRD §8.5), the
  layer responsible for semantic correctness.

## Consequences

**Positive**

- The contract is **derived, not authored** — there is one source of truth (Zod),
  and the two guards make any divergence a CI failure rather than a runtime
  surprise on a `project.fp.json` written by one side and read by the other.
- The parity guard immediately earned its keep: it caught and we fixed **three
  real drifts** in the Python mirror —
  1. transcript field named `text` instead of `word`,
  2. a missing `Keyframe.id`, and
  3. an untyped `assets: list[dict]` replaced with a typed `Asset` model.
- Zero new dependencies; the exporter is already available via `zod/v4`.

**Negative / accepted costs**

- Semantic invariants are not in the exported schema, so the JSON Schema alone
  does **not** fully validate a document — that is by design (the validator owns
  invariants), but readers must know the contract is _shape only_.
- Any data-model change is now a three-step ritual: edit Zod → regenerate the
  committed schema → mirror in Pydantic (and migrate, per AGENTS invariant 3).
  The guards enforce the ritual but do not perform it.

**Related tooling fix (recorded here for the same change):** composite-package
`typecheck` scripts changed from `tsc -b --noEmit` to `tsc -b`. TypeScript rejects
`--noEmit` when it is forced onto _referenced_ composite projects (error TS6310:
"Referenced project may not disable emit"), so the build-mode typecheck must let
composite references emit their declaration/`.tsbuildinfo` outputs.

## Alternatives Considered

- **Hand-maintained JSON Schema (or hand-maintained Pydantic against Zod by
  eye):** rejected — this is the status quo that had already drifted three ways;
  it has no mechanical guard.
- **Pydantic as source of truth, generate TS from it:** rejected — the editor,
  patch engine, and desktop shell are TS-first and depend on Zod's runtime parsing
  and inferred types; the data model originates on the TS side.
- **A shared neutral IDL (e.g. Protobuf/JSON-Schema-authored-by-hand):** rejected
  — adds a third artifact and a codegen toolchain for both languages, when
  `z.toJSONSchema` already derives the contract from the schema we maintain.
- **Encode `.refine()` invariants into the JSON Schema:** rejected — JSON Schema
  cross-field constraints are awkward and would duplicate the validator's job;
  shape and semantics are deliberately separated.
