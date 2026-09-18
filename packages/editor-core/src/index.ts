/**
 * @framepilot/editor-core — public surface: operations, patch engine, validator,
 * and caption segmentation. See plan/PLAN.md Phase 1.2–1.4.
 */
export * from './operations.js';
export * from './operation-contract.js';
export * from './edit-value-contracts.js';
export * from './project-operations.js';
export * from './patch.js';
export * from './history.js';
export * from './validator.js';
export * from './keyframes.js';
// Which picture clips replay material another already plays — the one definition the agent's
// clip rows, `get_clips` and the duplicate-takes rubric share (TRACKING Q5).
export * from './source-repeats.js';
export * from './speed-curve.js';
// The one authoritative caption segmenter, shared by the Captions panel and the
// AI `add_captions` recipe so they cannot disagree (ADR 0071).
export * from './captions/segment.js';
export * from './captions/emphasis.js';
// The one definition of "what does this caption say?", shared by the editor
// list, the live preview, and (mirrored) the Python renderer (ADR 0071).
export * from './captions/cue.js';
// The one source ↔ sequence time mapping. No other module may compute a
// timeline offset for a source timestamp (ADR 0076).
export * from './timeline-map.js';
// Transcript → edited-timeline caption derivation, built on that mapping.
export * from './captions/derive.js';
// Where the sequence really cuts, and what a transition can do there (ADR 0076).
export * from './edit-boundaries.js';
export * from './professional-commands.js';
export * from './motion-commands.js';
export * from './color-commands.js';
export * from './track-follow.js';
export * from './track-reframe.js';
export * from './picture-occupancy.js';
export * from './lane-placement.js';
// The one shape of "a fetched stock clip on the timeline", shared by the Stock
// panel and the agent's `add_stock` so the two paths cannot drift (ADR 0140).
export * from './stock-placement.js';
// The audio twin: shared by the Sounds panel and the agent's `add_music`.
export * from './music-placement.js';
// The v22 mask stack's display-corrected source space and compact path storage (ADR 0178).
export * from './mask-geometry.js';
// Mask stack operations and the frame-fraction ↔ source-pixel builders tools share (ADR 0178).
export * from './mask-operations.js';
export * from './mask-builders.js';
// Hand-editing geometry, freehand fitting and the mask commands the UI and the agent share (MK4).
export * from './mask-path-editing.js';
export * from './mask-curve-fit.js';
export * from './mask-commands.js';
// The transform-track artifact a tracked mask points at, and the host policy that builds one
// out of tracker measurements (MK7).
export * from './mask-track.js';
export * from './mask-track-solve.js';
export * from './mask-track-review.js';
export * from './track-samples.js';
export * from './tracking-commands.js';
export * from './audio-commands.js';
// How a transition is stored across the two clips it joins, and where its ramp
// sits relative to the cut (plan/ADVANCED-TRANSITION-SYSTEM.md).
export * from './transitions.js';
export * from './frame-grid.js';
// What one exported frame is made of, back to front — the TS twin of the engine's
// `render/frame_plan.py`, pinned by `tests/fixtures/frame-plan` (PX1).
export * from './frame-plan.js';
// The model states why a transition belongs at a cut; this decides which one and
// how long, from the cut's measured deltas (plan/visual-understanding §VU4.1).
export * from './transition-policy.js';
// Grade parameters solved from measured luma/chroma rather than guessed by the
// model (plan/visual-understanding §VU3.1, ADR 0175).
export * from './color-solver.js';
