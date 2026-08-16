# Quality Bar & UI Teardown — Companion to the Revamp Super-Prompt

> Feed this **together with** `ui-revamp-super-prompt.md`. That file defines the _process and design system_; this file defines the _quality bar_, fixes the _specific problems in the current build_, and tells you exactly what "looks designed, not AI-generated" means. The tokens, primitives, phases, and the ⛔ "do not change functionality" directive from the main prompt all still apply here.

The app today is a React (Electron/Vite) video editor ("FramePilot"). A screenshot of the current state has been analyzed below. Your job is not just to "make it dark and clean" — it's to make it look like a **detail-obsessed, pro-grade tool** in the lineage of Notion, Vercel, Cursor, and Linear, with content and motion that real editors have.

---

## PART A — TEARDOWN OF THE CURRENT BUILD (fix these exactly)

These are concrete defects observed in the current UI. Treat each as a required fix. Do **not** change what any control _does_ — only how it looks and where it lives.

### A1. Redundancy & layout

- **Two Export buttons** (top-right header _and_ the secondary toolbar). Keep ONE canonical Export in the top-right; remove the duplicate from the toolbar (wire its handler into the surviving button if needed — don't drop functionality).
- **Two timecode readouts** (transport `00:00:00:00 / 00:00:14:00` and the "Playhead" row). Keep one authoritative `current / total` readout in the transport bar; remove the second.
- **The "Playhead" label + separate scrubber slider row is non-standard.** Delete the word-label "Playhead" and the standalone slider. Scrubbing happens by clicking/dragging in the **ruler**; the playhead is a visual element, not a labeled widget. Move the zoom/fit and split controls that lived there into the toolbar groups (A2).
- **The secondary toolbar is an ungrouped grab-bag** (cut, delete, align, flag, zoom−, zoom+, undo, redo, export). Reorganize into **logical clusters separated by dividers**: `[edit: split · ripple-delete · marker]  |  [view: zoom− · zoom-fit · zoom+]  |  [history: undo · redo]`. Right-align nothing random; no Export here.

### A2. Video-editor conventions that are missing

- **Track headers lack standard controls.** Add the genre-standard per-track controls (presentation only — wire to existing state if it exists, otherwise stub as disabled, do not invent new behavior without asking):
  - Video track: **hide/show (eye)**, **lock**.
  - Audio track: **mute (volume)**, **solo**, **lock**.
  - Caption track: **hide/show**, **lock**.
  - Keep the V/A/C type indicator but make it a small subtle glyph, not a bordered box.
- **Clips have no content.** Render real clip content:
  - Video clips → a **filmstrip of frame thumbnails** across the clip body.
  - Audio clips → a **waveform**.
  - Caption clips → text snippet preview.
  - Clip header strip: name (13px/500) + duration (11px mono, muted). If thumbnails/waveforms aren't yet generatable, use a tasteful neutral pattern as a placeholder _that still reads as "content area,"_ never a flat saturated fill.
- **No proper playhead.** Render a crisp 1–2px vertical playhead line spanning **all tracks**, with a draggable "head" handle docked in the ruler. It moves smoothly and snaps to clip edges (A/Part C).
- **Trim handles.** On clip hover, reveal left/right trim handles; show a grab cursor. Selected clip → accent outline (not a different fill).
- **The CAPTION track is drawn as spreadsheet cells.** Remove the grid cells. An empty track is a single quiet lane with a faint label and (optionally) a hover hint to add captions — never a table.
- **Ruler is cluttered.** `00:00:02:00`-style full timecodes at every tick are too wide. Use compact, zoom-aware labels (e.g. `0:02`, `0:04` …), major/minor tick hierarchy, and only label major ticks.

### A3. Polish & "slop" tells

- **No button system.** Import (filled), New Folder (outline), Add (grey), × (bordered), Export ×2 (two styles) = five ad-hoc treatments. Replace ALL with the primitive `Button` (`primary` / `secondary` / `ghost` / `icon`). Example mapping: Export → `primary`; Import → `secondary`; New Folder → `ghost`; Add → `secondary` (sm); × → `icon` (ghost).
- **Everything is boxed.** Media cards, track headers, panels all have visible full borders → admin-panel look. Switch to **hairline dividers + subtle background elevation**; reserve full borders for inputs and truly elevated surfaces (dialogs/popovers).
- **Accent is overused.** The active tab, every clip, Import, and the segmented "Edit" are all loud blue. Pull accent back to: primary button, focus ring, active tab indicator, selection. Clips use the muted per-type `--clip-*` tokens, not pure accent blue. The segmented control's active state should be a subtle raised surface, not a solid blue block.
- **SAVED badge is toy-like.** Replace the green outline pill with a quiet status: a small dot + muted "Saved" text (Linear-style), transitioning to "Saving…" with a tiny spinner when dirty.
- **Empty preview has stray gradient bands.** Empty canvas = clean `--bg-canvas` near-black void with a centered, designed empty state (icon + "Drop media to begin" + subtle border-dash on drag-over), not accidental gradients.
- **Tabs overflow with chevrons.** If tab rows are overflowing, that's a sign of too many peer tabs — verify spacing/sizing so the common tabs fit without an overflow chevron at this width.
- **Flat type hierarchy.** Section labels (MEDIA, AI) → 11px uppercase, `--text-tertiary`, letter-spaced. Item titles → 13px/500 `--text-primary`. Metadata → 11–12px `--text-secondary`. Make the hierarchy obvious.

---

## PART B — REFERENCE-PATTERN DNA (borrow precisely)

Don't imitate these apps' surfaces — internalize _why_ they read as premium, and apply it to an editor.

- **Notion** → calm grayscale; hierarchy from text-opacity + weight, not color; hairline borders; controls that appear on hover; generous padding in panels.
- **Vercel** → near-black, high-contrast, geometric minimalism; one accent on a monochrome base; _beautifully designed empty and loading states_; precise alignment to a strict grid.
- **Linear** → everything feels **instant**; fast, subtle micro-interactions; sliding active indicators; command palette; keyboard-first; dense yet breathable.
- **Cursor** → IDE-grade dark density that's comfortable for long sessions; clear panel separation; accent reserved for active/AI surfaces only.

**Net formula:** monochrome foundation + ONE accent used sparingly + real content (thumbnails/waveforms) + hairline structure (not boxes) + instant, subtle motion + obsessive alignment.

---

## PART C — MICRO-INTERACTIONS CATALOG (required)

Everything below uses the motion tokens from the main prompt and **must** respect `prefers-reduced-motion`. Animate only `opacity`/`transform`. Motion should feel _fast and inevitable_, never decorative or bouncy.

**Controls**

- Buttons: bg lifts on hover (120ms); press → `scale(0.97)`; focus → accent ring; loading → spinner swaps in, width preserved.
- Icon buttons: tooltip fades in after ~400ms; hover bg; active tint.
- Tabs / segmented control: the active indicator **slides** between options (shared-layout style), 180ms.
- Inputs: focus ring eases in; invalid state shakes once subtly (optional) or just shows accent→danger ring transition.

**Timeline (the showpiece)**

- Clip hover: subtle brighten + trim handles fade in at edges.
- Clip select: accent outline animates in (no layout shift).
- Clip drag: smooth 1:1 follow; on nearing a clip edge/playhead, a **magnetic snap** with a brief snap-guide line flash.
- Playhead drag / scrub: smooth, snaps to edges; preview updates live.
- Timeline zoom: **animated** zoom centered on the cursor/playhead, not an instant jump.
- Adding a clip to a track: it eases into place.
- Drag media from bin → track: a drop-zone highlight (accent dashed outline + bg tint) appears under the cursor's target lane.

**Panels & overlays**

- Dropdowns/menus/popovers: fade + scale-from-origin (96%→100%), 150ms.
- Dialogs: overlay fades; dialog scales 98%→100% + fades, 180ms ease-out.
- Toasts: slide-up + fade; auto-dismiss with a thin eased progress indicator.
- Panel resize: smooth handle (brightens on hover), content reflows without jank.

**Content & status**

- Media cards: thumbnail subtly zooms on hover; quick actions fade in.
- AI panel: streaming text appears token-by-token; skeleton shimmer while generating; "Propose edit" enables with a smooth state change when input is non-empty.
- Save status: "Saving…" → "Saved" with a checkmark cross-fade.
- Scrollbars: appear on hover/scroll, fade when idle.
- Inspector numeric fields: **drag-to-scrub** values (click-drag left/right on the label/field to adjust — a pro-tool hallmark), with a horizontal-resize cursor.

---

## PART D — ICONOGRAPHY & IMAGERY STANDARD

**Icons — one family, uniform stroke (Lucide React, 1.5–2px, optically sized 16px dense / 18–20px toolbar). Never mix filled+outline randomly; never use emoji.** Use this mapping so icons aren't chosen at random:

| Action         | Icon                             |     | Action          | Icon                    |
| -------------- | -------------------------------- | --- | --------------- | ----------------------- |
| Play / Pause   | `play` / `pause`                 |     | Mute / Unmute   | `volume-x` / `volume-2` |
| To start / end | `skip-back` / `skip-forward`     |     | Solo            | `headphones`            |
| Step frame     | `chevron-left` / `chevron-right` |     | Lock / Unlock   | `lock` / `lock-open`    |
| Split / cut    | `scissors`                       |     | Hide / Show     | `eye-off` / `eye`       |
| Delete clip    | `trash-2`                        |     | Snap            | `magnet`                |
| Marker         | `flag`                           |     | Loop            | `repeat`                |
| Zoom out / in  | `zoom-out` / `zoom-in`           |     | Fit / frame     | `maximize-2` / `frame`  |
| Undo / Redo    | `undo-2` / `redo-2`              |     | Settings        | `settings`              |
| Import         | `upload`                         |     | Shortcuts       | `keyboard`              |
| Export         | `download`                       |     | AI              | `sparkles`              |
| New folder     | `folder-plus`                    |     | Add to timeline | `plus`                  |
| Video asset    | `film`                           |     | Audio asset     | `audio-lines`           |
| Image asset    | `image`                          |     | Caption/text    | `type`                  |

**Imagery / real content (this is what kills the "AI slop" look):**

- Video clips: **real filmstrip thumbnails** sampled from frames across the clip width.
- Audio clips & assets: **real waveforms**.
- Media bin items: real thumbnail + duration overlay (bottom-right, 11px mono on a scrim), type glyph.
- Empty states: a single quiet line-icon + one line of helper text + a primary action — a _designed_ empty state, never a blank box or a spreadsheet grid.
- No lorem rectangles, no flat saturated placeholder fills, no stock-art clutter. Crisp logos/avatars at 2x.

---

## PART E — THE ANTI-AI-SLOP STANDARD (hard checklist — none of these may ship)

- ❌ Flat colored-rectangle clips with no thumbnail/waveform.
- ❌ Every container wrapped in a visible border (gridded admin-panel look).
- ❌ More than one visual treatment for the same kind of action (e.g. two Export buttons styled differently).
- ❌ Mixed icon families or inconsistent stroke weights; emoji used as icons.
- ❌ Accent color on everything; rainbow of hues; purple-gradient energy.
- ❌ Default-shadcn look with zero token customization.
- ❌ Off-grid spacing, misaligned edges, controls that don't share a baseline.
- ❌ Labels that state the obvious ("Playhead") or duplicate readouts that can disagree.
- ❌ Centered generic card grids where a dense list belongs.
- ❌ Any control without hover / focus-visible / disabled states, or any async surface without loading + empty + error states.
- ❌ Tables/spreadsheet grids standing in for timeline lanes.

---

## PART F — THE "PREMIUM" DETAILS THAT SEPARATE PRO FROM SLOP

Spend extra effort here — these are what make people say "this feels expensive":

- Pixel-perfect alignment to the 4px grid; optical adjustments where math isn't enough.
- One accent, used like punctuation — rare and intentional.
- Real content everywhere (filmstrips, waveforms, thumbnails) instead of placeholders.
- Hairline `rgba(255,255,255,0.06–0.09)` dividers doing the structural work instead of boxes.
- Instant, subtle motion on _every_ interaction; nothing static, nothing slow.
- A genuinely designed empty state for the canvas, the media bin, and each empty track.
- Keyboard affordances surfaced (shortcut hints in menus/tooltips), command-palette-ready.
- Consistent corner radii, consistent icon sizing, consistent text-opacity tiers — the kind of consistency a careful human enforces and a careless generator does not.

**Apply this alongside the phased plan in the main prompt. Start with Phase 0 (audit), incorporate the Part A fixes into the plan, and stop for review before restyling.**
