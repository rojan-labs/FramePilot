# ADR 0011: Caption burn-in render-wiring (transcript-derived, opt-in, no schema change)

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Phase 3.3 render-debugger

> **Extended by ADR 0071** (schema v11): the burn-in wiring itself is
> unchanged, but a caption's text is no longer always reconstructed from the
> transcript — a clip carrying its own `captionCue` is authoritative, and the
> transcript-overlap reconstruction described below is the fallback for clips
> without one.

## Context

PLAN §3.3 ("Caption burn-in toggle") was the last open Phase 3 task. The
CaptionEditor already has a burn-in toggle, but it was **preview-time only** —
the deterministic Python render engine (`engine/python`) skipped caption tracks
entirely (they were reported by `unsupported_track_types`, never rendered). To
"complete Phase 3 end to end" the engine has to actually draw captions into an
exported/preview video when requested, and a caption-timing golden test has to
back it (PLAN §2.3 deferred that golden to "when caption rendering lands").

Two constraints shaped the design:

1. **Where does the caption text come from?** A caption clip
   (`add_caption_layer`) carries only a time range and an empty `caption` effect
   — `assetId = "__caption__"`, no text. The spoken words live in
   `project.transcript`. The editor preview already reconstructs each caption
   line's text from the transcript words in the clip's range
   (`apps/web-editor/src/editor/captions.ts`).
2. **No schema change without a migration** (AGENTS.md). Persisting caption
   _style/template/burn-in_ on the clip would need a new schema field — i.e. a
   versioned migration — which is explicitly out of scope for this slice and is
   deferred (see `captions.ts`).

## Decision

Burn captions in the render engine **deterministically from the transcript**,
gated behind an **opt-in `burn_captions` flag**, with **no schema change**:

- A new pure module `render/captions.py` owns two functions:
  `caption_text_for_range(transcript, start, end)` (reconstructs a caption's
  text by transcript-word overlap — the same rule the editor preview uses) and
  `render_caption_image(text, w, h)` (rasterizes the text to an RGBA overlay
  with Pillow's **bundled** font via `ImageFont.load_default(size=…)`, so there
  is no dependency on an installed system font and output is identical across
  machines with the same Pillow version).
- `compile_timeline(..., burn_captions=False)` composites caption-track clips as
  `ImageClip` overlays in the lower safe area, on top of the video, when the flag
  is set. `unsupported_track_types(..., burn_captions=...)` stops reporting
  caption tracks as deferred when they are being burned in.
- The flag is threaded through every render surface: `RenderOptions.burn_captions`
  → `render`/`render_preview`/`export_video`, the sidecar `RenderRequest` /
  `RenderPreviewRequest` (`/render`, `/render/preview`), and the CLI
  `framepilot render --burn-captions`.

A caption-timing golden (`test_burned_captions_appear_only_during_their_range`)
renders the same project with and without burn-in and asserts the lower frame
region differs sharply **during** a caption's range and is unchanged **after** it
— proving both that captions are drawn and that they are correctly time-bounded.

## Consequences

**Positive**

- Phase 3.3 is genuinely complete end-to-end through the engine: a project with a
  caption track exports a video with burned-in captions, validated automatically
  (the black-frame/duration/stream checks still run).
- **Deterministic** — captions are a pure function of transcript + timeline, so
  golden tests are stable and the render stays reproducible (PRD §3.6).
- **No new dependency, no schema migration.** Pillow is already a dependency;
  text derives from the existing `transcript` field.
- Soft captions remain the default (`burn_captions=False`), so existing renders,
  goldens, and the preview-only path are unchanged.

**Negative / accepted costs**

- Caption **styling/templates/keyword-highlight are not honored at render** — the
  burned-in look is a fixed deterministic baseline (white text on a translucent
  box). Honoring per-clip styles needs a schema field and is deferred to a future
  migration (tracked with the existing caption-style deferral in `captions.ts`).
  **Update (schema v5, ADR 0045, 2026-07-10):** this is closed on the engine
  side. `render_caption_image` now accepts an optional `CaptionStyle` (font
  family/scale, text/outline color, position, `presetId`, per-word
  `pop`/`karaoke-fill` highlight) and `_caption_layers` in `render/compiler.py`
  wires it in — a static cached image for non-animated styles, a per-frame
  synced RGB+alpha `VideoClip` when a highlight animation is active. A clip
  with no `captionStyle` still renders the exact baseline above, byte-for-byte
  (regression-tested). The `CaptionEditor.tsx` UI has no way to author a
  `captionStyle` yet, so this is a render-engine capability only, not a
  user-facing feature until that UI wiring lands.
- The renderer **UI → engine export IPC channel** is not added here, so the
  CaptionEditor's burn-in toggle does not yet reach a real export from the desktop
  app (no render IPC channel exists). Wiring that toggle to a render request is a
  separate Phase 8 surface (broadening the IPC surface is an "ask first" change).
- The bundled-font rasterization is legible but plain; richer typography (custom
  fonts, outline/shadow) is a later compositing concern (Phase 5/6).

## Alternatives Considered

- **Store caption text + style on the clip (schema field).** Rejected for this
  slice: requires a schema migration (AGENTS.md "no schema change without a
  migration") and broadens scope well beyond the open task. Deferred.
- **MoviePy `TextClip`.** Rejected: in MoviePy 2.x `TextClip` depends on an
  external/system font (and historically ImageMagick), which is non-deterministic
  across machines and would make goldens brittle. Pillow's bundled font is
  deterministic and dependency-free.
- **Commit per-pixel/aHash caption goldens.** Rejected as the primary assertion:
  exact glyph pixels can shift between Pillow versions. The relative
  during-vs-after frame-diff test is robust to that while still proving the
  feature and its timing.
