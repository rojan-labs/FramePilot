# ADR 0024 — Project schema v2: engine-derived `Asset.media`

- **Status:** Accepted
- **Date:** 2026-06-26
- **Phase:** 8 — Production Hardening & Release
- **Relates to:** ADR 0008 (cross-language schema sync via JSON Schema), the schema
  versioning + migration framework (PLAN §1.1), and the timeline UI's waveform/
  thumbnail "skeleton" placeholders (ADR 0013–0014)

## Context

The timeline UI draws audio clips with a waveform **skeleton** and video clips
without thumbnails. Real waveforms and thumbnails were deferred pending an
`Asset`/bridge contract change, because of a hard rule: **the renderer never computes
media** (no audio-decode or frame-extract in the browser — render-vs-preview, PRD
§9.2). The Python engine already produces exactly this derived media
(`media/waveform.py` → normalized per-bucket peaks; `media/derive.py` → low-res proxy
and thumbnails) during the Phase 2 media pipeline, but there was nowhere in the
project document to persist it for the timeline to read.

The project/timeline data model is owned by the TS Zod schema
(`packages/timeline-schema`), which is the single source of truth; the cross-language
JSON Schema is exported from it and the Python Pydantic models mirror it, guarded by a
drift test and a parity test (ADR 0008). So adding a place to store derived media is a
**schema change**, and a schema change is governed by the project rule: _no schema
change without a migration_ (PLAN §1.1, CLAUDE.md §5).

## Decision

Add an optional, read-only **`AssetMedia`** sub-object to `AssetSchema` and bump the
envelope `SCHEMA_VERSION` from **1 → 2**.

- `packages/timeline-schema/src/index.ts`:
  - `SCHEMA_VERSION = 2`.
  - New `AssetMediaSchema` with all-optional fields: `proxyPath?` (project-relative
    path to a generated low-res proxy), `peaks?: number[]` (downsampled, normalized
    0..1 waveform peaks), `peaksPerSecond?` (sampling rate, for time-accurate
    drawing), `thumbnailPaths?: string[]` (project-relative, time-ordered thumbnail
    images).
  - `AssetSchema` gains an optional `media: AssetMediaSchema`.
- The committed `schema/project.schema.json` is **regenerated** from the Zod source
  (`pnpm --filter @framepilot/timeline-schema schema:generate`), keeping the TS drift
  guard green.
- The Python mirror (`engine/python/framepilot_engine/timeline/models.py`) adds an
  `AssetMedia` model and `Asset.media`, keeping the parity test
  (`test_schema_parity.py`) green.
- A **v1 → v2 migration** is registered in `migrations.ts`.

### Why the field is read-only and engine-derived

`media` is a **cache of derived media**, not user-authored timeline state. The engine
is the only producer (browser never decodes/extracts — render-vs-preview); the
timeline only ever _reads_ it to draw real waveforms/thumbnails instead of skeletons.
Making every field optional means an asset without derived media is still valid, so
import-then-derive can populate it incrementally. The field is populated by the
**desktop import path** (the engine derives media on import and the project persists
the result); browser-only builds simply leave it unset and keep the skeletons.

### Why a migration even though the change is additive

The change is purely additive: a v1 asset has no `media`, and because `media` is
optional, the v1 document validates unchanged against v2 — no data needs
transforming. We still register a migration because the project rule is **no schema
change without a migration**, full stop. The registered v1→v2 step is an identity
transform (`migrate: (raw) => raw`); its job is to **stamp the new envelope version**
on the document (`migrateToCurrent` sets `schemaVersion: step.to`) and to make the
version bump an explicit, reviewed, logged event rather than a silent one. Keeping the
migration chain gap-free also preserves the framework's invariant that opening any
older file walks a complete `from: N → to: N+1` sequence; a missing step throws.

## Consequences

- **`project.fp.json` is now `schemaVersion: 2`.** Files written by this build carry
  the new envelope. v1 files open via the additive migration (no data change). The
  Python render engine still does **not** migrate — it rejects an older file with
  guidance to open it in the editor once (the editor owns migrations); that behavior
  is unchanged.
- **The timeline can render real waveforms/thumbnails** once the desktop import path
  populates `Asset.media`, with no further schema change.
- **Cross-language contract stays in sync** by construction: regenerated JSON Schema
  equals committed (TS drift guard), and the Pydantic field set equals the JSON
  Schema property set at every level (Python parity guard) — both per ADR 0008.
- **No new dependency.** Pure schema + migration + mirror change.
