# ADR 0169 — A full-frame cutaway goes in front

- **Status:** Accepted
- **Date:** 2026-09-03
- **Schema:** unchanged (no project-file field, no operation shape, no migration). The
  twelve frozen sessions moved by exactly the tool-definitions token delta — `+125` per
  request, from the rewritten `add_clip` and `add_track` descriptions — and nothing
  behavioural in them changed.
- **Relates to:** ADR 0140 (stock media is placed as a cutaway — **amended** by this),
  ADR 0048 (multi-layer compositing at export), ADR 0144 (an edit that renders as nothing
  is refused), goal.md Workstream A ("preview and final output must agree"),
  `plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` §0.2 (`SUC-P1`)
- **Decided by:** the maintainer, explicitly, on 2026-09-03. This is a product decision
  taken in session, not an inference from the code.

## Context

ADR 0140 refused any placement of picture media on top of picture media, and its
2026-09-02 amendment extended that from `add_stock` to every agent placement —
`add_clip`, `add_clips`, `move_clip`. The reason it gave was real:

> the preview flattens picture from every track into one chain and the export composites
> it, so **any** picture over picture is an edit the user approves in one form and
> receives in another.

The consequence, on the projects this product exists for, was that the agent could not
build a montage or a layered cutaway **at all**. A talking-head recording occupies its
main track end to end; every span the agent might cut b-roll into is occupied; so every
`add_clip` was refused. `packages/ai-sdk/src/beat-grid-wiring.test.ts` — a test whose
whole subject is a beat-synced montage over existing footage — went from green to
**2 passed / 8 failed** on the day the amendment landed, and every failure was the run
applying nothing.

Reading both sides of the divergence shows the refusal was too wide.

**The export** (`engine/python/framepilot_engine/render/compiler.py`) builds
`picture_by_track` in track order and then composites `reversed(picture_by_track)`, so the
first track's clips are drawn **last**, on top. Track index 0 is the visual front. That is
what `AddLayerOp.atIndex`'s doc already claimed, and it is now established from the render
code rather than from a comment.

**The preview** resolves a stack in two different places, and only one of them was wrong:

- the DOM `PreviewPlayer` picks the front-most picture clip from `activeClipsAt`, which
  returns clips in track order. It has always been z-order correct.
- `pictureSegments` (`apps/web-editor/src/editor/selectors-base.ts`), which feeds the
  WebCodecs canvas compositor, sorted every picture clip by `start` **alone** and let a
  later clip overwrite time. Its own doc said it "assumes no overlaps", and
  `canvasPreviewEligible` enforced that by declaring any overlapping project ineligible —
  so the projection was never actually wrong on screen, it was merely unable to answer.

So with overlapping picture the monitor shows the front-most clip, and the export
composites the layers. **For a layer that covers the whole frame opaquely, those are the
same picture.** The divergence ADR 0140 exists to prevent does not arise there. It arises
for a scaled, positioned, cropped, masked, faded or blended overlay, because the export
blends the base through it and a one-layer preview cannot.

## Decision

**A full-frame opaque picture placement over existing picture is legal and lands on a
layer in front of everything it covers. Every other stacked picture placement is still
refused, with the reason.**

Four parts:

1. **`isFullFrameOpaque`** (`packages/editor-core/src/picture-occupancy.ts`) is the
   predicate. A clip qualifies when it has no transform keyframes, no `crop`, a `normal`
   or absent `blendMode`, and no `mask` or transition effect. It lives in `editor-core`
   because the agent's guard and the canvas preview's eligibility test must ask the
   identical question; two copies would drift, and the way they would drift is that the
   guard starts allowing an overlay the preview cannot show.

   The disqualifiers are the fields that change **coverage or alpha**, not appearance: a
   colour grade is fine, a scale of 0.6 is not. Any keyframe disqualifies rather than the
   evaluated value, because coverage would otherwise be a function of time.

   `crop` disqualifies even though a _cover_ crop increases coverage: telling the two
   apart needs the source's measured pixel dimensions, which the predicate is not given.
   `add_clip`'s own auto-reframe crop is unaffected because it is applied **after** the
   placement is resolved, and it is a cover crop by construction.

2. **`pictureSegments` resolves the stack by z-order.** It splits the chain at every clip
   edge and takes the front-most clip over each run. A clip a cutaway covers contributes
   two spans, so `PictureSegment` now carries the `sourceStart`/`sourceEnd` **that span**
   plays — the engine maps source time from the span's `projectStart`, and handing it the
   clip's original in-point would restart the shot at the cut.

3. **`canvasPreviewEligible` admits an overlap** when every clip in it is full-frame
   opaque and no two of them share a lane. The "all of them, not just the front one" is
   deliberate: the clip _underneath_ is the one that gets sliced, and the engine derives
   its clip-relative compositing time from the span's start, which only stays correct when
   there is nothing clip-relative left on it. Two clips on ONE lane still make the project
   ineligible — that state has no defined order, which is why the validator refuses to
   create it, and nothing here can invent one.

4. **`add_clip`/`add_clips`/`move_clip` resolve the lane** through
   `createPicturePlacer` (`packages/ai-sdk/src/domain-tools/picture-layers.ts`). It keeps
   the lane the model named when that lane is in front of what the clip covers, falls back
   to an existing front lane with room, and otherwise emits an `add_layer` at index 0
   **in the same patch** as the placement — so the compound applies atomically and one
   undo removes the layer along with the clip on it. The placer is stateful for the length
   of one call, exactly like `editor-core`'s `createLaneAllocator`, so a batch lays one
   layer rather than one per entry; across calls the orchestrator's speculative working
   copy (`executeToolCalls`) carries the layer forward.

   The new lane is a **`video`** layer, never `overlay`. A clip's kind comes from its
   asset, so picture parked on an `overlay` lane would still composite as picture at export
   while this module's own occupancy scan stopped counting it — and the next placement
   would be told the time was free.

### What this supersedes in ADR 0140

ADR 0140's decision — "stock picture media is placed only where it does not overlap
existing picture media in time" — **stands unchanged for `add_stock` and the Stock
panel**. Those pick the track themselves and cannot be handed a front layer, so
"is this moment occupied?" really is the whole question for them.

ADR 0140's 2026-09-02 amendment — "the refusal now applies to every agent placement of
picture media" — is **superseded**. The refusal now applies to every agent placement that
is not full-frame opaque.

Two consequences of that narrowing are worth stating plainly:

- `add_clip` and `add_clips` write a bare clip, so they can no longer produce this
  refusal at all. The only tool that can is `move_clip`, which moves a clip that already
  carries compositing. The `picture_over_picture` refusal cause, and the run-memory
  banking built on it (`deterministicFailureKey`), are unchanged and now key that.
- `tracksWithNoFreePictureSpan` became `tracksCoveredByPictureInFront`, and its question
  changed with its name: not "is every instant occupied?" but "is every instant occupied
  **by something in front of me**?". Picture behind a lane never hid it; only the
  time-only test made it look that way. `arrangementLine` and `get_timeline_summary`'s
  digest both say `— hidden behind picture 0–Ns (a full-frame clip added here lands on a
new front layer)`, in identical words, because a run that oriented with the tool and a
  run that read the arrangement fact must hold the timeline in the same terms.

## Why not the alternatives

**Leave ADR 0140's amendment in place and teach the model to cut holes.** This is what the
refusal already told it to do, and it is not an editorial equivalent: a cutaway that
replaces the A-roll loses the narration's own picture continuity, and it cannot express
b-roll that returns to the same shot. It also cost the product its montage capability
outright, which is not a trade the divergence justifies once the divergence is measured.

**Fix `SUC-P1` first — real multi-layer compositing in the preview.** Still the right
end state, still a subsystem: blend modes, masks and per-layer decode in the WebCodecs
compositor. This change is the part of it that needs no new engine, and it removes the
refusal for the case that is 95% of what an editor asks for.

**Move the named track to the front instead of opening a new one.** Reorders existing
content the user did not ask to reorder. Rejected.

**Let the placement stay on the lane the model named, behind the footage.** Preview and
export would agree — both would show nothing — which is ADR 0144's "an edit that renders
as nothing" with extra steps. The placer refuses a lane it cannot be seen on for the same
reason it refuses a hidden or locked one.

## Consequences

- The agent can build montages and layered cutaways again, and `beat-grid-wiring.test.ts`
  is green with no change to the test.
- A run that has to lift a placement gets a layer it did not name. The `add_clip`
  description says so, and the returned patch names the lane, so the model can address it
  on the next turn. The lane id is `video_cutaway_N` — self-describing because it is the
  only naming surface there is: `add_layer` carries no `name`, and both the timeline UI
  and `projectNames` label a lane from its kind and position.
- The canvas compositor now serves stacked projects instead of silently handing them to
  the DOM player. That is a quality improvement on the desktop path and a new exposure:
  the compositor is exercised on segment shapes it never saw before.
- **Still divergent, and knowingly so.** A picture layer that is not full-frame opaque
  over other picture keeps the old behaviour in the preview — the monitor paints the
  front-most clip and the export blends. The agent cannot create one; a person dragging
  clips in the timeline still can, and owns the result. So can a run that places two
  full-frame clips and then adds a transition or a punch-in to the one in front: nothing
  re-tests the predicate after placement, and `canvasPreviewEligible` will drop such a
  project back to the DOM preview rather than paint it wrongly.
- ~~**Letterboxing is the other known gap.**~~ **Superseded by ADR 0170** (2026-09-03). The
  gap was real and the diagnosis here was incomplete: giving the predicate the measured
  shape is not enough, because whether a letterboxed layer diverges depends on the shape of
  what is UNDERNEATH it. Coverage is a relation between the front clip, everything it covers
  and the frame — `coverageVerdict` — and `isFullFrameOpaque` is now only its opacity half.
  The `crop` disqualifier described in Decision 1 above went with it: a crop is geometry, and
  refusing every cropped front clip refused the cover crop `add_clip` itself writes.
- One defect this exposed and fixed on the way: the beat grid resolved an operation's
  track type against the pre-turn timeline only, so cuts laid on a layer the same patch
  opened were classified as "not a picture track" and exempted from the grid entirely.
  `trackTypeLookups` now folds in the proposal's own `add_layer` operations. That is
  failure mode 2 in `beat-alignment.ts`'s header — silent non-enforcement exactly when it
  matters — with a newer cause.
