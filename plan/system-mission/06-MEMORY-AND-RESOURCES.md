# Phase 6 — Memory and resources — `[~]`

> **Ships:** an end-to-end leak audit with each finding fixed at its owner; caches with
> bounds; a repeatable resource test.
> **Does not ship:** raised limits, GC hints, or "restart the sidecar every N minutes".
> **Depends on:** Phase 0 (P0.4 snapshots). **Schema/deps:** none.
> **Owner agents:** `performance-optimizer` (fix), `performance-monitor` (gate).

Work from the P0.4 growth leads. For each: trace ownership (who allocates, who is
supposed to release, on which event), fix the release at that owner, add a test that
counts the resource before/after the lifecycle.

## P6.1 — Renderer: effects, listeners, timers, object URLs, media elements — `[ ]`

**Touches:** `apps/web-editor/src/**` — `useEffect` cleanups, `addEventListener` pairs,
`setInterval`/`requestAnimationFrame` cancels, `URL.createObjectURL` ↔ `revokeObjectURL`,
`<video>`/`<canvas>` teardown in preview (`preview/`, WebCodecs compositor), thumbnail
and waveform caches, framer-motion overlays (see edit-pulse note), zustand/store
subscriptions. Method: dev-only counters wrapped around each primitive (already partly
built for P0.4), a scripted 10-minute session, assert counters return to baseline after
closing the project.
**Done when:** counters flat across open → edit → close ×3; heap snapshot diff shows no
retained detached DOM or clip arrays.

## P6.2 — Renderer: bounded caches — `[~]`

Every in-memory cache (thumbnails, waveforms, frame cache, footage map, transcript,
query caches) gets a size bound in bytes or entries with LRU eviction, and a
`clear()` on project close. Bounds are constants in one module, not magic numbers.
**Done when:** each cache has a test for eviction and a project-close test for emptiness.

Finding 2026-08-29: the renderer's real caches are already LRU-bounded with close-on-evict
(`bitmapCache.ts` 256 decoded frames, `ClipWaveform.tsx` `MAX_WAVEFORM_BITMAPS`, both on
`editor/lruCache.ts`); the other `Map`s are per-render memos, not caches. What was missing
was the project-close path: nothing cleared them, so a previous project's bitmaps stayed
resident until pressure evicted them. `App.tsx` now clears both when `project.id` changes.
Remaining: the eviction/emptiness unit tests named in the done-when, and the footage-map /
transcript query caches in the AI sidebar.

## P6.3 — Main process: IPC listeners, child processes, handles, temp files — `[~]`

**Touches:** `apps/desktop/electron/main.ts` (127 KB — split listener registration by
domain while here, no behaviour change), `ipc/*`, `sidecar/*`, `render/*`,
`media/*`. `ipcMain.handle` registered once per channel (assert in a test); every
`webContents`/window listener removed on close; temp files created under the sandboxed
project temp dir and removed on job end and on startup sweep; file handles from
`fp-media://` streams closed on abort.
**Done when:** `lsof` count and child count return to idle after export and after AI run;
temp dir empty after each.

Landed 2026-08-29: `ipc/main-channel-registration.test.ts` scans every main-process
source and asserts each contract channel is `handle`d at most once, never both
`handle` and `on`, and that nothing the contract declares goes unserved. First run caught
`referencesAnalyze`: declared in the contract and preload since Phase 3, handled by
nothing — a desktop reference attachment could never resolve. Handler added in `main.ts`
(sandboxed path, sidecar analyzer, typed result). Render children die with their process
group (`killProcessGroup`, Phase 7). Remaining: the `lsof`/child-count idle assertion
after export and after an AI run (the resource spec measures `openFiles` and
`ffmpegCount` at session end; add an export leg), temp-dir sweep, and the `main.ts` split.

## P6.4 — Sidecar: emitters, caches, streams, MoviePy clip trees — `[ ]`

**Touches:** `service.py`, `render/resources.py` (`close_clip_tree`), `composition_cache.py`,
brain caches, analysis result caches, `queue.py`. Every clip tree closed in `finally`;
composition and analysis caches bounded and evictable; long-lived emitters audited for
subscriber growth; streaming responses closed on client disconnect.
**Done when:** sidecar RSS after 5 exports ≈ after 1 (±10%); no `ResourceWarning` under
`-W error` in engine tests.

Evidence 2026-08-29: `pytest -W error::ResourceWarning` over the whole engine suite —
2,723 passed, 0 ResourceWarnings (P6.4's second done-when condition holds).

Finding (2026-08-29): the composition cache is a bounded LRU with a build semaphore
(`composition_cache.py`); the only process-lifetime dicts in `service.py` are per-project
lock maps. Render children now die with their process group. Remaining: the 5-export RSS
measurement and `-W error` run.

## P6.5 — FFmpeg / ffprobe / frame buffers — `[ ]`

Every invocation through `subprocess_safety` with timeout; stdout/stderr drained (a full
pipe is a hang, not a leak, but shows up the same); frame grabs stream rather than
accumulate; no per-frame PIL images retained past the call.
**Done when:** P0.5 peak RSS for FFmpeg and sidecar during export is not higher after
Phase 7's changes, and 100 consecutive `get_frame` calls hold RSS flat.

## P6.6 — Resource regression test — `[~]` (gate written in `resource-baseline.spec.ts` behind RESOURCE_GATE=1; seeded-leak proof and CI lane pending)

**Touches:** `apps/desktop/scripts/resource-snapshot.mjs` → a vitest/e2e that runs the
P0.4 script and asserts growth bounds (heap, RSS, children, handles, listeners, object
URLs). Runs in CI on the desktop lane when a fixture is available; otherwise nightly.
**Done when:** the test exists, passes, and a seeded leak fails it.

## P6.7 — Close — `[ ]`

`06-after.md` with the P0.4 table re-run; each fix linked to its commit and root cause.

## Discovered

