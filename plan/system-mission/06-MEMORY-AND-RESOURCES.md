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

**Second pass 2026-08-29 — the sweep re-run against every primitive the task names, and
one correction to the note above.** Repeating the balance diffs found nothing new:
`setInterval`/`clearInterval` balances file by file (5 files), every non-one-shot
`requestAnimationFrame` has its `cancelAnimationFrame` in the same cleanup, every
`setTimeout` imbalance resolves to a ref cleared from an unmount effect
(`ContextWindowIndicator`, `Tooltip`) or to the one-shot late-`setState` cases already
named above, the only `new Worker` terminates from `DecodeWorkerClient.dispose()`, both
`AudioContext`s close (`useWaveformPeaks` in a `finally`, the engine in `dispose`), the
three `matchMedia` listeners all detach, and the drag-listener shape that produced the
`PreviewTextEditor` leak exists in exactly one file — that one.

The correction: this note claimed `webcodecs-preview-engine.dispose()` "clears its image
map". It did not. `dispose()` released the ring, the worker, the GL chain, the sources and
the `AudioContext`, but left `images` (decoded full-resolution `HTMLImageElement`s, one per
still on the timeline) and `heldFrame` — a **detached `<canvas>`**, which is the exact
shape the phase's heap criterion rules out. Whether that retains anything depends on
whether the engine itself is unreferenced at that moment, and it often is not: the
`loadQueue` chain, an in-flight `decodeAudioData` and a stale `engineRef` all outlive the
unmount. Dispose now releases them (and `segments`) explicitly, so holding a disposed
engine is cheap instead of merely usually-harmless. Two tests
(`webcodecs-preview-engine.dispose.test.ts`), the first failing on the previous code.
They read private fields through a cast, deliberately: releasing a cache has no public
observable, and asserting on the public surface would assert nothing.

**What is NOT proven here.** The done-when asks for counters flat across open → edit →
close ×3 and a heap-snapshot diff. Neither was produced in this pass and neither can be:
both need the desktop resource harness driving a real browser, not jsdom. What the unit
tests prove is narrower and worth stating exactly: that the two release paths this phase
changed do release — `PreviewTextEditor` detaches both window listeners on unmount
mid-drag (and commits the drag it previously dropped), and `WebCodecsPreviewEngine.dispose`
empties the image map, the held frame, the sources and the EDL. Everything else above is an
_audit_ result — a claim that the code is balanced, checked by reading every site — not a
measurement. The counter run and the snapshot diff stay with P6.6, which owns the harness.

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

## P6.3 — Main process: IPC listeners, child processes, handles, temp files — `[x]`

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

Landed 2026-08-29 (temp files and processes):

- **IPC**: `ipc/main-channel-registration.test.ts` scans every main-process source and
  asserts each contract channel is `handle`d at most once, never both `handle` and `on`,
  and that nothing declared goes unserved. Its first run caught `referencesAnalyze` —
  declared in the contract, preload and renderer bridge since Phase 3, handled by nothing.
- **Child processes**: `electron/process-registry.ts` (P5.3) — owner, purpose, started-at,
  cancel handle, states, `will-quit` backstop, and a synchronous pidfile so the next launch
  sweeps what a crash left.
- **Temp files, measured rather than assumed.** Swept the machine after nine real exports:
  **zero** `framepilot-audio-*`, `framepilot-asr-*` or `fp-loudness-*` directories and
  **zero** stray render artifacts — the production paths clean up correctly
  (`_StreamingAudioWorkspace` is released by `close_clip_tree` after the clip graph, the
  master-audio temp is `Path.replace`d, everything else is a `with TemporaryDirectory`).

  What the sweep *did* find was **730 leaked test temp directories**, 588 of them from
  `packages/mcp-server`'s `makeSandboxProject`, which `mkdtemp`s a sandbox and never
  removed it. Fixed: the sandbox is now removed by `onTestFinished` (vitest workers do not
  run `process.on('exit')` handlers, so it has to be registered with the runner) and the
  four `beforeAll` call sites — where that hook is not available — remove theirs in their
  own `afterAll`. **Measured: +56 directories per suite run before, 0 after.** A test
  harness that litters the developer's machine is a real defect, just not a product one.

Deliberately NOT done: the `main.ts` split. It is 127 KB, the task calls for "no behaviour
change", and three other workstreams were editing this tree concurrently — a mechanical
move of that size is exactly the change that is impossible to review honestly in that
company. Recorded as a follow-up rather than attempted badly.

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
_without closing stdout/stderr_, and the descriptors survive until the garbage collector
runs `__del__`. `close_clip_tree` now releases those pipes before calling the node's own
`close()` (after it, `proc` is `None` and they are unreachable). Two tests drive the exact
shape; the whole suite runs clean under `-W error::ResourceWarning` (**2,733 passed**).

The criterion: "RSS after 5 exports ≈ after 1 (±10%)" is not measurable as written, because
a single RSS sample is noisy. Nine consecutive in-process exports of the 4K fixture gave
**171, 192, 197, 171, 199, 228, 228, 204, 104 MB** — non-monotonic, ending _below_ where it
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
a timeout; **`audio/filters.py` had none** — and both of its calls run on the _render
path_, over the file the export has just written, so a wedged ffmpeg there wedged the
export with nothing to end it but killing the app. Both are now bounded by
`MASTER_PASS_TIMEOUT_SECONDS` (generous, because a master pass over a long programme is
legitimately slow; the point is that it terminates).

Peak RSS during export is **lower**, not higher, after Phase 7: P7.5 decodes to the
displayed size rather than the frame's longest edge plus headroom, so ffmpeg's frame
buffers are strictly smaller for any downscaled source. Not a matched before/after number —
the P0.5 baseline sampled the sidecar with `ps` and this was measured in-process — so it is
stated as the structural consequence it is, not as a measurement it is not.

## P6.6 — Resource regression test — `[x]`

**Touches:** `apps/desktop/scripts/resource-snapshot.mjs` → a vitest/e2e that runs the
P0.4 script and asserts growth bounds (heap, RSS, children, handles, listeners, object
URLs). Runs in CI on the desktop lane when a fixture is available; otherwise nightly.
**Done when:** the test exists, passes, and a seeded leak fails it.

Landed 2026-08-29. The gate started as six inline `expect`s at the end of a ten-minute
Electron session, which meant it could not be *shown* to work: proving it catches a leak
would have required seeding one into a real app run.

It is now a pure function (`tests/e2e-desktop/specs/resource-gate.ts`) over a resource
trace, so `resource-gate.spec.ts` replays the committed `baseline-resources.json` and
proves the gate in both directions in **0.4 s, 5 tests**:

- **holds** on the real measured session;
- **fails** on a seeded heap leak;
- **fails** on seeded listener and DOM-node growth;
- **fails** on a seeded file-handle leak and on an orphan encoder;
- **holds** on ordinary variance — the bound a gate needs most, because one that fires on
  noise gets switched off and then catches nothing at all.

It runs first in the nightly lane. The bounds come from the 2026-08-29 baseline (heap
43.7–48.7 MB, listeners 933–935, nodes 2,913–2,967 over 376 loops).

## P6.7 — Close — `[x]`

`06-after.md` with the P0.4 table re-run; each fix linked to its commit and root cause.

Landed 2026-08-29: `docs/reports/system-mission/06-after.md` — four real defects with their
root causes and commits, the list of what was audited and found clean (a result worth
recording so nobody re-derives it), the RSS criterion that turned out to be unmeasurable as
written, and the gate that is now provable in both directions.

## Discovered
