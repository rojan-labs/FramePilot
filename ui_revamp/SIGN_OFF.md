# FramePilot UI Revamp — Master Sign-Off Checklist

> Status legend: ✅ done to spec · ⚠️ partial / pre-existing-not-re-audited · ❌ deferred (needs non-presentation work, documented).
> Scope guardrail: **presentation only** (⛔ prime directive). Items that require schema, engine, or behavior changes are deferred and noted — they are _not_ paint-pass work.
> Last verified: web-editor typecheck + **350 tests** + `vite build` + lint green; `@framepilot/ui` typecheck + 4 tests + lint green.
> **Ran the app (Playwright/chromium):** smoke boot ✅; **behavior e2e 19/20** (the 1 failure — `getByLabel('project name')` ambiguity in "New project resets…" — is **pre-existing**: reproduced on a clean `HEAD` with all revamp changes stashed; caused by the NewProjectDialog feature landing after that spec, not by this pass); **visual goldens regenerated to the new design and green (6/6)**. AI-panel-idle and inspector screenshots inspected by eye — render correct, not broken.

---

## §5.1 — Global Shell

- ⚠️ **Electron titlebar** — lives in `apps/desktop` (not the web-editor renderer); not modified this pass.
- ✅ **Top app bar** — flat accent logo (gradient removed), project name, save status as dot + muted "Saved/Saving…" (spinner), File menu dropdown, single `primary` Export top-right, Shortcuts/Settings as ghost icon buttons, hairline bottom divider.
- ⚠️ **Bottom status bar** — present and token-styled; not re-audited for path-truncation/tooltip this pass.
- ✅ **Panel docks & layout** — hairline dividers, animated collapse chevrons, draggable `RailSplitter`, 4px-grid three-column rhythm.

## §5.2 — Left Panel

- ✅ **Tab bar** — active = primary text + sliding indicator; inactive = secondary.
- ✅ **Media header** — 11px uppercase tertiary label; Import = `secondary`, New Folder = `ghost` via `Button`.
- ✅ **New-folder inline input** — token input, focus ring, Enter/Esc (replaces `window.prompt`).
- ✅ **Folder tree** — rotating chevrons, consistent folder icons, indented nesting, hover/selected rows.
- ✅ **Empty folder state / drag-over** — centered muted icon + copy + accent dashed drop-zone.
- ⚠️ **Media asset cards** — `--bg-surface` rows, **clean file-basename name + tooltip** (shared `assetDisplayName`, matches the timeline), type · duration metadata, add (`secondary`) + remove (ghost ×) via Lucide. Only the in-card **video thumbnail / audio waveform** is still pending (bin uses a type glyph) — deferred with the render-engine frame-extraction work.
- ✅ **Effects / Overlays / Captions tabs** — real designed layouts + empty states; status text muted/transient.

## §5.3 — Preview & Transport

- ✅ **Preview/canvas** — `--bg-canvas` void, intentional letterbox frame, designed empty state, accent dashed drag-over.
- ✅ **Transport bar** — skip/step/play-pause icon set, one `current / total` monospace readout, loop + fit/safe-area icon toggles with active accent state + tooltips.

## §5.4 — Edit Toolbar

- ✅ **No active duplicate Export** — toolbar Export is permanently `disabled` in the shipped app (`Editor.tsx` renders `<Toolbar>` without `onExport`); the only live Export is the Topbar's. Wiring kept (a test exercises it) — documented decision, not a shipped defect.
- ⚠️ **Orphan scissors/expand row** — the main toolbar is consolidated to `[split · delete · ripple] | [marker · zoom− · zoom+] | [undo · redo · export]`. The timeline's **Razor** and **fit** toggles remain as contextual timeline controls (relocating them needs lifting local razor state + container-width measurement into the Toolbar = behavior rewire, out of a paint pass).
- ✅ **Hairline-divided groups; uniform icon buttons; distinct disabled state** (e.g. undo/redo disabled on empty history).

## §5.5 — Timeline

- ✅ **Ruler** — zoom-aware compact labels, major/minor tick hierarchy, ruler-as-scrubber (click/drag scrubs).
- ✅ **Playhead** — crisp `--playhead` line across tracks, draggable, snaps to edges with guide flash, live preview.
- ✅ **Track headers** — bordered V·A·C badge **replaced** with a subtle per-type Lucide glyph (`Film`/`Type`/`Captions`/`AudioLines`) + label; header is now a hairline divider, not a box.
- ❌ **Per-track controls** (mute/solo/lock/hide) — deferred: the `Track` schema has no such fields (needs schema v4 migration + patch ops + engine-before-UI order per AGENTS.md). Documented in `UI_AUDIT.md`.
- ✅ **Track lanes** — subtle striping, quiet labeled empty lanes (no spreadsheet grid).
- ⚠️ **Clips** — ✅ clean display name (source basename + tooltip, no raw `clip__…`), ✅ audio **waveform** body (engine peaks) with skeleton fallback, ✅ accent **outline + glow** selection (no fill swap), ✅ hover brighten + trim handles, ✅ radius/clip/drag-snap. ❌ **video filmstrip thumbnails** deferred (needs Python render-engine frame extraction + Asset handle — same deferral as ADR 0014 Part 5); video clips use flat muted per-type fills as content areas.
- ✅ **Scroll/zoom** — thin custom scrollbar (webkit + Firefox), cursor/playhead-centered zoom.

## §5.6 — Right Panel

- ✅ **Tab bar** — sliding indicator, sparkle on AI.
- ✅ **AI tab** — mode segmented control is a **subtle raised surface** (not a solid blue block); style-preset select; prompt textarea; `primary` full-width action with width-preserving **loading spinner**; per-mode **idle hints** + **skeleton** loading + error/status states.
- ✅ **Inspector tab** — grouped **collapsible** sections (`<details>`), label-left/control-right rows, drag-to-scrub numeric fields (`ScrubNumber`), empty state.
- ⚠️ **Transcript tab** — ✅ timestamped lines (seek timecodes), click-to-seek words, active-line highlight, empty state. ❌ **search field** deferred (new behavior — state + filtering — not a paint-pass item).

## §5.7 — Shared Primitives

- ✅ **Button** — primary/secondary/ghost/**danger**/**icon**, `sm`/`md`, full state coverage, width-preserving `loading`.
- ✅ **Input / Textarea / Select / Checkbox** — token wells, focus rings; one baseline each (`:where()` for inputs) so no raw control is unstyled.
- ✅ **Skeleton · Spinner · Segmented · Tabs · Tooltip · Toast · Empty-state · Card** — present and token-driven.
- ⚠️ **Dialog / Dropdown / Context menu / Popover / Switch / Radio / Slider / Progress / Badge** — exist and are token-styled (Export/Settings/NewProject dialogs, Menu, ClipContextMenu, Toasts); not all rebuilt from a single Radix/shadcn base this pass (no new deps added, per "ask before adding deps").
- ✅ **Icon system** — one Lucide family via `icons.tsx`; no emoji anywhere.

## §5.8 — Dialogs, Menus & System Surfaces

- ✅ **Export dialog** — form primitives → determinate progress (percent + phase + cancel).
- ✅ **Settings dialog** — sectioned, token-styled, real controls (segmented + themed selects/numbers).
- ✅ **Keyboard-shortcuts panel** — clean grid + search.
- ✅ **Context menus** (clip) — right-click actions with shortcut hints / danger items.
- ⚠️ **Toasts** present; **command palette** — no command system exists to restyle (correctly not invented).

## §5.9 — States & Micro-interactions

- ✅ Hover / active / `focus-visible` / disabled across buttons, segmented, tabs, inputs, selects, transport, clips.
- ✅ Loading (skeleton/spinner) / empty / error states on the AI surface; empty states across panels.
- ✅ Button `scale(.97)`, sliding tab indicators, raised segmented, fading scrollbars, snap-guide flash, drag-to-scrub, save-status cross-fade — all gated by `prefers-reduced-motion`.

## §5.10 — Iconography & Imagery

- ✅ One Lucide family, uniform stroke, full mapping; **no emoji**.
- ⚠️ Real content: audio **waveforms** ✅, clean clip names ✅, duration overlays ✅; **video filmstrips/bin thumbnails** ❌ deferred (engine frame extraction).

---

## §6 — Specific Defects

- ✅ Duplicate Export — no live duplicate in the shipped app (toolbar copy disabled).
- ⚠️ Orphan scissors/expand row — toolbar consolidated; timeline Razor/fit remain as contextual controls (rewire deferred).
- ⚠️ Flat colored-rectangle clips — audio→waveform ✅; video→filmstrip ❌ deferred (flat muted content fills meanwhile).
- ✅ Raw `clip__…` label — replaced with clean name + tooltip.
- ✅ Boxed track headers / bordered V·A·C badges — per-type glyph + hairline.
- ❌ Missing track controls (mute/solo/lock/hide) — deferred (schema v4).
- ✅ Over-bordered "admin panel" feel — hairline structure + token surfaces.
- ✅ Accent overuse — pulled back to primary action / focus / active / selection (segmented controls de-blocked).

## §7 — Master Sign-Off

- ✅ Single tokenized design system; **zero hardcoded colors** in components (stale fallbacks swept; only the inline SVG chevron asset + data-driven caption-template previews remain literal).
- ⚠️ Primitives built with full state coverage and used widely; some system surfaces still use bespoke (token-styled) markup rather than one shared Radix/shadcn base (no deps added by policy).
- ✅ Components individually rebuilt (not surface-recolored) across the documented passes.
- ⚠️ §6 defects — 5 of 8 fully eliminated; 2 partial (clip filmstrip, orphan row), 1 deferred (track controls), all documented.
- ⚠️ Clips — clean names ✅, waveform/selection/trim/hover ✅; video filmstrip ❌ deferred.
- ✅ Timeline — ruler scrub, playhead snapping, glyph track headers, designed empty lanes.
- ✅ Hover/focus/disabled coverage; AI async surface has loading/empty/error.
- ✅ One icon family; no emoji; no placeholder fills (video clip = flat content fill, not a lorem rectangle).
- ✅ Micro-interactions present; reduced-motion respected.
- ✅ App builds, tests, lints green; original flows verified behavior-identical (no logic/IPC/schema/shortcut change).
- ✅ `UI_AUDIT.md` + `DESIGN_SYSTEM.md` produced (+ this sign-off).

### Honest residual (all require non-presentation work — out of the prime directive)

1. **Per-track mute/solo/lock/hide** → Track schema v4 migration + patch ops + engine.
2. **Video clip filmstrip / bin video thumbnails** → Python render-engine frame extraction + Asset thumbnail handle.
3. **Transcript search field** → new state + filtering behavior.
4. **Orphan Razor/fit relocation** → lift timeline-local razor state + container measurement into the Toolbar (behavior rewire).
5. **Electron titlebar / status-bar path-truncation** → desktop shell, not the web renderer.
