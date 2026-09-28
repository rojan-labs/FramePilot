/**
 * @framepilot/ai-sdk/acceptance — what "done" means for a request, in checkable terms.
 *
 * ## Why this exists
 *
 * A run's objective was seeded from the request and never replaced: `objective.outcome`, the
 * single acceptance criterion, the committed decision and the criterion verification reported
 * against were all the same verbatim sentence the editor typed. `objective.provisional` was
 * documented as a placeholder that "yields to the first real interpretation", but nothing ever
 * produced one — `setObjective` had exactly one caller, the seed itself.
 *
 * The consequence was a verification that could only ever answer "did any operation succeed".
 * A criterion that can be measured against the timeline is what this module records.
 *
 * ## Where a condition may come from — and where it may not
 *
 * Only from something that arrives already structured:
 *
 * - the finished LENGTH, as the model that routes the message read it and grounded it in the
 *   request's own words (`kernel/command-classifier.ts` `DeliverableLength`), or as the host
 *   stated it (`AgentOptions.durationTargetSeconds`);
 * - the median shot length of a reference the editor attached, MEASURED by the analysis
 *   (`references/directives.ts`), never read from the prompt.
 *
 * Nothing here reads the request's words. It used to: keyword and regex readers turned a
 * brief into a minimum shot count, per-clip "coverage" demands, requested stickers and
 * callouts, a rendered-file deliverable, a remember-for-later preference and a stock cutaway
 * cap. Each was patched brief by brief and each misread the next one. Run `d8d2e445` is the
 * last straw recorded in ADR 0196's amendment: "a tiny animated compass or arrow … (optional)"
 * became "A callout is on the timeline", a 27k-character brief yielded "at least 3 distinct
 * shots" from no stated count, and "every picture clip carries its own reframe" was met by the
 * automatic centred crop every landscape clip gets in a portrait frame — so four automatic
 * criteria were satisfied by one `add_clips` and one arrow, and the run completed over the
 * model's own "not done yet" list. A wrong criterion fails runs that did the work, or passes
 * runs that did not; either way it is worse than none.
 *
 * The request's parts — the shots, the treatments, the elements, the deliverable — belong to
 * the model, which reads the whole request and states them as its own plan (`update_plan`).
 * Taste, rhythm and retention stay in the objective's prose for the same reason.
 */

import type { ReferenceDirectives } from './references/directives.js';

/**
 * A finished length the run is held to: read from the request by the command reader
 * (`kernel/command-classifier.ts#DeliverableLength`, which also carries `statedAs`) or
 * stated by the host (`AgentOptions.durationTargetSeconds`, which does not).
 */
export interface StatedDuration {
  readonly seconds: number;
  readonly toleranceSeconds?: number;
  readonly statedAs?: string;
}

/**
 * The finished length a run is held to: the host's explicit target when it set one, else
 * the command reader's grounded reading, else none. One function for the criterion
 * (`conductor.ts`) and the check (`orchestrator.ts#critiqueOptions`), so they cannot pick
 * different targets.
 */
export function statedDuration(options: {
  readonly durationTargetSeconds?: number;
  readonly requestReading?: { readonly deliverableLength?: StatedDuration };
}): StatedDuration | undefined {
  if (options.durationTargetSeconds !== undefined) {
    return { seconds: options.durationTargetSeconds };
  }
  return options.requestReading?.deliverableLength;
}

/** A condition the deterministic Critic can check against a finished timeline. */
export interface CheckableAcceptance {
  /** Stated deliverable length in seconds, when the request named one. */
  readonly durationSeconds?: number;
  /** Half-width of the stated range, when the length was stated as one. */
  readonly durationToleranceSeconds?: number;
  /**
   * The request's own words that state the length. Carried into the criterion so a run —
   * and the editor reading its record — can see WHICH words a target came from, instead
   * of arguing with a bare number (run `6cb12e30` argued with "3s" five times).
   */
  readonly durationStatedAs?: string;
  /**
   * Median picture-clip length the cut is expected to hold, from a MEASURED reference the
   * editor attached — never from the prompt, which never states one (P3.4).
   *
   * It lives here rather than only on `CritiqueOptions` so the run's objective carries it:
   * the briefing's WHAT DONE LOOKS LIKE is where a run reads what it is being graded on,
   * and a target the Critic checks but the objective never states is a condition the run
   * can only fail by surprise.
   */
  readonly medianShotSeconds?: number;
  /** Which reference set it, so the criterion attributes the number. */
  readonly medianShotSource?: string;
}

/**
 * The checkable conditions a run is held to.
 *
 * @param _request - The request the run works toward. Deliberately NOT read (see the module
 *   header); the parameter stays so the callers that pass it keep one signature.
 * @param length - The finished length, as the command reader read and grounded it
 *   (`kernel/command-classifier.ts#DeliverableLength`) or as the host stated it. Passed in
 *   rather than read here, so the criterion and the Critic's check are one reading.
 * @param references - Targets measured off the editor's attached references.
 */
export function checkableAcceptance(
  _request: string,
  length: StatedDuration | undefined,
  /** Targets measured off the editor's attached references (`references/directives.ts`). */
  references: ReferenceDirectives = { applied: [], ignored: [] },
): CheckableAcceptance {
  const medianShotSource = references.applied.find((c) => c.line.startsWith('Pacing:'));
  return {
    ...(length === undefined ? {} : { durationSeconds: length.seconds }),
    ...(length?.toleranceSeconds === undefined
      ? {}
      : { durationToleranceSeconds: length.toleranceSeconds }),
    ...(length?.statedAs === undefined ? {} : { durationStatedAs: length.statedAs }),
    ...(references.medianShotSeconds === undefined
      ? {}
      : { medianShotSeconds: references.medianShotSeconds }),
    ...(medianShotSource === undefined ? {} : { medianShotSource: medianShotSource.profileId }),
  };
}

/**
 * The criterion standing in for everything the request asks that no check can settle.
 *
 * It used to be the request PASTED IN — `criteria.push(prompt)`. The intent was right (the
 * unmeasurable half of the ask must not be forgotten) and the mechanism was a copy: the run
 * already persists the request verbatim as `objective.request`, one field away, and the
 * copy then rode along into `decisions`, `objectives`, `nextAction` and every telemetry row
 * that carries the working state. In a captured run that was a ~7,000-token brief stored
 * five times over, and `briefing.ts` has to filter four of those copies back out as noise
 * before it can render anything.
 *
 * A pointer keeps the meaning and drops the duplication. Nothing is lost: every reader of
 * the criteria holds the objective it belongs to.
 */
export const JUDGEMENT_CRITERION =
  'Everything else the request asks for — taste, pacing, structure — which no automatic ' +
  'check settles. Judge it against the request itself.';

/**
 * The acceptance criteria to record on the run's objective: one line per checkable condition,
 * then {@link JUDGEMENT_CRITERION} for everything judgement owns.
 */
export function acceptanceCriteria(acceptance: CheckableAcceptance): readonly string[] {
  const criteria: string[] = [];
  if (acceptance.durationSeconds !== undefined) {
    const seconds = acceptance.durationSeconds;
    const tolerance = acceptance.durationToleranceSeconds;
    const span =
      tolerance === undefined
        ? `about ${String(seconds)}s`
        : `${String(seconds - tolerance)}–${String(seconds + tolerance)}s`;
    const stated =
      acceptance.durationStatedAs === undefined
        ? ''
        : ` (the request says “${acceptance.durationStatedAs}”)`;
    criteria.push(`The finished sequence runs ${span}${stated}.`);
  }
  if (acceptance.medianShotSeconds !== undefined) {
    const from = acceptance.medianShotSource ? ` (${acceptance.medianShotSource})` : '';
    criteria.push(
      `The median picture clip runs about ${acceptance.medianShotSeconds.toFixed(1)}s, ` +
        `matching the attached reference${from}.`,
    );
  }
  criteria.push(JUDGEMENT_CRITERION);
  return criteria;
}

/** True when at least one condition here can actually be checked. */
export function hasCheckableAcceptance(acceptance: CheckableAcceptance): boolean {
  return acceptance.durationSeconds !== undefined || acceptance.medianShotSeconds !== undefined;
}
