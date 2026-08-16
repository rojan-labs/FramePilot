# Contributing to FramePilot

FramePilot uses the following engineering workflow for owner-maintained changes and community
contributions.

## Contribution status

FramePilot is **source-available, non-commercial software**, not an OSI-approved open-source
project. Issues, product feedback, private security reports, and code or documentation pull
requests are all welcome. By submitting a pull request you license your contribution under the
same terms as [`LICENSE`](./LICENSE) ("inbound = outbound") — no separate Contributor License
Agreement is required. The repository owner retains full discretion over whether to accept any
contribution.

Running, modifying, and contributing to this repository is free for non-commercial purposes.
Commercial use of any kind — including internal business use, resale, hosting as a service, or
incorporation into another commercial product — is not permitted under this license and requires
a separate written agreement with the copyright holder. See [`LICENSE`](./LICENSE) for the
complete terms.

## Before starting an invited change

1. Confirm that the repository owner has invited the contribution and that contribution terms are
   agreed before submitting code.
2. Read [`AGENTS.md`](./AGENTS.md) for repository-wide invariants.
3. Read the relevant rules and skills under [`.agents/`](./.agents). That directory is the
   canonical source for agent instructions. `.claude`, `.codex`, `.cursor`, and `.opencode`
   are adapters.
4. Read [`docs/reports/STATUS.md`](./docs/reports/STATUS.md) for the current product state.
5. Locate the relevant current work in [`plan/PLAN.md`](./plan/PLAN.md).
6. Read the applicable architecture, API, guide, ADR, and test documentation.
7. Inspect the implementation before assuming that a plan or old document still describes
   the code.

Do not mark a plan item in progress unless you are actively maintaining that plan state for
the change.

## Setup

The repository baseline is Node.js 22.15.0, pnpm 9 or newer, Python 3.11 or newer, `uv`,
FFmpeg, and ffprobe.

```bash
nvm use
corepack enable
pnpm install
pnpm engine:sync
cp .env.example .env
```

The mock provider supports offline development. Real-provider testing requires the relevant
credentials and a model that supports the workflow being tested.

Read [`docs/guides/getting-started.md`](./docs/guides/getting-started.md) for the complete
command and environment reference.

## Development commands

```bash
pnpm desktop:dev
pnpm --filter @framepilot/web-editor dev
pnpm website:dev

pnpm typecheck
pnpm lint
pnpm test
pnpm engine:test
pnpm test:e2e
pnpm test:coverage
pnpm engine:test:cov
pnpm format:check
pnpm license:scan
pnpm verify
```

`pnpm verify` runs typecheck, lint, TypeScript tests, and Python tests. It does not include
E2E, coverage, packaging, render fixtures, or the license scan. Run every specialized gate
required by the affected surface.

## Engineering rules

### Preserve project authority

- The UI and model must not write `project.fp.json` directly.
- Manual and AI edits use typed operations and validated patches.
- Host-side commits use current project revisions and authoritative project services.
- Original media remains immutable.

### Preserve reversibility

- Every project mutation must have a correct inverse or a validated snapshot-based restore.
- A multi-step gesture should become one meaningful undo unit.
- No-op work should not create misleading history.

### Preserve preview and export parity

A visual feature is incomplete when only the program monitor or only the Python render path
implements it. Shared catalogs, timing rules, clamping, keyframe evaluation, deterministic
seeds, and cross-language fixtures should be used where possible.

### Preserve honest degradation

Missing models, keys, analysis, native extensions, media, host services, or binaries must
produce an explicit unavailable or partial state. Do not fabricate a transcript, visual
inspection, successful render, usage reading, or completed edit.

### Keep context and work bounded

Long videos, large timelines, caption-heavy projects, long AI runs, and durable history must
not cause unbounded memory, context, DOM, decode, or persistence growth. Add shape-based or
budget-based regression tests when performance is part of the change.

### Treat model output as untrusted

Provider output, tool arguments, and textual claims are suggestions until validated by typed
code and authorized by the host. A capable model does not replace schema validation,
capability gating, path containment, cancellation, or completion verification.

## Change workflow

1. Create a focused branch from current `main`.
2. Trace the complete behavior path before editing.
3. Add or update deterministic core behavior first.
4. Connect manual UI, AI tools, preview, Python export, persistence, or packaging only where
   the feature requires them.
5. Add tests at the lowest useful layer, then add integration or E2E coverage for the user
   boundary.
6. Update living docs and the changelog when behavior changes.
7. Run the applicable validation on the final branch state.
8. Open a pull request that separates what changed, why, validation, limitations, and any
   follow-up work.

## Definition of done

A change is complete only when the applicable items are satisfied:

- Behavior is implemented end to end for its intended surface.
- Typed contracts and validation cover every new input and mutation.
- Undo and redo preserve project state.
- Preview and export agree for visual behavior.
- Schema changes include migrations, generated contracts, TypeScript/Python parity, and old
  fixture coverage.
- AI features use registered tools, bounded context, cancellation, honest capability checks,
  and explicit completion evidence.
- Host, renderer, sidecar, and MCP authority boundaries remain intact.
- Tests cover normal behavior, malformed inputs, boundaries, regressions, and degradation.
- Relevant typecheck, lint, unit, engine, E2E, render, coverage, packaging, security, and
  license checks pass.
- [`plan/PLAN.md`](./plan/PLAN.md) reflects completed and remaining work.
- User-visible changes are recorded in [`CHANGELOG.md`](./CHANGELOG.md).
- Architecture, API, guide, status, runbook, or ADR documentation is updated where required.
- The pull request reports only validation that was actually run.

## Documentation expectations

Use [`docs/README.md`](./docs/README.md) to choose the correct document:

- `README.md` gives the project overview and setup entry point.
- `docs/reports/STATUS.md` describes the current implementation and boundaries.
- `plan/PLAN.md` records detailed progress and remaining work.
- `CHANGELOG.md` records user-visible changes.
- `PRD.md` records long-term product intent.
- `docs/architecture` explains current structural behavior.
- `docs/api` documents contracts.
- `docs/adr` preserves durable decisions and supersession history.
- `docs/guides` and `docs/runbooks` support development and operation.

Do not rewrite historical ADRs or changelog entries to make them sound current. Add a new ADR
or a new changelog entry when behavior changes.

## Dependencies

Before adding a dependency:

- explain why existing code or dependencies are insufficient,
- check maintenance and platform compatibility,
- review its license and redistribution implications,
- run `pnpm license:scan`,
- account for Electron and PyInstaller packaging where relevant,
- document hosted-service data and privacy boundaries.

Do not add a dependency only to simplify a small local helper.

## Security and privacy

- Never commit secrets, tokens, signing credentials, user media, project databases, or local
  caches.
- Keep local HTTP services on loopback unless an accepted design explicitly changes that.
- Keep renderer privileges behind the preload contract.
- Apply project-root containment to file operations.
- Document when frames, audio, transcripts, or metadata leave the device.
- Follow [`SECURITY.md`](./SECURITY.md) and
  [`docs/runbooks/security-hardening.md`](./docs/runbooks/security-hardening.md).

## Commits and pull requests

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
`perf:`, and `chore:`.

A good pull request includes:

- the problem and user impact,
- the implementation boundaries,
- important decisions and tradeoffs,
- exact validation performed,
- screenshots or recordings for meaningful UI changes,
- schema, storage, provider, privacy, or packaging implications,
- known limitations and follow-up work.

Keep the branch reviewable. Large plans can land through multiple coherent pull requests when
that reduces risk and makes verification clearer.
