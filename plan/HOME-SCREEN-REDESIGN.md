# Home Screen Redesign

**Status:** `[x]` complete  
**Started:** 2026-08-07  
**Completed:** 2026-08-07

## Goal

Replace the existing splash/home screen with the approved minimal project-launch layout while preserving FramePilot's existing light/dark palette and project behavior.

## Work

- [x] Keep the existing FramePilot design tokens and logo rather than introducing a new palette.
- [x] Use the approved two-card **New Project / Open Project** launch layout.
- [x] Add one theme icon that switches the same persisted theme preference used by the editor.
- [x] Keep recent-project loading metadata-only and sorted by last opened.
- [x] Give the recent-project section bounded vertical scrolling and horizontal truncation for long names/paths.
- [x] Keep desktop/browser capability behavior intact.
- [x] Add focused component coverage for long recent lists and the single theme control.
- [x] Run repository verification and confirm the affected TypeScript, lint, unit/coverage, license, Python, render-fixture, web-editor production build, and desktop build gates pass.

## Verification

GitHub Actions run `31175063570` completed the affected verification successfully before this plan was closed. TypeScript typecheck, lint and unit-test coverage passed, the web editor built for production, the desktop package built, and the repository's Python, render-fixture and license gates also passed. E2E smoke and visual-regression jobs were skipped by the workflow for this run rather than failing.

No timeline, render, schema, or AI behavior changes are part of this work.
