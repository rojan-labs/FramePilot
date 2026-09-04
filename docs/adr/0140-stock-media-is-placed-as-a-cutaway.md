# ADR 0140 — Stock media is placed as a cutaway, not an overlay

**Status:** accepted
**Date:** 2026-08-24
**Implements:** `plan/3rd-party-sourcing/photo-video` Phases 3–4
**Related:** ADR 0139 (provider media is fetched in main), ADR 0048 (multi-layer
compositing at export), `plan/SCENE-UNDERSTANDING-AND-COMPOSITING.md` §0.2 (`SUC-P1`)

## Context

Stock photo and video sourcing lets FramePilot put a picture clip on the timeline
that the user never filmed. The obvious placement is the one
`placeAssetPatch` already implements: if no existing layer of the same kind has
room at the drop point, create a new layer at the front and put the clip there.

That is wrong here, and the reason is a divergence that already exists in the
product.

**The preview is a single-picture-layer engine. The export is not.**
`apps/web-editor/src/editor/selectors.ts` flattens picture clips from every track
into one time-ordered `PictureSegment[]`, sorted by start, with gaps filled — two
overlapping picture clips on two layers cannot both be shown, and the later one
simply overwrites time. Meanwhile `render/compiler.py` (`_blend_layer_over`,
schema v8 / ADR 0048) composites them properly, with blend modes.

This is documented as blocker #1 in the scene-understanding plan, and `SUC-P1`
exists to close it. It has not started.

For music the divergence was irrelevant: audio does not composite through the
picture path. For stock picture media it decides the design. A clip dropped onto
a new front layer over a screen recording would show one thing on screen and
render another — the preview-vs-render defect class the repo treats as a bug,
and precisely the "UI tells a lie" failure `SUC-P1` was written to close.

## Decision

**Stock picture media is placed only where it does not overlap existing picture
media in time. Where it would overlap, the placement is refused with a stated
reason.**

Three consequences follow:

1. `addStockClipPatch` returns `null` rather than falling through to a
   new-front-layer branch. Placing into _empty_ time is unaffected — a clip that
   overlaps nothing composites identically either way, so a fresh layer is
   created exactly as `placeAssetPatch` would.
2. The Stock panel disables **Add** with the reason visible **before** the click,
   recomputed as the playhead moves. The user is told what to do about it ("move
   the playhead, or make a gap"), not merely that something is wrong.
3. `add_stock` fails with the same reason, checked in main **before** spending a
   download — the answer does not depend on the bytes. Per ADR 0083 it fails
   closed rather than reporting a completed edit on a timeline it did not change.

The predicate lives in `packages/editor-core/src/picture-occupancy.ts` because
two processes need the identical answer: the renderer, to disable a button, and
Electron main, to refuse the agent. Two copies would eventually disagree, and the
way they would disagree is that one of them starts allowing the overlap.

## Why not the alternatives

**Ship the stacking and accept the divergence.** This is the option that looks
like more product. It ships a feature whose output the user cannot evaluate until
export, in a product whose central promise is that the preview tells the truth.
One bad export costs more trust than the missing capability costs.

**Fix `SUC-P1` first.** Correct, and much larger: multi-layer picture compositing
in the WebCodecs preview is an unstarted project with its own mask, blend-mode
and performance surface. Gating stock sourcing behind it would have delayed a
useful capability by a subsystem.

**Ripple-insert instead of refusing.** Pushing everything right and inserting the
clip is the natural resolution, and the `insert` operation already exists — but
it is AI-only with no UI, and building the first UI for it is a timeline-editing
change with its own correctness surface (ripple semantics across locked tracks,
markers, captions). It remains the right next step, and it belongs in the
timeline plan rather than this one.

**Treat "no same-kind layer with room" as the test** (the first implementation).
It was wrong in a way worth recording: with no image layer in the project, the
first photo the user ever added would be refused for conflicting with nothing.
The predicate has to be about time, not about layers.

## Consequences

- Stock media cannot yet be laid over existing footage. Picture-in-picture,
  split-screen and B-roll-over-A-roll are **not** available from this feature.
  The guide says so plainly rather than letting the user discover it.
- When `SUC-P1` lands, this becomes a layer choice instead of a refusal. Nothing
  else in the stock feature needs redesigning for that: the predicate has one
  home, and one caller each side.
- The agent can hit the refusal mid-run. The tool description and the b-roll
  skill both say it is a real constraint rather than something to retry around,
  so a run does not walk the placement forward one second at a time until it
  sticks.
- A photo has no duration, so both the panel and main use the same default still
  length. They are kept in step deliberately; a mismatch would make the button's
  enabled state disagree with what actually fits.

## Amendment (2026-09-02) — the same refusal now covers every agent picture placement

> **Superseded in part by ADR 0169 (2026-09-03).** This amendment's blanket refusal cost
> the agent the ability to build a montage or a layered cutaway on any project whose main
> track is occupied — which is every talking head. ADR 0169 narrows it: a **full-frame
> opaque** placement is legal and is lifted onto a layer in front of what it covers, and
> only a scaled, positioned, cropped, masked, faded or blended one is still refused. The
> decision below is unchanged for `add_stock` and the Stock panel, which choose the track
> themselves. Read this amendment as the reasoning, and ADR 0169 as the current rule.

This ADR was written about `add_stock`, because that was the feature in front of
us. The reason it gave was never about stock: the preview flattens picture from
every track into one chain and the export composites it, so **any** picture over
picture is an edit the user approves in one form and receives in another.

The general agent path was still creating exactly that. `add_track` invited it in
as many words — "stack simultaneous elements — a title over b-roll,
picture-in-picture" — and `add_clip`/`add_clips`/`move_clip` would then put a
video or image clip on a second video layer over existing footage. The validator
allows it (clips on _different_ tracks may overlap), so nothing refused it, and
the preview showed the later clip alone.

**The refusal now applies to every agent placement of picture media.**
`packages/ai-sdk/src/domain-tools/picture-layers.ts` answers one question —
which picture clips on OTHER tracks a candidate span would cover — and
`add_clip`, `add_clips` and `move_clip` refuse when the answer is non-empty,
naming the clip, the track, the reason and the cutaway alternative. The refusal
is a `deterministicFailure`, so the model is stopped from retrying the identical
call rather than walking the placement across layers one at a time.

Three boundaries are deliberate:

- **Same-track overlap is not this predicate's business.** The validator already
  rejects it, with a better message. What is left is the cross-track overlap the
  validator allows and the preview cannot show — which is why this is not
  `editor-core`'s `picturePlacementConflict`, whose occupancy answer covers the
  target track too because the Stock panel picks the track itself.
- **Only picture.** Kind comes from the asset, never the layer, so text overlays
  (`__text__`), captions (`__caption__`) and audio beds stack freely — stacking
  them is what layers are for, and they never enter the picture chain.
- **Manual UI editing is untouched.** A person dragging a clip onto a second
  layer can see both, chose it, and owns the result. This constrains what the
  agent does _for_ the user.

Lifting it is still `SUC-P1` and still a maintainer decision. When multi-layer
picture preview lands, this becomes a layer choice instead of a refusal, and the
callers are three lines in one file.

### A refusal is not a bad argument (follow-up)

Extending the rule surfaced a defect in the tool boundary that predates it.
`operationsForCall` wrapped _every_ throw out of `buildOps` as `invalid_args`, so
this refusal reached the model as `Invalid arguments for "add_clip": Refused: …`.
That prefix argues against the sentence behind it: told its arguments are wrong,
a model fixes arguments — nudging `start`, trying another `trackId` — instead of
placing the cutaway the refusal names.

`ToolRefusalError` (`packages/ai-sdk/src/tool-refusal.ts`, imports nothing so
neither the dispatcher nor the tool families gain a cycle) says which kind of
"no" it was. `operationsForCall` re-labels it as the `refusal` code, and the
orchestrator writes `Refused "add_clip": <sentence>` with nothing in front of it.
Still `deterministicFailure` — a policy refusal is the most certainly repeatable
failure there is — and the editor's card shows the same plain sentence, because a
refusal is already written in the language a human needs.

Three existing sites were reclassified with their wording untouched: caption cues
that would cross an edit boundary or run too long for `add_caption_layer`,
captioning a project with no transcript or no surviving speech, and a punch-in
asked of a caption clip. Argument errors around them — an unknown template, an
unbundled font, an ungrounded emphasis keyword, an unknown `effectId`, an
inverted `apply_effect` window — stay `invalid_args`, because for those the
arguments really are what is wrong.
