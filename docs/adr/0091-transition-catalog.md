# ADR 0091 — The transition catalog

Status: **Accepted** · Date: 2026-08-01 ·
Supersedes nothing · Extends ADR 0021 (transitions), ADR 0061 (transitions in the
live preview), ADR 0076 (edit boundaries), ADR 0088 (effect layers).

## Context

Transitions shipped end to end — an operation, an eligibility check, a validator
rule, a MoviePy render, both preview paths, timeline blocks with resize handles,
an on-cut picker, an inspector section, AI and MCP tools. What they did not have
was a **library**: seven kinds, chosen from a list of seven words in a popup.

Seven is enough to prove the pipeline and nowhere near enough to be a product. An
editor arriving from CapCut or Premiere opens the picker, reads "Fade, Cross
dissolve, Push, Zoom, Blur, Wipe, Slide", and concludes FramePilot does not really
do transitions. Worse, the seven were chosen by what the renderer happened to
implement rather than by what anyone wanted, so the list read like an
implementation detail — which it was.

The obvious answer, "add sixty more kinds", is the wrong one. A kind is a shader
**and** a numpy pass **and** a place in four schemas, and sixty of those would be
sixty pairs to keep in parity across two renderers, in a codebase whose entire
transition story is that the preview and the export agree.

## Decision

**Split what a transition IS from what a renderer DOES**, exactly as ADR 0088 did
for effect layers.

- A **catalog entry** is pure data: a name, a category, one render kind, and a
  shallow override of that kind's defaults. 77 of them.
- A **render kind** is a shader and a numpy pass. 29 of them.
- Nothing branches on an entry id. "Whip Pan Left" and "Speed Blur" are the same
  `blur-directional` kind with different numbers.

Adding transition #78 is a one-object change to one file. Adding a _kind_ is a
deliberate two-sided implementation with a parity test.

### What a transition pass is

One function, in both languages:

```
transition(toTex, uv, p, params) -> vec4 rgba   // the incoming picture, with alpha
```

The compositor is unchanged: it draws that over whatever is beneath, which is the
outgoing clip where the two overlap and black where they are sequential. That one
signature is what makes 29 kinds tractable — a wipe is alpha, a slide is UV plus
alpha, a 3D turn is a perspective remap plus alpha, a glitch is UV plus colour.

`intensity` is **not** mixed generically by the epilogue, unlike an effect layer's.
At progress 0 there is no source to blend back towards, so a generic mix would make
every transition start as a hard cut. Each pass reads it.

### Alignment, and the second effect

A transition can now sit before, across or after the cut. The two placements that
are not "after" need the outgoing clip to do something, and nothing in the old
model let it, so a transition is stored as up to **two** effects:

| effect           | lives on      | covers                 |
| ---------------- | ------------- | ---------------------- |
| `transition`     | incoming clip | the ramp after the cut |
| `transition_out` | outgoing clip | the ramp before it     |

Progress runs 0 → 1 across the whole window wherever it sits. At progress `p` the
incoming clip's alpha is `A(p)` and the outgoing clip's is `1 − A(p)` — complements
of one function rather than two animations kept in agreement by hand.

The outgoing half contributes **alpha only**. A pass is written from the incoming
clip's point of view (it slides _in_, it zooms _in_), and running that picture
transform on the outgoing clip would send the old shot travelling the wrong way.
The reveal is what is genuinely symmetric.

## Consequences

### No schema change, no migration

`Effect.params` is free-form and `Effect.type` is an open string, so every new
param and the second effect are additive. A project saved before this exists opens
with its transitions intact.

### The seven original kinds keep their original render path

`fade`, `cross-dissolve`, `push`, `slide`, `zoom`, `blur` and `wipe` are catalog
entries mapped onto the kinds that reproduce what they already do — but the
compiler still routes them through the mask/geometry/blur code they always used,
not through the new per-pixel path. Byte-identical renders by construction rather
than by argument.

The one exception is alignment: the old path ramps over the incoming clip's first
`durationSeconds` and has no notion of a window sitting elsewhere, so a legacy kind
that is _not_ start-aligned takes the general path. That is a placement the user
explicitly asked for, so it is not a silent change.

### The parity surface grew, and is checked rather than trusted

Three tables state what each render kind reads — its directions, whether it has a
magnitude, whether it has an edge to feather — and the inspector builds its
controls from them. A parity test checks those tables **against the shaders
themselves**, so a control the render ignores cannot be shipped by hand-editing a
list. Another asserts every kind has both a GLSL pass and a numpy twin, and that
`uParams[i]` means the same parameter on both sides.

### Known limitation: sequential clips blend through black

This engine borrows no source handles (ADR 0076's reasoning), so on butt-joined
clips a dissolve blends through black rather than through the outgoing shot. True
two-shot blending needs an outgoing tail extension in both the compiler and the
preview decoder. It is out of scope here and tracked in the sub-plan; the UI states
which case a given cut is in rather than pretending.

### Rejected alternatives

**Sixty more kinds.** Sixty shader/numpy pairs to keep in parity, and a catalog
that could only grow by writing renderer code. The reuse is the point: a 0.25s 2.4×
punch and a 0.8s 1.25× drift are different tools and the same `zoom`.

**A `TransitionKind` union of every id.** Compile-time safety in exchange for
making every added transition a type change in editor-core, the AI tool layer, the
MCP server and the Python models. The value is checked against the catalog at apply
time instead, so a typo is a refused operation with a readable sentence — which is
also what an AI needs in order to correct itself.

**Sharing `GlEffectChain`.** Effect layers stack and output opaque RGB; a
transition is one pass whose alpha is the whole point. Sharing would have meant an
`alpha` flag threaded through every method and a ping-pong loop that never runs
more than once.

## See also

- `plan/ADVANCED-TRANSITION-SYSTEM.md` — the slices this was built in.
- `docs/guides/transitions.md` — how to use them, and how to add one.
- `packages/timeline-schema/src/transition-catalog.ts` — the catalog.
- `apps/web-editor/src/preview/transitions/glsl-transitions.ts` and
  `engine/python/framepilot_engine/render/transition_passes/` — the 29 pairs.
