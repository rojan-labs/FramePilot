# Professional color commands

FramePilot separates an editor's color objective from stored effects:

```text
ColorObjective
  → resolveColorObjective
  → correct_shot ColorCommand(s)
  → compileColorCommand
  → validated apply_color_grade patch + inverse patch
```

The controller never selects a shot from prose. `this`, `these`, and `playhead` resolve through the
revision-bound `EditorInteractionContext`; stale, missing, ambiguous, audio, and caption targets are
rejected before an operation is emitted.

## Primary correction node

Each visual clip has at most one controller-owned primary correction effect with the stable id
`color__<clip-id>__primary`. A correction supplies absolute values for one or more supported axes:

| Axis        | Range |
| ----------- | ----: |
| exposure    | -5..5 |
| contrast    | -1..1 |
| saturation  | -1..3 |
| temperature | -1..1 |
| tint        | -1..1 |
| shadows     | -1..1 |
| highlights  | -1..1 |

Omitted axes retain their current primary-correction values. Reapplying a correction replaces the
same stable effect rather than stacking another correction. Distinct creative LUT or look effects
remain untouched.

`target: these` compiles one command per selected clip. All commands are revision-bound and each
compiler checks clip existence, visual track type, track lock state, effect parameter contracts,
patch validation, application, and exact inversion.

## Evidence-bound reference matching

`professional_color` only applies explicit numeric corrections supported by the editor's direction
or host-acquired evidence. It does not infer exposure, white balance, skin tone, or a “cinematic”
look from filenames or prose.

`measure_color` renders a bounded representative window of one clip and stores its complete
RGB/luma/saturation distribution in the run evidence store. Its returned handle is opaque to the
model. `match_reference` accepts a target and reference handle, then verifies:

- both entries came from `measure_color`;
- their timeline revision is still current;
- target evidence names the clip resolved from live editor state;
- all five channels contain means, tonal percentiles, and near-black/near-white ratios;
- no other visible clip/caption overlapped the sampled window.

The controller derives conservative exposure, contrast, saturation, temperature, and tint deltas
from those measurements using the renderer's documented parametric color math. Each axis is capped
to a restrained correction range, then added to the target shot's current primary correction and
clamped to the public parameter contract before the ordinary `correct_shot` compiler validates and
applies it. This is required because the measured timeline composite already includes the current
grade; replacing the grade with a measured delta would regress repeated matching. The model never
supplies the measurements or computed grade values.

The model-facing schema remains one strict top-level object for provider compatibility. Conditional
validation still enforces the two legal forms: explicit correction requires `adjustments` and no
evidence handles, while reference matching requires two evidence handles, one target shot, and no
model-authored adjustments.

The measurement is explicitly a `timeline_composite`, not a claim about an isolated source frame.
An obstructed composite fails instead of contaminating the match.

## Shot grouping

`groupShots: true` expands the one resolved shot into **every shot cut from the same source
recording** and grades them identically. "Match all of camera B to this" becomes one instruction
instead of forty selections.

The group is derived from the footage, never from how the shots look. A similarity threshold would
regroup the moment a grade lands — the shots it clustered by appearance stop resembling each other
as soon as one is corrected — whereas "same source file" is a fact that stays true and stays
explainable to the person reviewing the edit. Multicam needs no special case: an angle (schema v18)
_is_ one recording, so "camera B's shots" and "clips of B's asset" are the same set, and an
ungrouped project groups exactly as well as a grouped one. A one-off shot groups to itself, which is
the honest answer rather than a refusal.

## Skin preservation

`preserveSkin: true` on a match holds faces where they are while the rest of the frame moves.

Two things make this real rather than a promise in a prompt. First, presence is **measured**:
`measure_color` now also reports the pixels a documented colour qualifier selects — the classic RGB
skin-tone region, not a CV model — as `skin_red`/`skin_green`/`skin_blue` channels with a coverage
ratio. Below 2% coverage the controller refuses (`skin_absent`) rather than reporting no drift, and
a measurement taken before those channels existed refuses as `skin_unmeasured`. A qualifier selects
skin-_coloured_ pixels, which is not the same as skin; that is why coverage is reported and why low
coverage is a refusal.

Second, the restraint is arithmetic on the renderer's own math. Only temperature and tint are scaled
back — exposure and contrast move a face along the same axis as everything else, which is what
matching a shot _means_ — and they are scaled until skin **warmth**, its red:blue ratio, stays within
8% of where it started. The controller reports the scale it applied as a fact, including when it
applied none.

Warmth rather than hue, because the render-backed fixture said so: a large temperature push rotates
a skin tone's RGB hue by about a degree while moving its red:blue ratio by more than half. Warming a
red-dominant tone mostly changes how far it sits from grey, not which way. A hue tolerance would
have guarded nothing. Because a multiplicative white balance scales both channels by fixed factors,
the admissible push depends only on the tolerance and not on the particular tone — the measurement's
job is to establish that skin is present and how much of the frame it occupies.
