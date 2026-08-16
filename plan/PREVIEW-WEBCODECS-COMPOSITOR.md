# Preview WebCodecs Compositor — "exactly like the exported video"

> Sub-plan of `plan/PLAN.md`. Status legend matches PLAN.md:
> `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked
>
> **Scope:** replace the `<video>`-element preview pipeline with a decode-ahead
> frame compositor so multi-clip playback is frame-continuous — indistinguishable
> from playing the exported file. This is the **ceiling**; it is deliberately
> scoped *after* the incremental pre-roll fix (Phase 12.1), which already removes
> the felt hitch for the common (trimmed-clip) case, **and after a proxy-encode
> fix (P-1) that may shrink the problem enough to defer the compositor.**

**Snapshot (2026-07-30):** `[x]` P6 removes the accepted legacy program-monitor path,
its obsolete setting, corrects the scrubber layout, and preserves project-time transport
when a failed source is displayed as an errored gap. `[x]` P5 promotes WebCodecs to the default preview and
closes the remaining monitor-shell, action-control, orientation/fit, effect,
and workflow parity gaps end to end. P6 supersedes P4's legacy fallback after
creator acceptance. `[~]` P-1 code done (re-baseline still needs the
user's real footage); **P0, P1, P2 done — all verified against real Google
Chrome, not just typechecked**, on `feat/preview-proxy-encode-p1`. **P3a
(transform/crop/grade/blend) + P3b (text/caption overlays) + P3c (srgb canvas,
letterbox/contain-fit, orientation refresh) done — all verified against real
Chrome** (`preview-webcodecs-p3.spec.ts`, pixel-level). One P3 item remains:
the automated three-way visual-diff harness (DOM vs canvas vs export). **P4
started: graceful fallback to the `<video>` pool + tab-hidden pause + rapid-cut
(<40 ms) zero-jitter + multi-source short-clip/scrub lag done, real-Chrome
verified** (`preview-webcodecs-p4/p5/p6`); decoder-pool LRU, speed ramps, and
the perf regression guard remain (the dedicated scrub path is deferred — P6
measured seek→present at ~3–5 ms, far under the 100 ms budget).

---

## Why this exists

The program monitor (`apps/web-editor/src/components/PreviewPlayer.tsx`) plays a
montage by swapping between a pool of 5 persistent `<video>` elements
(`PREVIEW_POOL_SIZE`), one decode pipeline each, on a single rAF clock driven by the
front element's `currentTime`. The Phase 12.1 **pre-roll** fix (2026-07-09,
`selectors.ts` `prerollLead`/`shouldPreroll`, `PREVIEW_PREROLL_LEAD_SECONDS = 0.15`)
removed the `play()`-startup freeze at cuts by starting the on-deck element *before*
the cut — but two residuals are inherent to element-swapping and **cannot** be closed
within that design:

1. **Untrimmed clips (`sourceStart ≈ 0`)** have nothing to seek back into, so they
   get no pre-roll runway and still pay a small `play()`-startup cost at their cut.
2. **Independent decode pipelines** each have their own clock, buffering, and the
   browser's compositor decides when each `<video>` paints — so frame-exact,
   tear-free continuity across a cut is never *guaranteed*, only made very likely.

An exported file has neither problem because it is a **single continuous decode**.
The only way to reproduce that in the browser is to become the decoder ourselves:
decode frames ahead into a unified buffer and present them on one clock.

### But first, suspect the proxy (P-1)

The reported "jitter and buffer" is **not yet attributed**. Today's proxies
(`engine/python/framepilot_engine/media/derive.py`, `generate_proxy`) are encoded
`-vf scale=-2:540 -c:v libx264 -preset veryfast -crf 28` with **no** `-g`,
`-sc_threshold`, `-movflags +faststart`, or fps normalization. That yields x264
defaults: ~250-frame GOPs (~8–10 s), scene-cut keyframes at arbitrary positions,
`moov` atom at end-of-file, and VFR passthrough. Every seek/pre-roll to a cut point
forces a decode from a keyframe up to ~8 s away. **This alone plausibly explains most
of the felt jitter.** P-1 fixes it in a day, improves the *existing* pool, and is a
hard prerequisite for any honest P0 measurement. It may make the compositor
unnecessary — that is an acceptable and cheaper outcome.

## Target architecture (the ceiling, if P-1 is insufficient)

- **Demux + decode** the proxy media with `WebCodecs` (`VideoDecoder`), fed by a
  demuxer (MP4Box.js for the plain-MP4 proxies). A **decoder pool** (LRU, explicit
  reconfigure) keyed by source — reused across trims of the same asset — because
  Chromium hardware-decoder instances are platform-limited (single digits on some
  Windows MFT setups) and overflow silently falls back to ~5–10× slower software
  decode.
- **Audio-master clock (decides the whole design):** decode proxy audio via the same
  MP4Box path into WebAudio, schedule `AudioBufferSourceNode`s sample-accurately for
  gapless cuts, and **slave video frame selection to `AudioContext.currentTime`** —
  *not* rAF. A muted-`<video>` audio sidecar is explicitly rejected: it reintroduces
  the independent-clock drift this project exists to eliminate.
- **Frame queue / jitter buffer:** decode N frames ahead of the playhead across the
  clip boundary, so the frame for `t` (whichever clip owns it) is already decoded.
  Budget is **frame count** (≤ ~24 in-flight `VideoFrame`s total), not MB — frames
  are GPU-backed and every one must be `.close()`d promptly or the decoder
  **deadlocks silently**.
- **Single presentation loop:** one loop selects the frame active at the
  audio-clock playhead and draws it to an `OffscreenCanvas` transferred **once** to a
  worker; demux/decode/draw all live in the worker, and `VideoFrame`s are **never**
  posted to the main thread per-frame. Cuts are just "the next frame comes from a
  different source" — no element swap, no gap. Overlays/transforms/grade/crop/blend
  composite in the same pass.
- **Speed / rate ramps (H1.2j):** the custom clock must honor per-clip speed on both
  frame selection and audio (`AudioBufferSourceNode.playbackRate` + an explicit
  pitch decision). Not an afterthought — it constrains the clock.
- **Back-pressure + eviction:** cap decoded-frame count; drop/pause decode when the
  tab is hidden or the queue is full; recover on seek.

## Constraints & non-negotiables

- **Render-vs-preview rule (AGENTS.md):** this is preview only. MoviePy/FFmpeg stays
  the sole export path. Export output must remain byte-for-byte governed by the
  Python engine — the compositor may *approximate* nothing that export depends on.
- **Invariants unchanged:** no timeline/schema change, no new patch types; the
  compositor is a consumer of the same `createPlaybackIndex` / `activeClipsAt` /
  `audibleAudioAt` projections (`selectors.ts`) the pool already uses.
- **Graceful fallback:** decoder-error, unsupported-codec, or too-many-decoders falls
  back to the current pre-roll'd `<video>` pool. Ship behind a flag.
- **Flag has no home yet:** the web editor has **no feature-flag system**. Add a
  preview-engine toggle to `EditorSettings` (`apps/web-editor/src/editor/useSettings.tsx`)
  for a user-visible switch, or an `import.meta.env` build flag (precedent:
  `FRAMEPILOT_PYTHON_API_URL`) for a dev-only gate. Decide in P1.

## Reuse map (what already exists — don't rebuild)

- **Projections:** `createPlaybackIndex`, `activeClipsAt`, `upcomingVideoFrom`,
  `audibleAudioAt` in `selectors.ts` — consumed as-is.
- **Audio-only clips:** `PreviewAudioMixer.tsx` (hidden `<audio>` bus, gain/solo,
  drift resync) is directly reusable for music/VO/SFX; only *footage* audio moves to
  the audio-master clock.
- **Media transport:** `fp-media://` custom scheme already supports **byte-range**
  requests and the renderer CSP already allows `connect-src fp-media:` — so
  `fetch()`-ing proxy byte ranges for the demuxer works without a security change.
- **OffscreenCanvas pattern:** `ClipWaveform.tsx` is the existing precedent (not the
  code, just the pattern).
- **Playhead store:** `editor/playhead-clock.ts` (`seekTransient` → `usePlayhead`)
  already isolates 60fps playhead updates from the editor tree — the compositor
  writes through the same path.

## MSE vs raw WebCodecs — decision

**Chosen: WebCodecs.** Both APIs collapse to "Chromium" on the Electron target, so
MSE's cross-browser advantage is moot. MSE (per-timeline concatenated fMP4 +
`timestampOffset`/`appendWindow` for sub-GOP trims) would give a single pipeline,
single clock, and native A/V sync "for free" — but it yields **no canvas
compositor**, so P3 parity (overlays/transform/grade/crop/blend in one pass, which
FramePilot genuinely needs) does not fall out of it; compositing over an MSE
`<video>` via `drawImage` rebuilds half the WebCodecs renderer with less control.
**If** P3 compositing parity were dropped, MSE would be the cheaper path — revisit
only if that requirement changes. *(If the web editor must also run in Safari, note
WebCodecs H.264 decode-config and `VideoFrame` color quirks apply — state which
targets the flag covers in P1.)*

---

## Phased tasks

- [~] **P-1 — Fix the proxy encode (prerequisite, ~1 day).**
    - [x] `derive.py` `generate_proxy`: CFR (`fps=30` default), half-second closed
          GOP (`-g/-keyint_min = fps//2`, `-sc_threshold 0`, `-bf 0`), explicit
          BT.709 tagging, `-movflags +faststart`. Tests: argv-shape + a real-ffmpeg
          CFR assertion (`test_media_derive.py`), 100% coverage on `derive.py`.
    - [x] Cache digest salted with `PROXY_ENCODE_VERSION`
          (`service.py:derive_proxy_path`) so existing proxies invalidate and
          re-derive on next preview-media request instead of silently reusing a
          stale transcode. Test: `test_asset_media_proxy_cache_invalidates_on_encode_version_bump`.
    - [ ] **Re-baseline the `<video>` pool against the new proxies and re-measure
          the reported montage — needs the actual footage and a human eye on
          perceived smoothness; not automatable from here.** Decision gate: if the
          pool is now "good enough," **stop here** and defer P0–P4.
    - Branch: `feat/preview-proxy-encode-p1`. Coordinate with `engine/python` if the
      encode change needs further iteration after re-baseline.
- [x] **P0 — Spike / feasibility. GO**, evidence below. Real `VideoDecoder` +
      `mp4box` demux in a Worker, canvas presentation on main, a real
      `AudioContext`-driven audio-master clock — all verified against **real
      Google Chrome** (`channel: 'chrome'`, not Playwright's bundled
      open-codecs Chromium), not just typechecked. Code:
      `apps/web-editor/src/preview/{demux,decode,clock,spike}/`; harness
      exposed as `window.__framepilotSpike`; spec:
      `tests/e2e/specs/preview-spike.spec.ts`, run via the opt-in
      `pnpm --filter @framepilot/e2e test:preview-spike` (NOT part of the
      default `pnpm test`/`pnpm verify` — needs real Chrome + real-time audio,
      neither guaranteed in CI; see package.json).
    1. **Cut continuity — PASS.** 100 scripted cuts (alternating 2 sources,
       even rounds untrimmed at chunk 0 / odd rounds trimmed at a
       reproducible offset), zero dropped/repeated/misordered frames — ground
       truth read off actual canvas pixels (a burned-in watermark), not
       `VideoFrame.timestamp` bookkeeping.
    2. **Cold seek-to-frame — evidence only, not the gate.** p95 1.8–2.5ms on
       this dev machine. The plan's exact gate (≤100ms p95 on **min-spec**
       hardware) needs a run on the actual target device — this number is a
       (very comfortable) lower bound, not proof of that gate.
    3. **Scrub — evidence only, not the gate.** p95 10–15ms here; the plan's
       "≥ parity with the re-baselined `<video>` pool" comparison needs the
       P-1 re-baseline to exist first.
    4. **A/V sync — PASS, thin margin.** Full plan spec (60s, 10 cuts, real
       `AudioContext` playback): max drift **33,266µs vs a 33,333µs (1-frame)
       budget — reproducible, bit-identical across repeated runs, ~0.2%
       under budget.** This margin is real and worth flagging, not
       comfortable: every `decodeRange` call — even a "continuation" one —
       must fully reset+configure+seek-to-keyframe+`flush()`, because
       WebCodecs requires a keyframe immediately after `flush()`, not only
       after `configure()` (undocumented in mp4box's README, confirmed
       against Chrome directly). That per-window reconfigure cost is most of
       what's eating the margin. **P2 should investigate a non-flushing,
       continuous-decode pipeline** (track "N frames received" via the
       output callback instead of awaiting `flush()` every window) to get
       real headroom instead of skating the edge.
    5. **Resource hygiene — PASS.** Zero leaked frames across all runs
       (`framesCreatedTotal === framesClosedTotal`), in-flight peak ≤ 24,
       reconfigure counts sane and attributable.
    - **Three real, non-obvious bugs found and fixed only by actually running
      against Chrome** (typecheck/lint caught none of them):
      (a) `gen-proxy.mjs`'s single ffmpeg call mixing piped-stdin rawvideo
      input with `+faststart` was genuinely non-deterministic — one run
      produced a byte-for-byte duplicate `moov` box; fixed with a two-step
      encode-then-remux. (b) creating a new `VideoDecoder` per seek leaked a
      decoder every time, silently exhausting Chrome's concurrent-decoder
      limit within dozens of seeks (generic "Decoding error.", no other
      symptom); fixed by reusing one persistent decoder per session. (c) the
      A/V-sync gate's decode-ahead originally fetched a whole 3-second
      segment in one burst, overflowing the 24-frame ring and evicting most
      of it before playback arrived; replaced with a real windowed,
      ring-paced jitter buffer. Full narrative in the
      `fix(preview-spike): 3 real bugs found + fixed` commit.
    - MP4Box.js (`mp4box`, BSD-3-Clause) added as the demuxer, approved
      pending `pnpm license:scan` (passes).
- [x] **P1 — Single-source canvas playback. DONE**, wired into the real editor
      (not just the spike), behind `settings.webCodecsPreview`
      (`useSettings.tsx`, Settings → Playback), gated additionally by
      `singleVideoClip` (`selectors.ts`, pure + unit-tested): exactly one clip
      on the whole timeline and it's video, else the normal `PreviewPlayer`
      renders unchanged. Browser target: real Chromium (Electron uses the
      same engine; Playwright's bundled open-codecs Chromium cannot — see P0).
    - Code: `preview/engine/webcodecs-preview-engine.ts` (play/pause/seek/scrub
      on the audio-master clock, footage audio via WebAudio, decode-ahead via
      the same windowed ring-paced jitter buffer P0 gate #4 verified — reuses
      `DecodeWorkerClient`/`FrameRing`/`AudioMasterClock`, no spike code),
      `components/WebCodecsPreviewPlayer.tsx` (canvas + minimal transport,
      synced to the shared editor playhead both ways: `seekTransient` during
      playback, a `subscribePlayhead` listener for external seeks like the
      timeline ruler).
    - `DecodeWorkerClient` (`preview/decode/worker-client.ts`) extracted from
      the P0 spike harness — shared production surface (request/response
      correlation, frame accounting), not duplicated.
    - **Verified against real Google Chrome via Playwright**
      (`tests/e2e/specs/preview-webcodecs-p1.spec.ts`, run via the opt-in
      `pnpm --filter @framepilot/e2e test:preview-spike`): injects a
      single-clip project via the app's own localStorage persistence schema
      (asset path an `https://` URL — sidesteps a separate, pre-existing gap:
      `fp-media://` only has a handler in the Electron desktop shell, so
      real media silently can't load in the plain-browser build for
      *either* preview path, old or new; not a P1 concern to fix), flips the
      setting, and drives play/pause/seek/scrub against a real decoded file.
      **Two more real bugs found and fixed only by this integration test**
      (P0's spike harness didn't have React lifecycle or repeated
      seek-while-playing to shake out): (a) React StrictMode's dev
      double-invoke raced `WebCodecsPreviewEngine.load()`'s async chain
      against its own `dispose()`, and `DecodeWorkerClient` silently
      resurrected a fresh, unloaded worker instead of recognizing it had
      been disposed — now throws clearly instead; (b) every `decodeRange`
      resetting the decoder (P0's flush()-needs-a-keyframe fix) means a
      seek legitimately aborts an in-flight decode-ahead `pump()` call, but
      the abandoned pump reported that expected abort as a real error — a
      generation counter now lets superseded work distinguish "aborted
      because a newer seek won" from "genuinely failed."
- [x] **P2 — Multi-clip continuity. DONE** (with one honest caveat below).
      `WebCodecsPreviewEngine` generalized from P1's single clip to an
      ordered multi-segment EDL built by the new pure selectors
      `canvasPreviewEligible`/`pictureSegments` (`selectors.ts`, unit tested):
      video segments (one long-lived decoder session per unique source,
      reused across every segment referencing it — same windowed, ring-paced
      jitter buffer the P0 A/V-sync gate proved for a multi-segment/
      multi-source EDL), image "stills" (decoded via `<img>`, never
      `VideoDecoder` — **implemented but not yet exercised by a real-Chrome
      test with an actual image fixture; flagging rather than claiming
      unverified coverage**), and gaps (canvas cleared, silence). Footage
      audio for every video segment from the playhead onward is scheduled
      back-to-back on the audio-master clock in one call — gapless the same
      way P0 verified. `PreviewAudioMixer` reused as-is for non-footage audio
      (audio-only tracks) — it's driven entirely by the shared
      `editor.state.playing`/`usePlayhead`, both of which the engine already
      keeps correct via `setPlaying()`/`seekTransient()`, so mounting it
      alongside required zero engine changes.
    - `singleVideoClip` (P1's narrower check) retired — fully superseded by
      `canvasPreviewEligible`, deleted along with its tests to avoid dead code.
    - **Verified against real Google Chrome**
      (`tests/e2e/specs/preview-webcodecs-p2.spec.ts`): two real clips from
      *different* sources with a gap between them, played continuously
      through the cut and the gap via real wall-clock playback (not just a
      seek), scrubbing directly into the gap and into the second clip, plus
      an audio-only clip whose `<audio>` element is confirmed mounted with
      the right source. Passed on the first real run.
- [~] **P3 — Compositing parity:** overlays (text/caption), on-canvas transform (H4),
      crop (`clip-path`→canvas), blend (`mixBlendMode`→canvas), approximate grade,
      orientation/letterbox — all in the canvas pass. **Canvas fixed to `srgb`;
      visual-diff vs the current DOM preview AND vs the export path** (catches the
      601/709 "preview ≠ export" bug class). Split into reviewable pieces:
    - [x] **P3a — picture-layer compositing (transform/crop/grade/blend). DONE.**
          New pure `clipCompositing`/`isIdentityCompositing` selectors
          (`selectors.ts`, unit-tested); `canvasPreviewEligible` relaxed to
          admit transform/crop/grade/blend on picture clips (still falls back
          for overlays/overlapping-picture/speed). `WebCodecsPreviewEngine`
          gained `drawSource` — clears + composites each frame with a centered
          transform (keyframed scale/x/y evaluated per-frame via
          `evaluateKeyframes`), an in-place crop clip (matches `cropClipPath`,
          no zoom-to-fill), an approximate grade (`ctx.filter =
          colorGradeCssFilter`), and blend (`globalCompositeOperation`) — and
          `applyCompositing` to refresh compositing IN PLACE on a grade/
          transform edit without reloading the decoder (`WebCodecsPreviewPlayer`
          drives it off a compositing-signature effect). Identity compositing
          keeps the cheap full-frame `drawImage`. **Verified against real
          Google Chrome** (`preview-webcodecs-p3.spec.ts`, pixel-level: a
          centered scale-0.5 transform leaves the canvas corners cleared and the
          centre the video bg; a left-half crop clears the right half) — P1/P2
          re-run green (no regression from the draw refactor). Threaded
          `project.resolution` into the engine for the H4 px→frame conversion.
    - [x] **P3b — overlay layer (text/caption) composited on canvas. DONE.**
          `canvasPreviewEligible` now admits overlay clips (still requires ≥1
          picture clip to composite over). New pure `overlayClips` projection
          (`patch-builders.ts`, unit-tested) mirrors the DOM `PreviewPlayer`'s
          overlay resolution (hidden tracks excluded, empty-text dropped,
          `params.text || first-non-empty-text/caption-effect`). New
          `overlay-painter.ts` (`paintTextOverlay` + pure, unit-tested
          `wrapLines`) draws each overlay matching `textOverlayStyle`:
          percent-based position/box-width, font size as a fraction of frame
          HEIGHT, alignment, optional rounded background box, and the SHARED
          `textOverlayAnimationState` (extracted from `textOverlayStyle` so DOM
          and canvas animate identically). Engine gained `setOverlays`/
          `drawOverlays`, called after every picture draw with a `painted`
          guard so overlays repaint on a freshly-cleared frame and never stack;
          `WebCodecsPreviewPlayer` pushes overlays on mount + refreshes in place
          on an overlay-signature effect (no decoder reload). **Verified against
          real Chrome** (`preview-webcodecs-p3.spec.ts`: a red/green background
          box composites at the overlay's centre while a far corner stays the
          video bg, and survives playback without compounding).
    - [~] **P3c — `srgb` canvas + orientation/letterbox.** DONE except the
          automated visual-diff harness:
        - [x] Context fixed to `{ colorSpace: 'srgb' }` on the
              default GPU-backed path — a `display-p3` canvas would preview wider
              than the sRGB export can reproduce, while `willReadFrequently`
              can force software backing and is forbidden in production preview.
        - [x] **Letterbox / `contain` fit.** Canvas buffer is now sized to the
              **project aspect** (capped to a 1280px long edge —
              `WebCodecsPreviewPlayer`) instead of a fixed 1280×720, so a 9:16
              project isn't horizontally squished. `drawContain` fits each
              source inside the frame box preserving its aspect, matching the
              DOM `.preview-video { object-fit: contain }`; the cleared bars show
              `#000` via new `.webcodecs-preview-canvas` CSS. Verified real-Chrome
              (`preview-webcodecs-p3.spec.ts`: a 9:16 project over the 16:9
              fixture leaves the top/bottom bands cleared, centre = video bg).
        - [x] **Orientation refresh.** `WebCodecsPreviewEngine.setResolution`
              updates the transform px→frame math + letterbox aspect in place on
              a resolution change (no decoder reload); the component drives it +
              resizes the canvas buffer. Closes P3a's captured-at-mount gap.
        - [ ] **Automated visual-diff harness** vs the DOM preview AND the
              export path. Deferred — needs the Python export wired into an e2e
              pixel comparison (a substantial separate harness). Parity is so far
              evidenced by the targeted per-feature pixel assertions above, not a
              full frame diff.
- [~] **P4 — Robustness + fallback.** Started:
    - [x] **Playback clock/presentation stability regression (2026-07-30). DONE.**
          Reproduce the uploaded 10.2 s recording where the canvas repeatedly
          drops to black and the shared timeline playhead oscillates; prove and
          fix the root cause across the audio-master clock, frame presentation,
          and shared playhead propagation. Add deterministic monotonic-clock and
          no-blank-frame regression coverage plus real-browser verification.
          Root causes were a clock that compacted away video-only/image/gap spans,
          presentation of stale decoded frames from the prior segment, two playback
          authorities, per-tick React renders around the canvas, and a layout-driven
          playhead. The clock now advances continuously on project time while scheduling
          audible buffers at their real offsets; mismatched frames are held instead of
          painted; editor state owns transport; the canvas owner is isolated; and the
          marker uses `translate3d`. The exact mixed real footage went from 144
          wrong-segment presentations and ~934 ms lag to zero and <= one frame. Portable
          P7 asserts zero sampled black frames, zero wrong segments, and no backward
          playhead steps. All p1-p7 tests (17/17), the web-editor suite (1,361/1,361),
          website build, and full `pnpm verify` pass (41 E2E; 1,421 engine tests).
    - [x] **Residual presentation-cadence/playhead shimmer follow-up (2026-07-30). DONE.**
          The severe black/wrong-segment regression is closed, but live acceptance still
          reports a minor picture and playhead flicker. Measure display-tick cadence and
          playhead pixel motion, eliminate redundant presentation/main-thread work and
          fractional-pixel line shimmer where proven, then extend the real-browser guard.
          Root causes: the production canvas carried the test-only `willReadFrequently`
          hint (software-backing risk); a ~120 Hz display repainted unchanged 30 fps source
          frames and drove semantic React UI at refresh cadence; and the 1px marker landed
          between physical pixels. Production now retains its alpha channel on the default
          GPU-backed sRGB canvas, reuses a resident static source frame until the media
          timestamp changes (continuous keyframes/transitions/overlays still repaint),
          quantizes semantic UI to project frames, and moves the marker imperatively on the
          device-pixel grid. P7 measured 513 ticks / 130 draws / 394 safe reuses, zero
          fractional marker positions, and zero missing, wrong-segment, black, or backward
          samples. All 12 real-Chrome compositor scenarios and full `pnpm verify` pass
          (web editor 1,364; standard E2E 41; engine 1,421).
    - [x] **Graceful fallback to the `<video>` pool. DONE.** The engine's
          `onError` (decoder failure, unsupported codec, demux error,
          too-many-decoders) now stops the transport and calls `onFallback`;
          `Editor.tsx` flips a session-sticky `webCodecsFailed` so the proven
          pre-roll'd `PreviewPlayer` renders for the rest of the session
          (cleared when the setting is toggled off→on, to retry). **Verified
          real-Chrome** (`preview-webcodecs-p4.spec.ts`: corrupt media →
          canvas gone, DOM `section.preview` shown).
    - [x] **Tab-hidden pause. DONE.** `WebCodecsPreviewPlayer` pauses playback
          on `visibilitychange`/`document.hidden` (which also halts the pump —
          it only runs while playing); no auto-resume. **Verified real-Chrome**
          (same spec: play → simulate hide → transport returns to Play).
    - [x] **Rapid-cut (<40 ms clips) zero-jitter. DONE.** Reproduced with a
          60-clip single-frame montage at scattered source in-points
          (`preview-webcodecs-p5.spec.ts`) measuring the engine's own
          `debugStats()` (`missing` + `wrongSegment` over `ticks`). Three real
          bugs, found only by running it:
          (a) the deferred **post-load `seek()` raced `play()`** — a
          many-segment load is slow, so a Play pressed during it let the
          `loadSegments().then(seek)` pause the just-started playback;
          (b) **a Play pressed before load finished was silently dropped**
          (`play()` no-ops on empty segments) — now the component records play
          intent and honors it when the load completes (like the DOM player's
          prepare-on-play), guarded by a new `isStarting` flag so an external
          seek during audio-clock startup can't cancel it;
          (c) the ring was only **topped up to a low watermark (12/24)**, so a
          transient decode-behind (GC, worker jank, a burst of reconfigures)
          dropped frames — the pump now keeps the ring **saturated at capacity**
          (~0.8 s cushion). Result: **8/8 fresh runs, `missing` = `wrongSegment`
          = 0, max lag < 1 frame (32.7 ms).** Frame-count back-pressure
          (`FrameRing` `RING_CAPACITY = 24`) unchanged.
          *(Fix (c) was later refined — see the multi-source entry below:
          saturating to capacity caused eviction of the current frame.)*
    - [x] **Multi-source short-clip switching + scrub lag. DONE.** Reproduced
          with 3 sources × 3-frame alternating clips + a 12-position scrub
          storm (`preview-webcodecs-p6.spec.ts`) — initially ~48% of frames
          missing. NOT decode throughput (all-intra `gop=1` fixtures made no
          difference — `gen-proxy.mjs` now takes a gop arg). Two real bugs:
          (a) **ring eviction of the current frame** — filling the ring to
          `RING_CAPACITY` (24) let a multi-frame window push overshoot
          capacity, and `FrameRing.push` evicts the oldest frame, which after
          `evictBefore` is exactly the frame the playhead needs now. The pump
          now fills to `LOOKAHEAD_TARGET` (capacity − window − 2 = 14, ~0.45 s
          at 30 fps) — deep enough to absorb observed ~150 ms transient decode
          stalls, while a window push can never reach the current frame;
          (b) **the audio clock reported media time BEFORE the playback start
          position during its ~50 ms scheduling lead** (negative elapsed in
          `mediaTimeUsAt`) — every `play()` began with 2–3 missing-frame ticks
          looking up frames before the start position. The clock now holds at
          the first segment's media start until scheduled audio begins
          (clamped in `audio-clock-math.ts`, unit-tested). Result: **p5+p6
          stable across repeated fresh runs, `missing` = `wrongSegment` = 0
          (543 ticks), scrub seek→present 3–5 ms worst case (budget 100 ms)**.
          `debugStats()` gained `maxSeekMs`/`maxDecodeMs` for the perf guard.
    - [x] **Real-footage lag: streaming decode pipeline + presentation-exact
          sample mapping. DONE.** The user still saw lag on a real timeline
          (image + video clips + a music track) that the proxy-shaped p5/p6
          fixtures couldn't reproduce. Root causes, all fixed:
          (a) **flush-per-window decode** — every `decodeRange` reset +
          reconfigured + re-decoded from the nearest keyframe + `flush()`ed,
          even a contiguous playback continuation: `O(GOP + window)` decodes
          plus a pipeline stall per 8-frame window. The worker session now
          STREAMS: contiguous windows just feed the next chunks (no reset, no
          prefix, no flush — `O(window)` amortized); only a true seek
          reconfigures; a withholding hardware decoder is dislodged by bounded
          one-chunk overfeeds whose beyond-range products are stashed for the
          next window;
          (b) **CFR index mapping** (`round(t / frameDuration)`) mis-indexed
          VFR/B-frame footage — replaced with exact presentation-order
          timestamp tables (+ decode-order translation) from the demuxer;
          (c) **B-frame cts reorder shift** — x264 `-bf 2` puts the first
          displayed frame at cts = 2 frames, so every clip in/out point mapped
          ~2 frames early and clips at source start were truncated to one
          frame (a deterministic freeze p7 caught as `maxLagUs` ≈ one full
          clip). Timestamps are now normalized to a 0-based presentation
          clock at demux.
          Verified: `preview-webcodecs-p7.spec.ts` (three 1080p GOP-30 `-bf 2`
          sources in 3-frame clips + still-image clip + music track):
          **missing = wrongSegment = 0 (524 ticks), maxSeekMs ~13 ms,
          maxDecodeMs 21 ms** (was 55 ms+ with flush-per-window); p1–p7 all
          green, p5–p7 stable across repeats.
    - [x] **Desktop edit-freeze: persistent engine + incremental media
          loading. DONE.** The React wrapper disposed/recreated the whole
          engine on every EDL-identity change — every cut/trim/delete
          re-fetched, re-demuxed, and re-decoded the audio of EVERY source
          (invisible on tiny fixtures, a multi-second freeze per edit on
          desktop-sized media). Now: one engine per mounted canvas;
          `loadSegments` is serialized + incremental (sources/images reused,
          only new media loads, departed sources pruned via a worker `unload`
          message that frees the decoder slot); ONE fetch per source ever
          (the worker transfers the demuxed file's bytes back for
          `decodeAudioData`); missing media loads in parallel; the fallback
          to the `<video>` pool logs its reason via the scoped logger
          (`web-editor:webcodecs-preview`) instead of failing silently.
          Verified: P7 gained an edit phase — delete a clip mid-session,
          assert ZERO additional media fetches, no fallback, live preview
          after the edit. p1–p7 green.
    - [ ] **Decoder-pool LRU + reconfigure** (bounded concurrent decoders —
          matters for many-source EDLs vs Chromium's HW-decoder limit;
          partially advanced by the P7 `unload` pruning above).
    - [ ] **Dedicated scrub path** (decode nearest-keyframe-only during drag,
          refine on idle; reverse-scrub GOP re-decode). **Deferred:** P6's
          scrub storm measures seek→present at 3–5 ms worst case against
          gop=15 proxies, and P7's at ~13 ms against GOP-30 B-frame 1080p —
          build only if real-footage scrubbing regresses.
    - [ ] **Browser-mode proxy generation** (discovered during the P7 lag
          investigation): `deriveEngineMedia` returns `undefined` outside the
          desktop app — browser imports NEVER get a P-1 proxy, so the preview
          decodes original camera files. The streaming pipeline makes that
          tolerable (p7 evidence), but CapCut-parity "always light media"
          needs an in-browser proxy encode (WebCodecs `VideoEncoder`) or a
          documented desktop-only stance.
    - [ ] **Speed-ramp (H1.2j) handling** — currently `canvasPreviewEligible`
          excludes non-1× speed; needs frame-selection + audio `playbackRate`.
    - [ ] **Perf budget + non-flaky regression guard** (`performance-monitor`).
- [x] **P5 — Default WebCodecs preview + complete monitor parity (2026-07-30).**
    - [x] Make WebCodecs the persisted-settings default and remove the
          "experimental" product label, while retaining the legacy player as the
          decoder/codec failure fallback until creator acceptance.
    - [x] Give both preview engines one monitor-shell/view-control contract:
          orientation, compare, loop, grid, safe area, fit/zoom, fullscreen,
          frame stepping, timecode and seeking must remain available regardless
          of the active engine.
    - [x] Make the canvas contain itself against both monitor dimensions and the
          exact project resolution/aspect, including portrait, square, landscape,
          custom resolutions, resize, zoom and fullscreen.
    - [x] Verify effect-layer preview, edits, bypass/removal, transport, overlays,
          captions, transitions and orientation changes on the default WebCodecs
          path with focused component tests and real-Chrome pixel/workflow E2E.
    - [x] Update ADR/guides/developer changelog/customer changelog and run the
          affected suites plus repository verification gates.
- [x] **P6 — WebCodecs-only product path + transport polish (2026-07-30).**
    - [x] Place the program-monitor scrubber on a dedicated full-width transport row.
    - [x] Remove the WebCodecs preference from settings and persisted state.
    - [x] Remove the legacy program-monitor selection and decoder fallback path.
    - [x] Keep failed sources as timed gaps with a visible monitor error, preserving
          project duration, transport, effect placement, history and caption workflows.
    - [x] Update tests, ADR, guides, and both changelogs; run affected verification gates.
- [x] **Docs/ADR. DONE.** `docs/adr/0052-webcodecs-preview-compositor.md`
      covers both (a) the P-1 proxy-encode change + cache invalidation and
      (b) the preview compositor architecture incl. the MSE-vs-WebCodecs
      decision, the P3 compositing pass, and the P4 fallback. Added a "WebCodecs
      preview compositor" budgets table to `docs/guides/performance-budgets.md`
      and a user-facing `CHANGELOG.md` entry. (No standalone render guide exists
      to update; the render-vs-preview boundary is restated in the ADR.)

## Proxy format (P-1 target)

- **Codec:** H.264 High, `yuv420p`, explicitly BT.709-tagged
  (`-colorspace bt709 -color_primaries bt709 -color_trc bt709`) — HW-decodable on
  every Chromium/Electron target incl. macOS VideoToolbox.
- **Frame rate:** CFR — `-vf "scale=-2:720,fps=30"` — kills VFR (screen/talking-head
  recordings are the worst offenders) at the source. *(Confirm the 540→720 height
  bump against decode cost during P-1 re-baseline; keep 540 if 720 regresses
  min-spec.)*
- **GOP:** `-g 15 -keyint_min 15 -sc_threshold 0 -flags +cgop -bf 0` — half-second
  **closed** GOPs, no scene-cut, **no B-frames** (decode order = presentation order →
  trivial frame queue, lower latency, tolerable reverse scrub). Bitrate cost is
  irrelevant at CRF 28.
- **Container:** plain MP4 with `-movflags +faststart` — a complete front-loaded
  `moov` gives MP4Box.js O(1) random access (better than fragmented for *local*
  files; only fragment if the MSE path or HTTP streaming is ever chosen).
- **Audio:** keep AAC 48 kHz; demux via the same MP4Box path into WebAudio (no hidden
  `<video>`).
- **Optional scrub proxy:** P0 also measures an **all-intra variant** (`-g 1`, ~2–3×
  size) as an opt-in — makes every seek O(1 frame). Ship only if scrub gate needs it.

## Risk

High: a new real-time subsystem with codec/browser variance, memory (frame-count)
pressure, and worker/threading complexity. Multi-PR.

- **Biggest post-investment sink:** gapless, drift-free **audio across arbitrary
  cuts** — the one thing `<video>` gave us free, invisible in a video-only spike,
  and it invalidates the rAF-clock premise if discovered late. De-risked by making
  the audio-master skeleton a **P0 gate**.
- **Close second:** **scrub latency** regressing below the re-baselined pool — de-risked
  by the P0 scrub gate measured *against* the pool, plus the P4 dedicated scrub path.
- Must not regress the (now smooth) pre-roll + P-1 baseline — hence the flag +
  fallback from P1 onward.
