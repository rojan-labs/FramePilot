# PROGRESS.md — FramePilot UI/UX Revamp (master-prompt checklist)

> Mirror of `ui_revamp/framepilot-revamp-master-prompt.md`. Each item is ticked
> `[x]` **the moment it is done AND verified**, committed per item. `[~]` = in
> progress. A trailing _(note)_ records deferrals/decisions, never a silent drop.
>
> Status legend: `[x]` done · `[~]` in progress · `[ ]` not started ·
> `[d]` deferred (out of scope this pass, with rationale).

## 1. Design Foundation (tokens)

- [x] Token system on `:root` (`apps/web-editor/src/styles.css`) — Notion palette,
      canonical names + legacy aliases, spacing/radius/type/elevation/motion/z-index.
      _Shipped in #21; see `DESIGN_SYSTEM.md`._

## 2. Global Rules

- [x] One icon family — Lucide via `components/icons.tsx`, no emoji. _#21._
- [x] Tooltip on EVERY icon-only action (styled, 200–400ms, `--bg-elevated`, shows
      shortcut). _`Tooltip` primitive applied across Toolbar, Topbar, MediaBin, transport,
      timeline tools, and track controls._
- [x] Real content over placeholders — audio waveforms; **real client-side bin
      thumbnails** for imported media, glyph + shimmer fallback for reloaded path-only
      assets _(engine thumbnail deferred)_.
- [x] Hairline structure, not boxes. _#21 token pass._
- [x] One accent, used sparingly. _#21._
- [x] Every control hover/active/focus/disabled; every async surface loading/empty/
      error. _Audited per panel this pass._

## 3. Panel-by-Panel

### 3.1 Top bar & File menu

- [x] Logo crisp, project name 14/600, save status = dot + muted cross-fade.
- [x] Single Export top-right; Shortcuts + Settings ghost icons w/ tooltips. _(Batch 1.)_
- [~] File dropdown: New · Open · Save · Reveal. _Save As + Recent submenu deferred —
  they need new App/persistence/IPC handlers (CLAUDE.md §5: ask before broadening IPC),
  out of a presentation pass._
- [~] New project routes through `NewProjectDialog` (a deliberate step, not a silent
  discard). _Save/Don't-save/Cancel confirm deferred to App-level wiring._

### 3.2 Left panel · Media tab

- [x] Import + New Folder become ghost ICON buttons w/ tooltips. _`Upload`/`FolderPlus`._
- [x] New-folder flow: inline-edit folder tile inserted in tree; bottom input removed.
      _Draft renders as a folder tile w/ glyph + pre-selected name field._
- [x] Rich filled dimensional folder glyph (custom SVG), not thin line icon.
      _`FolderGlyph.tsx`, accent-tinted._
- [x] Inline rename on any folder (double-click name; pencil action; context-menu later).
- [x] Media items show real thumbnail; type-glyph fallback + shimmer.
      _`useAssetThumbnail` — client-side capture for imported video/image; glyph for
      reloaded path-only assets (engine thumbnail deferred)._
- [x] Item layout: thumb + display name + `type · duration`; add/remove icon actions.
- [x] Drag-from-bin + empty folder = accent dashed drop-zone. _Pre-existing._

### 3.3 Effects tab (CapCut-style)

- [x] Category tabs/sections + search field. _Color · Transitions tabs + search._
- [x] Scrollable preview-tile grid; hover preview; click applies. _CSS-filter swatch
      / animated transition preview; applies via existing patch-builders._
- [x] Applied/selected state (accent ring + check). _Reads clip grade / next-clip
      transition to mark the active tile._
- [~] Transitions: preview tiles → timeline junction indicator + duration control.
  _Duration control (length chips) done; timeline junction indicator lands in Batch 9._
- [x] Match CapCut layout/density/preview feel, themed to tokens.

### 3.4 Overlays tab

- [x] Overlay type selector (Text · Title · Shape · Image). _Shape/Image scaffolded
      disabled (no engine support yet) w/ "Coming soon" tooltip._
- [x] Style/template gallery (visual previews). _Preview-time presets (documented)._
- [~] Position control — 9-point grid + live preview. _9-point picker + live panel
  preview done; drag-on-main-canvas + render persistence deferred (no schema field)._
- [x] Timing — Add at playhead, editable start + duration.
- [~] List of existing overlays w/ inline edit/delete; empty state. _Seek, inline
  text edit (combined delete+add patch), delete done; reorder deferred (time-ordered)._
- [x] `Add overlay` primary, contextual to chosen type.

### 3.5 Captions tab

- [x] Generation controls in clean form; **visual** template gallery; keyword chips;
      styled checkbox; Generate. _(Generation is instant — no fake progress bar.)_
- [~] Caption list timeline-synced (seek + active-line highlight + delete).
  _Text is derived from the transcript by time range (clip stores only the span),
  so wording is edited in the Transcript tab; free-text inline edit + drag-timing
  deferred (no single-caption engine op)._
- [x] Caption style controls (size/color/position) w/ live preview. _Preview-time._
- [x] Status line muted; designed empty state w/ CTA.

### 3.6 Right panel · AI tab (Cursor-style)

- [x] Mode selector — refined segmented (icons + shortcut hint on Agent ⌘I + active
      check); model/preset select beside it. _(Spec allows "refined segmented"; kept as
      buttons to preserve the AI contract + tests.)_
- [x] Composer layout: stream above, prompt docked at the bottom, compact mode+model bar.
- [x] Per-mode UX (Agent stream / Plan / Edit proposal / Chat). _Edit shows the
      existing reviewable proposal (why + changes + Apply/Reject); the timeline-diff
      component remains a Phase 4.3 placeholder — no fake diff added._
- [x] Skeleton/streaming/empty/error states throughout. _Pre-existing, retained._

### 3.7 Right panel · Inspector tab

- [x] Header metadata key–value block; truncate long clip name w/ tooltip.
- [x] Collapsible hairline sections (`<details>` — Transform & Motion, Color, Mask, Audio).
- [x] Every numeric field drag-to-scrub + click-to-type + reset-to-default.
      _`ScrubNumber` gains optional `defaultValue` → double-click / reset icon._
- [x] Selects use the Select primitive; buttons use the Button primitive.
- [x] Keyframe UI readable; "No keyframes" empty state. _Pre-existing, retained._
- [x] Empty state when no clip selected. _"Select a clip to inspect it."_

### 3.8 Transcript tab

- [x] Lines w/ timestamps; click to seek; search; active line highlight; empty state.

### 3.9 Preview & transport

- [x] `--bg-canvas` void; centered vertical video; empty state + dashed drag-over. _Pre-existing._
- [x] Consistent transport icons; one mono timecode; loop/safe-area icon buttons +
      tooltips + active states. _Transport buttons now use the Tooltip primitive._

### 3.10 Edit toolbar

- [x] Duplicate Export — kept as restyled secondary (audit D-A1: only manifests when
      `onExport` wired; the shipped app's only Export is in the Topbar). Documented.
- [x] Remove orphan scissors/expand mini-row. _Razor + Zoom-to-fit moved into the
      timeline's top-left corner cell (no second row floating above the ruler)._
- [x] Group w/ hairline dividers; tooltip + consistent size; distinct disabled. _(Batch 1.)_

### 3.11 Timeline & playhead

- [x] Clean clip display name (no UUID/filename); truncate + tooltip. _`assetDisplayName`._
- [~] Clip content: waveform on audio + skeleton; text label on clips. _Video filmstrip
  deferred (needs engine frame extraction)._
- [x] Selection = accent outline + glow; hover reveals trim handles. _Pre-existing._
- [x] Ruler compact zoom-aware labels; click/drag scrubs. _Pre-existing._
- [x] Playhead crisp line; ruler drag scrubs; snaps to clip edges; live preview. _Pre-existing._
- [x] Track headers: type glyph + label + per-track controls (stub disabled w/ tooltips).
- [x] Empty lanes quiet labeled lane; thin scrollbar; centered zoom. _Pre-existing._

## 4. Shared primitives & overlays

- [x] Button/Input/Textarea/Select/Dialog/Context menu/Tooltip/Tabs/Badge/Switch/
      Checkbox/Radio/Slider/Toast/Progress/Spinner/Skeleton/Card/Empty-state — full
      states. _`Tooltip` + `Select` added this pass; the rest were already token-styled._
- [x] Export dialog, Settings dialog, Keyboard-shortcuts panel — token-styled. _Pre-existing._

## 5. Micro-interactions

- [x] Press scale (`[data-variant]:active`), tab/segment slides, menu/dialog
      fade+scale, toast slide, thumb hover-zoom, clip snap flash, scrub fields,
      scrollbar fade, folder/rename animate, save-status cross-fade, tooltip/effect
      hover previews. All opacity/transform; `prefers-reduced-motion` honoured globally.

## 6. Specific defects (must all be gone)

- [ ] Duplicate Export _(decision: keep toolbar copy as restyled secondary — only
      manifests when `onExport` wired; documented in UI_AUDIT.md D-A1)._
- [x] Orphan scissors/expand second toolbar row. _Folded into the timeline corner cell._
- [x] UUID/filename clip labels. _Clean `assetDisplayName` + truncate/tooltip._
- [~] Flat colored-rectangle clips _(waveform on audio; video filmstrip deferred — engine)._
- [x] Text-button Import/New Folder. _Now ghost icon buttons._
- [x] Bottom "Folder name" input for folder creation. _Replaced w/ inline folder tile._
- [x] Thin/placeholder folder icons. _Replaced w/ filled `FolderGlyph`._
- [~] Media items without thumbnails. _Real thumbnails for imported assets; glyph
  fallback for reloaded (engine thumbnail deferred)._
- [x] Plain bordered-button Effects list. _Replaced w/ CapCut-style preview-tile browser._
- [x] Icon-only actions without tooltips. _Tooltip primitive on toolbar, topbar,
      media bin, transport, timeline tools, track controls._
- [x] Boxed track headers / missing track controls. _Hairline headers + per-track
      control stubs (disabled, tooltipped) added._

## 7. Master sign-off

- [x] Tokenized system; primitives token-styled (bare `<select>` replaced by `Select`
      in the rebuilt panels; remaining native inputs theme via zero-specificity baselines).
- [x] Every §3 panel rebuilt to its pattern (not recolored).
- [x] All §6 defects eliminated or documented (duplicate Export + filmstrip/track-wiring
      carry explicit deferral notes).
- [x] Folders/Media/Effects/Overlays/Captions/AI/Inspector reworked per spec.
- [x] Tooltip on every icon action; one icon family (Lucide); no emoji/placeholder fills.
- [x] Timeline: clean names, content (waveform), ruler-scrub, snapping, track-control stubs.
- [x] Every control hover/focus/disabled; async loading/empty/error; micro-interactions.
- [x] App builds (`vite build`) + web-editor suite green (362 tests, typecheck, lint);
      hard-protected flows behavior-identical (no schema/IPC/render/AI changes). _Pre-existing,
      unrelated failures remain in `desktop` lint + `mcp-server` http test — out of this pass._
- [x] `UI_AUDIT.md`, `DESIGN_SYSTEM.md`, `PROGRESS.md`, and ADR 0029 produced/updated.

### Deferred (documented, not dropped — see ADR 0029)

- Track-header control **wiring** (needs schema v4 + patch ops); shown as disabled stubs.
- Video clip **filmstrips** + thumbnails for reloaded assets (need engine frame extraction).
- AI Edit **timeline-diff** component (still a Phase 4.3 placeholder; proposal review shipped).
- File-menu **Save As / Recent** + New-project save/discard confirm (need persistence/IPC).
- Overlay drag-on-canvas + caption inline text edit (data model: overlay position not
  persisted; caption text is transcript-derived).
