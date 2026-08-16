# FramePilot Documentation

FramePilot's documentation is organized by purpose. Use this page to find the right source
instead of treating every Markdown file as an equally current capability statement.

Documentation drift is a bug. A change that alters behavior, contracts, setup, architecture,
security, release mechanics, or user-visible capability must update the relevant living
source in the same pull request.

## Source of truth map

| Question | Canonical source |
| --- | --- |
| What is FramePilot? | [`../README.md`](../README.md) |
| What is implemented now? | [`reports/STATUS.md`](reports/STATUS.md) and the current code |
| What changed for users? | [`../CHANGELOG.md`](../CHANGELOG.md) |
| What work is complete or pending? | [`../plan/PLAN.md`](../plan/PLAN.md) |
| What is the long-term product intent? | [`../PRD.md`](../PRD.md) |
| Why was a technical decision made? | [`adr/`](adr) |
| What contracts must code follow? | [`api/`](api) and the source schemas |
| How do I develop or operate the project? | [`guides/`](guides), [`runbooks/`](runbooks), and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |

The PRD is product intent, not a shipped-feature checklist. The plan is a detailed living
execution record, not an onboarding guide. ADRs preserve decisions at the time they were
made and may be superseded by later ADRs. The status report is the concise current-state
snapshot.

## Start here

### New contributor

1. [`guides/onboarding.md`](guides/onboarding.md)
2. [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
3. [`architecture/overview.md`](architecture/overview.md)
4. [`../AGENTS.md`](../AGENTS.md) and the canonical [`.agents/`](../.agents) tree
5. The relevant contract, guide, ADR, and current plan section for the change

### Product or architecture review

1. [`reports/STATUS.md`](reports/STATUS.md)
2. [`../README.md`](../README.md)
3. [`architecture/overview.md`](architecture/overview.md)
4. [`../CHANGELOG.md`](../CHANGELOG.md)
5. [`../plan/PLAN.md`](../plan/PLAN.md)

### Setup or troubleshooting

1. [`guides/getting-started.md`](guides/getting-started.md)
2. [`guides/configuration.md`](guides/configuration.md)
3. [`guides/ai-providers.md`](guides/ai-providers.md)
4. [`runbooks/render-debugging.md`](runbooks/render-debugging.md)
5. [`runbooks/ci-cd.md`](runbooks/ci-cd.md)

## Architecture

| Document | Scope |
| --- | --- |
| [`architecture/overview.md`](architecture/overview.md) | Current process model, authority boundaries, preview and render split, AI run flow, storage, MCP, and packaging. |
| [`architecture/timeline-and-patch-engine.md`](architecture/timeline-and-patch-engine.md) | Project model, operations, patches, validation, inversion, diff, undo, and migrations. |
| [`architecture/ai-engine.md`](architecture/ai-engine.md) | Providers, context, tools, skills, orchestration, memory, review, and completion. |
| [`architecture/render-engine.md`](architecture/render-engine.md) | Python sidecar, media analysis, compilation, rendering, validation, and preview parity. |
| [`architecture/desktop-shell.md`](architecture/desktop-shell.md) | Electron main process, IPC, project authority, sidecar lifecycle, storage, recovery, and packaging. |
| [`architecture/editor-ui.md`](architecture/editor-ui.md) | React editor structure, timeline, program monitor, inspector, effects, captions, and interaction boundaries. |

## API and contracts

| Document | Scope |
| --- | --- |
| [`api/timeline-schema.md`](api/timeline-schema.md) | Project and timeline schema, versions, and migrations. |
| [`api/patch-format.md`](api/patch-format.md) | Patch envelope, operations, validation, and reversibility. |
| [`api/ai-tools.md`](api/ai-tools.md) | Tool registry, tool categories, mutation contract, and authoring rules. |
| [`api/editor-capabilities.md`](api/editor-capabilities.md) | Discoverable editor commands/properties and their executable contract links. |
| [`api/capability-packs.md`](api/capability-packs.md) | On-demand pack identity, project pins, installation, storage, and worker boundaries. |
| [`api/temporal-evidence.md`](api/temporal-evidence.md) | Typed frame/range/scope/motion/audio evidence and deterministic review. |
| [`api/python-engine-api.md`](api/python-engine-api.md) | FastAPI sidecar endpoints and CLI commands. |
| [`api/mcp-server.md`](api/mcp-server.md) | External MCP surface and session behavior. |

When prose and an executable schema disagree, the executable schema is authoritative and
the prose must be corrected.

## Guides

### Setup and configuration

- [`guides/onboarding.md`](guides/onboarding.md)
- [`guides/getting-started.md`](guides/getting-started.md)
- [`guides/configuration.md`](guides/configuration.md)
- [`guides/settings.md`](guides/settings.md)
- [`guides/ai-providers.md`](guides/ai-providers.md)
- [`guides/agent-harnesses.md`](guides/agent-harnesses.md)

### Editing and AI workflows

- [`guides/ai-sidebar.md`](guides/ai-sidebar.md)
- [`guides/context-and-memory.md`](guides/context-and-memory.md)
- [`guides/transcription.md`](guides/transcription.md)
- [`guides/captions.md`](guides/captions.md)
- [`guides/transitions.md`](guides/transitions.md)
- [`guides/project-brain.md`](guides/project-brain.md)
- [`guides/media-intelligence.md`](guides/media-intelligence.md)

### Engineering workflows

- [`guides/adding-a-timeline-operation.md`](guides/adding-a-timeline-operation.md)
- [`guides/writing-tests.md`](guides/writing-tests.md)
- [`guides/mcp-server.md`](guides/mcp-server.md)
- [`guides/performance-budgets.md`](guides/performance-budgets.md)
- [`guides/ui-system.md`](guides/ui-system.md)
- [`guides/release-checklist-v1.md`](guides/release-checklist-v1.md)

## Architecture decision records

The complete decision history lives in [`adr/`](adr). Read the newest relevant ADR and
follow its supersession notes. Important current boundaries include:

- pnpm and Turborepo monorepo organization.
- Electron as the desktop host.
- MoviePy and FFmpeg as the deterministic export engine.
- Typed timeline and patch engine before AI mutation.
- Canonical `.agents/` repository automation.
- Cross-language schema generation.
- Streamable HTTP MCP transport on loopback.
- Bundled Python engine and production packaging.
- Project Brain and visual search storage.
- Catalog-driven effects and transitions.
- Keyframe and Bezier schema behavior.
- Model vision through export-compiler frame inspection.

ADRs are historical records. Do not silently rewrite an accepted decision to describe a new
architecture. Add or supersede an ADR when the decision changes.

## Runbooks

| Document | Scope |
| --- | --- |
| [`runbooks/render-debugging.md`](runbooks/render-debugging.md) | Failed renders, media inspection, validation, and diagnostics. |
| [`runbooks/security-hardening.md`](runbooks/security-hardening.md) | Sandbox, IPC, secrets, local services, and security review. |
| [`runbooks/ci-cd.md`](runbooks/ci-cd.md) | CI gates, reports, and failure investigation. |
| [`runbooks/release.md`](runbooks/release.md) | Packaging, signing, release artifacts, SemVer, and changelog workflow. |

## Reports

| Document | Scope |
| --- | --- |
| [`reports/STATUS.md`](reports/STATUS.md) | Current implementation, lifecycle, boundaries, and latest recorded verification. |
| [`reports/README.md`](reports/README.md) | Human-written reports in `docs/reports` versus generated artifacts in `/reports`. |

## Documentation maintenance

When changing the repository:

1. Update the closest behavior or contract guide.
2. Update the architecture overview when a process, authority, storage, or execution
   boundary changes.
3. Update `CHANGELOG.md` for user-visible behavior.
4. Update `plan/PLAN.md` for completion state or remaining work.
5. Update `reports/STATUS.md` only for a meaningful current-state change.
6. Add or supersede an ADR for a durable architectural decision.
7. Verify commands and version requirements against executable configuration such as
   `package.json`, `.nvmrc`, `pyproject.toml`, and `.env.example`.
8. Preserve historical records. Correct broken links or factual mistakes, but do not make an
   old ADR or changelog entry pretend it was written with later knowledge.

Use the `docs-maintainer` skill under `.agents/skills/` when an agent performs the update.
