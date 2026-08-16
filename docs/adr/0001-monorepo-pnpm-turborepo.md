# ADR 0001: Monorepo with pnpm workspaces + Turborepo

- **Status:** Accepted
- **Date:** 2026-06-18

## Context

FramePilot spans a desktop shell (`apps/desktop`), a web editor
(`apps/web-editor`), shared UI (`packages/ui`), and several tightly-coupled libraries
that must stay version-locked: `packages/timeline-schema`, `packages/shared-types`,
`packages/editor-core`, and `packages/ai-sdk` (PRD §12). The timeline schema in
particular is consumed by nearly everything; a version skew between the schema and the
patch engine would be a correctness bug, not just an annoyance.

We need: atomic cross-package changes, fast incremental builds/tests, strict typecheck
across boundaries, and a clean place for the separate Python engine (`engine/python`) to
live alongside the JS/TS world without entangling toolchains.

## Decision

We will use a **single monorepo** managed by **pnpm workspaces** (declared in
`pnpm-workspace.yaml`) with **Turborepo** (`turbo.json`) orchestrating tasks
(`build`, `test`, `lint`, `typecheck`). Shared TS config lives in `tsconfig.base.json`.
The Python engine lives in the same repo (`engine/python`, `pyproject.toml`, managed by
`uv`) but uses its own toolchain rather than being shoehorned into the JS graph.

## Consequences

- **Positive:** atomic PRs across schema + engine + UI; one install; content-hashed task
  caching and parallelism via Turborepo; pnpm's strict, disk-efficient symlinked
  `node_modules` catches accidental undeclared dependencies.
- **Positive:** one CI pipeline can gate the whole product (see
  [../runbooks/ci-cd.md](../runbooks/ci-cd.md)).
- **Negative:** contributors must learn pnpm + Turborepo conventions; the repo mixes two
  language toolchains (mitigated by keeping Python isolated under `engine/`).
- **Follow-up:** keep the Zod (TS) and Pydantic (PY) schemas in sync via a shared JSON
  Schema (Phase 1).

## Alternatives Considered

- **npm/yarn workspaces** — workable, but pnpm's strictness and speed are better suited to
  a large, multi-package graph.
- **Polyrepo (one repo per package)** — rejected: makes atomic schema+engine changes
  painful and invites version skew, the exact failure mode we most want to avoid.
- **Nx instead of Turborepo** — capable, but heavier; Turborepo's lightweight task
  pipeline + caching is enough for our needs today.
