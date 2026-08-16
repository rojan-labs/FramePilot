# 13. Professional editor layout and browser media import

Date: 2026-06-22

## Status

Accepted

## Context

Phase 3 delivered a working manual editor, but its renderer was a single
stage column plus one tabbed right rail — functional, but not the spatial model
professional editors (Adobe Premiere Pro, DaVinci Resolve, Cursor) train users
on. The product brief calls for a layout where **assets and authoring tools live
on the left, the program monitor and timeline occupy the center, and the AI
inspector lives on the right**, with raw-footage import and asset handling as
first-class actions.

Two questions had to be answered together:

1. **How is the workspace laid out** so each Phase 1–4 capability has an obvious,
   conventional home?
2. **How does raw media get into a project** from the browser renderer, given the
   render/preview rule (the Python engine is the render engine; the UI preview is
   HTML video) and the path sandbox (assets resolve within the project dir)?

## Decision

### Three-column NLE workspace

`Editor.tsx` composes a fixed three-column grid framed by a top menu bar and a
bottom status bar:

- **Left "library" rail** — a tablist over **Media** (the asset bin + import),
  **Effects** (color-grade and transition presets), **Overlays** (text overlays),
  and **Captions** (transcript-driven caption authoring). These are _authoring_
  surfaces: they create timeline content.
- **Center stage** — the program monitor (`PreviewPlayer`), the editing
  `Toolbar`, and the multi-track `TimelineView`. This is where footage plays and
  where edits land.
- **Right rail** — a tablist over **AI** (chat / plan / edit / agent), the clip
  **Inspector**, and the **Transcript**. These are _inspection/assistant_
  surfaces.

Every panel is driven by the same patch-engine-backed `useEditor` store, so a
manual edit (toolbar, drag-drop, effect preset) and an AI edit share one
`validate → apply → record` path. No panel mutates the timeline directly.

The AI **mode** selector is a segmented button group (`aria-pressed`), not a
nested `tablist`, to avoid two competing tablist semantics inside the right rail.

### Browser media import via session-scoped object URLs

Raw footage is imported from the **Media** rail. In the browser renderer there is
no engine media probe, so `import.ts#probeMediaFile` reads a picked `File`'s
intrinsic duration/dimensions from a detached `HTMLMediaElement` over an
`URL.createObjectURL(file)` blob URL — the same media the preview `<video>`
plays in-session. The pure half (`kindOf`, `buildAsset`, deterministic
id-derivation with de-duplication) is unit-tested; the DOM probe is excluded from
coverage (jsdom has no media pipeline) and exercised manually / in e2e.

Import appends a schema-validated `Asset` to the project's media bin (it does
**not** touch the timeline). Placing an asset on a track — by the bin's "Add"
button or by dragging it onto a lane — is a separate, ordinary `add_clip` patch
through the engine, so it is validated and undoable like any other edit.

**Removing** an asset reverses that split cleanly: `removeAssetClipsPatch` lifts
every clip that references the asset as a single undoable `delete_range` patch
(a lift leaves the surrounding clips in place, so the patch's ops stay valid as
it applies), and only then is the asset dropped from the bin (`removeAsset`,
re-validated). Bin state and timeline state stay separated — undo reverses the
clip removal; the bin edit is the persisted-project concern.

### Program monitor follows the transport

A single `playing` flag lives in the store (`setPlaying`) so the Space key, the
J/K/L keys, and the on-screen play button are one source of truth. The hard part
is the clock. The first cut ran _two_ clocks — a wall-clock rAF advanced the
playhead while the `<video>` played on its own clock — and reconciled them by
writing `video.currentTime` whenever they drifted; every such write reseeks the
element, which **flickered** the picture. The fix inverts the relationship:

- **When a video clip is under the playhead, the element is the master clock.**
  The rAF loop _reads_ `video.currentTime` and maps it back to timeline time
  (`clip.start + (currentTime − clip.sourceStart)`) to drive the playhead. It
  never writes `currentTime` during smooth playback, so the element is never
  interrupted.
- **Sections with no video to ride** (gaps, audio-only, overlay-only, or a
  finished source) advance the playhead on a wall-clock tick instead.
- **Writes to `currentTime` happen only when they matter:** snapping exactly to
  the playhead while paused (scrubbing), or correcting a _gross_ mismatch while
  playing (a seek, or a cut to a discontinuous source). Frame-to-frame the
  delta is ≈ 0, so nothing is written.

The seek target is _source_ time — the clip's `sourceStart` plus the offset into
the clip — not timeline time, so trimmed/split clips show the correct frame. The
loop reads the live editor/clip through refs so it stays subscribed across the
per-frame re-renders `seek` causes. This also fixes the original "stuck on one
frame" bug (the element used to mount but was never told to play).

### Keyboard shortcuts as patch builders

`useShortcuts.ts` installs one global `keydown` listener that maps
Premiere/DaVinci-style accelerators (Space/J/K/L, Backspace/Delete ± ripple,
S / ⌘K split, ←/→ frame nudge, Home/End, M, zoom, ⌘Z/⌘⇧Z/⌘Y) onto the **same**
store actions and patch builders the toolbar uses — there is no second edit
path. It reads the live editor via a ref so it subscribes once, and it no-ops
while a text field or contenteditable surface is focused so typing is never
hijacked. Buttons advertise their accelerator through `title` hints for
discoverability.

## Consequences

- The layout maps each capability to a conventional location, so the editor reads
  as a professional NLE and the AI rail is clearly "the assistant," not a bolted-on
  panel.
- Import and placement stay cleanly separated: the bin is project state
  (`onProjectChange`), the timeline is store state (patches). Undo affects only the
  placement, never the import.
- **Limitation:** object URLs are session-scoped — they do not survive reload and
  are not real on-disk paths. A desktop import path that runs the engine's
  `inspect-media` probe and stores sandbox-resolved paths is the follow-up (tracked
  under Phase 8 alongside the renderer→engine export IPC channel).
- **Known gap (pre-existing, unchanged here):** the store's edited timeline is not
  yet synced back into the app-level `Project` that Save persists; wiring that
  through the desktop bridge is tracked under Phase 8.
