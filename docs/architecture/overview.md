# Architecture Overview

FramePilot is a local-first desktop video editor with an AI agent operating through the
same deterministic editing contracts as the manual UI. The system is designed around one
central rule: models may reason, inspect, and propose, while typed code owns project state,
validation, execution, persistence, and rendering.

For the current implementation snapshot, read [`../reports/STATUS.md`](../reports/STATUS.md).
For detailed completion history and remaining work, read
[`../../plan/PLAN.md`](../../plan/PLAN.md).

## Architectural invariants

1. **Original media is immutable.** Edits modify the project document and derived artifacts,
   not imported originals.
2. **Every project mutation is typed.** Manual and AI workflows use registered timeline
   operations and validated patches.
3. **Project authority belongs to the host.** The Electron main process and editor core own
   authoritative state. Renderers and models do not write project files directly.
4. **Every accepted mutation is reversible.** Operations carry or derive an inverse before
   they enter durable history.
5. **Preview and export share contracts.** They may use different execution engines, but they
   interpret the same timeline, timing, effects, transitions, captions, and keyframes.
6. **Unavailable capability is explicit.** Missing binaries, credentials, models, indexes,
   visual support, or cloud services return a visible unavailable state.
7. **AI completion requires evidence.** A run must distinguish analysis, proposed work,
   applied work, visual review, and verified completion.

## Runtime topology

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Electron main process                                                       │
│ project authority, secure IPC, autosave, recovery, licensing, durable runs, │
│ sidecar lifecycle, native dialogs, packaging, updater and release surfaces  │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ preload contract and request-scoped events
                                v
┌──────────────────────────────────────────────────────────────────────────────┐
│ React editor renderer                                                       │
│ media bin, timeline, inspector, program monitor, captions, effects,         │
│ transitions, export UI, settings, AI sidebar and proposal review            │
└───────────────┬───────────────────────────────────────┬──────────────────────┘
                │ deterministic TypeScript contracts    │ loopback HTTP
                v                                        v
┌──────────────────────────────────────┐   ┌───────────────────────────────────┐
│ Shared TypeScript core               │   │ Python sidecar                    │
│ timeline schema, operations, patch   │   │ media probe, proxy, waveform,    │
│ validation, diff, undo, indexes, AI  │   │ ASR, scenes, beats, frames,      │
│ providers, tools, skills and context │   │ brain, render, validation and CLI│
└──────────────────────────────────────┘   └──────────────────┬────────────────┘
                                                             │
                                                             v
                                           ┌───────────────────────────────────┐
                                           │ Local project storage             │
                                           │ project document, imported media, │
                                           │ derived artifacts, brain, renders │
                                           └───────────────────────────────────┘
```

The MCP server is a separate TypeScript process that exposes the canonical tool registry
over loopback Streamable HTTP. It follows the same session, validation, patch, and save
contracts as the desktop orchestrator.

## Code ownership by layer

| Layer | Location | Responsibility |
| --- | --- | --- |
| Desktop host | `apps/desktop` | Native process authority, IPC, project commands, persistence, AI run coordination, sidecar lifecycle, packaging, and licensing. |
| Editor surface | `apps/web-editor` | Interactive editing UI, preview, timeline gestures, inspector, review, and desktop/browser adaptation. |
| Project schema | `packages/timeline-schema` | Zod source of truth, migrations, generated JSON Schema, catalogs, and timeline types. |
| Editing core | `packages/editor-core` | Operations, validation, apply/invert, patches, diffs, undo, indexes, selection-independent editing logic. |
| AI system | `packages/ai-sdk` | Providers, request normalization, context, orchestration, skills, tools, budgets, usage, verification, and event stream. |
| Shared contracts | `packages/shared-types` | Cross-package types, IPC shapes, safety helpers, logging, and host/renderer contracts. |
| MCP | `packages/mcp-server` | External agent sessions and Streamable HTTP tool access. |
| UI system | `packages/ui` | Shared components, icons, tokens, and interaction primitives. |
| Media and render engine | `engine/python` | FastAPI, CLI, media analysis, project brain, frame generation, compilation, MoviePy/FFmpeg export, and validation. |
| Marketing website | `apps/website` | Public product site, pricing, checkout, and generated marketing assets. |

## Project authority and persistence

The renderer holds the responsive in-memory editing view. The Electron host remains the
persistence and cross-process authority for desktop workflows.

A normal project update follows this path:

```text
user gesture
  -> pure operation or patch builder
  -> validate against the current project
  -> apply immutably
  -> record inverse in editor history
  -> update preview
  -> reconcile and autosave through the host
```

Host-side AI commits use revision checks and project command services. The host merges the
latest live editor project with host-owned state instead of allowing a stale renderer or a
long AI run to overwrite newer work.

Project JSON is saved atomically. Editor history is bounded for durable storage while the
current session can retain a richer in-memory undo stack. Recovery and active-project
pointers are stored separately from the project document.

## Timeline, patches, and schema

`packages/timeline-schema` defines the canonical project shape. The Python engine mirrors the
contract and rejects unsupported future schema versions rather than guessing.

`packages/editor-core` owns:

- operation definitions and validation,
- immutable application and inversion,
- patch envelopes and transaction semantics,
- timeline diffs and action descriptions,
- undo and redo history,
- temporal and boundary indexes,
- transition eligibility,
- keyframe evaluation,
- deterministic helpers shared by UI and AI tools.

Schema changes require a migration, generated contract updates, TypeScript and Python
parity, fixtures, tests, and documentation.

## Preview architecture

MoviePy is not the realtime preview engine.

The editor preview uses browser-native media capabilities and a compositing layer:

- bounded proxy media can use the WebCodecs path,
- feature-length or unproxied originals use Chromium's streaming media path,
- temporal indexes resolve active clips, captions, effects, and transitions near the
  playhead,
- canvas and WebGL render overlays, captions, transforms, effects, and transitions,
- audio monitoring is controlled independently from authored project audio,
- paused views avoid unnecessary display-refresh work.

This adaptive strategy prevents whole-file decode and whole-timeline scans from becoming the
cost of every frame.

Preview behavior must match final export semantics. Shared catalogs, parameter clamping,
timing rules, deterministic noise, keyframe math, and cross-language parity fixtures protect
that contract.

## Render and media engine

The Python sidecar provides engine-backed capabilities through FastAPI and a CLI. Its work
includes:

- media inspection and safe path resolution,
- proxy, waveform, thumbnail, and frame generation,
- local and hosted transcription,
- scene, silence, beat, and other media analysis,
- project brain and visual-search storage,
- timeline compilation,
- effect, transition, caption, text, audio, mask, and tracking passes,
- preview renders, frame grabs, and final exports,
- render validation and structured diagnostics.

Final export is deterministic with respect to the project, media, engine version, and
configured render inputs. The model never emits render code or directly controls MoviePy.

## AI run architecture

The AI sidebar and desktop host use a request-scoped event stream. A run is durable and can
survive renderer remounts or temporary UI detachment.

```text
request
  -> active provider and model
  -> bounded project and memory context
  -> tool and skill availability
  -> analysis and planning
  -> schema-validated tool calls
  -> proposed typed operations
  -> patch validation and diff
  -> host-authoritative commit
  -> preview or frame inspection
  -> verification and completion report
```

Read and analysis tools may execute concurrently when marked safe. Mutation, action, and
human-question tools remain serial. Results are folded back in original order so concurrency
changes latency, not observable semantics.

The orchestrator uses bounded context rather than repeatedly sending every tool result and
the full project. Durable logs, expandable details, streamed output, undo history, and model
projections are capped to prevent long projects or long runs from growing without limit.

## Model vision

Visual ability is a property of the active model configuration, not a claim made by the tool
registry.

For supported vision-capable runs, `get_frame`:

1. accepts a timeline time,
2. renders one composited frame from the current inline working project through the export
   compiler,
3. attaches the image to the next provider request using that provider's native image shape,
4. removes the transient image after it has been shown.

Text-only models do not receive visual tools that would encourage fabricated sight. The UI
and completion report must say when a visual result was not inspected.

## Project Brain and memory

Derived understanding lives outside `project.fp.json` so it can be rebuilt without changing
the authored edit.

The project brain stores analysis, transcript evidence, visual spans, embeddings, field
provenance, and session memory in a per-project SQLite database under derived storage.
Optional `sqlite-vec` indexing accelerates vector search. A brute-force path preserves
correctness when the native extension is unavailable.

Cloud visual embeddings and hosted media understanding are optional. Configuring their
credentials is an explicit boundary where selected media data can leave the device.

Cross-project working-style memory is stored separately from project memory and is promoted
carefully from repeated evidence across distinct projects.

## Desktop packaging

Development builds run the Python engine from source through `uv`. Packaged builds stage a
self-contained PyInstaller engine under the application's resources and launch that binary.
FFmpeg and ffprobe resolution is injected into the packaged sidecar environment. Signing,
release artifacts, and per-platform packaging are handled by the desktop build and release
workflows.

The packaged app does not rely on a user's Python environment or `uv` for normal runtime.

## Security boundaries

- Renderer access is limited through the preload contract.
- File-accepting IPC and sidecar routes resolve paths inside the configured projects root.
- Local media uses a sandboxed custom protocol instead of exposing arbitrary `file://` paths.
- The renderer has a restrictive Content Security Policy.
- Secrets remain in host or local configuration surfaces and are not sent to the renderer as
  general project context.
- Tool availability is capability-gated.
- Model output is untrusted until schema validation and host authorization succeed.
- Local HTTP services bind to loopback by default.

Read [`../runbooks/security-hardening.md`](../runbooks/security-hardening.md) for the
operational checklist and relevant ADRs for decision history.

## Documentation boundaries

- [`../reports/STATUS.md`](../reports/STATUS.md) states what exists now.
- [`../../plan/PLAN.md`](../../plan/PLAN.md) records detailed implementation progress and
  remaining work.
- [`../../CHANGELOG.md`](../../CHANGELOG.md) describes user-visible changes.
- [`../../PRD.md`](../../PRD.md) describes long-term product intent.
- [`../adr/`](../adr) preserves architectural decisions and supersession history.
