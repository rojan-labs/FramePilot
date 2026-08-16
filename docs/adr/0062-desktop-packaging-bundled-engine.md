# ADR 0062: Desktop packaging — bundled PyInstaller engine + staged renderer

- **Status:** Accepted
- **Date:** 2026-07-17
- **Deciders:** Rojan Acharya (maintainer) with Claude Code

## Context

The Phase 8 packaging scaffold ([`plan/PLAN.md`](../../plan/PLAN.md) "Signed
desktop builds") produced a complete `electron-builder.yml` (targets, signing
env, auto-update feed) — but the packaged app could not actually run:

1. **No renderer.** `files: renderer/**` was packaged, but no build step ever
   produced `apps/desktop/renderer/`; the web-editor build stayed in its own
   package's `dist/`, and Vite's default absolute `base` (`/assets/…`) breaks
   under Electron's `loadFile()` (`file://`) anyway.
2. **No engine.** `main.ts` spawned the sidecar as `uv run framepilot serve`
   with `cwd` resolved into the repo's `engine/python`. End users have neither
   `uv`, nor Python, nor the repo (PRD §15: the desktop app is a self-contained
   product; CLAUDE.md: the desktop path is the #1 product focus).
3. **Missing signing asset.** `build/entitlements.mac.plist` was referenced by
   the mac config but did not exist.

Constraint: the render engine is CPython + MoviePy/FFmpeg by design (ADR 0003);
rewriting it for packaging convenience is out of the question. The sidecar
contract (spawn → `/health` poll → HTTP; ADR 0009) must stay identical between
dev and packaged builds so nothing above the spawn seam changes.

## Decision

We will ship the engine as a **self-contained PyInstaller onedir bundle** under
`Resources/engine/` and stage the **web-editor build into
`apps/desktop/renderer/`** at packaging time.

Specifics:

- **Engine freeze:** `engine/python/framepilot-engine.spec` +
  `packaging/pyinstaller_entry.py` freeze the same `framepilot_engine.cli:main`
  the dev CLI uses (identical subcommands/flags). PyInstaller lives in a new
  `package` optional-dependency extra (build-time only; GPL-2.0 *with the
  bootloader exception*, so the bundled output keeps our licensing).
  **onedir, not onefile** — onefile self-extracts ~250 MB to a temp dir on
  every launch; onedir starts instantly and lets differential auto-update ship
  deltas.
- **Staging scripts** (`apps/desktop/scripts/`): `copy-renderer.mjs` stages
  `apps/web-editor/dist` → `renderer/`; `package-engine.mjs` runs
  `uv run --extra package pyinstaller` and stages the bundle →
  `engine-dist/` (both staging dirs gitignored). `electron-builder.yml` ships
  `engine-dist` via `extraResources` → `Resources/engine/` (outside the asar —
  it must be spawnable from disk).
- **Spawn resolution seam:** new pure module
  `apps/desktop/electron/sidecar/spawn.ts` (`resolveSidecarCommand`, 100%
  covered): `FRAMEPILOT_ENGINE_DIR` override → dev-style `uv run` (even when
  packaged, for debugging); else packaged → bundled binary; else dev →
  `uv run` in the repo engine dir. The `SidecarManager` state machine is
  untouched.
- **Renderer base:** web-editor builds with Vite `base: './'` so the bundle
  works from `file://`, `http://`, or any subpath.
- **Orchestration:** `pnpm desktop:dist` (root) = workspace build → renderer
  stage → engine freeze → `electron-builder`; `dist:unpacked` builds the
  unpacked app for local verification.

## Consequences

Positive:

- A packaged FramePilot runs on a machine with **no Python, no uv, no repo** —
  verified by driving the frozen binary end-to-end: `/health` answers in ~5 s
  and a real project renders with validation green (duration, black-frame,
  clipping checks).
- Dev and packaged builds run the *identical* engine code path behind one
  tested resolution function; “works in dev, broken packaged” drift now has a
  single seam to inspect.
- Frozen-app pitfalls are encoded in the spec, not tribal knowledge:
  `collect_submodules` for lazy imports (`serve` imports the service lazily;
  uvicorn picks loops/protocols by string), `copy_metadata` for
  imageio/moviepy (`importlib.metadata` lookups fail in a bare freeze — found
  by an actual failed render), PIL data files for the caption font.

Negative / accepted costs:

- ~250 MB engine bundle per platform in the installer; PyInstaller builds are
  per-OS/arch, so release CI needs a native builder per target (already true
  for electron-builder).
- **`ffprobe` gap:** imageio-ffmpeg bundles `ffmpeg` only. Media inspect /
  render validation on a clean machine still needs `ffprobe` on PATH or
  `FRAMEPILOT_FFPROBE`. Tracked as a Phase 8 follow-up (bundle a static
  ffprobe next to the engine).
- **Deep-signing follow-up:** electron-builder does not code-sign
  `extraResources`; notarized releases need an afterSign/afterPack hook that
  signs the engine's Mach-O files (noted in `electron-builder.yml` and the
  release checklist). Until certs land, local builds are ad-hoc signed and run
  fine.

## Alternatives Considered

- **Require users to install Python/uv** — rejected: not a consumer product
  experience; violates PRD §15 packaging goals.
- **PyInstaller onefile** — rejected: seconds of extract latency on every
  sidecar start and no differential-update benefit.
- **python-build-standalone + venv shipped as resources** — rejected: larger,
  slower to assemble, and file-count-heavy installers; PyInstaller's hook
  ecosystem already solves the MoviePy/imageio metadata problems.
- **Rewrite the engine in TypeScript to avoid bundling Python** — rejected:
  contradicts ADR 0003 and the deterministic-render contract.
