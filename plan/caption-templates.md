# Sub-plan — Template-Based Caption System (clipvo-style, 40 templates)

> Linked from `plan/PLAN.md` §3.3. Replaces the 3-preset caption styling
> end-to-end with a data-driven template catalog. Reference: competitor
> template gallery (category-tabbed grid of animated caption templates, each
> tile live-looping a sample phrase). Adding template #41 must be pure catalog
> data — renderers interpret closed enum vocabularies only, never template ids.

**Approved decisions (2026-07-19):** full schema v10 with transforming
migration `presetId` → `templateId` · bundle ~7 OFL font families ·
map the 3 legacy presets (clean/bold-pop/subtle) to nearest new templates ·
engine goldens at primitive level (~20 images) + all-40 determinism smoke.
Baseline `style=None` render path stays byte-identical.

## Template catalog (40)

| Category | Templates |
|---|---|
| One word | Punchline, Beast, Impact, Stamp |
| Phrase | Trio, Duo, Phrase Pop, Duo Gold, Phrase Box, Phrase Marker |
| Karaoke | Karaoke, Broadcast, Outline, Glow, Minimal |
| Build | Hormozi, Slide, Bounce, Typewriter, Ticker |
| Boxed | Boxed, Tag |
| Editorial | Spotlight, Headline, Whisper |
| Aesthetic | Highlighter, Pill, Ember, Retro, Caption Bar, Pulse, Negative, Knockout, Kinetic, Cascade, Stacked |
| Cinematic | Soft Focus, Soft 2.0, Soft 3.0, Soft 4.0, Motion, Cinematic Cut, Cinetop, Real Estate, Subtitle Pop |

## Phases

- [x] **1. Schema v10** — new caption sub-schemas (display, emphasis, entrance,
  background, shadow, animation, accent) in `packages/timeline-schema/src/index.ts`;
  `SCHEMA_VERSION = 10`; first data-transforming migration in `migrations.ts`
  (presetId→templateId, legacy mapping); regenerate `schema/project.schema.json`;
  mirror in `engine/python/framepilot_engine/timeline/models.py`; ADR 0069.
- [x] **2. Catalog + fonts** — `src/caption-templates.ts` (40 entries +
  `resolveCaptionStyle`); JSON artifact emitted by `generate-json-schema.mjs`
  and packaged into the engine; Python loader/resolver + byte-drift test;
  bundled OFL fonts (engine + web-editor) with manifest; `pnpm license:scan`.
- [x] **3. Engine interpreter** — rewrite styled path of `render/captions.py`
  (display modes, emphasis, entrance/loop, accent, weight files); generalize
  `caption_style_is_animated`; primitive goldens + determinism smoke; 100% cov.
- [x] **4. Web preview** — `CaptionOverlay.tsx` (enum→CSS), wired into
  `PreviewPlayer.tsx` + `WebCodecsPreviewPlayer.tsx`.
- [x] **5. Gallery UI + removal** — delete `CAPTION_TEMPLATES` preset system
  from `editor/captions.ts`; `generateCaptionsPatch` stamps `templateId`;
  `CaptionEditor.tsx` category-tabbed animated 40-tile gallery (shared rAF
  clock, IntersectionObserver pause).
- [x] **6. AI layer** — tool-registry descriptions, `synthCaptionLayer`
  templateId, cue length capped at template words-per-line, skill/command docs.
- [x] **7. E2E + docs** — transcript-and-captions e2e, export burn-in smoke,
  CHANGELOG, supersede notes on ADR 0011/0045, plan checkoff.
