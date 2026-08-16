# Professional motion commands

FramePilot separates an editor's motion objective from stored keyframes:

```text
MotionObjective
  → resolveMotionObjective
  → animate_clip_property MotionCommand
  → compileMotionCommand
  → validated add_keyframes patch + inverse patch
```

The controller and compiler never mutate a project directly. They return typed commands and
validated reversible patches through the same patch authority as timeline editing.

## Motion objective

`professional_motion` accepts two intents:

- `animate_to`: evaluate the selected property at the live playhead and animate it to `value` over
  `durationFrames`.
- `continue`: use the last two property keyframes ending at the selected keyframe (or playhead) to
  extrapolate the established value-per-second trajectory for `durationFrames`.

The target is the primary selected clip or the single clip under the playhead. `property` may be
explicit. When omitted, exactly one selected keyframe property must resolve; FramePilot rejects an
empty or multi-property selection instead of choosing one.

Durations and positions use integer clip-presentation frames with the project's rational sequence
rate. Stored keyframe seconds are derived only in `compileMotionCommand`, avoiding decimal-fps drift
and keeping the model out of time conversion.

## Compiler guarantees

`animate_clip_property` is revision-bound and checks:

- the target clip exists on an unlocked visual track;
- at least two unique, non-negative clip frames are present;
- every frame lies inside the clip;
- scale remains positive and opacity stays within `0..1`;
- the generated `add_keyframes` patch validates, applies, and constructs an exact inverse.

Generated keyframe IDs derive from clip, property, and frame. Writes use `replace: true`, so editing
an existing property diamond updates that instant without stacking an indistinguishable duplicate.

## Easing and continuation

The objective supports `linear`, `ease-in`, `ease-out`, `ease-in-out`, `hold`, and `bezier` (the
schema's deterministic smoothstep when custom handles are absent). `animate_to` defaults to
`ease-in-out`; `continue` defaults to `linear` so extrapolated velocity does not unexpectedly
accelerate. Continuation normalizes floating-point residue before persistence.

## Transform constraints

`constraintPolicy: property_bounds` enforces the renderer's hard property contracts.

`constraintPolicy: cover_canvas` additionally samples every frame in the requested window using
the canonical keyframe evaluator. It requires scale and translation to keep the sequence canvas
covered and rejects rotation because the current axis-aligned proof cannot guarantee rotated-frame
coverage. This is deliberately fail-closed: use `property_bounds` only when exposing the canvas is
intentional (for example, a designed overlay).

The unified temporal reviewer remains responsible for verifying the rendered motion window. The P2
motion-controller item stays in progress until a render-backed objective fixture proves that path.
