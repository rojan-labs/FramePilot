# 18. Phase 5 — motion render wiring, masking, and the object-tracking seam

- Status: Accepted
- Date: 2026-06-25
- Phase: 5 (Professional Motion, Tracking & Masking)
- Builds on: [ADR 0017](0017-keyframe-evaluation-engine.md) (keyframe evaluation engine)

## Context

ADR 0017 added the pure keyframe _evaluation_ engine. This ADR covers making that
engine — and masking and tracking — actually do something end to end, across five
reviewable slices, while respecting the build order (engine math → render → AI →
UI) and the "no large unreviewed rewrites" / "ask before adding dependencies"
rules (CLAUDE.md §5–6).

A hard constraint shaped the tracking work: the user wants to track **arbitrary
objects via AI**, not just faces — but real automatic detection/segmentation needs
a CV model (OpenCV / SAM 2 / YOLO), each with a dependency + license footprint. The
user **deferred that dependency decision**, so everything here is built with **no
new dependency**, and the automatic engine is left as a clean, documented seam.

## Decision

Ship Phase 5 as five no-dependency slices, each verified and at 100% coverage on
the touched deterministic core:

1. **Render wiring (motion).** A pure `framepilot_engine.effects.transform`
   resolves a clip's `scale`/`x`/`y`/`rotation`/`opacity` from its keyframes
   (`ClipTransform`). The compiler applies scale/position/rotation as MoviePy
   **time-varying functions** layered on the existing letterbox fit, and applies
   static **audio gain** (the `adjust_audio` effect) in the mixer. `opacity` is
   evaluated but its render is deferred to Phase 6 (fades/transitions) and reported
   by `unsupported_animated_properties` — deferred, never silently dropped.

2. **AI `punch_in` tool.** A new registered tool (TS `@framepilot/ai-sdk` +
   Python mirror, parity-tested, auto-surfaced over MCP) emits `add_keyframes` via
   the **shared** `punchInKeyframes` generator, so AI, UI, and the engine produce
   identical motion. The window defaults to the whole clip.

3. **Keyframe editor UI.** The Inspector gains a one-click punch-in (from/to scale
   - easing) and a manual add-keyframe form (property/value/easing at the playhead),
     both routed through the existing `useEditor` validate→apply→record path.

4. **Masking.** `add_mask` is generalized to carry geometry
   (`bounds`/`points`/`feather`/`opacity`/`invert`) and effect keyframes — stored
   in the **free-form `Effect.params`/`keyframes`, so there is no schema change or
   migration**. A pure `render/masks.py` rasterizes rectangle/ellipse/polygon with
   feather (Pillow Gaussian blur — Pillow is already a dependency), opacity, and
   invert. The compiler attaches it to a clip as a static mask, or a **time-varying
   mask** when the effect has keyframes (mask params animate via the keyframe
   engine). An Inspector "Mask" panel authors them.

5. **Arbitrary-object tracking seam.** `track_object` is generalized to
   `target:'object'` with a picked `region`, an `engine` name, and per-frame bbox
   keyframes. A pure `effects/tracking.py` defines an `ObjectTracker` protocol, a
   deterministic `ManualTracker` (hold or interpolate user corrections — the
   "manual correction" workflow), `get_tracker` (raises `TrackerUnavailableError`
   for any automatic engine), `tracked_box_at`, and `boxes_to_keyframes`. The last
   is the key composition point: **a track becomes animated mask or transform
   keyframes**, so "blur/hide a tracked object" and "a callout that sticks to it"
   reuse slices 1 and 4 — no new render path.

## Consequences

- **No schema change, no migration, no new dependency** across all five slices.
  Mask/track geometry rides the existing free-form `Effect.params`/`keyframes`.
- The engine stays deterministic and golden-testable: heavy/auto tracking, when a
  dependency is approved, runs out-of-band and only needs to emit `Box` keyframes
  the same way `ManualTracker` does — a localized change.
- **Dependency-gated work is explicit, not faked** (build-order invariant):
  automatic detection, confidence/re-track, and AI subject segmentation remain
  unavailable (`detect_faces`/`generate_mask` stay `available:false`;
  `get_tracker` raises for auto engines). This is the deferred decision from the
  Phase 5 kickoff.
- TS↔Python parity is preserved for every op and tool (mirrored modules + parity
  tests); the MCP surface auto-derives the new `punch_in` tool.

## Alternatives considered

- **Add OpenCV/SAM 2/YOLO now for real tracking.** Deferred to the user
  (CLAUDE.md §5): license (YOLO is AGPL-3.0), footprint, and determinism
  trade-offs are theirs to weigh. The seam makes adoption a drop-in later.
- **Animate opacity in the compiler now.** Deferred to Phase 6 with fades: a
  time-varying alpha mask must match the (possibly zoomed) clip size per frame,
  which is fragile alongside animated scale; it belongs with transitions.
- **A new `set_keyframes`/`clear_keyframes` op for the UI.** Not needed yet —
  adding keyframes + undo covers the current UI; a replace/clear op is a future
  engine addition if richer keyframe editing demands it.
