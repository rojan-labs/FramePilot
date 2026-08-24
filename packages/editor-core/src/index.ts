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
export * from './track-samples.js';
export * from './tracking-commands.js';
export * from './audio-commands.js';
// How a transition is stored across the two clips it joins, and where its ramp
// sits relative to the cut (plan/ADVANCED-TRANSITION-SYSTEM.md).
export * from './transitions.js';
