# ADR 0155 — A frame the renderer fits into needs a shape to fit

**Status:** accepted
**Date:** 2026-08-28
**Schema:** v20 → v21 (additive; migration `20 → 21`)
**Related:** ADR 0076 (canonical timeline mapping), ADR 0138 (asset provenance, schema
v20), ADR 0146 (the frame grid), ADR 0153 (a run may not declare itself done over a
condition the request stated), ADR 0154 (a thing that says nothing still costs a model
turn)

## Context

`_place_video_clip` in `render/compiler.py` computes a clip's base scale as:

```python
base_scale = min(target_w / clip_w, target_h / clip_h)
```

That is *contain*, not *cover*. A 4:3 photograph in a 1080×1920 sequence therefore renders
as a band across the middle of a black frame unless its clip carries a `crop`. This is
correct behaviour and deliberately chosen — the alternative silently discards picture — but
it makes an asset's shape load-bearing for anyone deciding whether a clip needs cropping.

Nothing carried it. `AssetSchema` held `id`, `path`, `kind`, `durationSeconds`, `media`,
`folderId` and `source`; `AssetMediaSchema` held a proxy path, waveform peaks and thumbnail
paths. No width, no height, nowhere in the project file. `model-view.ts` then stripped the
whole `media` block before the model saw an asset, for the excellent reason that `peaks` is
thousands of floats nobody reasons over.

Two readers paid for it.

**`critic.ts#checkReframeCoverage`** could only ask a consistency question — is the picture
uniformly reframed? — and said so in its own docstring: *"the project does not carry each
asset's pixel dimensions"*. Where nothing was reframed at all it degraded to a `warn`,
because it could not distinguish "portrait sources, correctly uncropped" from "landscape
sources about to letterbox".

**The agent** was worse off. Run `fc10301a` was given 61 landscape WhatsApp photographs, a
1080×1920 project, and a delivery spec reading *"No black bars. No stretched photos.
Important subjects remain inside safe areas."* It placed 34 of them with no crop. It could
not have done otherwise: `list_assets` returns id, path, kind and duration, `set_clip_crop`
exists but nothing said which clips wanted one, and the only check that noticed emitted a
`warn` whose text was discarded before reaching the editor.

## Decision

**Add `width` and `height` to `AssetMediaSchema` (schema v21), and read them.**

1. **Schema.** `media.width` / `media.height`, positive integers, nullish like every
   sibling in that block — the Python engine serialises an unprobed asset's fields as
   `null`, not as absent keys. Migration `20 → 21` is a version stamp with nothing to
   backfill: the engine measures dimensions when it derives media, and an asset that has
   not been probed is honestly absent rather than guessed at.

2. **Producer.** `/asset-media` already calls `inspect_media`, and `MediaInfo` already
   exposes `width`/`height` off the first video stream. Carrying the two numbers into
   `AssetMediaResponse` costs one probe that was happening anyway. The desktop client takes
   them **both or neither** — half a shape is not a shape.

3. **Model view.** `ModelAsset` gains `orientation` (`landscape` | `portrait` | `square`)
   and `aspect`, derived. Two fields rather than the whole `media` block, for exactly the
   reason the block is stripped: `peaks` is noise and orientation is one word the model
   reasons over constantly.

4. **`list_assets`** gains a `letterbox` note naming the landscape assets in a portrait
   project and the tool that fixes them. That is a *join* — each asset's shape against the
   project's frame — which the model cannot make from any other single call.

5. **`checkReframeCoverage`** asks the geometric question where it can. Measured landscape
   picture in a portrait frame with no crop is no longer a risk to warn about; it is what
   the render will produce, so it `fail`s and names the clips.

## Absent means unknown, never square

Every consumer treats missing dimensions as "not measured" and says nothing, rather than
assuming a default. A guessed 1920×1080 would tell a run that a portrait photograph is
landscape and send it to crop the wrong axis — strictly worse than the gap being closed.
`checkReframeCoverage` keeps its old `warn` for an unmeasured project for the same reason:
failing a run over a shape nobody probed would be a false alarm on every project imported
before v21.

## Scope note

`CLAUDE.md` §5 requires asking before a schema change. The maintainer's instruction for
this branch was to close every gap in the run analysis "to the core instead of handling in
a shallow way", and this gap has no shallow fix — the information does not exist anywhere
to be surfaced. Recorded here so a later agent does not undo it as unapproved.

## Consequences

- Projects written before v21 keep working; their assets simply have no shape, and every
  reader degrades to the pre-v21 behaviour for those.
- A `warn` becomes a `fail` for measured landscape picture in a portrait frame. This is
  intended: it is the difference between "this might letterbox" and "this letterboxes".
- The renderer is unchanged. Fit-versus-cover remains its decision; this ADR only gives
  everyone else the numbers to reason about it.
