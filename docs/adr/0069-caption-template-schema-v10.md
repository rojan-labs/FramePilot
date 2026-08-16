# ADR 0069 — Template-based caption styling (schema v10)

- **Status:** Accepted (2026-07-19). **Extended by ADR 0071** (schema v11): the
  catalog and its closed enum vocabulary stand unchanged, but style resolution
  gains a track-level layer (clip override → track default → template), and
  `accent.mode: 'keywords'` — shipped here with no keyword source, and therefore
  a documented no-op in both renderers — becomes live via
  `accent.keywords`.
- **Supersedes:** the preset-resolution part of ADR 0045 (caption style schema
  v5); the burn-in wiring in ADR 0011 is unchanged.

## Context

Caption styling was a 3-preset system (`clean`, `bold-pop`, `subtle`): a
preview-time catalog in the web-editor, `CaptionStyleSchema.presetId` in the
timeline schema (v5), and hard-coded per-preset color dictionaries in the
Python rasterizer. The product direction is a competitor-grade **template
gallery** — ~40 named caption looks across categories (one-word, phrase,
karaoke, build, boxed, editorial, aesthetic, cinematic), each combining
typography, palette, an active-word emphasis, and an entrance animation.
Hard-coding 40 looks in two renderers (Pillow engine + DOM preview) would be
unmaintainable and would drift.

## Decision

1. **Schema v10** rewrites `CaptionStyleSchema` around closed enum
   vocabularies that renderers interpret generically:
   - `display`: `phrase | active-word | cumulative` (how words group over time)
   - `highlight.animation` (emphasis): `none | color | pop | karaoke-fill |
     background | glow | underline | pulse`
   - `animation.in.type` (entrance): `none | fade | slide-up | zoom | bounce |
     typewriter`, plus `out` (`none|fade`), `loop` (`pulse|wave`), `perWord`
   - new structured `background` (line chip), `shadow` (drop shadow / glow),
     `accent` (deterministic accent-word styling: `last-word | longest-word |
     keywords`), plus `fontWeight`, `fontStyle`, `textTransform`,
     `letterSpacing`.
   - `presetId` is **replaced** by `templateId`, referencing the canonical
     template catalog (`packages/timeline-schema/src/caption-templates.ts`).
2. **Resolution rule:** the template fills every field the clip's style leaves
   unset; explicit fields are user overrides and always win. Renderers (Python
   engine, web preview) interpret **only the enum vocabulary, never template
   ids** — adding a template is pure catalog data, no renderer change.
3. **First data-transforming migration (v9 → v10):** known preset ids map to
   their nearest catalog templates (`clean→minimal`, `bold-pop→boxed`,
   `subtle→whisper`, see `LEGACY_PRESET_TO_TEMPLATE_ID`); unknown preset ids
   are dropped; explicit v9 fields (a strict subset of v10) carry over
   unchanged. Unstyled clips are untouched — the pre-v5 baseline render path
   stays byte-identical.

## Consequences

- Every prior migration was a version stamp; v9→v10 transforms data, so
  `migrations.ts` now demonstrates the defensive pattern for raw (unvalidated)
  project JSON.
- Old projects using the three presets shift slightly in look (accepted
  trade-off; approved 2026-07-19).
- The Python `CaptionStyle` mirror grows nested models (`CaptionBackground`,
  `CaptionShadow`, `CaptionAnimation`, `CaptionAccent`); TS↔Python drift
  remains guarded by `schema:generate` + `json-schema.test.ts` +
  `test_schema_parity.py`, and the template catalog gets the same treatment
  via a generated `caption-templates.json` consumed by the engine.
- The engine's per-preset color dictionaries become transitional (keyed by
  both legacy and mapped ids) until the data-driven interpreter replaces them.
