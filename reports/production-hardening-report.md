# Production Hardening & UX Refinement — Final Report (Phase 15)

**Date:** 2026-07-06 · **Branch:** `milestone/production-hardening` · **ADR:** 0038
**Plan:** `plan/PRODUCTION-HARDENING.md` (per-item root causes + fixes)

## Verification

`pnpm verify` green from a warm cache — 16/16 turbo tasks (build, test, lint,
typecheck across every package) + engine pytest:

| Suite | Tests |
| --- | --- |
| ai-sdk | 383 (100% line/branch/function coverage) |
| editor-core | 173 |
| web-editor | 702 |
| desktop | 179 |
| shared-types | 19 |
| engine (pytest) | 478 |
| website | 15 + static export (26 routes) |

## Measured before/after (H22)

Micro-benchmarks over the real built modules (Node 24, M-series, single run —
order-of-magnitude evidence, not lab numbers):

| Metric | Before | After | Factor |
| --- | --- | --- | --- |
| Stream fold cost (H1): folding a conversation while streaming | full `reduceEvents` per event: **319ms for 4,000 events** (quadratic — ~8s at 20k) | incremental builder: **1.4ms for 20,000 events** | >200× at 4k, growing with length |
| Reasoning transport bytes (H1): one 2,000-chunk reasoning line | full-text snapshots: **32.2MB** over IPC/log | `reasoning_delta`: **275KB** | ~117× |
| Playhead queries (H3/H8): 6,000-clip project, 3,600 frames | linear scans: **0.14ms/frame** (and growing with clip count) | playback index: **0.8µs/frame** | ~170× |
| React commits while streaming (H1) | 1 per token | ≤1 per animation frame (rAF batcher) | chunk-rate-independent |
| Playback re-renders (H8) | whole transcript + caption lists per 60fps tick | only at word/cue boundaries | structural |
| Preview decode cost (H3) | camera originals always | 540p proxies (derived on import, idempotent) | media-dependent |

## Issues discovered → root causes → fixes

1. **"Buffered" AI reasoning (H1)** — quadratic full-text re-emission +
   whole-log refold + per-token dispatch + shimmer. Fixed with `reasoning_delta`
   events, an incremental view builder, frame-batched appends, and markdown
   token streaming.
2. **Preview flicker & heavy footage (H3)** — proxies were never generated;
   per-frame O(all clips) lookups; undecoded `<img>` painted at video→image
   cuts; stale frames over gaps. Fixed end-to-end (sidecar → contract → import
   → player) + `createPlaybackIndex` + decode/gap gates.
3. **Playback-time work (H8)** — transcript/caption panels re-rendered per
   tick. Boundary-stable `useSyncExternalStore` snapshots + binary searches.
4. **Vanishing timeline thumbnails / zoom lag (H6)** — fixed 8-frame filmstrip
   produced sub-pixel frames at low zoom; unthrottled placeholder repaints; no
   horizontal culling. Width-adaptive slots + rAF paints + `content-visibility`.
5. **Orchestration defects (H9)** — silent autosave/hydrate failures and a
   Stop-button race when switching providers mid-run. All observable/fixed;
   the validated apply chain was verified honest (no success without a real
   state change; patchId dedupe; blast-radius caps).
6. **Startup flash (H15)** — window shown before first paint; now
   `ready-to-show`-gated with a shell fade over the identical canvas colour.

## Features shipped

- On-canvas transform controls + live transform rendering in the preview (H4),
  on a new mirrored `add_keyframes.replace` op semantics (TS + Python).
- Project orientation presets in the monitor transport (H5).
- GitHub Models + GitHub Copilot providers, wired through every surface, with
  the Settings picker on the app's own Select (H11).
- AI sidebar accordions with remembered expansion, stable Stop button,
  Settings→AI deep-link (H2); AI-first right rail (H13); centered header with
  a status dot (H12); File→Home (H20); instant recents (H16); relevance-ranked
  project-index search + keyframed-clip query (H10); timeline tokens aligned to
  the reference mock (H7); motion scale + scrolling polish (H14/H19).

## Remaining technical debt / follow-ups

- Background proxy queue for sources over the 15-minute synchronous cap, and
  proxy retrofit for already-imported assets (H3 follow-up).
- Silence-analysis + scene-detection manual UI (engine-ready, AI-only today) —
  top of `reports/desktop-feature-audit.md`.
- Rotate handle on the transform controls; mask preview in the monitor.
- Opacity keyframe rendering (engine Phase 6) and CV-gated tools (dependency
  approval pending).
- Desktop MCP bearer-token wiring to a bundled client.
- Pre-existing: prettier `format:check` baseline is red on main (~90 legacy
  files); the `preload.cts` `require()` lint carve-out.

## Recommended next steps

1. Ship the two High-priority audit gaps (silence UI, scene markers).
2. Background proxy queue (unlocks feature-length footage end-to-end).
3. Phase 13 (agent-orchestration reliability R0–R5) remains the planned
   deep-dive on top of the H9 fixes.
