# 0040 — Timeline horizontal render windowing, canvas backing-store clamps, and the thumbnails preference

- **Status:** Accepted
- **Date:** 2026-07-06
- **Relates to:** ADR 0034 (performance hardening), ADR 0038 (production hardening), plan Phase 15 follow-up

## Context

Two field reports against the release candidate:

1. **Zooming the timeline made the whole app laggy and it never recovered**
   (restart required). Root cause: `ClipWaveform` and the filmstrip placeholder
   canvas sized their backing stores to the clip's rendered width
   (`offsetWidth × devicePixelRatio`). At maximum zoom (240 px/s) a clip a few
   minutes long is >100 000 px wide — beyond the ~32k per-dimension canvas limit
   in Chromium — and every such canvas pinned hundreds of MB of (GPU) memory
   that was never reclaimed while the clip stayed mounted. The waveform's
   *bitmap cache* was already bucketed and LRU-bounded (ADR 0034), but the
   visible canvas backing store was not.
2. **Film-style timelines (hours, thousands of clips) were heavy to zoom and
   scroll.** Vertical lane virtualization (M2b-2) bounds how many *tracks*
   mount, but every clip on a mounted lane rendered regardless of horizontal
   scroll — thousands of clip buttons, filmstrip strips, waveform canvases and
   ruler ticks, all rebuilt on every animation frame of a zoom gesture.

## Decision

1. **Clamp canvas backing stores** to 8192 device px
   (`MAX_WAVEFORM_BACKING_PX`, `MAX_PLACEHOLDER_BACKING_PX`) and let CSS
   (`width: 100%`) stretch the clamped store across the clip. For a waveform or
   a procedural placeholder the stretch is imperceptible; only the on-screen
   slice of a huge clip is ever visible.
2. **Window the lanes horizontally** with a pure, unit-tested selector pair:
   `laneRenderWindow(scrollLeft, clientWidth)` returns the slice worth mounting
   — the viewport plus ≥ one full viewport of overscan on each side, **quantized
   to whole viewport-width buckets** (min 256 px) so its identity (and therefore
   the memoised lane tree) changes only when scrolling crosses a bucket
   boundary, never per scrolled pixel. `spanInRenderWindow(start, end, window,
   pxPerSecond)` is the mount predicate for clips, transition pills, cut
   affordances and ruler ticks. A `null` window (unmeasured viewport — first
   paint, jsdom) mounts everything, mirroring the vertical virtualizer's height
   fallback; the drag-ghost clip always mounts because it holds pointer capture.
3. **`showTimelineThumbnails` preference** (default **on**; Settings → Editing,
   with an explicit "uses extra memory" hint). View state only (invariant 5) —
   it gates the filmstrip picture layer, nothing in the project. When on, the
   filmstrip no longer has a minimum clip width: a sliver clip draws at least
   one frame (`filmstripSlots` bottoms out at 1); the old 24 px cutoff still
   applies to the waveform band and clip header density only.

## Consequences

- Zoom/scroll/drag on film-scale timelines touch O(visible) clips, not O(all).
- Memory is bounded per mounted clip regardless of zoom; the
  "lags-until-restart" state is unreachable via zoom.
- Clips mount/unmount as the user pans across bucket boundaries; React state
  inside a clip subtree (none today — gestures live in the parent) must not be
  assumed to survive a long pan.
- Marquee selection and patches are unaffected: windowing is render-only;
  hit-testing for the marquee uses the pure `clipsIntersectingRect` over the
  timeline model, not the DOM.
