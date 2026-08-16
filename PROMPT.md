# PROMPT — Premium, Minimal Video-Editor UI/UX for FramePilot

> Hand this entire file to the coding agent as the task. It is the product spec for
> turning FramePilot's editor (`apps/web-editor`, shared bits in `packages/ui`) into
> a **premium, minimal, professional NLE experience** — the feel of Premiere Pro /
> DaVinci Resolve / CapCut, with the calm restraint of Linear / Things / Arc.
>
> This task is **UI/UX and interaction only**. The render engine, patch engine,
> schema, and AI layer already work. You are making the editor _feel_ world-class:
> crisp icons, frame-accurate everything, buttery dragging/trimming/splitting,
> complete and discoverable keyboard control, and a design language that is quiet,
> spacious, and confident. **Do not change what the engine does or how edits are
> validated.**

---

## 0. North star: "super minimal and nice"

Minimal is the brief. That means **restraint, not emptiness**.

- **Quiet by default, expressive on interaction.** Low-chrome surfaces, generous
  spacing, hairline separators instead of boxes-in-boxes. Color is information:
  one accent, muted neutrals, and track-type hues used sparingly. No gradients-on-
  gradients, no drop-shadow soup, no decorative borders.
- **One thing in focus at a time.** The timeline and the program monitor are the
  heroes. Everything else recedes until hovered/active.
- **Type and number discipline.** Tabular numerals for every timecode; a tight
  type scale; sentence case; few font weights. Labels are small, calm, uppercase-
  tracked only where it already is.
- **Motion is a sentence, not a fireworks show.** 120–200ms, ease-out, purposeful.
  If an animation doesn't help the user understand a state change, remove it.
- **Premium = precise.** Pixel-snapped lines, aligned baselines, frame-accurate
  playhead, consistent 4px spacing grid. Sloppiness reads as cheap; precision reads
  as premium.

The current UI (`apps/web-editor/src/styles.css`, ~970 lines) is already a dark
3-column NLE with a token foundation. **Refine it toward minimal — do not bootstrap
a new look from scratch and do not bolt on a heavy UI kit.**

---

## 1. Hard invariants (read `AGENTS.md` + `CLAUDE.md` first — these gate the task)

Violating any of these fails the task:

1. **Every timeline mutation is a typed patch through the store.** All edits build a
   patch via `apps/web-editor/src/editor/patch-builders.ts` and dispatch through
   `useEditor` (`applyPatch`), which runs `validate → apply → record`
   (`editor/store.ts` → `editor-core`). **No component mutates the timeline or
   project directly. There must be no second, unchecked mutation path.**
2. **Reversibility is sacred.** Everything editable stays undo/redo-able via the
   existing history. No edit may bypass it.
3. **Preview engine ≠ render engine.** UI preview/scrub/thumbnails/waveforms use
   HTML `<video>`, canvas/WebGL, and **engine-provided** proxy/peak/thumbnail data
   only. **Never invoke MoviePy/FFmpeg from the UI path** (PRD §9.2, AGENTS.md).
4. **No schema change** to `packages/timeline-schema` without a migration + tests +
   doc. This task should not need one. If you believe it does (e.g. to persist a
   track name / mute / lock, or to carry a waveform/thumbnail handle on an asset),
   **stop and propose it in `plan/PLAN.md` first** — do not silently add fields.
5. **UI-only state never masquerades as an edit.** Zoom, hover, drag ghosts, snap
   guides, panel sizes, mute/solo/lock toggles where no schema/op exists — these are
   ephemeral/local (or `localStorage` for view prefs), and must **not** be presented
   as if they changed the rendered timeline. If an action has no real operation,
   don't fake an edit; either omit it or clearly mark it as a view-only control.
6. **TS strict, no `any`** (use `unknown` + narrowing); named exports; small focused
   components; early returns; named constants (no magic numbers); JSDoc on public
   components/hooks. Pixel↔time math stays in `editor/selectors.ts` (pure, tested).
7. **Tests stay green and grow; coverage must not drop.** Accessibility preserved or
   improved. `prefers-reduced-motion` honored everywhere.

---

## 2. The codebase you are polishing (read before editing)

```
apps/web-editor/src/
  App.tsx                 # shell: menu bar + Editor + status bar
  styles.css              # ~970 lines, token-based dark NLE — REFINE this
  components/
    Editor.tsx            # 3-column layout (left rail / stage / right rail), tab strips
    Toolbar.tsx           # split / delete / ripple / marker / zoom / undo-redo / export
    TimelineView.tsx      # lanes + ruler + playhead + markers + media-bin drop +
                          #   accessible <input range> scrubber  (NO drag-move / trim yet)
    PreviewPlayer.tsx     # program monitor; rAF clock rides the <video> element
    Inspector.tsx, MediaBin.tsx, EffectsPanel.tsx, OverlaysPanel.tsx,
    CaptionEditor.tsx, TranscriptView.tsx, AiPanel.tsx
  editor/
    useEditor.ts          # reducer store: applyPatch/undo/redo/select/seek/setZoom/
                          #   toggleMarker/setPlaying — the ONLY mutation surface
    store.ts              # validate→apply→record; zoom clamp (MIN/MAX_PX_PER_SECOND),
                          #   markers, selection, playing
    useShortcuts.ts       # global key handler (a switch today — turn into a registry)
    patch-builders.ts     # trim/split/delete/ripple/move/addClip/addTextOverlay/
                          #   applyColorGrade/addTransition/adjustAudio  (REUSE these)
    selectors.ts          # secondsToPx/pxToSeconds/timelineDuration/findClip/
                          #   clipsActiveAt/snapTargets/snap  (REUSE these — already tested)
packages/ui/src/          # Button, PatchReviewPanel, TimelineDiffView (AI review UX)
```

**Critical context — most premium primitives already exist and are just not wired
into the UI. Reuse them; do not reinvent:**

- `snap(time, targets, threshold)` and `snapTargets(timeline, extraMarkers)` in
  `selectors.ts` already implement magnetic snapping — **wire them into drag/trim.**
- `moveClipPatch`, `trimClipPatch`, `splitClipPatch`, `deleteClipPatch`,
  `rippleDeleteClipPatch` already exist in `patch-builders.ts` — **wire drag-move
  and edge-trim interactions to `moveClipPatch`/`trimClipPatch`.**
- Engine already generates **waveform peaks, proxies, and thumbnails**
  (`engine/python/.../media`); the editor must consume that data, never compute it.
- Zoom is already clamped (`MIN_PX_PER_SECOND=4`, `MAX_PX_PER_SECOND=240`) — respect
  it.

**Match existing patterns; extend, don't rewrite** (`CLAUDE.md` §6). Small reviewable
patches, never one sweeping refactor.

---

## 3. Design system (refine `styles.css` into a real, minimal token set)

Consolidate every color/space/radius/shadow/z/motion value into CSS custom
properties and use them everywhere. No stray hex/px in components.

- **Surfaces:** a 3–4 step neutral elevation ramp (app bg → panel → raised →
  hover). Keep it dark, near-monochrome. Replace heavy 1px borders with hairlines
  (`--line` already exists) and prefer spacing/elevation over boxes.
- **Accent:** keep the single blue accent (`--accent`). Use it only for selection,
  focus, playhead, primary action. Don't spread it around.
- **Track-type hues:** keep the existing video/audio/caption/overlay hues but
  desaturate slightly for calm; use them as thin identifiers (badge + a 2px lane
  accent), not as big filled blocks.
- **Spacing & radius:** define a 4px-based spacing scale and 2–3 radii. Apply
  consistently; tighten the currently uneven paddings.
- **Elevation:** one or two soft shadows max (menus, dragged clip, modals). No
  shadow on static panels.
- **Motion tokens:** `--dur-fast` (~120ms), `--dur` (~180ms), `--ease`
  (`cubic-bezier(0.2,0,0,1)`), plus a snappier spring feel for drag settle. Every
  transition references these. Wrap all of it in
  `@media (prefers-reduced-motion: reduce)` overrides.
- **Typography:** one clean system/UI stack (already present); add `font-variant-
numeric: tabular-nums` to all timecodes/counters; define a small type scale.
- **States:** every interactive element needs hover / active / focus-visible /
  disabled / selected. Focus-visible must stay clearly keyboard-distinct. Nothing
  ambiguous, nothing dead.

---

## 4. Icons (replace emoji with a real, minimal icon set)

- Adopt **`lucide-react`** (MIT, tree-shakeable, minimal line icons) for toolbar,
  rails, transport, track headers, and context menus. Replace the emoji currently
  used for tabs/transport (`🎞️ ✨ 🔤 💬 ✦ ⚙ 📝 ⏮ ⏸ ▶`).
  ⚠️ Adding a dependency requires `pnpm license:scan` and a note in `plan/PLAN.md`.
  Lucide is MIT and safe — but **follow the rule and flag it; ask if unsure.**
- Icons are 16/18/20px on a consistent grid, inherit `currentColor`, align
  optically, and **always** carry `aria-label`/`title`. Icon-only buttons get a
  tooltip (see §7) and a visible label in menus.
- Keep it monoline and consistent — no mixed icon styles, no filled+outline mix.

---

## 5. Timeline — the centerpiece (where premium is won)

Upgrade `TimelineView.tsx` (+ reuse `selectors.ts`/`patch-builders.ts`) into a real
NLE timeline. **Keep the existing accessible `<input type="range">` scrubber** for
determinism/tests, but add real direct manipulation on top.

- **Drag to move a clip** (within a track and across compatible tracks): pointer
  drag shows a ghost + snap guide; on drop, commit exactly **one** `moveClipPatch`
  (never a patch per pointer-move). Validate target-track type compatibility before
  building the patch. Negative/overlap targets are clamped/snapped, then validated.
- **Edge-trim handles** on both clip edges: hovering a clip reveals slim L/R trim
  affordances; dragging changes in/out and commits a single `trimClipPatch` on
  release. Clamp to a minimum clip length and to source bounds.
- **Split at playhead** (already bound to `S` / `⌘K`): make the _interaction_
  premium — a **razor cursor mode**, a hover cut-line on the clip under the pointer,
  and a quick split animation. Still goes through `splitClipPatch`.
- **Snapping:** wire `snapTargets`/`snap` so drags/trims magnetize to clip edges,
  the playhead, markers, and origin. Render a snap guide line on engage; allow
  temporarily disabling snap by holding a modifier during the drag. Snapping is a UI
  affordance — the committed value still flows through a validated patch.
- **Playhead & ruler:** add a draggable playhead and click-to-seek on the ruler
  (dispatch `seek`). Ruler ticks **adapt to zoom** (frames → seconds → minutes) with
  major/minor ticks and frame-accurate labels; replace the current fixed `{t}s`
  ticks.
- **Zoom & scroll:** smooth zoom centered on the playhead/cursor (respect the
  `MIN/MAX_PX_PER_SECOND` clamp); horizontal scroll; **zoom-to-fit** and
  **zoom-to-selection** commands. Keep it smooth on long timelines — virtualize
  ticks/clips if a project is large.
- **Tracks:** calm per-type lanes with a thin hue identifier. Track headers get
  minimal **mute / solo / lock** controls — **view-only** unless a real op exists
  (see invariant 5); if no op/schema exists, render them as clearly local view
  state or omit them, do not fake edits.
- **Audio waveforms:** render from **engine-provided peak data** (see §2 / data
  plumbing in §9). If peaks aren't loaded yet, show a tasteful skeleton — never
  compute audio in the browser.
- **Clip cards:** minimal — name, duration (frame-accurate), an optional
  thumbnail/waveform, and crisp hover / selected / dragging / trimming states.
  Truncate labels cleanly. Multi-select with Shift/⌘-click only where it maps to a
  real multi-clip operation.
- **Frame-accurate timecode:** add a pure `formatTimecode(seconds, fps)` →
  `HH:MM:SS:FF` helper in `selectors.ts` (with unit tests) and use it everywhere
  (ruler, clip cards, transport). Replace the ad-hoc `mm:ss.d` `timecode` currently
  inlined in `PreviewPlayer.tsx`.

Components stay thin; all geometry/snapping stays pure in `selectors.ts`.

---

## 6. Keyboard control (complete, discoverable, from one source of truth)

Refactor `useShortcuts.ts` from a `switch` into a **typed shortcut registry**: an
array of `{ id, keys, when, group, label, run }`. The global handler iterates the
registry; the same registry feeds **tooltips** and the **help overlay** so they can
never drift. Preserve the existing `isTypingTarget` guard and the rule that every
editing shortcut builds a patch and dispatches through `useEditor`.

Cover at least (Premiere/Resolve conventions; resolve conflicts sensibly):

- **Transport:** `Space` play/pause · `J/K/L` shuttle (reverse/pause/forward,
  repeat-press accelerates) · `←/→` step one frame · `Shift+←/→` one second ·
  `Home/End` start/end.
- **Editing:** `S` or `⌘K` split · `Backspace`/`Delete` lift-delete ·
  `Shift+Backspace` ripple-delete · `⌘C/⌘X/⌘V` copy/cut/paste clip (as patches) ·
  `⌘D` duplicate · `[` / `]` trim in/out to playhead · `,` / `.` nudge selected clip
  by one frame.
- **Selection/nav:** `↑/↓` select clip on adjacent track · `Tab`/`Shift+Tab`
  next/prev clip · `Esc` deselect.
- **Markers:** `M` toggle marker · `Shift+M` / marker-nav to jump between markers.
- **View:** `=`/`-` zoom · zoom-to-fit · zoom-to-selection.
- **History:** `⌘Z` undo · `⌘⇧Z` / `⌘Y` redo.
- **Help:** `?` opens a **searchable keyboard cheat-sheet overlay** generated from
  the registry, grouped by section, showing platform-correct key glyphs (⌘ on mac).

Only add shortcuts that map to real operations. Don't invent edits with no patch.

---

## 7. Interactions & micro-motion (the "smoothness")

Engineered, minimal motion — always gated by `prefers-reduced-motion`.

- **Hover/press:** subtle, fast feedback on buttons, clips, tabs, list rows. Press =
  tiny scale/opacity, not a bounce.
- **Selection:** a clean ring that animates in (~120ms), never a flashing glow.
- **Clip drag:** lift elevation + ghost; snap guide appears crisply; drop settles
  with a short spring. Animate `transform`/`opacity` only — never `left`/`width` on
  the hot path.
- **Split / delete:** quick razor cut on split; a fast collapse/ripple-close on
  delete so the user sees what happened.
- **Playhead:** smooth rAF-driven motion during playback (the existing PreviewPlayer
  clock already rides the `<video>` element — keep that; don't reintroduce per-frame
  `currentTime` writes). Scrubbing is 1:1 with the cursor.
- **Tooltips:** a single lightweight tooltip primitive (delay-in, instant-out) for
  every icon-only control, showing label + shortcut from the registry.
- **Toasts:** minimal, non-blocking, auto-dismiss notifications for applied edits,
  undo/redo, validation failures (surface `state.issues` here rather than the
  current inline red list), and export status. Include an inline "Undo" where useful.
- **Empty / loading / skeleton states** for every panel and for media/waveform/
  thumbnail loads — never a blank void, never layout shift on load.

Prefer CSS transitions/transforms + rAF. A small animation lib (`framer-motion`/
`motion`, MIT) is allowed **only** where CSS clearly can't do it — license-scan and
**ask first**.

---

## 8. Layout, monitor, panels & polish

- **Resizable, collapsible rails:** the 3-column shell becomes draggable splitters
  with sensible min/max; persist sizes/collapsed state to `localStorage` (view
  state, not project state). Keep the existing tab strips per rail.
- **Program monitor (`PreviewPlayer.tsx`):** a clean, minimal transport bar —
  play/pause, frame-step, go-to-start/end, in/out, **frame-accurate current /
  total timecode** (via `formatTimecode`), loop, volume, fullscreen. Letterbox the
  video to the project aspect ratio; add a toggleable **9:16 / safe-area framing
  guide** (FramePilot targets Reels).
- **Inspector (`Inspector.tsx`):** grouped, minimal property controls with
  **drag-to-scrub number fields**, sliders with units, and clean labels. Property
  edits still emit patches (e.g. `adjustAudioPatch`, `applyColorGradePatch`).
- **Context menus:** right-click on clips/tracks exposing the same patch actions as
  the toolbar/keyboard (split, delete, ripple, duplicate, add transition…), built
  from the same registry where possible.
- **Toolbar (`Toolbar.tsx`):** convert to icon buttons + tooltips, grouped with
  hairline dividers; keep Export as the one primary action.
- **AI / patch review (`packages/ui` `PatchReviewPanel` / `TimelineDiffView`):**
  give the what / why / before-after / Apply-Reject flow first-class minimal
  styling — this reviewable-edit loop is core to FramePilot, so it must feel as
  polished as the timeline.
- **Menu bar & status bar (`App.tsx`):** quiet, aligned, minimal; the status bar
  shows project path + frame-accurate playhead + zoom, calmly.

---

## 9. Data plumbing, performance & correctness

- **Waveform/thumbnail data:** the engine already produces peaks/thumbnails/proxies.
  Surface them to the renderer through the existing IPC/bridge as **data the UI
  reads** (do not import the engine into the UI, do not run MoviePy in the browser).
  If the current `Asset`/bridge shape can't carry a peaks/thumbnail handle, that is a
  schema/contract change → **flag it in `plan/PLAN.md` and ask before adding fields**
  (invariant 4). Until wired, render skeletons.
- **60fps interactions:** memoize, keep selectors pure, subscribe narrowly. Drag/
  trim/scrub update via transforms + rAF and commit **one** patch on release.
- **Big timelines stay smooth:** virtualize ruler ticks and off-screen clips if
  needed.
- **No new global mutable state** outside the store. View-only state stays local/
  ephemeral (or `localStorage` for prefs) and never enters the timeline.

---

## 10. Testing, docs & plan (Definition of Done)

- [ ] Editor looks/feels premium **and** minimal: refined token system, real icon
      set, frame-accurate timecode everywhere, calm spacing, consistent states.
- [ ] Timeline supports fluid **drag-move, edge-trim, split (razor), snapping,
      adaptive ruler, zoom-to-fit/selection, click-to-seek**, all committed as
      **validated, reversible patches** via `useEditor` (one patch per gesture).
- [ ] **Single typed shortcut registry** drives the key handler, tooltips, and a
      searchable `?` help overlay; full transport/editing/nav/marker/view/history map.
- [ ] Motion is smooth, minimal, consistent, and **respects
      `prefers-reduced-motion`**; toasts replace inline error noise.
- [ ] Resizable/collapsible rails; minimal program monitor with frame-accurate
      transport + safe-area guide; drag-to-scrub inspector; context menus; tooltips;
      empty/loading/skeleton states.
- [ ] Waveforms/thumbnails render from **engine data only** (or skeletons); no
      MoviePy in the UI; no browser-side media compute.
- [ ] **No invariant violated:** no direct state mutation, no bypass of
      validate→apply→record, no unflagged schema change, no faked edits.
- [ ] Accessibility preserved/improved: roles, keyboard reach, focus-visible,
      ARIA on icon buttons, the accessible scrubber retained.
- [ ] **Tests:** unit tests for `formatTimecode` and any new patch builders;
      component/interaction tests for drag-move, edge-trim, split, the shortcut
      registry, and the help overlay; an e2e for a critical flow
      (drag a clip → trim an edge → split → undo/redo → seek). **Coverage not
      dropped.**
- [ ] `pnpm verify` passes (typecheck + lint + test + engine:test). Any new dep
      passed `pnpm license:scan`.
- [ ] `plan/PLAN.md` updated (task `[~]`→`[x]` only when DoD met; add discovered
      tasks); `docs/` + `CHANGELOG.md` updated for user-facing UI changes; add an
      **ADR** if you introduce a design-system or interaction-architecture decision.

---

## 11. How to work (sequence, small reviewable patches)

Read `AGENTS.md`, `CLAUDE.md`, `PRD.md` (§9.2 render-vs-preview, UI sections), and
the files in §2. Confirm the patch/validate/record flow before touching anything.
Add/locate the task in `plan/PLAN.md` and mark it `[~]`. Then proceed in order,
running affected tests after each step (never ship unverified):

1. **Foundation** — refine design tokens (color/space/radius/shadow/motion) in
   `styles.css`; add `lucide-react` + swap emoji; add `formatTimecode` (+ tests) and
   adopt it.
2. **Timeline interactions** — wire `snapTargets`/`snap` + `moveClipPatch`/
   `trimClipPatch` into drag-move and edge-trim; razor split; draggable playhead +
   click-to-seek; adaptive ruler; zoom-to-fit/selection.
3. **Keyboard** — registry refactor of `useShortcuts.ts`; tooltips + `?` help
   overlay from the registry.
4. **Monitor, panels, motion** — minimal transport + safe-area guide; resizable/
   collapsible rails; drag-to-scrub inspector; context menus; toasts; skeletons;
   micro-motion (all `prefers-reduced-motion`-gated).
5. **Data, tests, docs** — surface waveform/thumbnail data (flag any contract
   change first); add unit/interaction/e2e tests; update plan + docs + CHANGELOG.

Surface anything needing a dependency, a schema/contract change, or a broadened
surface **before** doing it (`CLAUDE.md` §5).

**Build it like a senior product engineer shipping a flagship editor: correct
first, then fast, then beautiful — and "beautiful" here means quiet, precise, and
minimal, never at the cost of the invariants.**
