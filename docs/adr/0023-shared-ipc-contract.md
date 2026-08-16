# ADR 0023 — Single-source IPC contract in `@framepilot/shared-types`

- **Status:** Accepted
- **Date:** 2026-06-26
- **Phase:** 8 — Production Hardening & Release
- **Relates to:** ADR 0016 (export IPC channel), the Phase 3.1 secure IPC contract
  (`apps/desktop/electron/ipc/contract.ts`), and the renderer bridge
  (`apps/web-editor/src/editor/bridge.ts`)

## Context

The desktop↔renderer IPC surface had its request/response shapes defined **twice**:

- `apps/desktop/electron/ipc/contract.ts` — the canonical contract (channel names +
  data shapes + the `FramePilotBridge` interface), implemented by the preload.
- `apps/web-editor/src/editor/bridge.ts` — a hand-maintained **copy** of those shapes
  (`SidecarStatus`, `RecentProject`, open/save/reveal/export results, the AI request
  and result types, and a `RendererBridge` interface) that the renderer consumed.

The two apps are independent deployables and (by the monorepo rule) never import each
other, so nothing failed to compile when the two definitions drifted. The renderer
copy was a standing **drift risk** — a flagged Phase 8 hardening item. (The dependency
direction is in fact `apps/desktop → apps/web-editor`, so the shared shapes cannot live
in `apps/desktop`: the renderer could not import them.)

## Decision

Hoist the IPC **data shapes** into `@framepilot/shared-types` — a leaf package both
apps already can depend on — as `packages/shared-types/src/ipc.ts`:

- `SidecarPhase`, `SidecarStatus`, `RecentProject`, `ProjectOpenResult`,
  `ProjectSaveResult`, `RevealResult`, `ExportRequest`, `ExportResult`, `AiRequest`,
  `AiTextResult`, `AiEditResult`, and the `FramePilotBridge` interface.

Both apps now build against that one definition:

- **Desktop** (`ipc/contract.ts`) keeps only the channel-name registry (`IpcChannels`
  / `IpcChannel` — a desktop concern) and **re-exports** the shapes from
  `@framepilot/shared-types`. Its five importers (main, preload, `sidecar/manager`,
  `render/export-client`, `recent-files`) and the CJS preload are **unchanged** — they
  still import from `./ipc/contract.js`.
- **Renderer** (`editor/bridge.ts`) imports the shapes from `@framepilot/shared-types`
  and aliases `RendererBridge = FramePilotBridge` (the renderer uses the whole
  surface). The previously duplicated declarations are deleted.

### Why shared-types (not a new package, not an assignability assertion)

- A **shared package** is the only option that respects "apps never import each other"
  _and_ gives a real compile-time guarantee. `shared-types` already exists, is a
  dependency-free leaf, and is described as "types shared across packages **and the
  apps**" — IPC shapes fit. A new `@framepilot/ipc-contract` package would add build
  scaffolding for no extra benefit.
- An **assignability assertion** in the renderer (`const _: RendererBridge = {} as
FramePilotBridge`) would require the renderer to import from `apps/desktop`, which
  violates the layering rule and creates a renderer→desktop dependency.

### Project boundary kept clean

`shared-types/ipc.ts` types `project` as `unknown` (validated against the Zod schema at
each boundary — AGENTS.md invariant 3), so the package needs **no** dependency on
`@framepilot/timeline-schema`. The channel-name registry stays desktop-local because it
is an Electron-process concern, not data the renderer needs to reason about.

## Consequences

- **Drift is now a compile error.** A change to the bridge shape on either side that
  isn't reflected in `shared-types` fails to type-check. The hand-sync comment in
  `bridge.ts` is gone.
- **No behavior, schema, or dependency change.** Pure type relocation; both apps add a
  `workspace:*` dependency on `@framepilot/shared-types` (already transitive).
- **Tests:** `packages/shared-types/src/ipc.test.ts` adds compile-time guards (every
  contract type is constructed; a stub satisfies `FramePilotBridge`). shared-types 6
  tests; desktop 44 and web-editor 333 unchanged and green; both apps typecheck clean.
- The pre-existing `preload.cts` `require()` lint error is unrelated and untouched.
