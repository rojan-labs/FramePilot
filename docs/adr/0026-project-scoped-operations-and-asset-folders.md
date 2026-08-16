# ADR 0026 — Project-scoped operations & media-bin asset folders

- **Status:** Accepted
- **Date:** 2026-06-26
- **Phase:** 8 — Production Hardening & Release
- **Relates to:** ADR 0001 (reversible operations), the patch engine
  (`packages/editor-core`), the timeline schema (`packages/timeline-schema`, ADR 0024
  schema v2), the AI tool registry (`packages/ai-sdk`, ADR 0012), the MCP server
  (ADR 0015), and the pro editor layout (ADR 0013)

## Context

Two needs landed together:

1. **Asset folders.** Users (and the AI) need to organize the media bin into nested,
   Finder/Explorer-style folders.
2. **AI-driven asset management.** An MCP/agent flow like _"manage my assets and edit
   the video"_ must (a) add assets that an AI model generated (`add_asset`), (b) fold
   them into folders (`manage_assets`), and (c) place clips + edit the timeline — in
   one reviewable, reversible run.

The blocker was structural. FramePilot's entire reversible-patch engine — the
`Operation` union, `applyPatch`/`invertPatch`, `validatePatch`, history, and diff — was
**timeline-scoped**. Assets and folders live on `Project`, _outside_ the timeline.
Asset add/remove were plain, **non-undoable** `Project` mutations
(`apps/web-editor/src/editor/project.ts`), not patches. So foldering, `add_asset`, and
`manage_assets` could not be expressed as `Operation`s, and could not flow through the
one pipeline that enforces AGENTS.md invariant 5 (every edit is a validated, reversible
patch — the model never mutates project JSON directly).

## Decision

**Generalize the patch engine to project scope, additively, without disturbing the
timeline path.**

1. **Schema v3 (migration required).** `Project` gains a `folders` tree
   (`Folder = { id, name, parentId }`, nested via `parentId`); `Asset` gains an
   optional `folderId`. Both are purely additive — a v2 project has no folders and its
   assets sit at the bin root, which is the default shape — so the v2→v3 migration only
   stamps the envelope version. Mirrored in the Python Pydantic models and the
   cross-language `project.schema.json`.

2. **Project operations.** A new `ProjectOperation` union in
   `packages/editor-core/src/project-operations.ts` (`add_asset`, `remove_asset`,
   `move_asset`, `create_folder`, `rename_folder`, `move_folder`, `delete_folder`),
   each a pure, reversible transform mirroring the timeline-op design: simple ops keep a
   readable same-shape inverse (`move_*`, `rename_folder`, `add_asset`→`remove_asset`);
   lossy/multi-axis ops invert to a lossless snapshot-restore primitive
   (`restore_assets`/`restore_folders`), exactly as timeline ops fall back to
   `restore_clips`.

3. **Unified patch, dual scope.** `Patch.operations` widens to `(Operation |
ProjectOperation)[]`. `applyProjectPatch`/`invertProjectPatch` route timeline ops
   through the existing (untouched) `applyOperation` and project ops through
   `applyProjectOperation`, so a single patch can fold the bin _and_ edit the timeline
   atomically. `commitProjectPatch`/`undoProject`/`redoProject` reuse the same history
   stack. The original `applyPatch(timeline, …)` stays for timeline-only callers and
   now rejects project ops with a clear error.

4. **Validation.** `validatePatch` gains a `folders` context and checks project ops:
   duplicate asset/folder ids, missing references, **folder cycles** (walking the
   `parentId` chain), and `asset_in_use` (a `remove_asset` is rejected while timeline
   clips still reference it). Working state advances across a patch, so create-then-use
   within one patch validates.

5. **Tools.** `add_asset` and `manage_assets` are registered mutating tools (TS + Python
   mirror) built by a `projectMutateTool` factory. `manage_assets` takes an explicit
   semantic plan (folders + assignments) **or** `strategy: "by-kind"` for a
   deterministic Video/Audio/Images grouping. Because they are ordinary registry tools,
   they auto-appear over MCP and in agent mode with no extra wiring.

6. **Agent loop.** The orchestrator applies each agent turn at **project scope**, so one
   run interleaves `manage_assets` → `add_asset` → `add_clip` → edits, satisfying the
   "manage my assets and edit the video" flow as a single reviewable patch.

7. **Web editor.** The store owns the bin (`assets`/`folders`) and applies project-scoped
   patches, making foldering/import/removal **undoable** like every other edit. The
   media bin renders a nested folder tree with create/rename/delete, drag-to-fold, an
   empty-folder state, and OS-like motion (gated by `prefers-reduced-motion`). Folder
   naming uses an **inline text field**, not `window.prompt` — Electron's renderer does
   not implement `prompt()` (it silently returns `null`), so the prompt path never fired
   in the desktop app. Import works from both the file picker and **OS file
   drag-and-drop** (dropping onto the bin, or onto a folder to import directly into it);
   both paths emit the same undoable `add_asset` patch.

8. **Security.** `add_asset`'s media `path` is untrusted over MCP, so the editing
   session resolves it through the projects sandbox (`resolveWithin`) before it is ever
   persisted, rejecting any path that escapes containment.

## Consequences

- Foldering and AI asset management are first-class, reversible, validated edits — no
  second, unchecked mutation path. The "every edit is a reversible patch" invariant now
  covers the bin, not just the timeline.
- A schema migration + cross-language mirror is the cost; guarded by the JSON-Schema
  drift test and the Pydantic parity test.
- The timeline engine is untouched (its 100% coverage stays a safety net); project-scope
  is a thin, additive layer over it.
- Foldering is organizational only: moving an asset between folders never alters the
  timeline or a render.
