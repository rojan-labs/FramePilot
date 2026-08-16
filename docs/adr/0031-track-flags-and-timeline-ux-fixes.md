# ADR 0031 — Track flags (lock/hide/mute, schema v4) and timeline UX fixes

- **Status:** Accepted
- **Date:** 2026-06-28
- **Builds on:** ADR 0001 (reversible operations), ADR 0026 (project-scoped ops),
  ADR 0029 (UI revamp), ADR 0030 (live project-file sync).

## Context

Several timeline interactions fell short of a CapCut-grade editing experience, and
one was an outright bug:

1. **Image clips froze playback.** An image asset placed on the video track was
   mounted in the preview as a `<video>` element. That element never loads or
   "ends", so the master playback clock — which rides the `<video>`'s own
   `currentTime` to avoid per-frame seek flicker — saw `seeking` / a non-finite
   time and **held the playhead in place forever**. The preview stuck the moment it
   reached an image.
2. **Drag-drop mis-placed clips.** Dropping a bin asset on the timeline computed the
   drop time from the DOM event's `offsetX`, which is relative to whatever child
   (often an existing clip) received the drop — so the clip landed at the wrong time.
3. **No cursor zoom.** There was no Cmd/Ctrl-scroll zoom; only the toolbar/keyboard
   zoom-to-fit existed.
4. **Audio clips drew a thin outline,** not the solid CapCut-style waveform body.
5. **Track controls were disabled stubs.** The per-track lock/hide/mute buttons had
   no backing data — the schema had no track flags — so they did nothing.
6. **The playhead was a bare line** with no grab handle or time readout.

These were intentionally scoped as **Phase 1** (self-contained fixes + parity). The
deeper "type-agnostic layers + render-order" data-model change is deferred to a
separate ADR/phase.

## Decision

### Track flags — schema v4 (`locked` / `hidden` / `muted`)

- `TrackSchema` (Zod) and the Python `Track` (Pydantic) gain three **optional**
  booleans. Optional (absent ≡ `false`) keeps the change purely additive: existing
  v3 tracks validate unchanged and no track literal in the codebase needs editing.
  A `from:3 → to:4` additive migration stamps the envelope; the JSON Schema contract
  is regenerated from the Zod source.
- Flags mutate **track metadata, not clips**, so they get a dedicated reversible
  operation `set_track_flags` rather than the clip-snapshot inverse most ops use.
  Its inverse is a same-shape `set_track_flags` carrying the prior values (the
  readable-inverse pattern already used by `trim_clip`/`move_clip`).
- **"Off" is canonicalized as absent.** `applySetTrackFlags` _sets_ a flag key when
  `true` and _deletes_ it when `false`. Absent and `false` are equivalent to every
  reader, but a single canonical form means undo lands on a deep-equal timeline (the
  reversibility contract) and unset flags never bloat the serialized project file.
- Semantics: `locked` is an **editor affordance only** (blocks move/trim/split/drop
  on that lane; selection still allowed) — it has **no render effect**. `hidden`
  drops a visual track's picture/overlays from **both** the preview and the render.
  `muted` silences an audio track in the render. The render compiler honors
  hidden/muted in its compile loop, and `has_video_content`/`has_audio_content` were
  updated so render-validation expectations match what is actually emitted.

### Image playback fix

The preview now resolves the active picture clip and branches on the asset `kind`:
a real video mounts a `<video>` (and the clock rides it as before); an **image
mounts an `<img>`** and the playhead advances on the wall clock, so it plays through
the still's full duration with no freeze.

### Other UX

- **Drop placement** uses the lane-relative cursor (`clientX − lane left`) plus the
  existing snap, and routes an incompatible drop to the asset's natural lane.
- **Cmd/Ctrl + wheel zoom** is attached as a non-passive listener on the lane
  scroller (so it can `preventDefault`), zooming around the cursor by re-deriving
  `scrollLeft` from the clamped zoom the store applied.
- **Audio waveform** renders the existing mirrored points as a filled `<polygon>`
  (CapCut-style body) instead of a stroked `<polyline>`.
- **Playhead** gains a grabbable head (sharing the ruler's seek handlers) with a
  live time bubble, over a crisper full-height line.

## Consequences

- Schema bumps to **v4**; older files migrate transparently (additive).
- `set_track_flags` is an editor-side operation; the Python engine reads the
  resulting track flags at render time and needs no operation-applier change.
- No change to the AI/MCP tool surface in this phase.
- Deferred: the type-agnostic layer model + render-order migration (a future ADR).
