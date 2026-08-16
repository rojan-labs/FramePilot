/**
 * The executable professional evaluation case registry.
 *
 * Every registered scorecard fixture id must appear here with a runnable case; the drift gate in
 * `professional-evals.ts` fails otherwise, so a capability cannot be advertised on paper alone.
 */
import type { ProfessionalEvalCase } from './professional-eval-runner.js';
import { AUDIO_EVAL_CASES } from './professional-eval-cases.audio.js';
import { COLOR_EVAL_CASES } from './professional-eval-cases.color.js';
import { MOTION_EVAL_CASES } from './professional-eval-cases.motion.js';
import { TIMELINE_EVAL_CASES } from './professional-eval-cases.timeline.js';
import { TRACKING_MASK_EVAL_CASES } from './professional-eval-cases.tracking-mask.js';

export const PROFESSIONAL_EVAL_CASES: readonly ProfessionalEvalCase[] = [
  ...TIMELINE_EVAL_CASES,
  ...MOTION_EVAL_CASES,
  ...COLOR_EVAL_CASES,
  ...TRACKING_MASK_EVAL_CASES,
  ...AUDIO_EVAL_CASES,
];

export {
  TIMELINE_EVAL_CASES,
  MOTION_EVAL_CASES,
  COLOR_EVAL_CASES,
  TRACKING_MASK_EVAL_CASES,
  AUDIO_EVAL_CASES,
};
