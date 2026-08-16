# ADR 0010: Renderer editor architecture — pure framework-agnostic core + thin React shell

- **Status:** Accepted
- **Date:** 2026-06-19
- **Deciders:** Phase 3 editor-UI work

## Context

Phase 3.2/3.3 builds the manual editor renderer (`apps/web-editor`): import/create a
project, preview, a multi-track timeline (trim / split / delete / ripple / move / snap /
zoom / markers), an inspector, and a transcript + caption editor.

Two forces shaped how it is structured:

- **The validated-edit invariant must hold for _manual_ edits too.** AGENTS invariant:
  every edit is a typed timeline operation, validated before apply, recorded with its
  inverse. The easy thing in a React app is to mutate project state in component handlers —
  which would create a second, unchecked edit path that bypasses
  `@framepilot/editor-core` and diverges from how AI edits (Phase 4) will work.
- **The edit logic is the part most worth testing, and React makes testing it harder.**
  Logic embedded in components needs a DOM runtime to exercise, so the most
  correctness-sensitive code would be the least unit-tested — the same trap ADR 0009 found
  in the desktop main process.

## Decision

Split the renderer into a **pure, framework-agnostic core** and a **thin React shell**, and
route **every** edit through the patch engine.

**Pure core** (`apps/web-editor/src/editor/`, no React import):

- `store.ts` — the only writer of the working timeline. `applyUserPatch` performs
  **validate → apply → record** via `@framepilot/editor-core`: a patch with `error`
  issues is rejected (timeline untouched, issues returned); a valid patch is committed with
  its inverse onto undo/redo. View state (selection / playhead / zoom / markers) lives here
  too but deliberately bypasses the patch engine — it is not part of the document.
- `selectors.ts` — pure projections (duration, `findClip`, `clipsActiveAt`, snapping,
  px↔seconds).
- `patch-builders.ts` — UI intent → typed `Patch` with **deterministic ids** (no clock/RNG;
  replayable, testable). No-op edits return `null` and never enter history.
- `captions.ts` — word grouping, active-word, templates, keyword highlight,
  transcript→`add_caption_layer` patch.
- `project.ts` — `newProject`/`newProjectFromVideo`, schema-validated.
- `bridge.ts` — `window.framepilot` access with a graceful non-Electron fallback; injected
  for tests; schema-validates opened projects.

**Thin shell** (`apps/web-editor/src/components/`): components render store state and
dispatch named intents through `useEditor` (a `useReducer` adapter over the pure store).
They hold no edit logic. `PreviewPlayer` honors render-vs-preview — HTML `<video>` + overlay
text, never MoviePy.

## Consequences

**Positive**

- Manual and AI edits share **one** validated, reversible pipeline; the Phase 4 AI layer
  plugs into the existing `applyUserPatch` rather than a parallel path.
- The pure core is at **100% unit-test coverage** (92 tests) because it is plain functions
  over plain data — the correctness-critical edit path is verified without a DOM.
- The bridge's graceful fallback lets the same renderer run in a plain browser (dev, tests,
  a future web build), and its schema validation keeps an invalid `project.fp.json` out of
  the editor (AGENTS invariant 3).

**Negative / accepted costs**

- True React glue (`main.tsx`, DOM rendering inside components) needs a browser runtime, so
  it is covered by the Playwright harness, not unit tests — the same coverage boundary as
  ADR 0009. We keep components thin to minimize untested glue.
- More indirection than handling edits inline in components; justified by testability and
  invariant enforcement.
- The renderer-side bridge type duplicates the IPC contract shape with no compile-time
  cross-check (drift risk), and the preview uses raw `file://` media without a CSP. Both are
  **LOW** Phase 3 security-review findings, tracked under Phase 8 hardening in
  [`../../plan/PLAN.md`](../../plan/PLAN.md) and noted in
  [editor-ui.md](../architecture/editor-ui.md) §6.

## Alternatives Considered

- **Mutate project state in React handlers, reserve the patch engine for AI:** rejected —
  two divergent edit paths; manual edits would bypass validation/reversibility and violate
  the core invariant (the same rejection ADR 0009 made for the store).
- **Put edit logic in custom hooks instead of a pure store:** rejected — hooks still require
  a React renderer to test, defeating the testability goal; a `useReducer` adapter over a
  pure store gets the React ergonomics while keeping the logic DOM-free.
