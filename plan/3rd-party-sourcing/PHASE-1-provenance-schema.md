# Phase 1 — Asset provenance, schema v20 — `[ ]`

> **Ships:** the project file can record where an asset came from and what crediting it
> obliges. Nothing user-visible yet.
> **Exists because of decision D2 (2026-08-23):** attribution-required tracks are usable, so
> attribution must be **durable**.
> **Maintainer-approved schema change** (CLAUDE.md §5, AGENTS.md §8 — no schema change
> without a migration).

---

## Why this is a phase and not a UI badge

The instinct is to show a "licensed / credit required" badge in the search results and be
done. That solves the wrong moment.

A badge at search time helps the user **choose**. The obligation lands weeks later, when they
publish and need to know _which_ of four tracks needed crediting, _to whom_, and _under which
licence_. If the only record of that was a chip in a search panel they closed, the product
has quietly walked them into a licence violation.

So the requirement is not "show the licence" but **"the project remembers the licence, and
the credit is retrievable at export."** That is a persisted field, which is a schema change,
which is a migration.

This also stops being an optional nicety once attribution-required content is allowed:
without it, the product's own failure mode is silent user harm.

---

## P1.1 — `AssetSourceSchema` (schema v20) — `[ ]`

**Touch:** `packages/timeline-schema/src/index.ts`, `migrations.ts`.

Add an **optional** `source` to `AssetSchema` (`index.ts:919`). Optional rather than
defaulted, exactly like `capabilityPacks` in v19 (`index.ts:1087`) — adding it must not force
every in-memory `Project` literal to materialize a value, and absent must remain the correct
reading of every pre-v20 project (an asset the user dragged in has no provenance, and never
will).

```ts
export const AssetSourceSchema = z.object({
  /** Provider roster name, e.g. 'openverse'. */
  provider: z.string().min(1),
  /** Provider-local id. Download dedupe + "find this again". */
  remoteId: z.string().min(1),
  /** Licence identifier verbatim from the provider, e.g. 'cc-by' / 'cc0'. */
  license: z.string().min(1),
  /** Canonical licence text URL, so the user can read the actual terms. */
  licenseUrl: z.string().optional(),
  /**
   * TRUE when the licence obliges the end user to credit someone. Stored rather
   * than derived: licence vocabularies differ per provider and change over time,
   * and a project written today must still know what it agreed to.
   */
  attributionRequired: z.boolean(),
  /**
   * The ready-to-paste credit line. Openverse supplies this directly; other
   * providers' adapters assemble it. This is the field that makes the obligation
   * survivable — everything else is metadata about it.
   */
  attribution: z.string().optional(),
  creator: z.string().optional(),
  creatorUrl: z.string().optional(),
  /** Landing page for the item on the provider. */
  sourceUrl: z.string().optional(),
  /** ISO-8601. What the terms were understood to be, and when. */
  fetchedAt: z.string(),
});
```

`SCHEMA_VERSION` 19 → 20. Migration `{from: 19, to: 20}` in `MIGRATIONS` is a **no-op
carry-over** — nothing to backfill, because no pre-v20 asset has a source. Write it anyway
and test it: the migration list is the contract, and a gap in it is worse than a trivial entry.

**Tests:** `migrations.test.ts` — a v19 project migrates to v20 unchanged and re-parses;
`index.test.ts` — an asset with and without `source` both validate; a `source` missing
`attributionRequired` is rejected.

---

## P1.2 — Python parity — `[ ]`

**Touch:** the Pydantic project models in `engine/python`.

Keep the Pydantic schema in lockstep (CLAUDE.md §2). The engine does not _use_ `source` —
provenance never affects a render — but a model that drops unknown fields would silently
strip it on any engine round-trip, which is exactly how provenance would get lost.

Note the existing cross-language contract: the engine serializes absent values as JSON
`null`, so the Zod side is `.nullish()`-tolerant where it must be (see the `AssetMediaSchema`
comment at `index.ts:900` for the precedent and the reasoning).

Also confirm the engine's strict envelope check still passes — the loader requires
`envelope == SCHEMA_VERSION` exactly, and fixtures must import the constant rather than
hard-coding it.

**Tests:** an engine round-trip of a project with `source` preserves every field.

---

## P1.3 — Credits surface — `[ ]`

**Touch:** `apps/web-editor` — export/project surface.

**This is what the schema is for.** Without it, Phase 1 is a field nobody can read, which is
the "backend-only completion" failure `product-discipline.mdc` §4 names explicitly.

- A **Credits** view listing every asset in the project with `source.attributionRequired`,
  showing the `attribution` string, licence name, and a link to the licence text.
- **Copy all credits** — one click, plain text, ready to paste into a video description. This
  is the actual user action; everything else is supporting cast.
- Empty state when nothing needs crediting: _"No tracks in this project require credit"_ —
  a positive confirmation, not a blank panel, because "nothing to do" is information.
- Reachable from export, where the obligation becomes real.

**Deliberately not built:** burning credits into the rendered video. That is a compositing
decision with layout, duration and style implications, and the user may credit in a
description instead. Recorded here so its absence is a decision.

**Tests:** credits list renders for attribution-required assets, omits CC0 ones, copy
produces the expected text, empty state renders.

---

## P1.4 — Docs — `[ ]`

- **ADR:** _"Asset provenance is persisted (schema v20)"_ — record the WHY: a search-time
  badge cannot discharge a publish-time obligation. Reference D2.
- `docs/guides/` — the schema addition, per the migration convention.
- `CHANGELOG.md`.

---

## Definition of done

- [ ] `SCHEMA_VERSION` is 20; the 19 → 20 migration exists and is tested
- [ ] v19 projects load unchanged; `source` is optional everywhere
- [ ] Python parity holds — an engine round-trip does not strip `source`
- [ ] Credits view lists obligations and copies them in one action
- [ ] `pnpm verify` green; `pnpm engine:test` green
- [ ] ADR + guide + `CHANGELOG.md` landed

**Deferred:** burned-in on-screen credits; per-clip (rather than per-asset) attribution;
provenance for user-imported files (there is none to record).
