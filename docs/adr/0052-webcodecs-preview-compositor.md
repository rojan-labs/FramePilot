# ADR 0052 — WebCodecs preview compositor + proxy re-encode

- **Status:** Accepted (single program-monitor engine)
- **Date:** 2026-07-11
- **Last updated:** 2026-07-30
- **Builds on:** ADR 0001 (reversible operations / render-vs-preview split),
  ADR 0046–0048 (clip speed / crop / blend mode), the Phase 12.1 preview
  pre-roll fix.
- **Part of:** `plan/PREVIEW-WEBCODECS-COMPOSITOR.md` (P-1, P0–P4).

## Context

The program monitor (`apps/web-editor/src/components/PreviewPlayer.tsx`) plays a
montage by swapping between a pool of five persistent `<video>` elements on a
single rAF clock driven by the front element's `currentTime`. The Phase 12.1
pre-roll fix removed the `play()`-startup freeze at cuts, but two residuals are
**inherent to element-swapping** and cannot be closed within that design:

1. **Untrimmed clips** (`sourceStart ≈ 0`) have nothing to seek back into, so
   they get no pre-roll runway and still pay a small `play()` cost at their cut.
2. **Independent decode pipelines** each have their own clock and buffering, and
   the browser's compositor decides when each `<video>` paints — so frame-exact,
   tear-free continuity across a cut is never *guaranteed*, only made likely.

An exported file has neither problem because it is a **single continuous
decode**. The only way to reproduce that in the browser is to **become the
decoder ourselves**: decode frames ahead into a unified buffer and present them
on one clock.

Two things had to be settled before committing to that:

- **Suspect the proxy first (P-1).** The old proxies were encoded
  `-c:v libx264 -preset veryfast -crf 28` with no `-g`, `-sc_threshold`,
  `+faststart`, or fps normalization — yielding ~250-frame GOPs, scene-cut
  keyframes at arbitrary positions, an end-of-file `moov`, and VFR passthrough.
  Every seek/pre-roll to a cut forced a decode from a keyframe up to ~8s away.
  This alone plausibly explained most of the felt jitter, and a proper re-encode
  is a hard prerequisite for any honest measurement.
- **MSE vs raw WebCodecs.** Both collapse to Chromium on the Electron target, so
  MSE's cross-browser advantage is moot.

## Decision

### P-1 — Fix the proxy encode

`engine/python/framepilot_engine/media/derive.py` (`generate_proxy`) now encodes
a **CFR, closed-GOP, BT.709, faststart** proxy:

- `-vf "scale=-2:720,fps=30"` — CFR, kills VFR at the source.
- `-g 15 -keyint_min 15 -sc_threshold 0 -flags +cgop -bf 0` — half-second
  **closed** GOPs, no scene-cut, **no B-frames** (decode order = presentation
  order → a trivial frame queue and tolerable reverse scrub).
- explicit `-colorspace/-color_primaries/-color_trc bt709`.
- `-movflags +faststart` — a front-loaded `moov` gives MP4Box.js O(1) random
  access.

The cache digest is salted with `PROXY_ENCODE_VERSION`
(`service.py:derive_proxy_path`) so existing proxies invalidate and re-derive on
the next preview-media request instead of silently reusing a stale transcode.

### The preview compositor — **WebCodecs, not MSE**

MSE (per-timeline concatenated fMP4 + `timestampOffset`/`appendWindow`) would
give a single pipeline, single clock, and native A/V sync "for free" — but it
yields **no canvas compositor**, so P3 parity (overlays / transform / grade /
crop / blend in one pass, which FramePilot genuinely needs) does not fall out of
it; compositing over an MSE `<video>` via `drawImage` rebuilds half the
WebCodecs renderer with less control. **We chose WebCodecs.** If P3 compositing
parity were ever dropped, MSE would be the cheaper path — revisit only then.

The compositor lives in `apps/web-editor/src/preview/` and is a **consumer** of
the same pure projections the pool uses (`selectors.ts`) — no timeline/schema
change, no new patch types (AGENTS.md invariants preserved). It is **preview
only**; MoviePy/FFmpeg remains the sole export path (render-vs-preview rule).

## Architecture

- **Demux + decode in a Worker** (`preview/decode/decode-worker.ts`): MP4Box.js
  (`mp4box`, BSD-3-Clause) demuxes the media; one long-lived
  `VideoDecoder` **per source**, reused across every trim/segment via
  `reset()` + `configure()` — never a new decoder per seek (that leaked a
  decoder each time and silently exhausted Chrome's concurrent-decoder limit).
  The decoder **streams**: a `decodeRange` contiguous with the previous one
  just feeds the next chunks — no reset, no keyframe-prefix re-decode, no
  `flush()` (`O(window)` amortized). Only a true seek reconfigures; `flush()`
  happens only at end-of-table or as a bounded stall fallback (a hardware
  decoder withholding output is dislodged by one-chunk overfeeds whose
  beyond-range products are stashed for the next window). The original
  flush-per-window design cost `O(GOP + window)` per 8-frame window — fine on
  gop=15 proxies, catastrophic on real footage (GOP 30–60, 1080p/4K).
- **Presentation-exact sample mapping** (`preview/demux/mp4-demuxer.ts`): all
  indices are presentation indices backed by exact per-sample timestamp tables
  (decode-order chunks + presentation-order timestamps + decode-index
  translation), normalized to a 0-based presentation clock (B-frame encoders
  shift cts by the reorder delay). This replaces the CFR
  `round(t / frameDuration)` mapping, which mis-indexed VFR and B-frame
  footage — real (unproxied) camera files, not just P-1 proxies, now map
  frame-exactly.
- **Continuous project-time audio master** (`preview/clock/audio-clock.ts`):
  playback is anchored once to `AudioContext.currentTime`; video frame selection
  derives continuous **project time** from that anchor, not from the subset of
  clips that contain audio and not from rAF. Audible buffers are scheduled at
  their real project offsets, so video-only clips, stills, and gaps remain in
  time as silence instead of being compacted out of the clock. A muted-`<video>`
  audio sidecar was explicitly rejected (it reintroduces the independent-clock
  drift this exists to eliminate).
- **Frame queue / jitter buffer** (`preview/decode/frame-ring.ts`): a windowed,
  ring-paced decode-ahead bounded by **frame count** (`RING_CAPACITY = 24`), not
  MB — frames are GPU-backed and every one must be `.close()`d promptly or the
  decoder deadlocks silently.
- **The engine** (`preview/engine/webcodecs-preview-engine.ts`) drives one
  `<canvas>` from an ordered multi-segment EDL (`canvasPreviewEligible` /
  `pictureSegments`): play/pause/seek/scrub on the audio clock, frame-exact
  swaps at cuts, gaps cleared, gapless footage audio, still images drawn from a
  decoded `<img>`.
- **One transport authority + isolated live UI**
  (`components/WebCodecsPreviewPlayer.tsx`): the editor transport owns play/pause
  intent for monitor controls, keyboard shortcuts, hidden-tab stops, and the
  separate audio mixer. The canvas owner never stores per-frame time in React
  state; only a small playhead-subscribing live layer updates the scrubber,
  timecode, and captions. A decoded frame tagged for a different EDL segment is
  retained for accounting but never painted over the last correct composite.
- **Compositing pass (P3)** — all in `drawSource` + `overlay-painter.ts`,
  matching the DOM `PreviewPlayer`'s CSS exactly (the deterministic truth stays
  the Python render; the canvas only *approximates*, grade especially):
  - centered transform (keyframed scale/x/y via `evaluateKeyframes`);
  - in-place crop mask (`clip-path: inset` semantics — masks, no zoom-to-fill);
  - approximate grade (`ctx.filter = colorGradeCssFilter`);
  - blend mode (`globalCompositeOperation`);
  - text/caption overlays (percent-based position/box, alignment, background
    box, the shared `textOverlayAnimationState`);
  - **letterbox `contain` fit** into a project-aspect canvas buffer;
  - context fixed to **`srgb`** so preview can't show a wider gamut than the
    sRGB export path (the 601/709 "preview ≠ export" bug class), with
    its alpha channel retained for crop/letterbox transparency and without
    `willReadFrequently` so Chromium keeps the production preview on its
    GPU-backed canvas path.
- **Display/project cadence separation:** the audio clock and physical-pixel
  playhead continue at display refresh cadence, but a source frame already
  resident on the canvas is reused until its media timestamp changes (unless
  keyframes, a transition, or an active overlay requires continuous painting).
  Semantic React UI is quantized to project-frame cadence. On the P7 30 fps
  timeline at ~120 Hz this reduces 521 valid presentation ticks to 132 source
  draws, while retaining monotonic clock updates.
- **Visible decoder failure (P6, superseding P4 fallback):** any fatal engine
  error stops the transport and remains visible inside the program monitor.
  The editor does not silently switch to a renderer with different effects and
  compositing semantics. A source that fails to load resolves as a timed gap,
  preserving project duration and playhead behavior for editing, captions,
  effects and history. Playback also pauses when the tab is hidden.

### Single program-monitor engine

The program monitor always mounts `WebCodecsPreviewPlayer`. There is no persisted
preview-engine preference and no legacy selection branch in `Editor.tsx`; old
`webCodecsPreview` values are discarded when settings are loaded. Browser target:
real Chromium/Electron. Playwright's bundled open-codecs Chromium cannot decode
H.264, so compositor verification runs against real Google Chrome.

The monitor mounts one bounded shell and the `PreviewViewControls` contract.
Orientation, compare, loop, composition grid, safe-area guides, fit/zoom,
fullscreen, frame stepping, seek and timecode stay together. The scrubber owns a
full-width row above the centered playback cluster instead of falling into an
implicit grid column. The canvas buffer follows the exact
project resolution/aspect while the CSS frame contains itself against both stage
dimensions, so portrait, square, landscape, custom resolutions, rail resize and
timeline resize cannot stretch or crop the deliverable frame.

## Consequences

- **Positive:** frame-continuous, drift-free multi-clip playback is now the normal
  editor experience — including
  mixed audible/video-only footage, stills, gaps, and a separate music bed — that
  compositing parity (overlays/transform/grade/crop/blend/letterbox) falls out
  of. One renderer also removes preview-setting ambiguity and renderer-dependent
  effect behavior.
- **Negative / residual risk:** a new real-time subsystem with codec/browser
  variance and worker/threading complexity. **Remaining P4 work:** decoder-pool
  LRU eviction (Chromium's HW-decoder limit on many-source EDLs), a dedicated
  scrub path, speed-ramp handling, and a non-flaky perf regression guard. The
  automated three-way visual-diff (DOM vs canvas vs export) is not yet built —
  parity is so far evidenced by targeted per-feature pixel assertions.

## Alternatives considered

- **MSE per-timeline concatenation** — rejected: no canvas compositor, so P3
  parity doesn't fall out of it (see Decision).
- **Muted `<video>` audio sidecar for the clock** — rejected: reintroduces
  independent-clock drift.
- **MB-budgeted frame buffer** — rejected: `VideoFrame`s are GPU-backed;
  frame-count is the real constraint and the miss-mode (unclosed frames) is a
  silent decoder deadlock.

## Verification

All against **real Google Chrome** (`channel: 'chrome'`), opt-in via
`pnpm --filter @framepilot/e2e test:preview-spike` (not in the default
`pnpm test`/`pnpm verify` — needs real Chrome + real-time audio):
`preview-spike` (P0 gates), `preview-webcodecs-p1` through `p7`. P3/P5 also
proves the default selection, shared action controls, 9:16 containment,
live 9:16→16:9 canvas reorientation, and effect-layer pixel output. P7 samples
actual canvas pixels, asserts monotonic and physical-pixel-aligned playhead
motion, confirms the canvas is not software-readback optimized, verifies
source-frame reuse on high-refresh displays, and mixes audible and video-only
B-frame footage with a still and separate music bed; decode-ring counters alone
are not accepted as proof of visible continuity. Pure
selectors (`canvasPreviewEligible`, `clipCompositing`, `overlayClips`,
`wrapLines`, …) are unit-tested and part of the default suite.
