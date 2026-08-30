/**
 * The Critic proposer, declared as a specialist (P5.1).
 *
 * The Critic is the one existing specialist Phase 5's audit found already correct
 * (`docs/reports/system-mission/05-after.md`, candidate 3): a bounded step on the small
 * tier with its own prompt and manifest budget. What it did not have was the same typed
 * boundary as the controllers — so this states its slice (`project` only; the Critic reads
 * no interaction snapshot and no host evidence) and maps its verdict onto the shared
 * output.
 *
 * `confidence` is the one place the shared shape earns a number rather than a boolean:
 * the Critic's verdict genuinely is graded — the share of the checks it ran that held —
 * and a run repairing one finding out of nine is in a different position from one
 * repairing eight.
 */
import type { CritiqueOptions } from '../critic.js';
import { type CriticReport, runCritic } from '../kernel/proposers/critic.js';
import { type Specialist, type SpecialistArtifact, defineSpecialist } from './contract.js';

/** The Critic specialist's model-supplied input: the goal/target facts `critique` takes. */
export interface CriticSpecialistInputs {
  readonly options?: CritiqueOptions;
}

/** The Critic specialist's product: the whole report, unflattened. */
export interface CriticSpecialistOutputs {
  readonly report: CriticReport;
}

/**
 * Share of the checks that did not fail. `skipped` checks count as held — a check that
 * could not run is not evidence against the edit, and counting it as one would make a run
 * on a project without a transcript look worse than the same run with one.
 */
function confidenceOf(report: CriticReport): number {
  const deterministic = report.findings.filter((finding) => finding.source === 'deterministic');
  if (deterministic.length === 0) return report.ok ? 1 : 0;
  const held = deterministic.filter((finding) => finding.severity !== 'fail').length;
  return held / deterministic.length;
}

export const CRITIC_SPECIALIST: Specialist<CriticSpecialistInputs, CriticSpecialistOutputs> =
  defineSpecialist<CriticSpecialistInputs, CriticSpecialistOutputs>({
    name: 'critic',
    slice: ['project'],
    run: (input) => {
      const report = runCritic({
        project: input.context.project,
        ...(input.inputs.options ? { options: input.inputs.options } : {}),
      });
      const artifacts: SpecialistArtifact[] = report.findings
        .filter((finding) => finding.severity !== 'fail')
        .map((finding) => ({ kind: 'fact', name: finding.id, value: finding.severity }));
      return {
        outputs: { report },
        artifacts,
        confidence: confidenceOf(report),
        // A failing check IS the Critic's error list: it is the thing the run must fix,
        // and the bounded repair loop (ADR 0159) scopes its one fix turn to exactly these.
        errors: report.findings
          .filter((finding) => finding.severity === 'fail')
          .map((finding) => ({ code: finding.id, detail: finding.detail })),
      };
    },
  });
