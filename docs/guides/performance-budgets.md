# Performance Budgets

> Phase 8 deliverable (plan/PLAN.md — "Performance budgets (preview latency, render
> throughput)"). These are the targets FramePilot holds itself to, how each is
> measured, and how regressions are caught. Budgets are **per the reference machine**
> (Apple M-series / equivalent x86, SSD, ffmpeg present) unless noted; CI runners are
> slower, so CI thresholds are the listed ceilings ×2.

## Why budgets

The product promise is a _responsive_ editor and a _deterministic, validated_ render.
A budget turns "feels fast" into a number we can defend and regress-test. We separate
two domains that fail differently:

- **Preview / interaction latency** — UI responsiveness. Owned by `apps/web-editor`.
- **Render throughput** — batch work in the Python engine. Owned by `engine/python`.

The render-vs-preview rule (AGENTS.md) means these never share a code path: preview is
HTML/canvas, render is MoviePy/FFmpeg.

## Interaction latency budgets (web-editor)

| Action                                              | Budget (p95) | Why                                          |
| --------------------------------------------------- | ------------ | -------------------------------------------- |
| Keystroke / pointer → patch applied → store updated | **< 16 ms**  | one frame at 60 fps; edits must feel instant |
| Timeline re-render after a committed patch          | **< 16 ms**  | dragging/trimming must track the cursor      |
| Playhead scrub → program-monitor frame update       | **< 33 ms**  | ≤ 2 frames; scrubbing stays legible          |
| AI proposal diff render (mock provider)             | **< 100 ms** | review UX feels immediate                    |
| Project open → editable (cold, demo project)        | **< 1 s**    | startup snappiness                           |

Every edit is a pure, synchronous `validate → apply → record` over an immutable
timeline (`@framepilot/editor-core`), so interaction cost is dominated by React render,
not by the patch engine. The patch engine itself is O(clips) per operation (no nested
scans) — the structural guarantee behind the 16 ms budget.

### Re-render scoping budgets (the 60 fps invariant)

Playback advances the playhead ~60×/s and ruler-scrub moves it per pointer sample, so
the amount of React work **per seek** is the real driver of playback/scrub smoothness.
The rule (plan Phase 12.1):

| Invariant                                                                                | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pure seek re-renders only the tiny nodes that show the live playhead                   | Playhead lives in a dedicated clock store (`editor/playhead-clock.ts`); only `PlayheadMarker`/`PlayheadScrubber`/`RulerBar` and the WebCodecs transport/caption live layer subscribe (`usePlayhead`). The imperative canvas owner never re-renders per frame. `Editor.tsx` memoises **every** non-live component on a key excluding `playhead` — panels, **Toolbar, and TimelineView**. **Guard: `components/Editor.perf.test.tsx`** asserts MediaBin/Toasts/Toolbar/TimelineView don't re-render on a seek while the timecode does |
| The heavy timeline lane tree is not rebuilt on a seek                                    | TimelineView itself doesn't re-render on a seek (above); its `trackLanes` memo also excludes `playhead`; `ticks`/`duration` memoised                                                                                                                                                                                                                                                                                                                                                                                                |
| The overview minimap is not rebuilt on a seek                                            | `React.memo(TimelineMinimap)` + memoised geometry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A zoom/pinch burst commits at most one store update per frame                            | rAF-batched wheel handler in `TimelineView`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A clip drag rebuilds lanes at most ~once per frame, and re-renders only the dragged clip | leading-edge rAF throttle on the drag ghost + `React.memo(TimelineClip)` (non-dragged clips bail)                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Components that MUST update on a seek (program monitor, toolbar timecode, timeline
playhead/ruler, inspector, transcript, caption highlight) are intentionally left in the
per-seek render path — their individual cost is small; the win is keeping the expensive,
playhead-independent subtrees out of it. When adding a panel, prefer keeping it
playhead-free and memoising it; if it needs the live position in a handler only, read it
via `useEditor().getPlayhead()` (stable) rather than `state.playhead` (a render dep).

## Render throughput budgets (engine)

| Metric                                 | Budget              | Why                                        |
| -------------------------------------- | ------------------- | ------------------------------------------ |
| Preview render (540p, ≤ 60 s timeline) | **≥ 1× realtime**   | preview must not feel slower than watching |
| Final export (1080p 9:16, ≤ 60 s)      | **≥ 0.3× realtime** | a 60 s Reel exports in ≲ 3.5 min           |
| Render validation pass (per output)    | **< 5 s**           | the auto-validation tax stays small        |
| Timeline compile (Timeline → MoviePy)  | **< 250 ms**        | compile is pure math, not IO               |

Renders run in a resumable background queue with timeout + cancellation
(`render/queue.py`), so a slow render never blocks the UI and a runaway render is
killed at the timeout rather than counting against throughput forever.

## WebCodecs preview compositor (default)

WebCodecs is the default for **bounded proxy-backed** picture media. Unproxied
video—including feature-length originals that exceed the synchronous proxy
limit—uses Chromium's streaming media-element preview instead of materializing
the whole source in renderer memory (ADR 0094).

The WebCodecs engine (ADR 0052) decodes proxy media itself and
composites on one `<canvas>`, so its budgets are decode/present latencies rather
than element-swap timings:

| Metric                                | Budget / evidence                            | Why                                                                |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| In-flight decoded `VideoFrame`s       | **≤ 24** (`RING_CAPACITY`)                   | frames are GPU-backed; frame-count is the cap                      |
| A/V sync drift                        | **≤ 1 frame** (33.3 ms); P0 measured 33.3 ms | audio-master clock; video slaved to it                             |
| Cold seek-to-frame (dev evidence)     | p95 1.8–2.5 ms                               | min-spec gate (≤ 100 ms p95) still needs the target device         |
| Leaked frames                         | **0** (`framesCreated === framesClosed`)     | an unclosed frame deadlocks the decoder silently                   |
| Wrong-segment / blank playback frames | **0** (P5–P7 + canvas-pixel sampler)         | never flash a stale clip or black frame at a cut                   |
| Live playhead direction               | **monotonic while playing** (P7)             | mixed silent/audible clips must not jump or reverse                |
| Playhead physical-pixel alignment     | **0 fractional physical positions** (P7)     | a 1px line must not shimmer between device pixels                  |
| Per-frame React canvas-owner renders  | **0**                                        | compositor painting stays imperative and isolated                  |
| Redundant source-frame draws          | **< 50% of display ticks** for 30 fps P7     | reuse resident pixels on 60/120 Hz displays; repaint for animation |
| Production canvas backing             | **`willReadFrequently: false`** (P7)         | retain Chromium's GPU-backed presentation path                     |
| Segment lookup                        | **O(log clips)**                             | playback cost must not grow linearly with movie cut count          |
| Caption/effect lookup per frame       | **current 5 s bucket only**                  | thousands of later cues/layers must add no per-frame scan          |
| Paused timeline/effect rAF loops      | **0 continuous loops**                       | an idle editor must not consume display-rate CPU                   |

The structural guards live in `selectors.test.ts` (unproxied two-hour media
chooses streaming), `temporal-index.test.ts` (7,200 cues remain locally bounded),
and `PreviewEffectOverlay.test.tsx` (paused effects schedule one frame only).

These are gated by the dedicated `preview-spike` Playwright project (real Chrome),
not the default suite. The P7 guard uses a portable mixed-audio fixture and
samples what Chrome actually paints; decode bookkeeping alone is insufficient.

## Caption and live-agent interaction budgets

Caption editing and the agent activity stream must keep work proportional to the visible
interaction, not to the length of the movie or conversation (ADR 0095):

| Invariant                               | Budget / evidence                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Mounted caption cue rows                | **< 50 for 7,200 cues**; the cue list is virtualized with a small overscan window                                              |
| Same-project host/agent commits         | **0 full Editor remounts**; validated project slices reconcile into the existing editor store                                  |
| Streaming conversation commits          | **≤ 20 Hz**; events remain lossless and are delivered in one store update per batch                                            |
| Markdown parses for partial stream text | **0**; growing assistant/reasoning text stays plain until the event settles                                                    |
| Historical event-row renders            | Memoized rows bail out when their event and callbacks are unchanged                                                            |
| Durable WAL reads during one live run   | **1 initial read**; validated events append against the in-memory run index in O(1)                                            |
| Undo-history bytes in an AI request     | **0**; Electron retains the host-owned recovery history while live editable slices cross IPC                                   |
| Durable WAL size                        | **≤ 64 MiB**; oversized legacy state is quarantined before JSON parsing                                                        |
| Continuous caption-style edits          | **1 durable patch per gesture**; pointer-frequency values remain local until release/blur                                      |
| Active-caption preview lookup           | **O(cues near the frame)** through the temporal index, never a full cue-lane scan per frame                                    |
| Restart-surviving undo payload          | **≤ 100 newest contiguous steps and ≈4 MiB**; the live session keeps its complete undo stack                                   |
| Event logs resident in the sidebar      | **≤ `MAX_LOADED_CONVERSATIONS` (3)**; hydrate reads metadata only, logs load on open and idle ones are evicted (flushed first) |
| Payload serialization per row render    | **0**; a row's copy text — `JSON.stringify` of the tool result included — is built on click, not on render                     |

The two entries above are the sidebar's **heap** budget rather than a latency one, and
they exist because the failure mode is different in kind: a slow frame is felt and
recovered from, while retained bytes accumulate silently across a session until the tab
is out of memory. Both holders were unbounded in the length of the _session_ rather than
of what is on screen — every past conversation's full transcript read at editor open, and
a fresh multi-megabyte string per row per streamed frame batch. Anything added to this
panel should be checked against the same question: does it retain in proportion to what
is displayed, or to everything that has ever happened?

The structural guards live in `CaptionEditor.test.tsx` (7,200-cue mount bound),
`useConversations.test.tsx` (metadata-only hydrate, resident-log cap, and the
never-write-a-stub-over-a-real-record safety property), `EventNode.test.tsx` (payload
serialized only when the clipboard asks),
`App.test.tsx` (same-project sync preserves the active workspace), `frameBatcher.test.ts`
(50 ms batching), `EventNode.test.tsx` (deferred Markdown formatting), and the desktop
run-coordinator suite (one disk read across a 120-event stream plus pre-parse quarantine),
`history.test.ts` (contiguous count/byte bounds), and the caption styling regression
(many slider changes produce one patch on release).

## Scale budgets (end-to-end audit, 2026-08-08)

The budgets above bound work against what is _on screen_. These bound it against what
crosses a _boundary_ — process, disk, or the JS heap — because that is where the
remaining costs scaled with the project rather than the interaction. The failure shape is
always one of four: bytes crossing a boundary where a path would do, a whole-project scan
after a one-track change, durability work at token frequency, or display/pointer-frequency
work that still reads project size.

| Invariant                                  | Budget / evidence                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer/main heap per media import        | **O(`MEDIA_IMPORT_CHUNK_BYTES`)**, not O(file); a multi-GB source is copied in bounded, offset-validated slices                       |
| Timeline scanned per validated operation   | **Only the operation's footprint** — `postValidationScope` names the touched tracks and which of overlap/transition/speed still apply |
| Snap-target work per pointer sample        | **0 rebuilds**; edges are cached on timeline identity and searched, not re-sorted and linearly scanned                                |
| Roll-gesture junction sorts                | **1 per track identity** for the whole gesture                                                                                        |
| DOM preview React commits during playback  | **≤ project fps**, independent of display refresh (120/144 Hz cannot multiply a 30 fps project)                                       |
| Bytes per routine authoritative commit     | **O(patch)**, not O(project); the renderer reconstructs the snapshot from its own cache, falling back to a full fetch                 |
| Full-file decodes per audio source         | **≤ 1**; concurrent consumers share one in-flight promise, and oversized browser fallbacks are refused rather than decoded            |
| fsyncs per streamed AI event               | **0**; the WAL descriptor stays open and checkpoints at recovery boundaries (plan/gate, patch decision, terminal, quit)               |
| Operation-array copies per grouped AI step | **0**; a run keeps compact per-commit entries and collapses **once**, at serialization                                                |
| Temporal-index references per long span    | **O(1)**, not one per 5s bucket; long spans are tiered into a separate structure                                                      |
| Change-detection cost per preview update   | **O(entries)** via semantic identity tokens; no `JSON.stringify` over EDL/effect/overlay payloads on the hot path                     |
| Durable replay lookup                      | **O(log n)/O(1)** by sequence offset, not a filter over the whole event array                                                         |
| Canonical serializations per project write | **1**; the bytes written to disk are the bytes fingerprinted                                                                          |
| Provider SDKs loaded when one is selected  | **1** (OpenRouter/NVIDIA deliberately share the OpenAI-compatible client)                                                             |

Structural guards: `import.test.ts` (bounded ordered chunks), `validation-scope.test.ts` +
`validator.test.ts` (footprint scoping with unchanged strictness), `snap-performance.test.ts`
(cached edges, junction reuse), `PreviewPlayer.frame-cadence.test.tsx` (one snapshot per
project frame while the raw clock ticks at display rate), `authoritative-patch.test.ts` +
`project-command-service.transport.test.ts` (delta transport and its full-snapshot fallback),
`useWaveformPeaks.test.ts` (in-flight dedupe and the size ceiling),
`run-store.performance.test.ts` (no fsync per append; checkpoint before snapshot; sequence
paging), `history.group-performance.test.ts` (compact live entries, collapse-once semantics),
`temporal-index.test.ts` (long-span tiering), `semantic-signature.test.ts` (signature size
independent of keyframe/text payload), and `langchain-providers.lazy.test.ts` (one chunk per
provider).

> **Note on the live/persisted history split.** Live history deliberately keeps one entry
> per commit and collapses groups only when producing restart history. Undo/redo still
> treats a contiguous run as one user action, and the persisted schema is unchanged — so
> the user-visible contract is identical, and only the allocation profile moved.

## Agent-run heap budgets (2026-08-15)

The budgets above bound work against what is on screen or what crosses a boundary.
These bound it against **the length of a run**, because that is the axis a long AI
session grows along, and every entry below was unbounded on it. The failure shape is
one of three: work started per turn with nothing limiting how much runs at once, a
ceiling expressed as a _count_ where the cost is _bytes_, or a value rebuilt at
display rate because its cache key changes at display rate.

| Invariant                                       | Budget / evidence                                                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Perceptual reviews in flight                    | **≤ 1** (`FRAMEPILOT_MAX_REVIEW_CONCURRENCY`); a review whose region a later turn rewrote is never started, and one running is aborted                                |
| Frame size review measures at                   | **≤ `REVIEW_MAX_DIMENSION`** (960 long edge), never the project's resolution: 273ms → 38ms per frame and 781 MB → 176 MB peak on an 8-clip 2160x3840 sequence         |
| Source decode resolution, review and frame grab | **≤ the frame it is composited into** (`compile_timeline(max_decode_dimension=)` → ffmpeg `-s`); export alone still decodes camera masters                            |
| Compositions being compiled at once             | **1** process-wide (`MAX_CONCURRENT_BUILDS`), bounded in the cache so every caller passes it — `/render/frame` and the MCP server included, not just the review route |
| Frames a review batch holds resident            | **comparison frames only**, capped by `MAX_RESIDENT_FRAME_BYTES` (512 MiB) — a byte budget, because 400 frames is 2.5 GB at 540p and ~80 GB at UHD                    |
| Decoder output width in review                  | **`uint8`**, never promoted; consumers divide by 255.0 into float64 transiently                                                                                       |
| Concurrent `/review/temporal-evidence` batches  | **1** process-wide, for every caller including the MCP server                                                                                                         |
| ffmpeg readers after a compile that raises      | **0**; `compile_timeline` closes what it opened before re-raising (measured: 12 live children → 0)                                                                    |
| Undo-stack folds per committed edit             | **0**; the history panel folds to the one cursor position it is asked about, never to all of them                                                                     |
| Review-card builds per edit                     | **1**; a card is a pure function of an immutable `EditResult` identity, so it is `WeakMap`-cached rather than rebuilt per frame batch                                 |
| Decoded `VideoFrame`s leaked per run            | **0** on every path — range rejection, superseded seek, and client dispose all close what they collected                                                              |

Structural guards: `review-findings.test.ts` (concurrency ceiling, supersession skip,
queued-review drain, cancellation is not a reviewer failure), `test_temporal_evidence.py`
(`_FramePlan` retention, `uint8` cache, comparison byte budget, review frame size, the
largest legal batch fitting the resident budget), `test_render_compiler.py`
(`TestDecodeBudget`: the budget reaches the decoder, never upscales, and closes the reader
it replaces), `test_render_frame_grab.py` (composite sized to the request, named presets
composited as authored), `test_composition_cache.py` (one build at a time across distinct
keys; a queued caller reuses what it waited for), `test_render_resources.py` (live-child
count after failed compiles), `HistoryPanel.perf.test.tsx` (commit cost against a no-panel
baseline, flat as the stack grows), `ai.review-card.test.ts` (card identity reuse), and
`worker-client.test.ts` (frames closed on reject/dispose, not closed when handed on). Each
of the leak guards fails against the code it replaced.

**Counts that are legitimately counts.** `RING_CAPACITY = 24` (decode-ahead
`VideoFrame`s) and `MAX_DECODED_BITMAPS = 256` (thumbnail bitmaps) are item ceilings, and
the rule above says an item ceiling is not a memory bound. They are sound anyway, for a
reason worth writing down rather than re-deriving: the resolution feeding them is bounded
upstream. `WebCodecsPreviewPlayer` mounts only when every video source has a proxy, and
proxies are 540p (`media/derive.py`), so 24 frames is tens of megabytes and cannot become
gigabytes the way 400 review frames could. If preview ever decodes masters, both become
byte budgets on the same day.

> **The question to ask of anything added to an agent run.** The panel budget above asks
> whether a holder retains in proportion to what is displayed. These ask two more: does
> this start work per turn without a limit on how much runs at once, and is its ceiling
> expressed in the unit that actually costs — bytes, not items? A frame count is not a
> memory bound, and "it is detached so it does not block" is not a statement about cost.

## Visual retrieval budgets (engine — Media Intelligence, MI7.1)

The visual index/search path (`brain/vector_store.py`, `brain/visual_search.py`) has
its own budgets, guarded by `engine/python/tests/test_visual_perf.py`:

| Metric                                                    | Budget                 | Status                                  |
| --------------------------------------------------------- | ---------------------- | --------------------------------------- |
| `VisualVectorStore.search` p95 @ 50k vectors (sqlite-vec) | **< 100 ms**           | **met** (~64 ms, 2026-07-18) — see note |
| Index-write throughput (`upsert`: durable + `vec0` index) | **≥ 500 rows/s** floor | met (~2–4k rows/s reference)            |

**How measured.** A seeded synthetic corpus (deterministic; `EMBEDDING_DIM = 1024`, a
representative CLIP-class width — the production dim is captured at runtime from the
`nvidia/llama-nemotron-embed-vl-1b-v2` response and is never hardcoded) is built on the
real sqlite-vec backend; search p95 is taken over many warmed iterations. Throughput
times only `VisualVectorStore.upsert` (durable BLOB write + `vec0` index maintenance) so
the number reflects our engine code — **it deliberately excludes ffmpeg keyframe
extraction and the NVIDIA embedding-API latency** (third-party costs we do not
regress-gate).

**Gate / non-flakiness.** The tight `< 100 ms @ 50k` assertion is opt-in behind the
`FRAMEPILOT_PERF=1` env gate; the default `pnpm engine:test` run builds a small corpus,
**measures + logs** the numbers, and asserts only a generous regression ceiling (catches
an algorithmic blow-up without failing on runner jitter). Run the real budget on the
reference desktop:
`FRAMEPILOT_PERF=1 uv run pytest engine/python/tests/test_visual_perf.py -s`. When the
`vec0` extension will not load, the KNN budget is _skipped_, never failed.

> **Met (reference M-series, 2026-07-18): search p95 @ 50k is ~64 ms (was ~1–3 s).**
> The prior cost was two _per-search_ O(n) materializations, not the vec0 KNN itself
> (isolated: raw KNN p95 ~52 ms, `_MAP_TABLE` full scan ~64 ms, `_span_meta()` 50k-row
> Pydantic rebuild ~259 ms). The fix resolves span metadata and rowid→key for **only the
> top-k hit rowids** via indexed point lookups (`_rowid_keys` over `_MAP_TABLE`'s integer
> PK; `_span_meta_for` over `visual_spans`' composite PK via a row-value `IN`), turning
> two O(n) passes into O(k) (k ≤ 50) on the unfiltered hot path. What remains is the raw
> KNN (~52 ms), so the strict gate now passes with no schema/index change. The filtered
> (`assetIds`/`timeRange`) path still fetches all ranked candidates before filtering to
> avoid starving the result below k — that path is O(n) by construction and unchanged.
> Regression guard: `test_vec_path_resolves_metadata_only_for_top_k` pins that the
> lookups see at most k keys/rowids, so a revert to full materialization fails a test.

**Indexing on real media (desktop, still open).** The throughput floor above bounds only
the deterministic write path. The plan MI7.1 promise of throughput _on minutes-long
camera files_ (ffmpeg decode + NVIDIA embed end-to-end) can only be verified on the
desktop and is **not** covered by the hermetic unit guard.

## How they're measured

- **Interaction:** `performance.now()` around the store's `commit` path and React
  Profiler in dev. A coarse regression guard lives with the editor-core benchmarks
  (apply N=10k sequential patches well under a generous ceiling) so a catastrophic
  O(n²) regression fails CI without making the suite flaky on timing.
- **Render:** the engine's render job records wall-clock per state
  (`preparing_assets → rendering_frames → encoding → validating_output`); divide the
  timeline duration by encode wall-clock for the realtime multiple. The golden-media
  fixture render (`tests/test_render_golden.py`) is the deterministic sample.

## Enforcement & monitoring

- **CI (hard):** the editor-core test suite + the structural complexity guard.
- **CI (informational):** render fixture timing is logged in the `python-engine` job;
  a large swing is reviewed, not auto-failed (runner variance is high).
- **Local:** `pnpm --filter @framepilot/editor-core test` for the interaction guard;
  `cd engine/python && uv run pytest tests/test_render_golden.py -q` for a render timing
  sample.
- **Release:** the [v1.0.0 release checklist](release-checklist-v1.md) includes a
  manual budget spot-check on the reference machine.

## Out of scope (tracked in Phase 9)

Continuous perf dashboards, real-device telemetry of interaction latency (would build on
the opt-in local telemetry), and GPU-accelerated preview are post-v1.
