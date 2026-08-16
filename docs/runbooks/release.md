# Runbook: Release

How to cut a FramePilot release. Releases are gated on the same quality bar as every PR
([ci-cd.md](ci-cd.md)) plus the readiness checks below. Companion: the
`release-readiness` work in Phase 8 of [../../plan/PLAN.md](../../plan/PLAN.md).

> For the first production release, use the concrete, per-release
> [v1.0.0 release checklist](../guides/release-checklist-v1.md) — it expands the
> readiness items below into a tickable gate (CI, coverage, security sign-off,
> signed/notarized builds, sample projects, docs, version bump + tag).

---

## Versioning — SemVer

FramePilot follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — incompatible changes (including a breaking `project.fp.json` schema change
  that requires a migration users must run).
- **MINOR** — backward-compatible features (new operations, tools, presets).
- **PATCH** — backward-compatible bug fixes.

The `project.fp.json` schema also has its own `version` field with a migration chain
([../api/timeline-schema.md](../api/timeline-schema.md)); a breaking schema change must
ship a migration and is reflected in the app's MAJOR version.

---

## Changelog — Keep a Changelog

Maintain [`../../CHANGELOG.md`](../../CHANGELOG.md) in
[Keep a Changelog](https://keepachangelog.com/) format: an `Unreleased` section with
`Added / Changed / Fixed / Removed / Security`, promoted to a dated version section at
release. Updating the changelog is part of the docs-maintainer workflow (the `update-docs`
skill / `.agents/skills/docs-maintainer/`).

---

## Release readiness checklist

- [ ] All CI gates green on the release commit ([ci-cd.md](ci-cd.md)).
- [ ] Core deterministic modules are meaningfully covered (timeline ops, patch validator,
      AI tool schemas, render validation) — behavior and error paths, not a percentage.
- [ ] Full E2E suite green (PRD §16.1 flows).
- [ ] Visual regression suite green.
- [ ] License scan clean; dependency review done.
- [ ] Security audit checklist reviewed
      ([security-hardening.md](security-hardening.md)).
- [ ] Render fixture project renders and **validates** (no black frames / clipping /
      duration drift).
- [ ] Schema migrations (if any) tested round-trip on real projects.
- [ ] `CHANGELOG.md` updated and version bumped (SemVer).
- [ ] [../../plan/PLAN.md](../../plan/PLAN.md) and [../reports/STATUS.md](../reports/STATUS.md)
      updated.
- [ ] Docs reflect shipped behavior (the `update-docs` skill).

---

> **Getting a build to users** — update feed, pack catalog, root key ceremony,
> rollback and incidents — is [`distribution.md`](./distribution.md). This file
> stops at producing the artifacts.

## Build & sign (planned — Phase 8)

- [ ] Build desktop binaries for macOS / Windows / Linux (`pnpm desktop:build`).
- [ ] **Code-sign and notarize** each platform build (planned).
- [ ] Publish to the auto-update channel
      ([../architecture/desktop-shell.md](../architecture/desktop-shell.md)).
- [ ] Tag the release (`vX.Y.Z`) and attach signed artifacts.
- [ ] Smoke-test the signed build on each platform (install → import → edit → export →
      validate).

> Signed builds and auto-update are scaffolded but not yet implemented; track status in
> the plan.
