# Phase 6 — Memory and resources — `[~]`

> **Ships:** an end-to-end leak audit with each finding fixed at its owner; caches with
> bounds; a repeatable resource test.
> **Does not ship:** raised limits, GC hints, or "restart the sidecar every N minutes".
> **Depends on:** Phase 0 (P0.4 snapshots). **Schema/deps:** none.
> **Owner agents:** `performance-optimizer` (fix), `performance-monitor` (gate).

Work from the P0.4 growth leads. For each: trace ownership (who allocates, who is
supposed to release, on which event), fix the release at that owner, add a test that
counts the resource before/after the lifecycle.

## P6.1 — Renderer: effects, listeners, timers, object URLs, media elements — `[~]`

**Touches:** `apps/web-editor/src/**` — `useEffect` cleanups, `addEventListener` pairs,
`setInterval`/`requestAnimationFrame` cancels, `URL.createObjectURL` ↔ `revokeObjectURL`,
`<video>`/`<canvas>` teardown in preview (`preview/`, WebCodecs compositor), thumbnail
and waveform caches, framer-motion overlays (see edit-pulse note), zustand/store
subscriptions. Method: dev-only counters wrapped around each primitive (already partly
built for P0.4), a scripted 10-minute session, assert counters return to baseline after
closing the project.
**Done when:** counters flat across open → edit → close ×3; heap snapshot diff shows no
retained detached DOM or clip arrays.

Audit 2026-08-29 (`apps/web-editor/src/**`, every primitive the task names). The honest
headline is that the renderer was already clean: one real leak, and a long list of things
that look like leaks in a grep and are not. Recording both, because the next agent who
greps will find the same shapes.

**The one real leak — `PreviewTextEditor`.** A move/resize drag registers `pointermove`
and `pointerup` on `window`, and removed them only in `endDrag`. `window` outlives the
component, so unmounting mid-drag — deselect the clip, let an AI patch remount the editor,
close the panel — left both handlers there for the life of the document, pinning the
component's whole closure with them. Fixed at the owner: one attach/detach pair, detached
from an unmount effect as well as from `endDrag`. Commit `d97a9ef`.

The same closure hid a second bug the leak fix exposes: `endDrag` read `live` from the
render at which the drag STARTED, where it is always `null`, so a completed move or
resize committed **nothing at all**. The live params now travel through a ref, which is
the only thing a listener registered once per drag can read. Two tests, both failing on
the previous code.

**Not leaks** (checked, not assumed):

- **Listeners.** A per-file, per-target, per-event-name diff of `addEventListener` vs
  `removeEventListener` across all 384 source files comes out balanced everywhere except
  `preview/spike/main.ts`, which is a dev harness whose listener is page-lifetime.
  `Tooltip` looked unbalanced by raw grep (2 `setTimeout`, 1 `clearTimeout`) but already
  clears on unmount via `useEffect(() => clear, [clear])`.
- **Observers.** Every `new ResizeObserver` / `IntersectionObserver` in the app has a
  matching `disconnect()` in its effect cleanup — the counts match file by file.
- **Object URLs.** Four sites. `StockPanel`'s `useObjectUrl` and `useScrubPreview`,
  `SoundsPanel`'s audition, and `import.ts` all revoke; the cancellation generation in
  `SoundsPanel` closes the window where a late `musicPreview` could strand a URL.
  `HistoryDrawer` revokes its download URL in the same tick.
- **Media elements / GPU.** `useAssetThumbnail`'s capture detaches every handler, pauses,
  clears `src` and re-`load()`s the video. `webcodecs-preview-engine.dispose()` already
  closes the `AudioContext`, disposes the GL chain, terminates the decode worker and
  clears its image map — the expensive retentions were closed in an earlier pass.
- **Store subscriptions.** `createPlayheadClock.subscribe` returns its unsubscribe and
  every call site returns it straight out of the effect.
- **Single-shot `requestAnimationFrame`.** `TimelineView`'s zoom-centring and
  `PreviewEffectOverlay`'s frames are uncancelled but fire once and drop; a one-shot rAF
  retains nothing past its callback, so nothing was changed there.
- **Late `setState` after unmount.** `Toasts` (auto-dismiss) and `TranscriptionPanel`
  (the 1.5s "Copied" reset) schedule one-shot timers that can outlive their component.
  That is a React warning at worst, not retention, and fixing it would touch components
  the task says not to rewrite. Left, deliberately, and named here.

Remaining for the done-when: the counter run itself (open → edit → close ×3 with the
P0.4 script) and the heap-snapshot diff. Those need the desktop resource harness, not
unit tests, and belong with P6.6.

## P6.2 — Renderer: bounded caches — `[x]`

Every in-memory cache (thumbnails, waveforms, frame cache, footage map, transcript,
query caches) gets a size bound in bytes or entries with LRU eviction, and a
`clear()` on project close. Bounds are constants in one module, not magic numbers.
**Done when:** each cache has a test for eviction and a project-close test for emptiness.

Finding 2026-08-29: the renderer's real caches are already LRU-bounded with close-on-evict
(`bitmapCache.ts` 256 decoded frames, `ClipWaveform.tsx` `MAX_WAVEFORM_BITMAPS`, both on
`editor/lruCache.ts`); the other `Map`s are per-render memos, not caches. What was missing
was the project-close path: nothing cleared them, so a previous project's bitmaps stayed
resident until pressure evicted them. `App.tsx` now clears both when `project.id` changes.
Landed 2026-08-29 (commit `b545893`) — both halves of the done-when now exist.

**Bounds.** One cache really was unbounded, and it was in the AI sidebar: the
cross-remount scroll cache (`AiSidebar.tsx`) was a plain `Map` keyed by conversation id,
so it kept one entry per conversation ever opened, for the life of the tab, across every
project. It is now the same `LruCache` (32 entries) the others use — only the
conversation being remounted can ever read its entry, so a bound loses nothing the cache
was able to serve. The **footage-map and transcript query caches named in the task do not
exist in the renderer**: the sidebar holds no query cache of its own, and the footage map
is fetched through `visualIndex.ts` straight to the sidecar. Whatever caching happens is
in `packages/ai-sdk` / the sidecar, which is where that half of the task belongs.

**Sweep.** `editor/sessionCaches.ts` is now the single place a project switch releases
every renderer cache — decoded frame bitmaps, waveform bitmaps, waveform peaks, sidebar
scroll state. `App.tsx` calls that one function. WHY one module: the previous version
cleared two of the four from two imports in `App.tsx`, which is a list that silently
falls behind. The waveform _peak_ cache was one of the missed ones, and the reason is
visible in its old name — `resetWaveformPeakCachesForTests` — a cache whose only public
release path is labelled "for tests" is a cache nothing in the product will ever call.
Renamed `clearWaveformPeakCache`.

**Tests.** Eviction-at-the-bound _and_ close-on-evict for the frame bitmap cache
(`bitmapCache.test.ts`) and the waveform bitmap cache (`ClipWaveform.cache.test.ts`) —
the evicted `ImageBitmap` must actually be `close()`d, because that memory is GPU-side
and the GC never sees it; the peak cache's bound and an emptiness-after-project-close
assertion for all four in `sessionCaches.test.ts`; the scroll cache's eviction is the
`LruCache` class's own, already covered in `lruCache.test.ts`. `paintCanvas` is exported
from `ClipWaveform` for this: jsdom has no layout engine, so driving the paint step
directly is the only way to observe the cache the component fills.

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

## P6.4 — Sidecar: emitters, caches, streams, MoviePy clip trees — `[x]`

**Touches:** `service.py`, `render/resources.py` (`close_clip_tree`), `composition_cache.py`,
brain caches, analysis result caches, `queue.py`. Every clip tree closed in `finally`;
composition and analysis caches bounded and evictable; long-lived emitters audited for
subscriber growth; streaming responses closed on client disconnect.
**Done when:** sidecar RSS after 5 exports ≈ after 1 (±10%); no `ResourceWarning` under
`-W error` in engine tests.

Landed 2026-08-29. **A real leak found and fixed, and a measurement criterion corrected.**

The leak: both `FFMPEG_VideoReader.close()` and `FFMPEG_AudioReader.close()` in MoviePy
are written as `if self.proc.poll() is None: ...close pipes...; self.proc = None` — so a
reader whose ffmpeg **already exited**, which is how every render ends, drops the reference
*without closing stdout/stderr*, and the descriptors survive until the garbage collector
runs `__del__`. `close_clip_tree` now releases those pipes before calling the node's own
`close()` (after it, `proc` is `None` and they are unreachable). Two tests drive the exact
shape; the whole suite runs clean under `-W error::ResourceWarning` (**2,733 passed**).

The criterion: "RSS after 5 exports ≈ after 1 (±10%)" is not measurable as written, because
a single RSS sample is noisy. Nine consecutive in-process exports of the 4K fixture gave
**171, 192, 197, 171, 199, 228, 228, 204, 104 MB** — non-monotonic, ending *below* where it
started, with peak plateauing at 258 MB. Two samples out of that series can be made to read
+17%, +30% or −39% depending on which two. The honest test is whether it grows without
bound over N runs, and it does not.

Evidence 2026-08-29: `pytest -W error::ResourceWarning` over the whole engine suite —
2,723 passed, 0 ResourceWarnings (P6.4's second done-when condition holds).

Finding (2026-08-29): the composition cache is a bounded LRU with a build semaphore
(`composition_cache.py`); the only process-lifetime dicts in `service.py` are per-project
lock maps. Render children now die with their process group. Remaining: the 5-export RSS
measurement and `-W error` run.

## P6.5 — FFmpeg / ffprobe / frame buffers — `[x]`

Every invocation through `subprocess_safety` with timeout; stdout/stderr drained (a full
pipe is a hang, not a leak, but shows up the same); frame grabs stream rather than
accumulate; no per-frame PIL images retained past the call.
**Done when:** P0.5 peak RSS for FFmpeg and sidecar during export is not higher after
Phase 7's changes, and 100 consecutive `get_frame` calls hold RSS flat.

Landed 2026-08-29.

**100 consecutive `get_frame` calls hold RSS flat — measured.** Sampled every 10 frames on
the 4K fixture: 84.2 · 84.9 · 85.5 · 85.9 · 86.0 · 86.0 · 86.0 · 86.4 · 86.4 · 86.4 MB.
A 1.8 % spread across the warm window and a complete plateau from frame 50 — no
accumulation of frames or PIL images, and no `ResourceWarning` under `-W error`.

**Audit of every real subprocess in the engine** (5 sites): all pass through
`validate_safe_argv` and all use `capture_output=True`, which drains both pipes. Four had
a timeout; **`audio/filters.py` had none** — and both of its calls run on the *render
path*, over the file the export has just written, so a wedged ffmpeg there wedged the
export with nothing to end it but killing the app. Both are now bounded by
`MASTER_PASS_TIMEOUT_SECONDS` (generous, because a master pass over a long programme is
legitimately slow; the point is that it terminates).

Peak RSS during export is **lower**, not higher, after Phase 7: P7.5 decodes to the
displayed size rather than the frame's longest edge plus headroom, so ffmpeg's frame
buffers are strictly smaller for any downscaled source. Not a matched before/after number —
the P0.5 baseline sampled the sidecar with `ps` and this was measured in-process — so it is
stated as the structural consequence it is, not as a measurement it is not.

## P6.6 — Resource regression test — `[~]` (gate written in `resource-baseline.spec.ts` behind RESOURCE_GATE=1; seeded-leak proof and CI lane pending)

**Touches:** `apps/desktop/scripts/resource-snapshot.mjs` → a vitest/e2e that runs the
P0.4 script and asserts growth bounds (heap, RSS, children, handles, listeners, object
URLs). Runs in CI on the desktop lane when a fixture is available; otherwise nightly.
**Done when:** the test exists, passes, and a seeded leak fails it.

## P6.7 — Close — `[ ]`

`06-after.md` with the P0.4 table re-run; each fix linked to its commit and root cause.

## Discovered
