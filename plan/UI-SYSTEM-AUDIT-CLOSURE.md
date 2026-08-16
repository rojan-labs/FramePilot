# UI System Audit Closure

- Status: `[x]` closed — implementation complete, local verification green on the PR branch, PR #145 open against `main`
- Started: 2026-08-10
- Updated: 2026-08-10
- Scope: web-editor presentation system, shared UI primitives, accessibility ergonomics, design tokens, and documentation

## Context

The 2026-08-10 end-to-end UI/UX audit found that FramePilot's interaction architecture is stronger than its presentation architecture. The editor already has virtualization, bounded scrolling, reduced-motion support, keyboard-aware overlays, and responsive rails, but the presentation layer accumulated several generations of styling with inconsistent typography, target sizes, tokens, and component ownership.

This pass closes the highest-value active issues without changing timeline schemas, render behavior, AI orchestration, IPC contracts, or editor mutation semantics.

## Work

- [x] Reconcile the documented design system with the actual canonical token values.
- [x] Add semantic tokens for sans typography, weights, pill radius, control heights, hit targets, density, and motion roles.
- [x] Strengthen light-theme tertiary-text contrast for dense UI metadata.
- [x] Enforce an 11px ordinary interface-text floor across the redesigned Settings, Inspector, and Caption surfaces.
- [x] Normalize active redesigned-surface font weights to the shared 400/500/600 scale.
- [x] Raise precision-editor interactive targets to at least 24px while preserving compact glyph sizes.
- [x] Define the previously implicit caption font/pill tokens used by active UI.
- [x] Add one deliberate editor-foundation layer for cross-surface ergonomics instead of another feature-specific override set.
- [x] Promote reusable Switch and SegmentedControl behavior into `@framepilot/ui` and migrate Settings to the shared primitives.
- [x] Make Button/Input/Switch/SegmentedControl carry usable token-driven presentation with the shared UI package.
- [x] Use the existing custom Select in the caption font picker instead of a native dropdown.
- [x] Add focused regression coverage for shared controls, Button loading semantics, and the Caption font-picker path.
- [x] Update the design-system contract, Settings guide, UI-system guide, documentation index, and audit closure report.
- [x] Execute the focused UI tests/typecheck/lint in a mounted checkout. Run 2026-08-10 against PR #145 head (`ae72a10`): repo-wide `pnpm typecheck` green (15/15 turbo tasks), `pnpm lint` clean on `@framepilot/ui` + `web-editor`, `pnpm license:scan` clean (7 packages), `web-editor`/`@framepilot/ui` test suites green — 2356/2356 tests passing.
- [x] Run broader PR/CI verification after the PR is open. GitHub Actions on PR #145 could not run to completion (account out of Actions minutes — all jobs terminated in ~5s, not real failures); verification was instead performed against the exact PR head commit in a mounted local checkout, per the item above. One real regression was found and fixed in that pass (see below) before this item was closed.

## Explicit residual source cleanup

These maintainability items remain visible rather than being falsely marked complete:

- [ ] Extract/delete historical feature blocks still resident in `apps/web-editor/src/styles.css` when an executable checkout and visual-regression run are available. New UI work must not add unrelated blocks there.
- [ ] Simplify the Caption workspace DOM/presentation boundary so the sidebar no longer needs its existing scoped `:has()` adapter. Preserve transcript virtualization and validated patch behavior.

The active user-facing issues from those areas are addressed by the token/foundation/primitive work above. The residual items are source-organization cleanups that require a broader visual verification pass.

## Repository bookkeeping

The focused plan, docs index, Settings guide, UI-system guide, and dated audit report were updated on the branch. The master-plan link (below, in `plan/PLAN.md`) and the root `CHANGELOG.md` Unreleased entry were folded in from a mounted checkout during this closure pass, resolving the earlier connector-only gap.

## Verification

Performed 2026-08-10 in a mounted local checkout, against PR #145 head. GitHub Actions itself could not be used as the verification source — the account is out of Actions minutes, so all jobs on the PR terminated in ~5 seconds without actually running (confirmed via the run's `created_at`/`updated_at` timestamps, not treated as real failures). Local runs stood in for CI instead:

- `pnpm typecheck` — 15/15 turbo tasks green.
- `pnpm lint` — clean on `@framepilot/ui` and `web-editor`.
- `pnpm license:scan` — 7 packages, no denylisted licenses.
- `pnpm test` (`@framepilot/ui` + `web-editor`, with coverage) — 2356/2356 tests passing.

One real, deterministic regression was caught and fixed in this pass: `apps/web-editor/src/components/CaptionEditor.test.tsx`'s font-picker assertions (`offers 20+ bundled creative fonts and persists the selected face`) still assumed native `<select>`/`<option>` DOM semantics, but this audit moved the caption font pickers to the portaled `Select` component (see Work above). The test was updated to open the combobox and click the option, matching the interaction pattern already used in `CaptionWorkspace.test.tsx`'s new coverage — commit `ae72a10` on `fix/ui-system-audit-closure`, pushed to PR #145.

## Non-goals

- No timeline/project schema changes.
- No render-engine changes.
- No AI/tool/orchestration changes.
- No Electron/IPC changes.
- No dependency additions.
- No broad visual redesign of existing layouts.
