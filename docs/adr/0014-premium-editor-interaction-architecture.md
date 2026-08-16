# 14. Premium editor interaction architecture

Date: 2026-06-23

## Status

Accepted

## Context

The editor (`apps/web-editor`) was functionally complete but did not yet _feel_
like a flagship NLE: clips could not be dragged or edge-trimmed, the ruler was a
fixed `{t}s` scale, shortcuts were a hard-coded `switch`, validation errors were an
inline red list, and the chrome used emoji. The brief (`PROMPT.md`) called for a
"premium, minimal" pass — Premiere/Resolve/CapCut precision with Linear/Things
restraint — **without changing the engine, schema, or how edits are validated**.

The hard constraint: every timeline mutation must remain a typed, validated,
reversible patch dispatched through the single `useEditor` store
(`validate → apply → record`). Direct manipulation, keyboard shortcuts, and AI all
funnel through that one path; there must be no second, unchecked mutation path
(AGENTS.md invariants; ADR 0010).

## Decision

1. **All pixel↔time geometry stays pure in `editor/selectors.ts`.** Drag/trim/zoom/
   ruler math — `formatTimecode`, `rulerTicks`, `clampTrimStart/End`,
   `tracksCompatible`, `zoomToFit`/`zoomToClip`, and clip/marker navigation — are
   pure, unit-tested functions. React components (`TimelineView`, `PreviewPlayer`)
   are thin pointer/DOM shells that read these and dispatch existing patch builders
   (`moveClipPatch`/`trimClipPatch`/`splitClipPatch`). One gesture commits exactly
   one patch on release; mid-gesture ghosts/snap-guides are ephemeral local state.

2. **One typed shortcut registry is the single source of truth.** `editor/shortcuts.ts`
   holds `{ id, keys, when, group, label, run }` entries; the global key handler,
   the tooltips, and the searchable `?` help overlay all derive from it, so they
   cannot drift. Chords are normalised canonically (`mod` = ⌘/Ctrl); every editing
   shortcut builds a patch through the store. Tab clip-navigation is focus-scoped so
   global accessibility traversal is preserved.

3. **UI-only state never masquerades as an edit (invariant 5).** Zoom, drag ghosts,
   snap guides, razor cut-lines, mute/solo/lock (omitted — no op exists yet), and
   rail sizes/collapse are ephemeral or `localStorage` view state, never timeline
   mutations. Rejected/committed edits surface as non-blocking **toasts** (with an
   inline Undo) instead of an inline error list.

4. **Motion is CSS transitions/transforms + rAF only**, every rule gated by
   `prefers-reduced-motion`. No animation dependency was added.

5. **One small dependency: `lucide-react`** (ISC, tree-shakeable monoline icons),
   centralised in `components/icons.tsx`, replacing emoji. `pnpm license:scan` green.

## Consequences

- The premium feel is won in pure, testable functions; components stay thin and the
  invariants hold — drag-move, edge-trim, razor split, snapping, and every shortcut
  remain reversible, validated patches.
- Tooltips/help can never contradict the real key map, because they read the registry.
- **Deferred (contract change, not made here):** rendering real audio **waveforms**
  and clip **thumbnails** needs the engine's peak/thumbnail data surfaced to the UI.
  The `Asset` schema (`packages/timeline-schema`) carries no peaks/thumbnail handle,
  so adding one is a schema + bridge change requiring a migration, tests, and a doc
  (invariant 4). Until that is proposed and approved, audio clips render a tasteful
  **skeleton** — the browser never computes media (render-vs-preview rule). See
  `plan/PLAN.md` Phase 8.
