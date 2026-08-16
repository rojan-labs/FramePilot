# Onboarding: from clone to first validated export

This guide introduces the current FramePilot system, gets the desktop app running, and
walks through the editing and export model. For command-only setup, use
[`getting-started.md`](getting-started.md).

## 1. Understand the product state

FramePilot is a functional pre-release editor, not the original Phase 0 scaffold. It already
contains manual timeline editing, an AI sidebar and agent mode, media analysis, captions,
effects, transitions, keyframes, a Python export engine, project intelligence, and packaged
desktop builds.

It is still under active development. Read [`../reports/STATUS.md`](../reports/STATUS.md)
before assuming a feature is stable or complete. Use [`../../plan/PLAN.md`](../../plan/PLAN.md)
for detailed remaining work.

## 2. Install the toolchain

Required baselines:

- Node.js 22.15.0 or newer, matching [`.nvmrc`](../../.nvmrc).
- pnpm 9 or newer through Corepack.
- Python 3.11 or newer.
- `uv` for Python dependency and command management.
- FFmpeg and ffprobe for source-development media work.

```bash
nvm use
corepack enable
pnpm install
pnpm engine:sync
cp .env.example .env
```

The default mock provider supports deterministic offline work. A live provider can be
selected later in `.env` or **Settings > AI > Providers**.

## 3. Learn the repository shape

```text
apps/desktop          Native host, project authority, IPC, sidecar, packaging, licensing
apps/web-editor       Timeline, preview, inspector, captions, effects, AI sidebar
apps/website          Marketing site and checkout
packages/editor-core  Typed edits, patches, validation, diff, undo, indexes
packages/timeline-schema
                      Canonical project schema, migrations, catalogs
packages/ai-sdk       Providers, tools, skills, context, orchestration, verification
packages/mcp-server   External MCP access over loopback Streamable HTTP
packages/shared-types Shared contracts, IPC types, safety and logging helpers
packages/ui           Shared components and tokens
engine/python         Media analysis, transcription, brain, render, validation, CLI
.agents               Canonical coding-agent rules, skills, commands, and subagents
docs                  Architecture, contracts, guides, ADRs, runbooks, and status
plan/PLAN.md          Detailed implementation history and remaining work
```

The TypeScript core and Python sidecar are separate for a reason. The editor needs responsive
interactive media playback. Final export needs deterministic compilation and validation.
Both systems interpret the same project and catalog contracts.

## 4. Run the full desktop experience

```bash
pnpm desktop:dev
```

The desktop command builds shared packages, starts the editor development server, launches
Electron, and supervises the Python sidecar. This is the correct surface for testing:

- project creation and persistence,
- native file import,
- derived media analysis,
- durable AI runs,
- host-authoritative agent commits,
- export and render validation,
- packaging and license-related behavior.

For browser-only UI work:

```bash
pnpm --filter @framepilot/web-editor dev
```

The browser surface must degrade honestly when the Electron host or Python engine is absent.

## 5. The core editing model

### Every mutation is a typed operation

A trim, split, caption change, transition, effect, marker, or keyframe update becomes a typed
operation in `packages/editor-core`. Operations are validated and applied immutably. Their
inverse is recorded so undo and redo remain deterministic.

```text
intent -> operation -> validate -> apply -> record inverse -> preview -> persist
```

The UI must not mutate `project.fp.json` directly.

### AI uses the same path

The model does not receive arbitrary write access. The orchestrator exposes a bounded set of
registered tools. Tool inputs are schema-validated, mutation tools return typed operations,
and the host applies the resulting patch through the same core used by manual editing.

```text
request
  -> context and available skills
  -> provider response
  -> validated tool calls
  -> proposed patch
  -> timeline diff
  -> host-authoritative apply
  -> preview or frame inspection
  -> completion verification
```

A model can describe an edit incorrectly. Typed validation and host authority prevent that
description from becoming an unvalidated project mutation.

### Preview and export are separate engines

The program monitor uses browser media APIs, WebCodecs when suitable, streaming media,
canvas, WebGL, and indexed timeline state for responsiveness.

The Python engine uses MoviePy and FFmpeg for preview renders and final export. Shared
catalogs and parity tests keep timing, effects, transitions, captions, and keyframes aligned.

### Visual completion requires visual evidence

Supported vision-capable models can call `get_frame` to inspect a frame rendered from the
current working edit through the export compiler. Text-only models must state that a result
was not visually reviewed rather than pretending to see it.

## 6. Create and edit a project

1. Start `pnpm desktop:dev`.
2. Create a project or open an existing `.fp.json` project.
3. Import media through the Media panel.
4. Allow the engine to probe the file and create available derived artifacts such as proxy,
   waveform, thumbnails, transcript, scenes, or beat analysis.
5. Add media to the timeline.
6. Use manual controls to trim, split, move, add effects, apply transitions, style captions,
   or animate transforms.
7. Open the AI sidebar for a plan, a focused edit, or a multi-step agent workflow.
8. Review proposed work, activity steps, warnings, usage, and timeline changes.
9. Apply only the work you want. Use undo to verify reversibility.

Derived analysis can be unavailable while an edit remains usable. The UI should explain
what is missing and how that affects the requested workflow.

## 7. Export and validate

Open the Export surface in the desktop app, select the target settings, and start the render.
The host submits a job to the Python engine. The engine compiles the current project,
renders the output, and runs validation before the UI reports success.

CLI example:

```bash
cd engine/python
uv run framepilot render path/to/project.fp.json
uv run framepilot validate-render path/to/output.mp4
```

A valid source project still needs accessible media paths. Imported originals remain
untouched. Renders and derived files are written to project-managed locations.

## 8. Run validation as a contributor

Use the smallest relevant checks during development, then run the full applicable gate.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm engine:test
pnpm test:e2e
pnpm test:coverage
pnpm engine:test:cov
pnpm license:scan
pnpm verify
```

`pnpm verify` does not include every specialized gate. A preview or editor change may need
Playwright. A schema change needs TypeScript and Python parity. A render change needs engine
fixtures and validation. A packaging change needs a distributable build. A dependency change
needs the license scan.

Never report a check as passed unless it was run on the final branch state.

## 9. Read before implementing

- Current state: [`../reports/STATUS.md`](../reports/STATUS.md)
- Architecture: [`../architecture/overview.md`](../architecture/overview.md)
- Editing contracts: [`../architecture/timeline-and-patch-engine.md`](../architecture/timeline-and-patch-engine.md)
- AI contracts: [`../architecture/ai-engine.md`](../architecture/ai-engine.md)
- Render contracts: [`../architecture/render-engine.md`](../architecture/render-engine.md)
- Tool surface: [`../api/ai-tools.md`](../api/ai-tools.md)
- Provider setup: [`ai-providers.md`](ai-providers.md)
- Agent repository rules: [`../../AGENTS.md`](../../AGENTS.md), [`../../CLAUDE.md`](../../CLAUDE.md), and [`.agents/`](../../.agents)
- Contribution workflow: [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md)

## 10. A useful first contribution

Choose a contained issue or plan item with a clear behavior boundary. Trace the complete
path before editing:

```text
schema or catalog
  -> deterministic core
  -> UI or AI tool
  -> preview
  -> Python export if visual
  -> tests
  -> docs and changelog
```

A small end-to-end change that preserves the system's invariants is more valuable than a
large surface implementation with disconnected preview, export, undo, AI, or documentation.
