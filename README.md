<div align="center">

# FramePilot

### Cursor for professional video editing

**Chat with your timeline. Review concrete edits. Let agents work through your footage.
Export through a deterministic, validated render pipeline.**

[![CI](https://github.com/rjach/FramePilot/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![License: Non-Commercial](https://img.shields.io/badge/license-non--commercial-blue.svg)](./LICENSE)
[![Status: Pre-release](https://img.shields.io/badge/status-pre--release-e5670a.svg)](./docs/reports/STATUS.md)

</div>

## What FramePilot is

FramePilot is a local-first desktop video editor with an AI agent built into the editing
workflow. Manual edits and AI edits use the same typed timeline operations, validation,
diff, undo, preview, and export systems.

The project has moved well beyond its original scaffold. The current pre-release editor
includes a functional multitrack timeline, an Electron desktop shell, a deterministic
Python render engine, an agentic AI sidebar, media analysis, captions, transitions,
effects, keyframes, project memory, and packaged desktop builds.

FramePilot is designed first for SaaS demos, screen recordings, product videos,
talking-head content, and short-form edits. It is not presented as a complete replacement
for Premiere Pro, After Effects, or DaVinci Resolve.

## Product principles

| Principle                       | Meaning                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| **Non-destructive**             | Imported originals remain untouched. Edits live in the project timeline.              |
| **Reviewable**                  | AI changes are expressed as concrete operations with reasons, diffs, and undo.        |
| **Deterministic**               | The model proposes work. Typed code validates and executes it.                        |
| **Preview and export parity**   | Visual behavior is implemented for interactive preview and deterministic export.      |
| **Honest capability reporting** | Missing engines, models, keys, analysis, or visual verification are reported plainly. |
| **Human authority**             | The editor owns the project. Agent work remains inspectable and reversible.           |

## What works today

### Editing and preview

- Multitrack video, audio, caption, overlay, and effect lanes.
- Trim, split, move, ripple operations, snapping, markers, zoom, selection, and undo/redo.
- Adaptive preview playback using bounded proxies and WebCodecs where appropriate, with
  streaming media fallback for feature-length originals.
- Timeline virtualization and indexed lookups for large projects and caption-heavy edits.
- Inspector controls for transform properties, keyframes, easing, effect parameters, and
  transition settings.

### AI editing

- Chat, plan, edit, and agent workflows through one streaming AI sidebar.
- Registered tools for timeline editing, media analysis, transcription, captions, effects,
  transitions, project search, and visual inspection.
- Skill-guided orchestration with bounded tool execution, durable runs, cancellation,
  reviewable proposals, and explicit completion checks.
- Vision-capable runs can use `get_frame` to inspect a composited frame rendered through
  the export compiler before claiming a visual result.
- Provider support for Anthropic, NVIDIA, OpenRouter, Groq, Google Gemini, Ollama,
  DeepSeek, and a deterministic mock provider.

### Media intelligence and memory

- Local media inspection, proxy generation, waveform extraction, scene and beat analysis,
  transcription, and frame extraction.
- A per-project brain backed by SQLite for derived analysis, searchable evidence, and
  provenance-aware memory.
- Visual search with hosted embeddings when configured, plus honest fallback paths when
  optional capabilities are unavailable.
- Project-scoped memory and an optional cross-project working-style memory.

### Captions, motion, effects, and transitions

- Local and hosted transcription paths with word-level timing support.
- Editable caption cues, splitting, merging, style templates, automatic emphasis, and
  export burn-in.
- First-class effect layers with a catalog-driven library and matched preview/render
  implementations.
- A catalog-driven transition system with alignment and editable parameters.
- Position, scale, rotation, and opacity keyframes with multiple easing modes and real
  cubic Bezier handles.

### Export and desktop delivery

- FastAPI and CLI render engine built on MoviePy and FFmpeg.
- Asynchronous export, render validation, preview renders, media probing, and frame grabs.
- Electron packaging with a bundled PyInstaller engine and staged media binaries.
- Loopback Streamable HTTP MCP server for external agent clients.

See [the current status report](./docs/reports/STATUS.md) for boundaries and the latest
recorded verification snapshot.

## Architecture

```text
Electron desktop host
  | secure IPC, project authority, durable AI runs, sidecar lifecycle
  v
React editor
  | timeline, inspector, preview compositor, captions, effects, AI sidebar
  v
Shared deterministic core
  | timeline schema, operations, validation, patches, diffs, undo, tool registry
  v
Python sidecar
  | media analysis, project brain, frame extraction, MoviePy/FFmpeg export, validation
  v
Local project storage
  | project.fp.json, imported media, derived artifacts, brain.sqlite, renders
```

The realtime preview and final export use different execution engines but share the same
project model and effect contracts. The editor uses browser media APIs, WebCodecs, canvas,
and WebGL for responsive interaction. The Python engine compiles the project into a final
render and validates the result.

Read [the architecture overview](./docs/architecture/overview.md) for the process model,
data flows, storage boundaries, preview strategy, AI authority, and packaging model.

## Repository layout

```text
apps/
  desktop/          Electron host, preload bridge, packaging, license and run authority
  web-editor/       React and TypeScript editor surface
  website/          FramePilot marketing website
packages/
  timeline-schema/  Zod source of truth for the project document
  editor-core/      Typed operations, validation, patching, diff, undo, and timeline indexes
  ai-sdk/           Providers, orchestration, skills, tools, context, and usage reporting
  mcp-server/       Streamable HTTP MCP surface
  shared-types/     Cross-package contracts and IPC types
  ui/               Shared UI primitives and tokens
engine/python/      FastAPI, CLI, render engine, analysis, project brain, and validation
tests/e2e/          Playwright end-to-end coverage
.agents/            Canonical coding-agent rules, skills, commands, and subagents
docs/               Architecture, contracts, guides, ADRs, runbooks, and status
plan/PLAN.md        Living implementation plan and detailed completion record
```

## Quick start

### Prerequisites

- Node.js **22.15.0 or newer**, matching [`.nvmrc`](./.nvmrc).
- pnpm **9 or newer** through Corepack.
- Python **3.11 or newer**.
- [`uv`](https://docs.astral.sh/uv/) for the Python workspace.
- FFmpeg and ffprobe available during source development. Packaged builds stage their own
  media binaries.

### Install

```bash
git clone <repository-url> framepilot
cd framepilot

corepack enable
pnpm install
pnpm engine:sync
cp .env.example .env
```

The default mock provider supports deterministic offline development. Configure a real
provider in `.env` or in the desktop Settings interface when testing live AI behavior.

### Run

```bash
pnpm desktop:dev                          # full desktop development experience
pnpm --filter @framepilot/web-editor dev # browser editor development
pnpm website:dev                          # marketing website

cd engine/python
uv run framepilot serve                   # Python sidecar only
```

### Validate changes

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm engine:test
pnpm test:e2e
pnpm license:scan
pnpm verify
```

`pnpm verify:core` runs the main typecheck, lint, TypeScript test, and Python test loop. Run
`pnpm verify` before release to include coverage, E2E, production builds, licenses, and rendered
professional-operation proof. Run additional platform packaging gates when the affected surface
requires them.

### Package the desktop app

```bash
pnpm desktop:build
pnpm desktop:dist
```

Packaging and signing requirements are documented in
[`docs/runbooks/release.md`](./docs/runbooks/release.md).

## AI providers

Set `FRAMEPILOT_AI_PROVIDER` or choose a provider in **Settings > AI > Providers**.

| Provider id  | Typical configuration                                |
| ------------ | ---------------------------------------------------- |
| `anthropic`  | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`               |
| `nvidia`     | `NVIDIA_API_KEY`, `NVIDIA_MODEL`                     |
| `openrouter` | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`             |
| `groq`       | `GROQ_API_KEY`, `GROQ_MODEL`                         |
| `google`     | `GOOGLE_API_KEY`, `GOOGLE_MODEL`                     |
| `ollama`     | `OLLAMA_BASE_URL`, `OLLAMA_MODEL`                    |
| `deepseek`   | `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`                 |
| `mock`       | No key. Deterministic development and test provider. |

A provider changes model transport, not editing authority. Models receive only the tools
allowed for that run. Tool inputs are validated, mutations become patches, and the host
retains project authority.

Read [`docs/guides/ai-providers.md`](./docs/guides/ai-providers.md) and
[`.env.example`](./.env.example) for detailed configuration.

## Documentation

Start with [`docs/README.md`](./docs/README.md), which maps each document to its role.

- Current implementation status: [`docs/reports/STATUS.md`](./docs/reports/STATUS.md)
- Living execution record: [`plan/PLAN.md`](./plan/PLAN.md)
- User-facing change history: [`CHANGELOG.md`](./CHANGELOG.md)
- Product intent: [`PRD.md`](./PRD.md)
- Architecture: [`docs/architecture/`](./docs/architecture)
- Developer guides: [`docs/guides/`](./docs/guides)
- API and contracts: [`docs/api/`](./docs/api)
- Architecture decisions: [`docs/adr/`](./docs/adr)
- Operations and releases: [`docs/runbooks/`](./docs/runbooks)
- Contribution workflow: [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## Working with coding agents

The canonical repository instructions live in [`AGENTS.md`](./AGENTS.md),
[`CLAUDE.md`](./CLAUDE.md), and [`.agents/`](./.agents). The `.claude`, `.codex`,
`.cursor`, and `.opencode` directories are harness adapters. Agents must inspect the
current implementation, preserve repository invariants, update relevant living docs, and
avoid claiming verification that was not run.

## Project state

FramePilot is an actively developed pre-release product. The repository version remains
`0.0.0`, interfaces can still evolve, and advanced editing surfaces continue to be built
and hardened. Use the status report and master plan instead of the original phase roadmap
when deciding what is shipped.

## License

FramePilot is **source-available, non-commercial software**. You may view, clone, run,
modify, and contribute to this repository for personal, educational, or other
non-commercial purposes at no charge. Commercial use of any kind — including internal
business use, resale, hosting as a service, or incorporation into another commercial
product — requires a separate written license from the copyright holder. See
[LICENSE](./LICENSE) for the complete terms.

Third-party dependencies, models, fonts, media, and other materials remain subject to their
own licenses.
