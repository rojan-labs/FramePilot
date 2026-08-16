# Frontend runtime performance audit — apps/web-editor (2026-07-02)

Audit of reported lag: 20s multi-layer project, zoom, drag, media bin, general UI —
even on 32GB RAM. React 18.3, Vite 5, no React Compiler, StrictMode on (2× in dev).
Only `ClipFilmstrip` and `AssetThumb` are memoized; every large panel is a plain
function component prop-drilled the whole `editor` object.

## Worst offender
Playback-clock → store `seek` → **whole-`Editor`-subtree re-render** coupling. Zoom and
drag ride the same full-subtree pattern via store/`setGhost` state changes.

## Findings (priority order)

### P0 — Monolithic store + unstable `editor` object re-renders the entire editor on every seek
- `store.ts:321` `seek()` returns `{...state, playhead}` — playhead shares the reducer with
  `timeline`/`selection`/`zoom`/`assets`/`folders`/`markers`.
- `useEditor.ts:130-135` returns a brand-new `{state, ...actions, canUndo, canRedo}` each
  render → `editor` prop identity changes every render.
- `Editor.tsx:217` prop-drills `editor` into every panel (MediaBin `:333`, EffectsPanel
  `:340`, OverlaysPanel `:341`, CaptionEditor `:343`, PreviewPlayer `:354`, TimelineView
  `:374`, Toolbar `:367`, Inspector `:444`, AiSidebar `:432`, TranscriptView `:446`,
  Toasts `:452`).
- Trigger: playback calls `ed.seek(next)` ~60fps (`PreviewPlayer.tsx:283/286/290`); ruler
  scrub calls `editor.seek(...)` per pointermove (`TimelineView.tsx:856/859`).
- Fix: decouple transient playhead into a dedicated tiny store consumed via
  `useSyncExternalStore` selectors (only playhead-drawing components subscribe), or drive
  imperatively via ref/CSS var. Pass the stable `actions` object down, expose `state` via
  selector hooks, then memoize panels.

### P0 — Visible playhead is React-state-driven
- `TimelineView.tsx:404` reads `playhead` from `editor.state`; `:1642` positions it via
  `left: secondsToPx(playhead, pxPerSecond)` from React state (auto-scroll loop uses refs
  at `:944-966`, but the marker does not). `trackLanes` memo (`:1101-1392`) correctly
  excludes `playhead`, but the `TimelineView` body still re-renders each seek (`rulerTicks`
  `:1092` unmemoized, tick maps `:1622/:1629`, sr-only scrubber `:1406`, playhead div, minimap).
- Fix: update the marker `transform`/`left` imperatively from the rAF clock; memoize
  `rulerTicks` on `[laneSeconds, pxPerSecond, fps]`.

### P1 — Clip drag rebuilds all lanes/clips per pointermove (no rAF throttle)
- `onClipPointerMove` (`TimelineView.tsx:631`) calls `setGhost` every move (`:652/:665/:679`);
  `ghost` is a `trackLanes` dep (`:1369`) → every move re-maps every track/clip incl.
  ClipFilmstrip/ClipWaveform.
- Fix: render the ghost as one absolutely-positioned overlay layered over static lanes so
  lanes don't depend on `ghost`; and/or rAF-throttle `setGhost`; scope re-render to the lane.

### P1 — Wheel-zoom commits a store update per tick, unbatched
- `TimelineView.tsx:916-929` `onWheel` calls `ed.setZoom(...)` synchronously per event;
  `pxPerSecond` is a `trackLanes` dep (`:1372`) → full lane rebuild + waveform repaint per tick.
- Fix: accumulate wheel delta, commit one `setZoom` per animation frame; optionally CSS
  `scale` during the gesture, real reflow on settle.

### P2 — TimelineMinimap recomputes full geometry every seek
- Rendered unconditionally (`TimelineView.tsx:1734`), not memoized; `minimapGeometry(...)`
  called in render body (`TimelineMinimap.tsx:63`) iterating every clip; blocks re-mapped
  (`:151`). Props stable during playback.
- Fix: `React.memo` + `useMemo` the geometry.

### P2 — MediaBin re-renders 60fps during playback
- `MediaBin.tsx:240` takes whole `editor`, always mounted. Internal memos hold, but the
  virtualizer + visible rows re-reconcile per seek. Matches "asset bin lag".
- Fix: `React.memo(MediaBin)`, pass `assets`/`folders`/`editMode`/stable actions only.

### P2 — AiSidebar diff callbacks churn identity → EventNodes re-render each seek
- `AiSidebar.tsx:156` `applyPatch` `useCallback` deps `[editor, onProjectChange, project]`;
  `editor` new each render → `applyPatch`/`diffActions` (`:163`) recreated → `EventNode`
  (`:279`, unmemoized) re-renders every visible row per seek when AI tab has content.
- Fix: depend on `editor.applyPatch` (stable); memoize `EventNode`.

### P3 — Smaller contributors
- Inspector is the default right tab (`Editor.tsx:223`) and reads `playhead`
  (`Inspector.tsx:382/408`) → re-renders each seek; consider `useDeferredValue`.
- `ClipWaveform.tsx:104` `markers = []` default creates new identity each render → repaint
  effect (`:150`) re-fires; hoist a module-level `const EMPTY: number[] = []`.
- `rulerTicks`/`duration`/`laneWidth` recomputed every render (`TimelineView.tsx:1092/:414-416`).

## Fix order (user-visible impact)
1. Decouple playhead from reducer state (P0×2) — kills playback+scrub lag, stops the storm.
2. Stable `actions` + memoize panels (P0 tail, P2 MediaBin/AiSidebar).
3. rAF-batch zoom (P1) + scope/throttle drag ghost (P1).
4. `React.memo` minimap (P2) + P3 cleanups.
