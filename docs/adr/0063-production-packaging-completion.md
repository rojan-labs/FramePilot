# ADR 0063: Production packaging completion — vendored ffprobe, staging-time deep-sign, release CI

- **Status:** Accepted
- **Date:** 2026-07-17
- **Deciders:** Rojan Acharya (maintainer) with Claude Code

## Context

ADR 0062 made the packaged desktop app self-contained except for three accepted
follow-ups: `ffprobe` was not bundled (imageio-ffmpeg ships only `ffmpeg`, and
media inspect + render validation shell out to `ffprobe`), the engine bundle's
Mach-O files were unsigned (electron-builder never signs `extraResources`, so
notarization would reject the app), and installers had no CI pipeline (the
PyInstaller bundle is per-OS/arch, so each target needs a native builder).
The maintainer approved closing all three, explicitly waiving the usual
per-dependency license review for this work.

## Decision

1. **Vendor ffprobe from `@ffprobe-installer/ffprobe`** (desktop devDependency;
   platform binaries link only OS frameworks — verified portable).
   `scripts/package-engine.mjs` stages the platform binary next to the frozen
   engine as `engine-dist/ffprobe(.exe)`.
2. **Hand helper paths to the engine via env at spawn.**
   `resolveSidecarCommand` now returns env *additions*: in packaged builds it
   sets `FRAMEPILOT_FFPROBE` (and `FRAMEPILOT_WHISPER_CLI` when a whisper-cli
   is staged) pointing into `Resources/engine/` — but only when the staged
   file actually exists (injected `fileExists`, keeping the resolver pure) and
   never overriding a user-supplied value. Dev spawns add nothing; the source
   engine keeps PATH/imageio discovery.
3. **Deep-sign at staging time, not via packager hooks.**
   `scripts/sign-engine.mjs` signs every Mach-O in `engine-dist/` (magic-number
   detection, batched `codesign --options runtime` with our entitlements,
   main executable last) when `CSC_NAME` is set — before electron-builder
   copies the tree into `Resources/` and signs the app, so the embedded
   signatures survive. `CSC_NAME='-'` exercises the path ad-hoc without certs.
   Two packaging landmines found by the first real signed build:
   - `mac.signIgnore: ['Resources/engine/']` is required: electron-builder's
     own signing walk treats PyInstaller's `Python.framework` as a framework
     bundle, and codesign rejects its layout ("unsealed contents present in
     the root directory") — aborting the build whenever ANY keychain identity
     is auto-discovered. The outer app signature still seals engine files as
     resources; file-level Mach-O signatures are what notarization checks.
   - Staging must copy with `verbatimSymlinks`: PyInstaller's bundle contains
     relative symlinks (`_internal/libx264.dylib → cv2/.dylibs/…`), and Node's
     default `fs.cp` rewrites them to absolute build-machine paths — codesign
     rejects the app ("invalid destination for symbolic link in bundle") and
     every link would dangle on a user's machine.
4. **Release CI** (`.github/workflows/release.yml`): tag-triggered matrix
   (macOS arm64 + x64, Windows x64, Linux x64) running `pnpm desktop:dist`,
   uploading installers to a **draft** GitHub Release; signing/notarization
   secrets are optional inputs, unsigned builds otherwise.

## Consequences

Positive:

- A clean machine needs **nothing** preinstalled — proven by rendering with
  `PATH` stripped to `/usr/bin:/bin` and only the bundle's tools: render
  completed *and* validation ran (validation is ffprobe-dependent).
- The full installer path is verified end-to-end locally: signed .app
  (`codesign --verify --strict --deep` passes), dmg + zip + blockmaps +
  `stable-mac.yml` update manifest produced, and the app launched **from the
  mounted dmg** with its sidecar (spawned from the dmg's `Resources/engine`,
  `FRAMEPILOT_FFPROBE` delivered) healthy in ~9 s.
- Hardened-runtime signing is verified compatible with the frozen engine
  (280 Mach-O files ad-hoc signed with `--options runtime`; serve + render
  still pass) — no surprises left for the first real Developer ID run.
- Transcription self-upgrades per platform: any release that stages a
  `whisper-cli` into `engine-dist/` is picked up automatically by the spawn
  env, with honest degradation (status reports "unavailable") until then.

Negative / accepted costs:

- Bundled ffprobe is 4.4.1 while imageio-ffmpeg's ffmpeg is 7.1 — acceptable
  because the engine only parses long-stable probe JSON fields, but the
  version skew should be retired when a maintained single-source
  ffmpeg+ffprobe vendor exists.
- whisper-cli is **not** bundled yet (no portable prebuilt exists across our
  four targets; compiling whisper.cpp in release CI is real work). Tracked in
  plan Phase 9.
- Notarization end-to-end (real cert → staple → Gatekeeper) still needs the
  Apple Developer ID secrets; the pipeline is ready but the last mile is
  unverifiable until they land (release checklist gates on it).

## Alternatives Considered

- **electron-builder afterPack/afterSign hook for deep-signing** — rejected:
  hooks run against packager internals (temp keychains, lazy signing info)
  and are notoriously version-fragile; staging-time signing uses only
  documented env + `codesign`.
- **`ffprobe-static` npm package** — rejected: no darwin-arm64 binary.
- **Requiring Rosetta/system ffprobe on macOS** — rejected: violates the
  "clean machine needs nothing" goal.
- **Publishing straight to the auto-update feed from CI** — rejected for now:
  a draft GitHub Release keeps a human smoke-test between build and ship
  (release checklist §4); the generic update host can mirror the published
  assets.
