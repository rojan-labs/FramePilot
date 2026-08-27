/**
 * Frame-time conversion — re-exported from its new home (ADR 0146).
 *
 * The grid moved to `packages/editor-core/src/frame-grid.ts` so that manual edits get it
 * too: it used to run only at the AI patch boundary, which meant a human trim landed off
 * the frame grid the AI was careful to hit. This module stays as the import path the
 * ai-sdk call sites already use; there is no second implementation.
 */
export {
  frameToSeconds,
  normalizeOperationTime,
  normalizeOperationTimes,
  operationTimeChanged,
  quantizePatch,
  rationalFrameRate,
  secondsToFrame,
  snapSecondsToFrame,
  type FrameRounding,
  type RationalFrameRate,
} from '@framepilot/editor-core';
