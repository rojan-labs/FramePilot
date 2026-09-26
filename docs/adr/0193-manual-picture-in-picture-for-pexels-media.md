# ADR 0193 — Manual picture-in-picture for Pexels media

- **Status:** Accepted. Supersedes ADR 0140's gating role for **manual** overlay placement only:
  **Add** is still a cutaway under ADR 0140, and the agent's `add_stock` is unchanged.
- **Date:** 2026-09-26
- **Decided by:** MD-E5, decided 2026-09-26 on the plan's recommended answer (manual only first).
- **Relates to:** ADR 0140 (stock media is placed as a cutaway), ADR 0169 (a full-frame cutaway
  goes in front), ADR 0170 (coverage is a relation between the layers), ADR 0180 (the program
  monitor composites every timeline), ADR 0191 (an element is an overlay), plan
  [`plan/elements/`](../../plan/elements/README.md) (EL9; risk R13 in
  [`11-RISKS-AND-DEFERRED.md`](../../plan/elements/11-RISKS-AND-DEFERRED.md)).

## Context

ADR 0140 let a Pexels photo or video onto the timeline only where no picture already was, and
gave its reason in one line: the preview drew one picture layer at a time while the export
composited them all, so a stock clip over footage would show one thing and export another. Its
consequences said so plainly — picture-in-picture, split screen and B-roll over A-roll were not
available from the Stock panel — and that "when `SUC-P1` lands, this becomes a layer choice
instead of a refusal."

That premise is gone. Since ADR 0180 the program monitor composites every timeline with the same
per-frame plan the export compiles, including scaled and positioned picture layers, and the PX4
oracle holds the two to each other in CI. A picture laid over footage now previews as it exports.

What was left was the product gap: the Photos and Videos tabs offered **Add** and nothing else,
so the most common thing a creator does with a stock shot over a talking head — a smaller picture
in a corner, over the speaker — meant importing the file by hand and resizing it on the canvas.

## Decision

**Each Photos and Videos tile offers two explicit placements, and a tile can be dragged to the
timeline. Only the manual placements change; the agent keeps its cutaway rule.**

- **Add** stays a cutaway. ADR 0140's rule is untouched: over picture it is disabled with the
  reason visible before the click. When no tile can be added, the panel's note now also points at
  **Add as overlay**.
- **Add as overlay** places the media at the playhead as a picture-in-picture: centred, at 40% of
  its contain-fit size (`STOCK_OVERLAY_SCALE`), written as the base `scale`, `x` and `y`
  keyframes at time 0 — the same keyframes the on-canvas handles write, so a placed overlay and a
  hand-sized one are the same data. It goes on a picture lane just in front of the front-most
  picture lane, and never in front of a graphics lane — so it covers the footage and stays under
  stickers, shapes, titles and captions (ADR 0191), even where an older project has a picture
  lane stacked above them; a second overlay joins that lane when it has room rather than opening
  a lane per clip. Started inside the programme, it ends with the last picture clip rather than
  lengthening the export; started at or after the end, it keeps its own length. It is never
  refused for covering picture: sitting over footage is what it is for. The new clip is selected
  so its handles show.
- **Dragging a tile to the timeline** places the media full frame at the drop time: on the picture
  lane it was dropped on when that lane has room, else on a new lane in front of the footage.
  ADR 0140 itself called the front-lane placement right for a file the user drags in by hand; a
  drag is an explicit stack. It keeps its full length even past the end of the programme, as any
  clip dragged in from the bin does: a full-frame shot is new material, not a picture over the
  footage, so the overlay's cap does not apply. The drag carries the provider id and the kind
  only, never a path or URL; main refuses an id that now names the other kind (a Pexels photo and
  video can share one). When the timeline changed during the download so the lane no longer has
  room, the clip still lands in front and a sentence says so.
- **One builder per placement, in `editor-core`** beside `buildAddStockOps`:
  `buildAddStockOverlayOps` and `buildDropStockOps`. The panel wraps them with a patch identity
  only, so a later agent path cannot drift from what the panel does. Each is one validated patch;
  one undo removes the clip, the lane it opened and the asset.
- **No new render path.** An overlay is an ordinary picture clip with a base transform. The frame
  plan, the monitor's compositor and the export already draw it.
- **The agent is unchanged.** `add_stock` (the desktop host and `stockOpsFromPayload`) keeps
  cutaway-first: a full-frame cutaway lifted in front of what it covers (ADR 0169), or a refusal
  when it cannot show one. It never builds the overlay. Relaxing that needs its own measurement —
  "Agent picture-in-picture with Pexels footage" in `plan/elements/11-RISKS-AND-DEFERRED.md` §2 —
  and a test in the web editor, the one package that imports both paths, holds it until then.

## Consequences

- Picture-in-picture over footage is one click from the panel, and it previews as it exports.
- Two named actions keep what a cutaway is clear (R13): **Add** always means "instead of what is
  there", **Add as overlay** always means "on top of it".
- The agent and the panel now differ for this one placement, on purpose. For **Add** they still
  build identical operations (the existing cross-path parity test).
- 40% is a starting size, not a rule: the on-canvas handles and the Inspector's transform rows
  resize and move the overlay like any clip.
- A front picture lane counts as a picture-in-picture lane when every clip on it is drawn below
  its contain-fit size (its base `scale` below 1) or it is empty; that is how a second overlay
  finds the first one's lane. A lane the user fills with full-frame footage stops qualifying, and
  the next overlay opens its own lane in front.
- `buildAddStockOps`, which the agent's `add_stock` also calls, opens a new lane (only into empty
  time) by the same rule, just in front of the front-most picture lane and under the graphics,
  rather than at index 0 where it covered them. That moves where the agent's lane opens, on
  purpose (ADR 0191: graphics stay on top); the agent's placement rule — cutaway first, no
  picture-in-picture — is unchanged.
- Evidence: `editor-core` builder tests (apply and invert, one undo, the lane rules, the length
  cap), the web editor's patch, drop and panel tests, the agent-unchanged test, and a desktop
  end-to-end spec: Add as overlay → a front lane at 40%, centred → undo and redo → export, with
  the overlay's and the footage's colours read from an export frame and monitor parity → save,
  close and reopen; and tiles dragged over and after the footage → undo.

## Alternatives considered

- **Let Add stack over footage by itself.** One button whose result depends on what happens to be
  under the playhead blurs what a cutaway is, and an editor could not predict it.
- **A full-frame overlay.** That is a cutaway: **Add** makes one into empty time, a drag makes one
  anywhere, and the agent lifts one in front of footage under ADR 0169.
- **A `Clip.pip` field or an overlay effect.** A schema change and a second renderer path for what
  a base transform already says, with a parity surface of its own.
- **Relax the agent in the same change.** Unmeasured: a picture-in-picture from the agent can
  land on a face or the very button a demo is about, and nothing checks for that yet. Deferred
  until it is measured.
- **Open the overlay's lane at index 0.** It would cover every sticker, shape and title on the
  timeline.
