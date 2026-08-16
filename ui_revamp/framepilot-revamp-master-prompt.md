# FramePilot — FINAL UI/UX Revamp Master Prompt (Panel-by-Panel, Check-Off-As-You-Go)

> Paste into your AI agent at the **repo root**. This is the definitive spec. Mirror the checklist in this file into a `PROGRESS.md`, and **the moment you finish AND verify each item, mark it `[x]` there and commit it — per item, never batched.** Surface-level recoloring is a failure: every panel below must be rebuilt to the described pattern.

---

## 0. SCOPE OF CHANGE — READ CAREFULLY

This pass includes some **intentional interaction/behavior changes** that the product owner has explicitly requested (folder-creation flow, File-menu flows, New Project handling, tooltips, AI mode UX). Those are in-scope. Everything else stays behavior-identical.

**🔒 HARD-PROTECTED (never change behavior, signatures, or data):** the render/export/FFmpeg/Remotion pipeline, AI model wiring (prompts, calls, JSON timeline contract), timeline data model & editing math, file persistence/format (`.fp.json`), undo/redo, keyboard-shortcut actions. Preserve all `data-testid`/`id`/`ref`/`aria` hooks.

**🔓 IN-SCOPE TO REWORK (presentation + the specific interactions named below):** every component's layout/styling, the new-folder creation flow, inline rename, File-menu UX, tooltips, the AI panel's mode UX, and adding presentational track/clip affordances. When reworking an interaction, **preserve the underlying capability and data** — e.g. a folder still creates the same folder object; only the _flow_ to create/name it changes.

If a change would touch hard-protected logic, **wrap/restyle or ask.** After each item, run the app and confirm nothing regressed.

---

## 1. DESIGN FOUNDATION (tokens — one source of truth, zero hardcoded values)

```css
--bg-app: #191919;
--bg-canvas: #0d0d0d;
--bg-panel: #1e1e1e;
--bg-surface: #232323;
--bg-elevated: #2a2a2a;
--bg-hover: rgba(255, 255, 255, 0.055);
--bg-active: rgba(255, 255, 255, 0.09);
--bg-selected: rgba(35, 131, 226, 0.16);
--border-subtle: rgba(255, 255, 255, 0.06);
--border-default: rgba(255, 255, 255, 0.094);
--border-strong: rgba(255, 255, 255, 0.16);
--text-primary: rgba(255, 255, 255, 0.9);
--text-secondary: rgba(255, 255, 255, 0.64);
--text-tertiary: rgba(255, 255, 255, 0.45);
--text-disabled: rgba(255, 255, 255, 0.28);
--accent: #2383e2;
--accent-hover: #3a93ec;
--accent-subtle: rgba(35, 131, 226, 0.14);
--focus-ring: rgba(35, 131, 226, 0.55);
--success: #4dab6d;
--warning: #d9a23b;
--danger: #eb5757;
--playhead: #eb5757;
--clip-video: rgba(35, 131, 226, 0.2);
--clip-video-bd: rgba(35, 131, 226, 0.5);
--clip-audio: rgba(77, 171, 109, 0.2);
--clip-audio-bd: rgba(77, 171, 109, 0.5);
--clip-text: rgba(217, 162, 59, 0.2);
--clip-text-bd: rgba(217, 162, 59, 0.5);
--track-lane: rgba(255, 255, 255, 0.02);
--ruler-tick: rgba(255, 255, 255, 0.2);
```

Spacing 4px base (2,4,6,8,12,16,20,24,32,40,48) · Radius sm4/md6/lg8/xl12 · Type: Inter UI + mono timecodes, 11/12/13/14/16/20/24 (13 workhorse), weights 400/500/600 · Shadows only on floating layers · Motion 120/150/180ms, animate opacity/transform only, respect `prefers-reduced-motion`.

---

## 2. GLOBAL RULES (apply to every panel)

- [ ] **One icon family** — Lucide, 1.5–2px stroke, 16px dense / 18–20px toolbar. No emoji, no mixed weights.
- [ ] **Tooltip on EVERY icon-only action**, app-wide (200–400ms delay, `--bg-elevated`, includes the keyboard shortcut when one exists).
- [ ] **Real content over placeholders** — thumbnails, waveforms, filmstrips, folder icons. Fallback to a type glyph only when a preview genuinely can't be produced, with a loading shimmer while it's generating.
- [ ] **Hairline structure, not boxes** — dividers + subtle bg elevation; full borders reserved for inputs and floating surfaces.
- [ ] **One accent, used sparingly** — primary action, focus ring, active indicator, selection. Nothing else.
- [ ] **Every control** has hover / active / focus-visible / disabled; **every async surface** has loading / empty / error.

---

## 3. PANEL-BY-PANEL SPEC

### 3.1 — TOP BAR & FILE MENU

- [ ] Logo (crisp 2x), project name 14px/600, save status = dot + muted "Saved"/"Saving…" cross-fade.
- [ ] **Single Export**, `primary`, top-right ONLY. Shortcuts (`keyboard`) + Settings (`settings`) as ghost icon buttons with tooltips.
- [ ] **File dropdown** (token-styled menu, icons + shortcut hints): New project · Open… · Save · Save As · Reveal in folder · (Recent projects submenu).
  - [ ] **New project handled properly:** if unsaved changes exist → confirmation dialog ("Save / Don't save / Cancel"); on confirm, cleanly reset to a fresh project (or new-project dialog for name/location). Never silently discard work.
  - [ ] Open/Save/Reveal use the existing handlers — restyle + wire to a clean dialog/native picker; don't change what they fundamentally do.

### 3.2 — LEFT PANEL · MEDIA TAB

- [ ] **Import and New Folder become ICON buttons** (`upload` and `folder-plus`), ghost style, with tooltips ("Import media", "New folder") — not text buttons.
- [ ] **New-folder flow redesigned:** clicking New Folder **immediately inserts a folder tile in the tree with its name in inline edit mode** (text pre-selected) — Enter confirms, Esc cancels, click-away confirms. **Remove the bottom "Folder name" input field entirely.** Same underlying folder object is created; only the create/name interaction changes.
- [ ] **Folder icons = rich, filled, dimensional folder glyphs** (matching the quality/feel of native macOS folders — a polished filled folder with a tab and subtle depth, in the app palette), NOT thin line icons. Use a high-quality custom/SVG folder asset; tint consistently. Expand/collapse chevron rotates smoothly; nesting indented on the grid with subtle guides.
- [ ] **Inline rename** available on any folder (double-click or context-menu → Rename) using the same edit-in-place pattern.
- [ ] **Media items show a real thumbnail on the item itself:** video → poster/frame thumbnail; image → image preview; audio → mini waveform. **Fallback to the type glyph** (`film`/`image`/`audio-lines`) on a neutral tile only when no preview is available; shimmer while generating.
- [ ] Item layout: thumbnail + clean display name (truncate + tooltip) + `type · duration` muted; Add (`plus`, tooltip) and remove (`x`, tooltip) as icon buttons that may fade in on hover.
- [ ] Drag-from-bin and **empty folder** = "Drag media here" with accent dashed drop-zone, not a bare box.

### 3.3 — EFFECTS TAB (replicate CapCut)

Replace the current plain bordered-button grid with a **CapCut-style effects/transitions browser**:

- [ ] **Category tabs / sections at top** (e.g. Color · Filters · Effects · Transitions) + a search field.
- [ ] **Scrollable grid (3–4 cols) of preview tiles**, each = a square **thumbnail/animated preview** of the effect + label beneath; **hover plays a quick preview**; click applies.
- [ ] **Applied/selected state** clearly marked (accent ring + check); applied effects reflect on the clip.
- [ ] **Transitions:** tiles show a small animated preview of the transition; applying inserts a **transition indicator at the clip junction on the timeline**; selecting it reveals a **duration control**. Keep the helper line about transitions blending into the next clip, restyled as muted caption.
- [ ] Reference CapCut's effects/transitions panel directly for layout, density, and preview behavior; match that feel, themed to our tokens.

### 3.4 — OVERLAYS TAB (enhance substantially)

- [ ] Replace the single text input with an **overlay type selector**: Text · Title / Lower-third · Shape · Image / Sticker.
- [ ] **Style/template gallery** (small visual previews of text/title styles, CapCut-like), selectable.
- [ ] **Position control** — a 9-point grid picker and/or drag directly on the preview canvas; **live preview on the canvas** as you edit.
- [ ] **Timing** — "Add at playhead", editable start + duration (restyle "Added at the playhead (3.1s) for 3s" into proper controls).
- [ ] **List of existing overlays** with inline edit / reorder / delete; designed empty state ("No overlays yet").
- [ ] `Add overlay` = `primary`, contextual to the chosen type.

### 3.5 — CAPTIONS TAB (easier & nicer)

- [ ] Generation controls in a clean form: Words/line (`Input`), Template (`Select` with **visual style previews**, not a bare dropdown), Highlight keywords (`Input` with token/chip entry), "Burn in on export" (styled `Checkbox`). `Generate captions` = `primary` with progress state while running.
- [ ] **Caption list = inline-editable, timeline-synced:** each caption row shows its time range + text; clicking seeks the playhead; text is **editable in place**; drag handles adjust timing; highlighted keywords render visibly.
- [ ] Caption **style controls** (font/size/color/position) with live preview on the canvas.
- [ ] Status line ("0 caption clips · soft") restyled muted; designed empty state with a clear CTA.

### 3.6 — RIGHT PANEL · AI TAB (make it feel like Cursor)

- [ ] **Mode selector like Cursor:** a compact dropdown (or refined segmented) listing modes with **icons + keyboard-shortcut hints + a check on the active mode** (model: Agent ⌘I, Plan, Edit, Chat). Place a **model/preset selector beside it** (reuse the existing "Style preset").
- [ ] **Composer layout like Cursor:** stream/area above, a clean prompt input docked at the bottom, mode+model controls in a compact bar. Primary action (`Run agent`/`Propose edit`) `primary`, disabled until valid, loading → spinner + label.
- [ ] **Per-mode UX:**
  - Agent → autonomous run with streaming steps / tool & edit log / progress.
  - Plan → generates a reviewable plan; approve-to-run.
  - Edit → produces a **reviewable proposal as a real diff / before-after** with Apply / Reject (restyle "Request an edit to get a reviewable proposal" into that flow).
  - Chat → conversational thread with composer.
- [ ] Skeleton/streaming/empty/error states throughout. (Restyle/UX only — do not alter the underlying AI calls or JSON contract.)

### 3.7 — RIGHT PANEL · INSPECTOR TAB (enhance properly)

- [ ] **Header metadata** (Clip / Track / Span / Source) as a clean key–value block; truncate long clip names with tooltip (never overflow the raw filename).
- [ ] **Collapsible, hairline-separated sections:** Transform & Motion (keyframes), Punch-in (Zoom), Color (Exposure/Contrast/Saturation/Temperature/Tint/Shadows/Highlights). Replace the heavy bordered cards with subtle grouped sections.
- [ ] **Every numeric field = `drag-to-scrub` + click-to-type**, with a slider where a range applies, consistent styling, and **double-click / reset icon to default**.
- [ ] **Selects** (Easing, Property) use the `Select` primitive (token menu, keyboard nav). Buttons (Add punch-in / Add keyframe) use the `Button` primitive.
- [ ] **Keyframe UI** cleaned up and readable; "No keyframes" is a proper muted empty state.
- [ ] **Empty state** when no clip is selected ("Select a clip to edit its properties").

### 3.8 — TRANSCRIPT TAB

- [ ] Transcript lines with timestamps; click a line to seek; search field; active line highlighted; loading/empty states.

### 3.9 — PREVIEW & TRANSPORT

- [ ] `--bg-canvas` void; vertical video centered with even, intentional letterboxing; empty state = "Drop media to begin" + accent dashed drag-over.
- [ ] Transport icons consistent (`skip-back · chevron-left · play/pause · chevron-right · skip-forward`); **one** `current / total` timecode (mono); loop/fit as icon buttons with tooltips and active states.

### 3.10 — EDIT TOOLBAR

- [ ] **Remove the duplicate Export** from the toolbar (header keeps the only Export).
- [ ] **Remove the orphan scissors/expand mini-row** floating above the ruler; fold any needed control into the single toolbar — no second tool row.
- [ ] **Group with hairline dividers:** `[ split · ripple-delete · marker ] | [ zoom− · zoom-fit · zoom+ ] | [ undo · redo ]`. Tooltip + consistent size/stroke on every icon; disabled states distinct (e.g. undo with empty history).

### 3.11 — TIMELINE & PLAYHEAD

- [ ] **Clip display name fixed:** never show the raw UUID/filename (`a76b6a11-…` / `clip__…_14000`). Show a clean, rename-friendly display name, truncated with ellipsis + tooltip.
- [ ] **Clip content:** filmstrip frame thumbnails on video clips, waveform on audio, text snippet on caption clips. No flat fills.
- [ ] **Selection** = accent outline + subtle glow (no fill swap, no layout shift); **hover** reveals trim handles at both edges (resize cursor).
- [ ] **Ruler:** compact zoom-aware labels (`0:02`, `0:04`…) on major ticks, major/minor hierarchy; **click/drag the ruler scrubs** (it is the scrubber).
- [ ] **Playhead handling:** crisp 1–2px `--playhead` line across all tracks with a draggable head; smooth drag; **snaps to clip edges** with a brief snap-guide flash; preview updates live.
- [ ] **Track headers:** subtle type glyph + label (no bordered box); add per-track controls — video: hide(`eye`)/lock; audio: mute/solo/lock; caption: hide/lock (presentation; wire to existing state or stub disabled — ask before adding new behavior).
- [ ] **Empty lanes** = one quiet labeled lane, never spreadsheet grid cells. Custom thin scrollbar; zoom animates centered on cursor.

---

## 4. SHARED PRIMITIVES & OVERLAYS (build once, full states each)

- [ ] Button (primary/secondary/ghost/icon/danger), Input, Textarea, **Select/Dropdown**, Dialog (focus trap/Esc), **Context menu** (right-click clip/media/track/folder, with Rename/Delete + shortcut hints), Tooltip, Tabs/Segmented, Badge, Switch/Checkbox/Radio, Slider, Toast, Progress, Spinner, Skeleton, Card, Empty-state.
- [ ] **Export dialog** (settings form → determinate progress + cancel). **Settings dialog** (sectioned). **Keyboard-shortcuts panel** (keycap grid). All token-styled; use Radix/shadcn for a11y (ask before adding deps; theme to tokens so they don't look default).

---

## 5. MICRO-INTERACTIONS (sweep across everything; respect reduced-motion)

- [ ] Buttons press `scale(.97)`; tab/segment/mode indicators slide; menus & dialogs fade+scale; toasts slide-up+fade; media/folder thumbs hover-zoom; clips snap with guide flash; numeric fields drag-to-scrub; scrollbars fade when idle; folder rename animates into edit; save status cross-fades.

---

## 6. SPECIFIC DEFECTS FROM THE CURRENT BUILD (must all be gone)

- [ ] Duplicate Export (toolbar copy removed).
- [ ] Orphan scissors/expand second toolbar row (removed/merged).
- [ ] UUID/filename clip labels (replaced with clean display names).
- [ ] Flat colored-rectangle clips (filmstrip/waveform content added).
- [ ] Text-button Import/New Folder (now icon buttons with tooltips).
- [ ] Bottom "Folder name" input for folder creation (replaced with inline-rename folder tile).
- [ ] Thin/placeholder folder icons (replaced with rich filled folder icons).
- [ ] Media items without thumbnails (thumbnails added, icon fallback).
- [ ] Plain bordered-button Effects list (replaced with CapCut-style preview-tile browser).
- [ ] Icon-only actions without tooltips (tooltips added everywhere).
- [ ] Boxed track headers / missing track controls (fixed).

---

## 7. MASTER SIGN-OFF (output `PROGRESS.md` with status per item)

- [ ] Tokenized system; zero hardcoded values; all primitives built & used (no raw `<button>`/`<input>`/`<dialog>` left).
- [ ] Every §3 panel individually rebuilt to its described pattern (not recolored).
- [ ] All §6 defects eliminated.
- [ ] Folders: rich icons + inline-rename creation flow. Media: real thumbnails + icon fallback. Effects: CapCut-style browser. Overlays & Captions: reworked per spec. AI: Cursor-style modes. Inspector: enhanced per spec.
- [ ] Tooltip on every icon action; one icon family; no emoji; no placeholder fills.
- [ ] Timeline: clean clip names, filmstrip/waveform, ruler-scrub, playhead snapping, track controls.
- [ ] Every control has hover/focus/disabled; every async surface has loading/empty/error; all micro-interactions present.
- [ ] App builds & runs; **every hard-protected flow verified behavior-identical**; requested interaction reworks preserve underlying capability & data.
- [ ] `UI_AUDIT.md`, `DESIGN_SYSTEM.md`, and a fully-ticked `PROGRESS.md` produced.

**Begin with a Phase 0 audit, mirror this checklist into `PROGRESS.md`, then work panel by panel. Tick each item the instant it's done and verified — per item, committed individually. No shallow recolor passes.**
