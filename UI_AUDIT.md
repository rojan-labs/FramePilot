# UI_AUDIT.md — FramePilot Presentation-Layer Audit (Phase 0)

> Scope: **presentation only**. No business logic, props/APIs, IPC, render/AI
> pipeline, shortcut bindings, routing, persistence, or test/`aria`/`data-*` hooks
> are changed. See `UI_REVAMP/ui-revamp-super-prompt.md` (⛔ prime directive).

## 1. Stack (discovered)

| Concern       | Finding                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework     | React 18 + TypeScript (`apps/web-editor`)                                                                                                                            |
| Bundler       | Vite 5                                                                                                                                                               |
| Desktop shell | Electron (`apps/desktop`) — renderer is `web-editor`                                                                                                                 |
| Styling       | **Single hand-authored CSS file** `apps/web-editor/src/styles.css` (~2.4k lines) with CSS custom properties on `:root`. No Tailwind, no CSS-in-JS.                   |
| Component lib | `@framepilot/ui` (local) — exposes `Button`, `PatchReviewPanel`, `TimelineDiffView`                                                                                  |
| Icons         | **`lucide-react` already wired** via `apps/web-editor/src/components/icons.tsx` (single re-export module, `ICON_SIZE` 16/18/20 grid). No emoji icons in UI surfaces. |
| Theming       | Dark-only, token-driven. `color-scheme: dark`, `prefers-reduced-motion` honored. **402** `var(--…)` references already in place.                                     |

**Implication:** the cheapest, highest-leverage transformation is to **retune the
`:root` tokens** to the Notion palette — it cascades through all 402 usages at once.
This is exactly "tokens before pixels."

## 2. UI surface inventory

**App shell:** `App.tsx` (shell grid, status bar), `Topbar.tsx` (brand, File menu,
Export, Shortcuts, Settings), `Editor.tsx` (3-column rail layout + draggable
`RailSplitter`), rail collapse/expand.

**Editor surfaces:** `PreviewPlayer.tsx` (program monitor, transport,
`current / total` timecode, loop/safe-area/compare toggles, letterboxed frame),
`Toolbar.tsx` (edit · markers+zoom · history clusters), `TimelineView.tsx` (ruler,
lanes, clips with **real waveforms** + skeletons, draggable playhead line, trim
handles, snap guides, razor), `MediaBin.tsx`, `Inspector.tsx` (+ `ScrubNumber.tsx`
drag-to-scrub numeric fields — **already present**), `EffectsPanel.tsx`,
`OverlaysPanel.tsx`, `TranscriptView.tsx`, `CaptionEditor.tsx`.

**AI surfaces:** `AiPanel.tsx` (prompt textarea, propose/apply/discard, agent mode,
step log), `PatchReviewPanel`/`TimelineDiffView` in `@framepilot/ui`.

**System UI:** `Menu.tsx` (dropdown), `ClipContextMenu.tsx`, `Toasts.tsx`,
`ExportDialog.tsx`, `SettingsDialog.tsx`, `NewProjectDialog.tsx`, `ShortcutHelp.tsx`
/ `ShortcutList.tsx`, `@framepilot/ui` `Button`.

## 3. Worst offenders (to fix)

| #   | Defect                                                                                                                                  | Location                            | Fix                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Palette is a cool near-black (`#0b0b0f`) + periwinkle accent (`#5b8cff`); not the warm Notion `#191919` / `#2383e2`.                    | `styles.css :root`                  | Retune tokens to Notion palette; add canonical spec token names as source of truth, alias legacy names.                                                                                   |
| D2  | ~50 **hardcoded hex** values scattered (clip gradients, badges, `#fff`/`#000`).                                                         | `styles.css` (see grep)             | Replace with tokens.                                                                                                                                                                      |
| D3  | **Gradient fills**: topbar logo (`linear-gradient … #8b5bff`) and clip blocks (per-type gradients). Spec forbids gradients + multi-hue. | `styles.css` 158, 1330–1355         | Flat accent tile for logo; flat muted `--clip-*` fills + brighter borders for clips.                                                                                                      |
| D4  | Selection shows as a **filled** accent block on clips.                                                                                  | `.clip-block[data-selected]`        | Accent **outline** + subtle glow, not a different fill.                                                                                                                                   |
| D5  | "Playhead" **labeled scrubber row** duplicates the transport `current/total` readout (two timecodes that can disagree).                 | `TimelineView` `.timeline-scrubber` | Visually hide the "Playhead" label + redundant `<output>`; **keep the `<input type=range>` as an sr-only accessible/seek control** (tests + keyboard depend on it; ruler already scrubs). |
| D6  | Save chip is a bordered pill.                                                                                                           | `.topbar-chip`                      | Quiet status: dot + muted text (Linear-style), spinner on "Saving…".                                                                                                                      |

## 4. Decisions where teardown conflicts with the prime directive / tests

- **"Remove the second Export button"** (teardown A1): in production `Editor.tsx`
  renders `<Toolbar editor={editor} />` **without** `onExport`, so the toolbar
  Export is permanently `disabled` and the duplicate **does not manifest in the
  shipped app** — the only canonical Export is in the Topbar. `coverage.test.tsx`
  explicitly passes `onExport` and clicks that button. Removing it would force a
  behavior/test change for no production benefit. **Decision: keep, restyle as a
  `secondary` toolbar action; do not change its wiring.** Documented, not silently
  dropped.
- **"Delete the Playhead slider"** (teardown A1/A2): the `<input type="range">` is
  the deterministic seek + keyboard a11y hook the test suite and screen readers
  rely on. **Decision: keep it functional but visually `sr-only`** and drop the
  visible label/duplicate readout — satisfies the visual intent without breaking
  hooks.
- **Track header controls** (teardown A2): the `Track` schema (`packages/timeline-schema`)
  has **no** `mute`/`solo`/`locked`/`hidden` fields. The teardown permits stubbing
  disabled controls, but a row of permanently-dead toggles is itself a slop tell, and
  AGENTS.md forbids schema changes without a migration + the engine-before-UI build
  order. **Decision: defer** — this is a real feature (schema v4 + patch ops), not a
  paint-pass item. Documented; not stubbed.
- **Clip filmstrips** (teardown A2): audio waveforms already render from engine peaks.
  Video **filmstrip thumbnails** require frame extraction from the Python render
  engine + an `Asset` schema handle (same deferral as ADR 0014 Part 5) — not
  presentation. Clips now read as content areas via flat muted per-type fills.

### Resolved in this pass (round 2 — full DoD sweep)

- **Emoji eliminated → Lucide throughout** (DoD + anti-slop Part E): `MediaBin`
  (`🎬🎵🖼️` asset kinds, `✕` remove, `▶` chevron, `📁` folder, `＋` add, `✎` rename,
  `🗑` delete), `AiPanel` (`✓ ! ✕ –` self-check badges + summary), and the `Topbar`
  `✦` logo are now `lucide-react` icons via `icons.tsx` (mapping per teardown Part D).
- Toolbar clusters keep dividers; trailing divider removed. Preview gained a designed
  empty state (icon + existing copy). All new inline icons aligned via flex.

## 5. Phase plan

1. **Phase 1 — tokens** (this change): retune `:root` to the Notion palette, add
   canonical spec tokens, sweep hardcoded hex → tokens. Cascades app-wide.
2. **Phase 2 — primitives**: `Button` variants/sizes/states already token-driven;
   confirm focus-visible + loading coverage.
3. **Phase 3 — surfaces**: clip flat fills + outline selection, save chip, topbar
   logo, scrubber de-dupe, focus rings, custom scrollbars.
4. **Phase 4 — verify**: `pnpm typecheck`, unit tests, `vite build`; document.

## 6. Round 3 — panel-by-panel rebuilds (ADR 0029)

The first pass was a deliberately conservative restyle. The owner's master prompt
(`ui_revamp/framepilot-revamp-master-prompt.md`) then asked for the deeper,
owner-requested interaction rebuilds it had deferred. Round 3 delivered those
panel by panel (committed per item; tracked in `PROGRESS.md`):

- **Primitives:** in-house `Tooltip` (app-wide, on every icon-only action) and
  `Select` listbox (replaces bare `<select>`s); `FolderGlyph`; preview-tile pattern.
- **Media bin:** icon actions, inline-edit folder-tile create flow, filled folder
  glyph, real client-side thumbnails (glyph fallback).
- **Effects → CapCut browser**, **Overlays** (type/template/9-point/list),
  **Captions** (visual templates, chips, synced list), **AI** (Cursor composer),
  **Inspector** (Select + reset scrubs), **Transcript** (search), **Timeline**
  (corner tools, track-control stubs).

### Deferred to follow-ups (documented, surfaced as disabled/preview UI)

- Track-control **wiring** → schema v4 + patch ops (engine-before-UI order).
- Video **filmstrips** + reloaded-asset thumbnails → engine frame extraction.
- AI **timeline-diff** component (Phase 4.3 placeholder).
- File-menu **Save As / Recent** + New-project confirm → persistence/IPC handlers.
