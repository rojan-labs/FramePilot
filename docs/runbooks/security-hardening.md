# Runbook: Security Hardening

FramePilot is a local-first desktop app that runs an AI agent over the user's files and
shells out to a render engine. The threat model is mostly about **not harming the user's
machine or data**: never destroy originals, never escape the project sandbox, never let
the agent run arbitrary code. This runbook is the checklist; the policy summary is in
[`../../SECURITY.md`](../../SECURITY.md) and the source rules are PRD §18.

Companion: the `security-hardening` skill (`.agents/skills/security-hardening/`).

---

## Local file safety (PRD §18.1)

- [ ] **Never delete original assets.** Edits are timeline operations, not file deletes.
- [ ] **Never overwrite user files without confirmation.** Renders go to the project
      `renders/` folder.
- [ ] **Safe path resolution** for every filesystem op; resolve and canonicalize before
      use.
- [ ] **Prevent path traversal** — reject any path that resolves outside
      `FRAMEPILOT_PROJECTS_ROOT`. Test with `../`, symlinks, absolute paths, and
      Unicode/encoding tricks.
- [ ] **Atomic saves** for `project.fp.json` (temp file → fsync → rename); see
      [../architecture/desktop-shell.md](../architecture/desktop-shell.md).
- [ ] **Never write through a link beside user media.** The sandbox proves the path it was
      given, not a sibling derived from it: write a derived file (a cache, a temp) to a fresh
      file in the same folder and swap it in with `os.replace`, and treat a symlink at the name
      as a miss on read. See the 2026-09-26 reference-cache note below.

## Agent sandbox (PRD §18.2)

- [ ] The agent **cannot run arbitrary shell commands** in the app runtime.
- [ ] The agent acts **only through registered tools**
      ([../api/ai-tools.md](../api/ai-tools.md)).
- [ ] **All tool inputs are schema-validated** (reject, don't coerce).
- [ ] File operations are **sandboxed to the project directory**.
- [ ] Render jobs have a **timeout** (`FRAMEPILOT_RENDER_TIMEOUT_SECONDS`) and are
      **cancellable**.

## Secrets

- [ ] Secrets live in `.env`, which is **never committed** (`.gitignore`).
- [ ] API keys (`ANTHROPIC_API_KEY`, `NVIDIA_API_KEY`, `OPENAI_API_KEY`) are read from env
      only; never logged, never written to project files, never sent to other providers.
- [ ] Default config (`provider=mock`, no keys) must run fully offline.

## Electron hardening

- [ ] `contextIsolation: true`, `nodeIntegration: false`.
- [ ] Renderer gets only a **minimal, typed preload bridge** — no raw Node, no `require`.
- [ ] Privileged ops (filesystem, spawning the sidecar) happen only in the main process.
- [ ] The Python sidecar binds to **loopback** (`127.0.0.1`) only.
- [x] **Sidecar routes sandbox caller-supplied paths.** Every FastAPI route that
      takes a filesystem path (`/render`, `/render/preview`, `/inspect-media`,
      `/validate-render`) resolves it through `resolve_within(projects_root, …)`
      before any disk access (finding 1.2). See incident note below.
- [ ] Restrict navigation / disable opening untrusted external content in the renderer.

## Dependency / license review (PRD §17)

- [ ] **No new dependency without a license review** (blocking CI rule).
- [ ] License scan runs in CI ([ci-cd.md](ci-cd.md)).
- [ ] Keep dependencies current; watch for advisories.

## Reliability (PRD §18.3)

- [ ] Background jobs are **resumable/retryable**.
- [ ] Failed renders emit **useful logs** (`logs/`).
- [ ] **Undo/redo** and **crash recovery** from last valid project state work.

---

## Incident notes

When a security issue is found or reported (see disclosure process in
[`../../SECURITY.md`](../../SECURITY.md)), record here: date, summary, affected component,
root cause, fix + PR link, and the regression test added. Treat a sandbox escape or
original-asset loss as **critical**.

### 2026-09-26 — Reference cache written through a symlink; the CodeQL backlog on PR #131 (HIGH, fixed)

- **Summary:** `POST /references/analyze` caches its measurement beside the reference as
  `<ref>.reference.json`, written with `Path.write_text`, which follows a symlink. A link planted
  in a project folder (a shared zip, a git clone) made the engine overwrite any file it could
  reach outside the projects root, and a dangling link created its target there. Reproduced: the
  route answered 200 and overwrote an outside `victim.txt`. The read side served whatever JSON the
  link pointed at as a cache hit. Found while triaging the 57 CodeQL alerts on PR #131 (the two
  alerts on those lines had been dismissed as false positives).
- **Affected component:** `engine/python/framepilot_engine/service.py` (`/references/analyze`).
- **Root cause:** `sandbox()` proved the media path is inside the root; the cache path was derived
  from it with `with_name` and never checked, and the write followed the link.
- **Fix (`0ab4bcd1`):** a symlinked cache is a miss (logged); the cache is written to an exclusive
  temp file in the same folder and swapped in with `os.replace`, which replaces the directory
  entry instead of writing through it; the temp file is removed if the swap fails. No other write
  beside user media exists in `service.py`.
- **Regression tests:** `engine/python/tests/test_service_references.py` — a live link to an
  outside file (unchanged, and replaced by a real cache), a dangling link (target not created), a
  forged linked cache carrying the real hash (not served), a cache name taken by a folder (no temp
  file left behind).
- **The sandbox idiom, and why (`01b453ff`):** every path route resolves through
  `safety.resolve_within`. It was correct, but CodeQL's `py/path-injection` does not model
  `Path.resolve()` as normalisation (it treats it as a file access) nor
  `base not in path.parents` as a guard, so ~40 downstream routes read as unchecked. The check is now
  `os.path.realpath` on both sides and one `startswith` on the value returned, with a trailing
  separator on both sides: that makes "inside or equal to the root" a single prefix test and rules
  out the sibling-prefix bug (`/projects` vs `/projects-evil`). Never compare against a bare root,
  never return a different variable from the one the guard checked, and never split the guard
  into `a == root or a.startswith(...)` (not recognised). A NUL byte is now a
  `PathTraversalError` (400), not the OS layer's `ValueError` (500).
- **The subprocess idiom, and why (`b144d2a4`):** CodeQL's command-line-injection query narrows
  "the command" to element 0 only when `subprocess` receives a list literal; a variable holding the
  whole validated vector reads as a tainted command. Probes that carry a sandboxed path now launch
  through `subprocess_safety.run_argv` / `popen_argv(binary, operands)`: the binary comes from the
  resolvers and is the literal first element, `shell` is fixed, `executable=` is refused.
- **Also fixed:** three polynomial regexes (caption trailing closers `f5db5f54`, perception-metric
  frame count and clip rows `659ddd8f`), two incomplete escapes in tests, and a substring URL test
  in the visual-describe model fetcher (`92dbcfc7`).
- **Open (tracked in `plan/PLAN.md`):** the render's audio mastering pass writes its predictable
  `<export>.master.tmp` sibling with `ffmpeg -y`, which follows a planted link the same way;
  matte artifact files are checked with `is_file()`, which follows a linked file (info: the pinned
  digest must still match); the already-dismissed whole-argv runners (`media/ffmpeg.run`, the ASR
  and audio-filter runners) keep their shape.

- **Surface:** everything Elements added across the IPC and agent boundaries — materialise and
  thumbnails, the Pexels download's new `kind`, the renderer drag payloads and the monitor and
  timeline drops, the bin's Add as overlay, `add_sticker`/`search_elements`, the MCP server's
  `placesStickers: false` — and the release pipeline's changes, reviewed by `security-reviewer`.
- **Held:** ids match their patterns and the catalogue before main acts on them; a Pexels download
  resolves only items main fetched itself, now also of the kind asked for; a drag (forgeable by any
  page or file drop) carries only a kind and an id, validated on drop, never a path or URL; the
  model reaches no path; the MCP sandbox is not widened; asar, the CSP, `contextIsolation`,
  `sandbox` and `nodeIntegration: false` are unchanged; no secret is echoed.
- **Fixed (medium):** making unsigned release builds succeed would have let a tag pushed without
  its signing secrets publish unsigned installers and their feed to installed apps. A tagged
  release now fails before building without the macOS signing and notarisation or Windows
  Authenticode secrets, and each app's signature is verified (codesign and spctl; Authenticode)
  before upload (`d2fe4d32`).
- **Fixed (medium):** the release job restored the encoded sticker set, and the manifest that
  vouches for it, from a cache another workflow could write. Only the pinned inputs are cached now
  (re-checked against the lock on every read) and a release re-encodes the set (`d2fe4d32`). The
  base64 `.p12` is readable only by the import step.
- **Fixed (low):** the packaged `manifest.json` is read bounded (2 MiB, regular file, no link);
  packaged files open by their real path with `O_NOFOLLOW`; the manifest's items are a `Map`, so a
  `__proto__` key cannot reach the prototype; the materialise project id is capped at 256
  characters (`b861b788`).
- **Accepted risk:** a parent-directory swap between the path check and the open remains possible
  without `openat`; it needs write access to the install folder, the same class as the EL6b entry.

### 2026-09-26 — Packaged sticker set review (plan/elements EL6b, PASS WITH FINDINGS)

- **Surface:** the installer's packaged set (`<resources>/elements/stickers`, `manifest.json`),
  `framepilot:elements:thumbnail`, the packaged branch of materialise and heal
  (`apps/desktop/electron/media/elements-library.ts`), the renderer's tile cache and sticker drop,
  and the agent's widened search, reviewed by `security-reviewer`.
- **Held:** ids are checked against the pattern and the catalogue's `packaged` availability;
  the manifest's files are pinned to `full|thumbs/<id>.webp`; a packaged source is read once,
  hashed, and that buffer written through `resolveWithin`; no path or error text crosses IPC;
  the handler is licence-gated; a drag from another window can only ask for an id; blob URLs are
  bounded by the catalogue (≈ 6 MB); the agent reaches no new file (`add_sticker` is still
  `hostUiOnly`); the CSP and Electron flags are unchanged.
- **Fixed (low):** a packaged file was read whole, following links, before any check: a tile
  linked to a private file would have been sent to the renderer, and a link to `/dev/zero` or a
  pipe could exhaust or hang main. Packaged files are now read by real path inside the set, as
  regular files only (opened non-blocking), no larger than the manifest says and under fixed caps
  (512 KiB a sticker, 64 KiB a tile).
- **Fixed (low):** the manifest was trusted field by field; its numbers reached projects. It is now
  validated whole (digest shape, integer sizes within the caps and 8192 px), and one bad entry
  means the set is not used. The build's `check:elements` now reads the set through the app's own
  library (every tile served, every sticker placed into a scratch project), so CI cannot pass a
  set the app would refuse.
- **Fixed (low, info):** the thumbnail request is refused whole when longer than one request may be,
  before its entries are walked (`thumbnailRequestIds`); a sticker click or drop whose IPC call
  rejects (a lapsed licence) now says the copy failed instead of leaving an unhandled rejection.
- **Accepted risk (info):** the manifest is the set's only trust root and sits outside the app's
  archive, so "verified against the manifest" catches corruption and a mismatched build, not a
  deliberate rewrite of the set by someone who can already write the install folder — who could
  equally rewrite `app.asar`, since the asar-integrity fuses are not enabled. The fix is those
  fuses with the manifest's digest compiled into the archive; tracked in `plan/PLAN.md`.
- **Tests:** `elements-library.test.ts` (a malformed manifest in seven ways, a tile linked outside
  the set, an oversized tile, a full file linked outside, the request parser),
  `packaged-stickers.test.ts` (the check refuses a set the app would ignore, and names a sticker
  whose tile the app would not show), `sticker-drop.test.ts` and `StickersBrowser.test.tsx`
  (a rejected copy is said, not thrown).

### 2026-09-26 — Sticker library review (plan/elements EL6a, PASS WITH FINDINGS)

- **Surface:** `framepilot:elements:materialize` and heal-on-open
  (`apps/desktop/electron/media/elements-library.ts`), the agent's `add_sticker` host
  (`electron/ai/sticker-host.ts`), reviewed against plan/elements 06 §5 by `security-reviewer`.
- **Held:** only a catalogue id (`^[a-z0-9_]{1,96}$`) and a project id cross the boundary; the
  project id is reduced to a safe segment; every write goes through `resolveWithin` as a temp
  file then a rename; each bundled file's SHA-256 is checked before it is copied, and an existing
  copy's before it is reused; the CSP and Electron hardening are unchanged; `add_sticker` takes no
  project id and is `hostUiOnly`, so MCP cannot reach it; telemetry carries no id or path.
- **Fixed (medium):** a project media folder linked outside the projects root made the sandbox
  throw a message naming both paths, which reached the renderer and the model, and an unguarded
  heal stopped the project opening. Every failure is now a closed code, heal never throws, and
  main guards it.
- **Fixed (low, info):** heal copied a sticker for an asset recorded elsewhere; it now restores only
  the file's own path and copies a shared sticker once. A catalogue entry must name its own
  file; a wrong-size copy is replaced unread; a crashed copy's temp files are swept.
- **Tests:** `elements-library.test.ts` (traversal-shaped ids and project ids, a symlinked media
  folder, a path-shaped catalogue file, tampered reuse, stale temp files, heal's no-write and
  never-throw cases) and `model-facing-failure.gate.test.ts` (the sentences the model sees).

### 2026-06-26 — Sidecar accepted arbitrary filesystem paths (CRITICAL, finding 1.2)

- **Summary:** The Python FastAPI sidecar routes accepted arbitrary caller-supplied
  paths with no sandbox containment, even though `Settings.projects_root` existed for
  exactly this purpose. A local process could POST `{"input_path": "/etc/passwd"}` to
  `/inspect-media` to probe arbitrary files, or point `/render`'s `project_path`
  anywhere on disk.
- **Affected component:** `engine/python/framepilot_engine/service.py`
  (`/render`, `/render/preview`, `/inspect-media`, `/validate-render`).
- **Root cause:** Routes did `Path(req.input_path)` etc. directly and never called
  the existing `resolve_within` sandbox primitive; `projects_root` was defined but
  never enforced.
- **Fix:** Added a `sandbox()` guard in `create_app` that routes every caller-supplied
  path through `resolve_within(settings.projects_root, …)` before any disk access,
  returning HTTP 400 on `PathTraversalError`. When `projects_root` is unset (optional
  `FRAMEPILOT_PROJECTS_ROOT`, defaults to `None`) the previous un-contained behaviour
  is preserved for backward-compat but a warning is logged; the packaged desktop shell
  always configures the root, so containment is strict in production.
- **Regression test:** `engine/python/tests/test_service.py` — traversal (`../../etc/passwd`)
  and out-of-root absolute (`/etc/passwd`) paths now return 400 on every guarded route;
  in-sandbox paths still succeed. `service.py` at 100% coverage.

### 2026-06-26 — Phase 8 security audit (full record)

A pass over every place a renderer/agent/network-supplied path or input reaches the
filesystem or the renderer. Findings below; each is marked **RESOLVED** with its fix
location or listed in the **hardening backlog** (not yet done). The remaining
high-severity TS/renderer items are recorded in
[ADR 0025](../adr/0025-path-sandbox-unification-and-renderer-csp.md); the sidecar item
is the incident note above.

**Resolved**

- **1.1 — Electron IPC accepted arbitrary paths (CRITICAL). RESOLVED.** The main-process
  handlers `projectOpen`/`projectSave`/`projectReveal`/`renderExport`
  (`apps/desktop/electron/main.ts`) passed a renderer-supplied absolute path straight to
  the filesystem. They now route every path through the projects sandbox via
  `sandboxProjectPath` (`apps/desktop/electron/ipc/sandbox.ts`, unit-tested) before any
  disk access, surfacing `{ ok: false }` on escape. See ADR 0025.
- **1.2 — Sidecar accepted arbitrary paths (CRITICAL). RESOLVED.** Every FastAPI route
  that takes a path now resolves it through `resolve_within(projects_root, …)` before
  disk access (HTTP 400 on escape). See the incident note above and
  `engine/python/framepilot_engine/service.py`.
- **1.3 — Sandbox symlinked-tail bypass. RESOLVED.** The TS `resolveWithin` realpaths the
  deepest existing portion of the resolved target **including a final symlinked
  component**, so a symlinked file (not just a symlinked parent dir) whose target leaves
  the sandbox is rejected. Covered by the safety tests in
  `packages/shared-types/src/safety.test.ts`.
- **1.4 — Two divergent TS sandboxes. RESOLVED.** A correct `resolveWithin`/
  `PathTraversalError` existed only in the MCP server; the Electron handlers had none.
  The primitive is now the single source in `@framepilot/shared-types/safety` (node-only
  subpath), mirroring the engine's `resolve_within`; `packages/mcp-server/src/safety.ts`
  re-exports it. See ADR 0025.
- **3.2 — No renderer CSP, raw `file://` media (HIGH). RESOLVED.** A strict
  Content-Security-Policy is now served on every renderer response
  (`onHeadersReceived` + `buildCsp`), and clip media is served through a privileged
  `fp-media://` scheme whose handler resolves each request through the sandbox before
  streaming (`apps/desktop/electron/security/media-protocol.ts`), replacing `file://`.
  See ADR 0025.

**Hardening backlog (NOT yet done)**

- [ ] **Windows / UNC path traversal tests** for the sandbox (current tests are POSIX-
      shaped).
- [ ] **Zod-validate `AiRequest` / `ExportRequest` at the IPC boundary**, including the
      free-form `userPrompt`, before the main process acts on them.
- [ ] **Redact upstream provider error bodies** before they are logged or surfaced
      (they may echo prompt content or keys).
- [ ] **Agent token / wall-clock budget** — bound an agent run by tokens and time, not
      only by step count.
- [ ] **SPDX-aware license logic + a `pnpm audit` CI gate** wired into the existing
      license scan.
- [ ] **Explicit `renders/` / `exports/` gitignore** so rendered output is never
      accidentally committed.
- [ ] **TS ↔ Python sandbox algorithm reconciliation + shared golden vectors** so both
      implementations are proven to agree on the same cases.
- [x] **Main-process native open/save dialog** for choosing a location **outside** the
      projects folder (the trusted way to broaden the sandbox; see ADR 0025). Done:
      export's Save As (`framepilot:export:save-as`) shows a main-process
      `dialog.showSaveDialog` and copies the sandboxed render there — the renderer
      never supplies the destination path directly, and the source path is still
      re-checked against the projects sandbox before the copy
      (`apps/desktop/electron/render/export-save.ts`).
