# ADR 0054 — Timeline toolbar IA reorg + orange brand identity

- **Status:** Accepted
- **Date:** 2026-07-12
- **Builds on:** ADR 0028 (Notion-dark design system, established the
  `#2383e2` "Cursor blue" accent that a later, undocumented pass moved to
  `#6d5cf6` indigo to match the then-current logo — see `tokens.test.ts`'s
  "not the original Cursor blue" test).

## Context

Two independent changes landed together on one branch.

**Toolbar IA.** The timeline toolbar (`apps/web-editor/src/components/Toolbar.tsx`)
and a floating cluster in the track-header gutter (`TimelineView.tsx`'s
`ruler-spacer` cell) had grown by proximity, not function: the blade/razor
control existed in both places under different names ("Split" vs "Razor"),
zoom-in/out lived in the toolbar while zoom-to-fit was stranded in the gutter,
Add-track lived in the gutter cluster next to unrelated view controls, and
Export appeared in both the toolbar and the header (`Topbar.tsx`) — the
toolbar's copy was in fact already dead (`Editor.tsx` never wired its
`onExport` prop; only the header's copy ever fired).

**Brand identity.** The product had a real logo asset for the first time (an
orange/white filmstrip "F" mark, supplied as
`ui_revamp/logo/framepilot logo-clean.png`), replacing the placeholder violet→
blue mark the indigo accent above was matched to.

## Decision 1 — group toolbar controls by scope, lift shared state to `Editor.tsx`

Controls now group as **Tools** (Selection/Blade, mutually exclusive) → **Clip
actions** (Split/Delete/Ripple) → **Markers** → **Edit mode** (Overwrite/Insert
+ Ripple-on-delete + new inline Snapping toggle) → **History**, then a
right-aligned **View/zoom** cluster (Zoom out/in/**to fit**, now together).
Add-track moves into the track-header gutter with a Video/Audio picker (track
scope belongs with the tracks); Export is removed from the toolbar entirely
(header-only, per the audit above).

The Blade/Selection tool was local `useState` inside `TimelineView` (`razor`).
Since the toolbar now needs to render and control the same state, it is lifted
to `Editor.tsx` alongside the existing `editMode`/`rippleOnDelete` lift
(`useEditMode`) — the established pattern for state shared between the toolbar
and the timeline view. Zoom-to-fit did **not** need lifting: it already
dispatched a decoupled `window` `CustomEvent('framepilot:zoom')` for its
keyboard shortcut, so the new toolbar button reuses the same event instead of
threading a ref through two memoized components.

Hand/Pan tool was deliberately **not** added — it doesn't exist today, and
building it would be new interaction, not a reorg. The Tools group ships with
Selection + Blade only.

## Decision 2 — extend the shortcut registry, don't invent a parallel one

`tool.select` (`a`), `tool.blade` (`b`), and `view.snapToggle` (`n`) are new
entries in the single `SHORTCUTS` registry (`apps/web-editor/src/editor/
shortcuts.ts`), following the existing `ShortcutDeps`/`ShortcutOptions`
threading pattern (`setTool`/`toggleSnapping`, wired through `useEditorShortcuts`
exactly like `toggleHistory`/`openSettings`). The `?` help overlay and toolbar
tooltips stay in sync automatically since they already render from this one
source of truth.

## Decision 3 — collapse to `⋯ More`, never wrap

A `ResizeObserver` on the toolbar container collapses **Markers** first, then
**Clip actions**, into a shared overflow menu (reusing `Menu`/`MenuItem`) below
two width thresholds. Degrades to "always full width" when `ResizeObserver` is
unavailable (jsdom) rather than crashing.

## Decision 4 — rebrand to orange, in both token systems, using the logo as-is

The accent moves from indigo `#6d5cf6` to `#e5670a` (sampled directly from the
logo's filmstrip fill), with a lighter `#ff7f1f` hover and an AA-contrast
`#a8460d` light-mode text/icon shade (5.9:1 on white) — the same
darken-for-light-mode pattern the indigo accent already used. This must be set
in **two independent** places because the site was never unified onto the
editor's tokens: `packages/ui/src/tokens.css` (dark/light-media/`data-theme`)
and `apps/website/src/app/globals.css` (its own Tailwind v4 `@theme` block),
plus every place either had hardcoded the old accent's `rgb(109,92,246,…)`
triplet directly in Tailwind arbitrary-value shadows/glows instead of a token
(six marketing components) and the OG/favicon generator's own `ACCENT` const.

The logo PNG (1048×1008, fully opaque — no real alpha, same "opaque rounded-
square tile" convention the placeholder mark already used) is used **unedited**
per explicit direction — the only pixel operation performed is padding it to a
square canvas with its own corner colour, a mechanical necessity for favicon/
icon generators that assume 1:1 source art, not a redesign. `apps/website/
scripts/generate-og.ts` already embeds `public/logo.png` and derives every
other raster asset (`og.png`, `icon-*.png`, `apple-touch-icon.png`, `icon.svg`,
`favicon.ico`) from it plus `ACCENT`, so replacing the file and the constant
and re-running `pnpm generate:og` regenerates the whole set correctly — no
per-asset hand editing.

`apps/desktop` had no app icon at all (Electron's default). Electron-builder's
`buildResources: build` directory is a **source** directory (icons,
entitlements), not build output, so it needed a `.gitignore` exception to the
blanket `build/` rule to be trackable at all — added alongside `build/icon.png`
(the same squared logo at 1024×1024) and explicit `mac.icon`/`win.icon`/
`linux.icon` keys, letting electron-builder derive `.icns`/`.ico` at package
time from the one source PNG.

## Consequences

- Every timeline control still exists; several only moved to the group that
  matches their scope. No functionality was removed.
- The accent is a deliberate, third brand value on this token (`#2383e2` →
  `#6d5cf6` → `#e5670a`) — `packages/ui/src/tokens.test.ts`'s pinning test is
  updated, not deleted, so the next change is forced to update it deliberately
  too.
- Risk: the two independent token systems (`packages/ui` vs the website's own
  `@theme`) can drift again next time either changes alone. Unifying them is
  out of scope here (a bigger, separate refactor) but is worth a future ADR.
