# v1.0.0 release checklist

A concrete, ordered checklist for cutting **FramePilot v1.0.0** — the first
production release that closes Phase 8 of [`../../plan/PLAN.md`](../../plan/PLAN.md).

This is the **per-release working copy** of the generic
[release runbook](../runbooks/release.md). The runbook explains _how_ releases
work (SemVer, Keep a Changelog, signing); this file is the v1.0.0 gate you tick
off. Run it on the exact release commit. **Do not tag until every box is
checked** (or a box is explicitly deferred to Phase 9 with a linked plan item).

> **Why a v1 checklist?** v1.0.0 is the first build a stranger installs without
> us in the room. Reliability is the product thesis — every gate below exists so
> that a shipped edit/render is correct, reversible, and signed, not "probably
> fine."

---

## 1. Quality gates — all CI green on the release commit

See [ci-cd.md](../runbooks/ci-cd.md) for what each gate enforces.

- [ ] **TS typecheck** — `pnpm typecheck` clean.
- [ ] **TS lint** — `pnpm lint` clean.
- [ ] **Format** — `pnpm format:check` clean.
- [ ] **TS tests** — `pnpm test` green.
- [ ] **Python lint** — `pnpm engine:lint` (ruff) clean.
- [ ] **Python typecheck** — `pnpm engine:typecheck` (mypy `--strict`) clean.
- [ ] **Python tests** — `pnpm engine:test` (pytest) green.
- [ ] **Coverage** — `pnpm test:coverage` + `pnpm engine:test:cov`; reported, not
      gated on a percentage. No skipped tests without a linked issue.
- [ ] **License scan** — `pnpm license:scan` clean; dependency review done.
- [ ] **E2E** — `pnpm test:e2e` (Playwright) green for the PRD §16.1 critical
      flows.
- [ ] **Visual regression** — timeline, captions, masks, color, keyframes.
- [ ] **Render fixture project** renders **and validates** (no near-black frames,
      no audio clipping, no duration drift).

> One-shot pre-push gate: `pnpm verify` (typecheck + lint + test + engine:test).
> It does **not** cover coverage, e2e, visual, or license — run those explicitly.

---

## 2. Correctness invariants

- [ ] **Core deterministic modules meaningfully covered** (behavior + error paths,
      not a percentage): timeline operations (`packages/editor-core`), the patch
      validator, AI tool schemas / input validation (`packages/ai-sdk`,
      `engine/python/.../ai_tools`), and render validation
      (`engine/python/.../validation`).
- [ ] Every operation tests both **`apply` and `invert`** (reversibility).
- [ ] Schema is documented; any `project.fp.json` schema change ships a
      **migration**, tested round-trip on real projects
      ([../api/timeline-schema.md](../api/timeline-schema.md)).
- [ ] AI edits flow **only** through tools → patches → `validate → apply` (no raw
      `project.fp.json` mutation path exists).

---

## 3. Security

- [ ] **Security audit signed off** against
      [security-hardening.md](../runbooks/security-hardening.md): path sandbox
      (no traversal / absolute / symlink escape), agent tool sandbox (no shell /
      eval / spawn), IPC surface (closed channel set, preload-only bridge),
      Electron hardening (`contextIsolation`, `nodeIntegration:false`,
      `sandbox:true`).
- [ ] Renderer media/CSP hardening reviewed (CSP present; preview media served
      over the sandboxed protocol, not raw `file://`) — or the residual risk is
      explicitly accepted and tracked in the plan.
- [ ] No secrets, media, or renders committed; `.env` is git-ignored.
- [ ] Render jobs enforce timeout + cancellation
      (`FRAMEPILOT_RENDER_TIMEOUT_SECONDS`).

---

## 4. Desktop builds — signed, notarized, auto-update

> **External prerequisites (provision before the release):** code-signing for
> signed/notarized builds requires an **Apple Developer ID** certificate (macOS
> notarization) and a **Windows code-signing certificate**, stored as **CI
> secrets**. These are external accounts/credentials, not code — without them,
> builds are unsigned and a v1.0.0 release must not ship.

- [ ] Apple Developer ID + Windows signing certs are present as CI secrets
      (`MAC_CERT_P12`/`MAC_CERT_PASSWORD`/`CSC_NAME` + `APPLE_ID`/
      `APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`; `WIN_CSC_LINK`/
      `WIN_CSC_KEY_PASSWORD` — see
      [`.github/workflows/release.yml`](../../.github/workflows/release.yml)).
- [ ] Tag `vX.Y.Z` pushed → the **Release workflow** builds installers for
      **macOS arm64/x64, Windows, Linux** (`pnpm desktop:dist` per native
      runner: workspace build → renderer staged → PyInstaller engine frozen
      with bundled `ffprobe` → deep-signed when `CSC_NAME` is set →
      electron-builder; ADR 0062/0063) and stages them on a **draft GitHub
      Release**.
- [ ] macOS build is **code-signed and notarized** (engine deep-signing is
      automatic via `scripts/sign-engine.mjs` when `CSC_NAME` is set); Windows
      build is **code-signed**.
- [ ] **Clean-machine check**: on a machine/VM with no Python, `uv`, ffmpeg, or
      ffprobe installed — import media, export, and confirm the render
      **validates** (exercises the bundled engine + vendored ffprobe).
- [ ] **sqlite-vec bundled in the packaged sidecar**: the packaged engine loads
      the native `vec0` extension — `GET /brain/visual/status` (or
      `vector_store.backend()`) reports `sqlite-vec`, **not** `brute-force` — on
      each platform's frozen build (MI2.4; the brute-force fallback is honest
      degradation, never the packaged default).
- [ ] **Auto-update channel verified**: a prior build can detect, download, and
      apply this release on each platform
      ([../architecture/desktop-shell.md](../architecture/desktop-shell.md)).
- [ ] **Smoke-test the signed build** on each platform: install → open a sample
      project → make an edit → export → the render **validates**.

---

## 5. Samples & docs

- [ ] **Sample projects open cleanly** in the editor —
      [`examples/hello-world.fp.json`](../../examples/hello-world.fp.json) and
      [`examples/product-demo-short.fp.json`](../../examples/product-demo-short.fp.json)
      load and validate against the current schema (see
      [`examples/README.md`](../../examples/README.md)).
- [ ] **Docs reviewed** and reflect shipped behavior — including the
      [onboarding guide](./onboarding.md) (commands match the current root +
      app `package.json` scripts). Run the `update-docs` skill.
- [ ] README ↔ docs cross-links valid; [docs/README.md](../README.md) indexes the
      new guides.

---

## 6. Release mechanics

- [ ] **`CHANGELOG.md` finalized**: the `[Unreleased]` section is promoted to a
      dated `[1.0.0] - YYYY-MM-DD` section (Keep a Changelog).
- [ ] **Version bumped** to `1.0.0` (SemVer; package version(s) updated).
- [ ] [`../../plan/PLAN.md`](../../plan/PLAN.md) and
      [`../reports/STATUS.md`](../reports/STATUS.md) updated; Phase 8 release
      items checked off.
- [ ] **Tag the release** `v1.0.0` and attach the signed artifacts.

---

## Sign-off

| Role        | Name | Date |
| ----------- | ---- | ---- |
| Engineering |      |      |
| Security    |      |      |
| Docs        |      |      |

Anything deferred from this list must be a linked, dated item in
[`../../plan/PLAN.md`](../../plan/PLAN.md) (Phase 8 or Phase 9), never a silent
gap.
