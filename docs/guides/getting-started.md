# Getting Started

This guide gets the current FramePilot repository running for development. For a longer
product and architecture walkthrough, read [`onboarding.md`](onboarding.md).

## Prerequisites

| Tool               | Supported baseline | Purpose                                                                                                  |
| ------------------ | ------------------ | -------------------------------------------------------------------------------------------------------- |
| Node.js            | 22.15.0 or newer   | Desktop, editor, website, packages, and tooling. The exact repo baseline is in [`.nvmrc`](../../.nvmrc). |
| pnpm               | 9 or newer         | Workspace package manager. The repository declares pnpm 9.12.0.                                          |
| Python             | 3.11 or newer      | Python sidecar, media analysis, project brain, render engine, and CLI.                                   |
| uv                 | Current            | Python workspace, dependency, and command runner.                                                        |
| FFmpeg and ffprobe | Recent             | Source-development media inspection and rendering. Packaged builds stage their own binaries.             |

Check the local toolchain:

```bash
node --version
pnpm --version
python3 --version
uv --version
ffmpeg -version
ffprobe -version
```

Use the Node version declared by the repository:

```bash
nvm use
corepack enable
```

## Install

From the repository root:

```bash
pnpm install
pnpm engine:sync
cp .env.example .env
```

`pnpm engine:sync` runs `uv sync` in `engine/python`. The root Python workspace also points
to that engine package, so direct `uv` commands should be run from the repository root or
from `engine/python` as documented by the command being used.

The example environment selects the deterministic `mock` provider. It requires no network
or API key and is suitable for UI development and automated tests. Configure a live provider
for real model behavior.

## Run the desktop app

```bash
pnpm desktop:dev
```

This is the complete development surface. The Electron host starts the editor and supervises
the Python sidecar, so native project storage, engine analysis, export, durable AI runs,
licensing behavior, and other host-backed capabilities can be tested together.

## Run the browser editor

```bash
pnpm --filter @framepilot/web-editor dev
```

The browser surface is useful for fast UI work. It does not reproduce every Electron host,
filesystem, packaging, license, or sidecar behavior. Features that require the desktop host
must expose a clear unavailable state in browser development.

When running a browser workflow that needs the Python API, start it separately:

```bash
cd engine/python
uv run framepilot serve
```

The default API address is `http://127.0.0.1:8765`. See
[`configuration.md`](configuration.md) for overrides and CORS configuration.

## Run the website

```bash
pnpm website:dev
```

The marketing website has separate build and runtime behavior from the editor. Public
checkout values use `NEXT_PUBLIC_*` variables, while Freemius secrets remain server-only.

## Common commands

### TypeScript and workspace

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:coverage
pnpm test:e2e
pnpm format:check
pnpm license:scan
pnpm verify
```

`pnpm verify` runs:

```text
typecheck -> lint -> TypeScript coverage -> Python lint/typecheck/coverage
-> license scan -> production builds -> functional E2E -> visual E2E
-> 33 rendered professional-operation evals
```

Use `pnpm verify:core` for the shorter typecheck, lint, TypeScript-test, and Python-test loop while
developing. `pnpm verify` is the release gate and expects Playwright Chromium, uv, Python, and
FFmpeg to be installed.

### Python engine

```bash
pnpm engine:sync
pnpm engine:test
pnpm engine:test:cov
pnpm engine:lint
pnpm engine:typecheck
```

Direct CLI examples:

```bash
cd engine/python
uv run framepilot serve
uv run framepilot inspect-media path/to/input.mp4
uv run framepilot render path/to/project.fp.json
uv run framepilot validate-render path/to/output.mp4
uv run framepilot asr-status
```

Use `uv run framepilot --help` for the current CLI surface instead of relying on an old
command list.

## Desktop builds

```bash
pnpm desktop:build
pnpm desktop:dist
```

`desktop:build` compiles the desktop package. `desktop:dist` runs the workspace build,
stages the renderer and Python engine, and invokes Electron Builder. Signing and platform
requirements are covered by [`../runbooks/release.md`](../runbooks/release.md).

## AI provider configuration

Set one provider in `.env` or select it in the desktop Settings interface:

```bash
FRAMEPILOT_AI_PROVIDER=mock
```

Supported provider ids are:

```text
anthropic
nvidia
openrouter
groq
google
ollama
deepseek
mock
```

Provider credentials, models, base URLs, vision behavior, and local-model notes are covered
by [`ai-providers.md`](ai-providers.md).

## Project storage

Desktop projects are local-first. The configured projects root contains the authored project
document, imported media, derived artifacts, recovery state, project intelligence, and
renders. The host and Python sidecar apply path containment before accepting file operations.

Do not commit:

- user media,
- project-derived databases or frame caches,
- `.env` files,
- provider keys,
- signing credentials,
- local build artifacts.

## Repository map

```text
apps/desktop          Electron host and packaging
apps/web-editor       React editor
apps/website          Marketing website
packages/editor-core  Operations, validation, patches, diff, undo, indexes
packages/ai-sdk       Providers, tools, skills, orchestration, context, events
packages/mcp-server   Loopback Streamable HTTP MCP server
packages/timeline-schema
                      Project schema, migrations, catalogs, generated contract
packages/shared-types Cross-package and IPC contracts
packages/ui           Shared UI and design tokens
engine/python         Sidecar, CLI, media analysis, brain, render, validation
.agents               Canonical coding-agent assets
docs                  Living docs, guides, ADRs, API, runbooks, reports
plan/PLAN.md          Detailed implementation record and remaining work
```

## Before changing code

1. Read [`../../AGENTS.md`](../../AGENTS.md).
2. Read the relevant `.agents/rules/` and `.agents/skills/` material.
3. Check [`../reports/STATUS.md`](../reports/STATUS.md) for the current product state.
4. Find the relevant current section in [`../../plan/PLAN.md`](../../plan/PLAN.md).
5. Read the applicable architecture, API, guide, and ADR documents.
6. Verify assumptions against source code and executable configuration.

Continue with [`onboarding.md`](onboarding.md),
[`../architecture/overview.md`](../architecture/overview.md), and
[`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
