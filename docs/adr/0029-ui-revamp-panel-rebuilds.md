# ADR 0029 — UI revamp: panel-by-panel rebuilds and in-house primitives

- Status: Accepted
- Date: 2026-06-28
- Supersedes/extends: ADR 0028 (Notion dark design system)

## Context

ADR 0028 retuned the design tokens and did a deliberately conservative restyle.
The product owner's definitive spec (`ui_revamp/framepilot-revamp-master-prompt.md`)
asks for **panel-by-panel rebuilds** (not a recolor) plus a set of explicitly
owner-requested interaction changes that the 0028 pass had deferred (folder
creation flow, CapCut-style effects browser, Cursor-style AI composer, overlay/
caption rebuilds, inspector Select primitives, timeline track controls).

The hard constraints are unchanged: the render/export/FFmpeg pipeline, AI calls +
JSON timeline contract, timeline data model + editing math, `.fp.json`
persistence, undo/redo, and keyboard actions are **hard-protected**; every
`data-testid`/`id`/`aria` hook is preserved; all edits route through the existing
typed patch-builders.

## Decision

1. **In-house primitives, no new dependencies.** Added a token-styled `Tooltip`
   (200–400ms, `--bg-elevated`, shortcut keycap, works on disabled controls) and a
   keyboard-operable `Select` listbox (icons + hint + active check), built on the
   existing `Menu`/`Button` patterns. We did **not** add Radix/shadcn — it would
   need dependency + license review (CLAUDE.md §5) for primitives we can build
   small and on-theme.

2. **Client-side bin thumbnails for imported media.** `useAssetThumbnail` captures
   a real poster frame from a session-imported video via `<video>`→`<canvas>` (and
   uses the image source directly for images), falling back to the type glyph with
   a shimmer for reloaded, path-only assets. No engine round-trip; durable
   engine-generated thumbnails (`asset.media.thumbnailPaths`) are used when present.

3. **Schema/engine-blocked affordances are stubbed, not faked or silently dropped.**
   - **Track-header controls** (hide/lock; mute/lock for audio) render as
     visually-complete but **disabled** stubs with "coming soon" tooltips, because
     the timeline schema has no `hidden`/`locked`/`muted` fields. Real wiring is a
     follow-up: a **schema v4 migration + patch ops** (engine-before-UI order,
     AGENTS.md). The owner chose to stub now.
   - **Video clip filmstrips** stay flat per-type fills; multi-frame filmstrips need
     Python-engine frame extraction (same deferral family as ADR 0024). Audio
     waveforms already render from engine peaks.
   - **Overlay template/position** and **caption template/keywords/style** are
     preview-time presentation (no schema field) — documented like the existing
     `captions.ts` settings, never implying persistence.

4. **Honest reviewable surfaces over placeholder UI.** The AI Edit mode keeps the
   existing reviewable proposal (why + changes + Apply/Reject); we did **not**
   fabricate a before/after diff because `TimelineDiffView`/`PatchReviewPanel` are
   still Phase 4.3 placeholders. Caption text remains transcript-derived (the clip
   stores only the span), so the caption list offers seek/delete rather than
   free-text edits (wording is edited in the Transcript tab).

5. **Single tool row.** The timeline's razor + zoom-to-fit moved from a second row
   floating above the ruler into the timeline's top-left corner cell (conventional
   NLE position); the global edit toolbar stays the single clip/history tool row.

## Consequences

- The editor now matches the spec's interaction patterns with **no new deps, no
  schema change, and no change to any hard-protected flow**; all edits remain typed,
  validated, reversible patches. Web-editor tests stay green (presentation-only test
  updates: Select listbox interactions, contextual labels).
- Three items remain genuine follow-ups with a clear path: (a) schema v4 +
  patch ops to wire track controls; (b) engine frame extraction for video
  filmstrips / reloaded-asset thumbnails; (c) a real timeline-diff component for AI
  Edit mode. These are tracked in `PROGRESS.md` and surfaced as disabled/preview UI,
  not hidden.
