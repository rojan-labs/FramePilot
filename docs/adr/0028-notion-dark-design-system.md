# ADR 0028 — Notion-style dark design system (presentation-only retoken)

- **Status:** Accepted
- **Date:** 2026-06-26
- **Phase:** 3.4 — Premium / minimal UI-UX pass
- **Relates to:** ADR 0014 (premium editor UI pass), `UI_REVAMP/` brief
  (`ui-revamp-super-prompt.md` + `ui-teardown-quality-bar.md`), `UI_AUDIT.md`,
  `DESIGN_SYSTEM.md`, and `apps/web-editor/src/styles.css`.

## Context

The `UI_REVAMP/` brief asked for a Notion-grade dark redesign of the editor under a
strict **prime directive: change nothing about behavior** — no logic, props/APIs,
event handlers, IPC, render/AI pipeline, keyboard bindings, routing, persistence,
or `data-testid`/`id`/`aria`/`ref` hooks. Discovery (`UI_AUDIT.md`) found the app
already mature: React 18 + Vite, `lucide-react` icons centralised in `icons.tsx`,
real waveforms, drag-to-scrub, a draggable playhead, and a token-driven stylesheet
with **402 `var()` references** — but a cooler `#0b0b0f`/periwinkle palette that
diverged from the Notion target, ~50 hardcoded hex values, gradient clip/logo
fills, and a `Button` primitive whose `data-variant` attribute nothing styled.

## Decision

A presentation-only pass, executed **tokens → primitives → surfaces**:

1. **Retune `:root` to the canonical spec tokens** (warm `#191919` surfaces, single
   `#2383e2` accent, opacity-based text tiers, low-opacity-white borders, muted
   semantic + `--clip-*` + `--playhead` tokens, spec radius/shadow scales). The
   existing legacy token names are **aliased** to the new ones, so a single palette
   edit cascades through all 402 usages without touching component code.
2. **Sweep every hardcoded hex** out of `styles.css` into tokens (clips → flat muted
   per-type fills + brighter borders, no gradients; badges; preview void; borders;
   status colours; scrollbars; de-gradiented topbar logo).
3. **Build the `Button` variant system in CSS** (`[data-variant]` primary/secondary/
   ghost with default·hover·active·focus-visible·disabled) at **one-attribute
   specificity, placed early** in the cascade so component-scoped rules
   (`.icon-btn`, `.rail-tabs button`, …) continue to win — closing the gap where the
   primitive emitted `data-variant` but rendered unstyled.
4. **Surface polish:** selection = accent outline + glow (not a fill); conventional
   red playhead; quiet dot+label save status (spinner while saving).

## Conflicts with the teardown, and how they were resolved

The teardown was written against an older screenshot; two of its removals collided
with the prime directive and the test suite:

- **"Remove the second Export button."** In production `Editor.tsx` renders the
  toolbar without `onExport`, so that button is permanently disabled and the
  duplicate never manifests in the app; `coverage.test.tsx` exercises it. **Kept and
  de-emphasised to `secondary`**, canonical top-right Export promoted to `primary` —
  pure variant swaps, no wiring change.
- **"Delete the Playhead slider."** Its `<input>` (`getByLabelText('playhead')`, ~20
  test refs) and `<output>` (`getByLabelText('playhead time')`) are the
  deterministic-seek + keyboard + screen-reader hooks. **Kept in the DOM but made
  `sr-only`** — gone from the visible chrome (the ruler scrubs; the transport shows
  the one authoritative `current / total`), intact for AT and tests.

## Consequences

- One palette swap reskins the whole app; future theming is a token edit.
- Zero hardcoded colours remain in `styles.css`; the `Button` primitive is now real.
- No behavior/test changes: web-editor **346** + ui **2** tests green, `tsc --noEmit`
  green, `vite build` green.
- Trade-off: a few bare `<Button variant>` instances that were effectively unstyled
  now adopt the variant look — an improvement, but worth a visual glance per surface
  as the pass continues (Phase 3.4 remains `[~]`).

## Round 2 — full DoD sweep

- **Emoji eliminated.** Every emoji used as an icon (`MediaBin` asset-kind glyphs +
  folder/add/rename/delete/remove controls, `AiPanel` self-check badges + summary,
  the `Topbar` `✦` brand mark) was replaced with `lucide-react` via `icons.tsx`,
  following the teardown's Part D icon mapping — one icon family, no emoji, as the DoD
  requires. The media-bin `Folder` _type_ and the `Folder` _icon_ collide by name, so
  the icon is imported `as FolderIcon`.
- **Designed empty state** for the program monitor (icon + existing copy — copy
  unchanged, the `No clip at playhead.` text node is preserved for `getByText`).

### Explicitly deferred (need non-presentation work — out of a paint pass)

- **Per-track mute/solo/lock/hide controls** (teardown A2): the `Track` schema has no
  such fields. Real work = schema v4 + migration + patch ops + tests, behind the
  engine-before-UI build order. Stubbing dead disabled toggles would itself be a slop
  tell, so they are **not** added.
- **Video clip filmstrip thumbnails** (teardown A2): requires Python render-engine
  frame extraction + an `Asset` schema handle (same deferral as ADR 0014 Part 5).
  Audio waveforms already render from engine peaks; clips read as content areas via
  flat per-type fills in the meantime.

## Amendment — 2026-07-01: Cursor/Linear retune (values only)

The token _values_ were retuned to a cooler, flatter dark ramp and a Cursor-blue
accent so the app reads as Cursor/Linear-class software chrome (part of the Phase 11
Cursor-UI pass). **No token names changed** and no new hardcoded hex was introduced,
so the retune stayed a single `:root` edit that cascaded through every `var()`
consumer — exactly the aliasing property this ADR established.

- Surfaces: `--bg-app` `#191919→#161618`, `--bg-panel` `#1e1e1e→#19191c`,
  `--bg-surface` `#232323→#202024`, `--bg-elevated` `#2a2a2a→#26262b`,
  `--bg-canvas` `#0d0d0d→#0a0a0b` (a hint of blue in the neutrals).
- Accent: `#2383e2→#3d7eff` (+ hover/subtle/focus/selection derived to match).
- Semantic: crisper `--success`/`--warning`/`--danger` (GitHub/Linear-dark adjacent).
- Added typography tokens: `--font-mono`, `--font-size-xs..xl`, `--leading-*`.

The `--playhead` red stays the conventional editor red (not accent-derived).
`DESIGN_SYSTEM.md` color/type tables updated to match.
</content>
