# Project-open and asset-panel performance

## Scope

This change targets the desktop project launcher to editor path and the editor Assets panel. It preserves project schemas, patch semantics, media metadata, sorting and filtering, selection, keyboard behavior, drag-to-timeline behavior, the MoviePy render path, and the existing desktop media sandbox.

## Root causes

### Project open

**Symptom:** the project file had already loaded, but the desktop open handler still waited before returning the editor document.

**Trigger:** `ProjectFileWatcher.watch()` reread, migrated, validated, and canonically serialized the same project file to establish its deduplication baseline. The open handler had just completed the same read and validation.

**Root cause:** watcher baseline initialization was awaited on the project-open critical path. Large projects therefore paid a second full project read, parse, migration, schema validation, and serialization before the renderer could show the editor.

**Change:** install the native file watch synchronously, initialize the canonical baseline in the background, and make real file events wait for that baseline before comparing. A generation token prevents a stale baseline from project A applying after a rapid switch to project B. No watcher work is dropped and external edits retain their ordering.

### Assets panel

**Symptom:** fast scrolling and remounting a large media bin left video decoders and canvas captures consuming resources after their cards left the virtualized window.

**Trigger:** each uncached video card queued a separate capture. The old concurrency gate limited active work to four, but could not remove abandoned queued captures, abort active captures, or share one in-flight capture between duplicate consumers.

**Root cause:** thumbnail work outlived the visible card that requested it. Large or rapidly scrolled bins accumulated stale decoder work and unnecessary garbage-collection pressure.

**Change:** a keyed four-slot capture pool shares one promise per resolved media source, removes queued work when its last consumer unmounts, and aborts a running `<video>` capture when its final consumer leaves. The existing 256-entry LRU result cache remains the completed-result cache.

## Performance budgets and regression evidence

The deterministic budgets enforced by focused tests are:

- No more than **4 active video thumbnail decoders**.
- A duplicate request for the same source creates **1 capture job**.
- A simulated 500-asset fast-scroll workload starts with 4 active and 496 queued jobs. Releasing offscreen cards leaves 4 active, 0 queued, and 4 tracked jobs. The previous gate retained all 496 abandoned queued jobs.
- `ProjectFileWatcher.watch()` resolves after installing the native watcher and does not await the duplicate baseline project parse.
- An external edit arriving during baseline initialization waits for that baseline and is emitted afterward, preserving correctness.

GitHub CI cannot produce trustworthy Electron wall-clock numbers against the creator's real camera files and local disk. This report therefore does not invent millisecond results. The project-open improvement removes one complete read, migration, validation, and canonical serialization from the awaited open path. Desktop profiling with the same real project should compare project-click to first editor paint before and after this branch.

## Failure handling

- Rapid project switching invalidates stale watcher baseline work.
- A missing or temporarily invalid file produces a null baseline, and the first later valid event is still emitted.
- Virtualized thumbnail cards cancel their queued or running work on unmount.
- Multiple consumers of one asset share work until the final consumer releases it.
- Decode failures continue to use the existing typed asset fallback rather than a blank cell or fake image.

## Verification

Required repository checks run through the existing pull-request CI. The focused regression files are:

- `apps/desktop/electron/projects/project-watcher.performance.test.ts`
- `apps/web-editor/src/editor/thumbnailCapturePool.test.ts`
- `apps/web-editor/src/editor/useAssetThumbnail.test.ts`

The implementation adds no dependency, schema change, IPC endpoint, sandbox expansion, renderer protocol change, or render-engine change.
