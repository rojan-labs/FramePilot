# Transitions

A transition is a treatment of a **cut** — the boundary where one clip ends and the
next begins. It is not an effect on a clip, and that distinction is the reason
FramePilot refuses to put one "at the pivot" of a continuous shot: there is no
boundary there to treat.

## Using them

### From the panel

The **Transitions** tab in the left rail is the library: 77 transitions across 7
categories. Search by name, by direction (`left`), by feel (`fast`, `cinematic`) or
by use case (`social media`). Hovering a tile runs the transition's _real_ shader
between two synthetic frames, so what the tile shows is what the export produces.

Clicking a tile applies it to the cut the panel has resolved, which it names in the
line under the search field. That resolution runs in one order:

1. an edit point you selected on the timeline,
2. the cut entering the selected clip,
3. the cut nearest the playhead.

Dragging a tile onto any cut applies it there instead.

### From the timeline

Hover a cut and a **+** appears. Click it for a compact version of the same
library — search, shelves, animated tiles — anchored to that cut. Right-click an
applied transition for the actions that are timeline thoughts: preview, replace,
duration presets, alignment, copy/paste, apply to similar or selected cuts, remove.

Shift-click transitions to gather several cuts; the menu's bulk actions then say
how many they will touch.

### From the inspector

Selecting a transition opens its section: kind, duration, alignment, the audio
treatment, and **only the look controls the selected kind actually reads**. A
mosaic has a block size; a glitch has four numbers; a wipe has an edge softness and
no intensity, because "80 % of a reveal" is not a picture the renderer can produce.

**Compare without** holds the transition off rather than removing it — everything
it carries survives, and one undo either way.

**Save as preset** keeps a tuned transition on your own shelf, alongside the
built-in ones in the panel's _My presets_.

## Alignment

Where the ramp sits relative to the cut:

|                   | picture | what it does                                         |
| ----------------- | ------- | ---------------------------------------------------- |
| **End at cut**    | `▓│ `   | the whole ramp is on the outgoing shot               |
| **Centre on cut** | `░│░`   | half either side — what most editors expect          |
| **Start at cut**  | ` │▓`   | the whole ramp is on the incoming shot (the default) |

`start` is the default because it is what this engine has always done, so every
project made before alignment existed is untouched.

## What a transition can and cannot do here

FramePilot borrows **no source handles**: it never plays footage from beyond a
clip's out-point. That has two consequences worth knowing.

- A transition never fails for want of footage. Most editors refuse a dissolve when
  a clip has no handles; this one does not have to.
- On **butt-joined** clips a dissolve blends through **black**, not through the
  outgoing shot, because the outgoing shot has genuinely ended. Where clips
  overlap, it is a true cross dissolve.

The only real limit is length: a transition cannot exceed half the shorter of the
two clips, or it has eaten the shot it was meant to introduce. The inspector states
that ceiling rather than just enforcing it.

## Audio

A transition can pair an audio treatment across the same cut:

| mode                  | what it writes                                                  |
| --------------------- | --------------------------------------------------------------- |
| **Hard cut**          | nothing (the default)                                           |
| **Crossfade**         | linear fades on both clips                                      |
| **Fade out, fade in** | smoothstep fades — for a cut where the sound genuinely does dip |
| **Equal power**       | sine/cosine fades that hold the summed power constant           |

Equal power is the one that matters for music. Two clips crossfading on linear gain
sum to a dip in the middle — power goes as the square of amplitude, so half plus
half is only 0.707 of the power — and that dip is audible as a hole.

## Suggestions

The panel offers a few suggestions for the cut in front of you, each with its
reason. They come from the **timeline** only: how long the two shots are, whether
they are two halves of one take, what the neighbouring cut already uses, whether
this is the last cut in the sequence. Nothing here needs an analysis pass, so the
shelf never appears and disappears for reasons you cannot see.

## For maintainers: adding a transition

**Adding an entry is a data change.** Append an object to `TRANSITION_CATALOG` in
`packages/timeline-schema/src/transition-catalog.ts`, run `pnpm schema:generate`,
and it is in the panel, the popover, the inspector, the AI tool and both renderers.
Nothing else needs touching.

```ts
{
  id: 'iris-in',                 // stored verbatim as the transition's `kind` — never rename
  label: 'Iris In',
  category: 'wipe',
  renderKind: 'wipe-radial',     // one of the 29
  params: { invert: 0 },         // only what makes it distinctive
  defaultDuration: 0.6,
  thumbnail: pair(SHOT.city, SHOT.sea),
  description: 'A circle opens out of the centre.',
  tags: ['iris', 'circle', 'open'],
}
```

**Adding a render KIND is a two-sided implementation**, and the rule is absolute:

1. a GLSL pass in `apps/web-editor/src/preview/transitions/glsl-transitions.ts`;
2. a numpy twin in `engine/python/framepilot_engine/render/transition_passes/`;
3. param descriptors in `transition-params.ts`, whose **order is the uniform
   order** the shader and the numpy dispatcher both index by;
4. entries in `TRANSITION_DIRECTIONS` and `TRANSITION_UNIVERSAL_PARAMS` stating
   what the pass actually reads.

The parity tests then check every one of those against the shader itself —
including that no kind declares a param it never reads, which is what stops a
control the render ignores from reaching the inspector.

Read `glsl-transition-common.ts` first. Two things there are easy to get wrong:
UV is y-**up** in both renderers (the numpy side hands out a flipped grid on
purpose, so the two bodies read line for line the same), and `intensity` is each
pass's own business rather than an epilogue mix.

## See also

- ADR 0091 — why the catalog is split from the render kinds.
- ADR 0061 — transitions in the live preview.
- ADR 0076 — edit boundaries, and why no handles are needed.
