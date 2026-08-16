# Compact Settings UI pass

**Status:** `[x]` complete

**Date:** 2026-08-09

## Goal

Reduce the Settings modal footprint and visual weight while preserving every
existing setting, keyboard behavior, persistence path, provider configuration,
readiness signal, responsive behavior, and reset action. Match the supplied
Settings reference closely enough that the surface reads like a native compact
editor utility rather than a compressed version of the previous modal.

## Constraints

- Presentation-only. No project schema, timeline operation, render path, AI
  provider behavior, or settings persistence contract changes.
- Keep all six sections: Display, Editing, Playback, AI, Memory, Shortcuts.
- Preserve the focus trap, Escape close, roving tab keyboard navigation,
  auto-save behavior, and Reset to defaults.
- Keep the existing theme tokens and reduced-motion behavior.
- Favor compact, flat Linear/Notion/Cursor-style editor chrome over large cards,
  accent-heavy selection states, or oversized spacing.
- Keep Settings-specific CSS in one canonical stylesheet. Do not leave the old
  Settings block duplicated in the shared `styles.css`.

## Work

- [x] Add an isolated Settings stylesheet loaded after the editor base styles.
- [x] Rework the desktop shell around the supplied reference: compact title
  lockup, grouped left rail, readiness card, neutral active navigation, flat
  bordered groups, restrained segmented controls, low-profile switches, and a
  quiet footer.
- [x] Remove the legacy Settings-specific rule block from `styles.css` and keep
  only genuinely shared editor controls there, including the global segmented
  control.
- [x] Keep Editing and Playback in a two-card dashboard where width allows, with
  a compact single-column fallback on narrower windows.
- [x] Preserve mobile/tablet navigation and content scrolling.
- [x] Update the Settings guide to document the reference-driven visual pattern
  and stylesheet ownership.
- [x] Run the repository CI quality gates on the reference-fidelity pass and
  inspect the resulting desktop build before marking complete.

## Verification

GitHub CI run 498 passed for the reference-fidelity and CSS-extraction changes:

- TypeScript typecheck passed.
- TypeScript lint passed.
- Unit tests and coverage passed, including the existing SettingsDialog suite.
- Python typecheck, lint, tests, coverage, and render-fixture smoke passed.
- License scan passed.
- Desktop build passed.
- E2E smoke and visual-regression jobs are currently disabled by the repository
  workflow (`if: false`), so CI reports them as skipped rather than executed.

The final plan-status commit is documentation-only and uses `[skip ci]`; run 498
covers the implementation and documentation state immediately before this status
update.
