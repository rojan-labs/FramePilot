# 0094. Adaptive program preview for feature-length media

- Status: Accepted
- Date: 2026-08-03

## Context

The WebCodecs program monitor builds an in-memory MP4 sample table and decodes
the source audio before playback. That is a good trade for FramePilot's bounded
540p proxies, but imports longer than the synchronous proxy limit intentionally
have no proxy. Feeding a feature-length original into the same path made project
open and small edits pay CPU and memory costs proportional to the entire movie.

Long timelines also exposed three whole-project costs on every preview tick:
linear segment lookup, scans across every caption/effect span, and display-rate
loops that continued while the editor was paused.

## Decision

Select the program-monitor engine from media suitability:

- proxy-backed, canvas-compatible timelines use the WebCodecs compositor;
- any timeline that references an unproxied video uses Chromium's native media
  element pipeline, which streams and range-reads the source;
- images may continue through WebCodecs because they are decoded as images, not
  demuxed as full video sources.

Both paths remain preview-only and preserve the same timeline/patch contract.
The WebCodecs path uses binary segment lookup and a bucketed temporal index for
caption/effect spans. The native effect overlay and timeline follow loop schedule
continuously only during playback; a paused frame is painted once.

## Consequences

Feature-length originals no longer need to be fetched, demuxed, retained, and
audio-decoded in full by the renderer before editing. Per-frame lookup cost is
bounded near the current playhead rather than by total movie complexity.

The native path previews effects over the picture layer but below DOM text and
captions, an existing documented limitation of that path. Final export remains
the deterministic source of truth. A future background proxy queue can move long
sources back to the WebCodecs path once a bounded proxy exists.
