# 0088. Model effects as timeline layers, dispatched on a closed render-kind enum

- Status: Accepted
- Date: 2026-07-30

## Context

Before this change an "effect" in FramePilot meant one entry in `clip.effects`, applied to
that clip's own picture by `compiler._apply_color_grade`. Four types actually rendered:
`color_grade`, `lut`, `transform`, and `transition`. The Effects panel showed those plus ten
tiles explicitly disabled with a "Soon" tag — honest, but it meant the product had no glitch,
no VHS, no grain, no warp, no mirror, and no way to say "this look applies to the next three
seconds of the edit" rather than "to this one clip".

Three things blocked closing that gap, and each had to be decided rather than assumed.

**There was no render stage that could do it.** Every existing effect transforms a single
clip before compositing. An effect that restyles "whatever is visible beneath it for this
time range" needs a stage that runs on the *composited* frame. Nothing in `compile_timeline`
operated there.

**The preview could not show most of it.** `webcodecs-preview-engine` composites onto a 2D
canvas and expresses per-clip looks with `ctx.filter` — CSS filter strings. That covers blur
and a grade. It cannot express chromatic aberration, halftone, fisheye, mosaic, mirror, or
any per-pixel corruption. Per-pixel JS at 1080p/30 is not close to real time.

**A large catalog and a small renderer surface are in tension.** Fifty-plus browsable effects
implemented as fifty-plus shaders (twice — GLSL and numpy) is a hundred implementations to
keep in visual agreement, and the caption template work (ADR 0069) had already shown how
expensive that kind of parity contract is to maintain.

## Decision

### Effects are layers on their own track type

Schema v13 adds `effect` to `TrackType` and `Track.effectLayers`. An `EffectLayer` carries
`{ effectId, kind, start, end, params, intensity?, disabled? }`.

An effect layer is **not** a `Clip`. Modelling it as one would have forced a sentinel
`assetId` past the validator's "every clip resolves to an asset" rule and given every effect a
meaningless source in/out range. It is its own shape, and `effect` tracks carry
`effectLayers` instead of `clips`.

`effectLayers` is `.optional()`, not `.default([])`. A default makes the field *required* on
the parsed type, which forced `effectLayers: []` into every `Track` literal in the repo — 216
type errors across 29 files, nearly all unrelated test fixtures — and would write the key into
every track of every saved file. Optional keeps a v12 project byte-identical through a
round-trip and matches the posture every other additive `Track` field already takes
(`captionStyle`, `locked`, `hidden`, `muted`). The cost is that a reader can forget the empty
case, so `effectLayersOf()` is the sanctioned accessor and no renderer reads the field
directly.

Per-clip `clip.effects` is unchanged and still honoured. v13 adds a second, complementary
place for effects to live rather than moving the old one, which is what keeps every existing
project and every existing patch valid.

### Renderers dispatch on a closed enum, never on a catalog id

`EffectRenderKind` is a 41-value closed enum. The 72-entry catalog is pure data: a name, a
category, one kind, and a shallow override of that kind's default params. Both renderers
branch **only** on the kind.

This is the same extensibility contract caption templates established (ADR 0069), and it is
what resolves the catalog-size tension: "Retro Fade" and "Faded Polaroid" are both `film-fade`
with different params, so adding effect #73 is a one-object change with zero renderer work,
while adding a *kind* is a deliberate two-sided implementation.

Parameters are declared per kind in `effect-params.ts`, because a parameter is a property of
the renderer. Three consumers read that one declaration: the patch validator (rejects
out-of-range values), the Inspector (builds its controls generically), and the AI tool layer
(publishes real ranges so the model picks legal values instead of guessing). Every param is a
number; discrete choices are a numeric index plus a `choices` list, which keeps the wire
format uniform for the validator, the renderers, and keyframe animation alike.

### The compositing order lives in one place

`activeEffectLayersAt` (TS) and `Timeline.active_effect_layers_at` (Python) both walk tracks
bottom-up, then by `start` within a track. That shared order **is** the "multiple effects
combine predictably" guarantee. It is deliberately duplicated rather than derived, and both
copies are pinned by tests, because two renderers walking different sequences is precisely
how a stacked effect would drift between preview and export.

### The preview gets a WebGL2 post-process stage

A GPU pass is the only honest way to preview the catalog. It is placed as a post-process on
the finished 2D canvas rather than inside the per-clip draw: effect layers apply to the
composited frame, the existing presentation path (whose clock and canvas handling were
stabilized only in `05e6a6b`) stays untouched, and the whole stage is removable by deleting
one call. `drawImage` from a WebGL canvas to a 2D canvas stays on the GPU — it is not a
`readPixels` round trip.

It is lazy and failure-tolerant: no GL context until a project actually has an effect layer,
and a failed context or shader compile presents the un-effected composite rather than a black
frame. One bad shader skips its own layer; the rest of the stack still previews.

### Determinism is engineered, not assumed

Half the catalog needs randomness, and a render must be a pure function of the project.

Noise comes from a 32-bit **integer** bit-mix (`lowbias32`), not the conventional
`fract(sin(dot(p, k)) * large)`. That idiom is standard GLSL but `sin` is hardware-approximated
— its low bits differ between GPU vendors and differ again from numpy — so grain built on it
would visibly disagree between preview and export on the same frame. Integer ops are exact in
both `uint32` and GLSL `uint`.

Animated noise is keyed on a timestamp quantized to a shared 1/60s grid, because a render
steps exact frame times while a preview lands on whatever the compositor gives it. Both snap
to the same grid and then agree.

`CLAMP_TO_EDGE` sampling is a correctness requirement, not a preference: `REPEAT` would fold
content in from the opposite edge on every fisheye, ripple and kaleidoscope, so preview and
render would disagree at the frame border.

### One operation surface for both manual and AI editing

Six typed operations cover every effect action: add / remove / move / trim / set_params /
set_enabled, each with a lossless inverse. Deliberately absent: "duplicate" is an add with a
fresh id; "stack" is two overlapping ranges with order derived, never stored; "reorder" is the
existing `move_layer` on the effect track.

The seven AI tools drive these same six operations. "Manual editing and AI editing produce
the same results" is therefore true by construction — there is no second code path to keep in
step — and a test asserts the two produce deep-equal timelines.

## Consequences

**Good.** 72 effects across all 20 promised families on 41 shared kinds. Effects apply across
clips, stack predictably, and are fully reversible. Adding a catalog entry is data-only. Old
projects load unchanged and render byte-identically when they have no effect layers, paying no
per-frame cost. The AI can discover, apply, retime, retune, reorder, bypass and remove every
effect through the same operations a person uses.

**Costs and risks, accepted.**

- **The parity contract is manual.** 41 kinds × 2 implementations must stay in visual
  agreement, enforced by 350 structural parity tests (shader coverage, `@register` pairing in
  both directions, shared constants, param index alignment) rather than by pixel comparison —
  CI has no GPU. A golden-media test with a real GL context is the remaining gap.
- **Blur is approximated differently in each renderer.** numpy uses a summed-area table
  (O(1) per pixel); GLSL uses fixed 5×5 taps. Both are three-pass box approximations of a
  Gaussian, but they are not bit-identical at large radii. Judged acceptable because the
  difference is a slightly different softness, not a different effect.
- **`datamosh` is not a true datamosh.** A real one needs the previous frame, which would make
  the render stateful and order-dependent, and therefore un-seekable. It smears macroblocks
  along pseudo-motion vectors instead: the visual signature without the statefulness.
- **`pixel-sort` is not a true sort.** A per-row sort is data-dependent and cannot be
  expressed in a fragment shader, so both sides run a directional maximum-smear gated by
  brightness.
- **The AI tool surface costs ~868 prompt tokens.** Seven tool descriptions, measured against
  the frozen `streamAgent` golden. `discover_effects` caps results at 20 to stop the catalog
  itself consuming the context window.
- **A new subsystem sits in perf-critical code.** The WebGL stage is adjacent to a preview
  engine whose clock was only just stabilized. Mitigated by placement (post-process, one
  call), laziness (no context without effects), and failure tolerance — but it warrants perf
  measurement against desktop-scale media before it is considered settled.

## Alternatives considered

**Keep effects inside clips.** No migration, but it cannot express "this look covers the next
three seconds regardless of cuts", which was the requirement.

**Reuse `Clip` for effect layers.** Rejected: a sentinel `assetId` to satisfy the validator,
and a meaningless source range on every effect.

**CSS-filter preview only.** Honest and cheap, but caps the catalog at roughly 15 effects and
cannot cover the promised families.

**One shader per catalog entry.** Rejected as the thing that makes a large catalog
unmaintainable — 72 shaders twice, versus 41 kinds twice with params doing the differentiating.

**Approximate the preview and accept drift.** Rejected: "manual and AI editing produce the
same visible results" and "the preview updates immediately" both depend on preview and export
agreeing, so drift undermines the feature's premise rather than merely degrading it.
