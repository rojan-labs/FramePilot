/**
 * @framepilot/ai-sdk/kernel/verification-note — the check a mutation's result already
 * carries, so the model does not spend a round trip asking for it.
 *
 * ## Why a result verifies itself
 *
 * `verify_transitions` and `verify_captions` are pure functions of the project. Their
 * descriptions told the model to "run this before saying a transition was added", and it
 * did: across the desktop runs recorded since 2026-09-01 (all providers, 985 calls), 89
 * model calls asked for one of the two, and 14 of those steps did nothing else — 188 s of
 * wall time whose only content was a check the harness could have done for free at the
 * moment the edit landed (TRACKING.md §X1).
 *
 * The orchestrator holds the post-patch project when it writes the result note. Running
 * the same verifier there, on the tools whose edits the verifier is about, turns "Added
 * transition Video 2" into "Added transition Video 2 · verified: all good, 3 transition(s)"
 * — and a failing check into the first problems, named, in the same breath as the edit
 * that caused them. The read tools stay available for a re-check after other edits.
 */
import { createLogger } from '@framepilot/shared-types';
import type { Project } from '@framepilot/timeline-schema';
import {
  DEFAULT_CAPTION_TOLERANCE_SECONDS,
  verifyCaptions,
  verifyTransitions,
  type VerificationIssue,
} from '../verify.js';

const log = createLogger('ai-sdk:kernel:verification-note');

/** Tools whose landed edit is what `verifyTransitions` checks. */
const TRANSITION_TOOLS: ReadonlySet<string> = new Set(['add_transition', 'add_transitions']);

/** Tools whose landed edit is what `verifyCaptions` checks — timing and the computable look. */
const CAPTION_TOOLS: ReadonlySet<string> = new Set([
  'caption_the_edit',
  'add_caption_layer',
  'auto_emphasize_captions',
  'set_track_caption_style',
  'set_caption_style',
]);

/** Problems spelled out before the rest are counted. */
export const VERIFICATION_NOTE_MAX_ISSUES = 3;

function problems(issues: readonly VerificationIssue[]): string {
  const shown = issues.slice(0, VERIFICATION_NOTE_MAX_ISSUES).map((issue) => issue.detail);
  const rest = issues.length - shown.length;
  const count = issues.length === 1 ? '1 problem' : `${String(issues.length)} problems`;
  return `${count}: ${shown.join('; ')}${rest > 0 ? `; …and ${String(rest)} more` : ''}`;
}

/**
 * The verifier's verdict for the edit a tool just landed, as a ` · verified: …` suffix, or
 * `''` for a tool no verifier is about.
 *
 * @param toolName - The tool whose operations were applied.
 * @param applied - The working copy AFTER the patch — the state the verdict describes.
 * @returns The suffix for the result note and card, or `''`.
 */
export function verificationNote(toolName: string, applied: Project): string {
  // A check that throws costs the run one log line, never its edit: the operations have
  // already applied and validated, and the verifier is an extra the model can still ask
  // for. (A cue with no source asset, as a fixture builds, once threw here and turned a
  // landed style change into an error note.)
  try {
    if (TRANSITION_TOOLS.has(toolName)) {
      const report = verifyTransitions(applied);
      return report.ok
        ? ` · verified: all good, ${String(report.transitionCount)} transition(s)`
        : ` · verified: ${problems(report.issues)}`;
    }
    if (CAPTION_TOOLS.has(toolName)) {
      const report = verifyCaptions(applied, DEFAULT_CAPTION_TOLERANCE_SECONDS);
      return report.ok
        ? ` · verified: in sync, ${String(report.cueCount)} cue(s)`
        : ` · verified: ${problems(report.issues)}`;
    }
  } catch (error) {
    log.warn('verification note skipped — the verifier threw; the edit stands', {
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return '';
}
