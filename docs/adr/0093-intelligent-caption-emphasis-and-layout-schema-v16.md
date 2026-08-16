# ADR 0093 — AI caption emphasis, bundled typography, and direct layout (schema v16)

Status: **Accepted** · Date: 2026-08-02 · Extends ADR 0069, ADR 0071, and ADR 0076.

## Context

FramePilot already persisted editable caption cues and interpreted a data-driven template catalog,
but emphasis still depended on manually entered keywords and layout stopped at three vertical
anchors. That left two visible gaps: cue grouping could not reserve visual room for a deliberately
large anchor word, and the Program monitor could not place a caption with the direct manipulation
creators already use for text overlays.

## Decision

- Automatic emphasis calls the AI provider selected in Settings. The model receives transcript
  words with timing and confidence evidence, and returns a strict JSON keyword contract. Its output
  is schema-validated, de-duplicated, capped to a sparse density, and restricted to words that
  actually occur in the transcript. A provider failure, missing provider, or malformed response is
  reported in the UI and falls back to the deterministic editor-core scorer; captions remain usable
  offline without presenting the fallback as an AI result. The result persists through the existing
  `captionStyle.accent.mode = "keywords"` contract, so preview, export, undo, AI tools and project
  persistence share one representation.
- The canonical segmenter accepts those semantic anchors. Anchor words carry their larger visual
  width during packing and line balancing, and a composed phrase ending on an anchor is preferred
  over isolating it as a one-word orphan. The linguistic hierarchy—sentence, clause, pause,
  non-dangling function words—still outranks visual preference.
- Schema v16 adds optional `xPercent`, `yPercent`, `rotation`, `maxWidthPercent`, `textAlign`,
  `lineHeight`, and `safeArea` fields to `CaptionStyle`. They are percentages/unitless values so the
  same project is resolution-independent in the DOM preview and the deterministic Python export.
- Direct manipulation writes these fields only through the existing reversible
  `set_caption_style` operation. Text editing continues through `set_caption_cue`; no preview code
  mutates project JSON.
- Six supplied-reference families are added as catalog data, never template-id branches in either
  renderer.
- A canonical 22-family caption-font catalog generates the browser `@font-face` sheet and Python
  renderer manifest. Every face is bundled from the Google Fonts OFL collection in both runtimes;
  projects never depend on an editor's locally installed fonts.
- The registered AI surface exposes `discover_caption_styles`, `auto_emphasize_captions`, and
  `set_track_caption_style`. The invoking model selects transcript-grounded anchor words and may
  compose font/template, x/y placement and every `CaptionStyle` field in the same call. The tool
  rejects unspoken keywords, unknown templates and unbundled fonts, then emits the same reversible
  track-style operation used by the manual editor. Per-cue `set_caption_style` remains the override.

## Consequences

- A v15 project migrates by version stamp only and renders byte-identically because every new field
  is optional; absent geometry keeps the legacy centered top/middle/bottom placement.
- Positive rotation is clockwise in both UI and project data. The compiler negates it at the
  MoviePy boundary because Pillow/MoviePy use anticlockwise-positive rotation.
- Safe-area placement defaults on. Free centres clamp to the inner 10% unless a creator explicitly
  disables it.
- AI emphasis is a creative suggestion, not an irreversible transcript rewrite. Creators can
  replace its keywords, edit cues, split, merge, move, and undo without regenerating. The local
  fallback remains reproducible; provider-backed results can vary by configured model.
- Agent Auto Emphasis deliberately does not make a hidden nested provider request: the calling AI
  supplies its contextual selections through a strict contract. This preserves provider ownership,
  makes the proposed operation reviewable, and keeps TypeScript, Python and MCP behavior aligned.
- Mask-stack work previously proposed for schema v16 moves to v17.
