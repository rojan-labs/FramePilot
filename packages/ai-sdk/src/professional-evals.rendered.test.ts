import { describe, expect, it } from 'vitest';
import { PROFESSIONAL_EVAL_CASES } from './professional-eval-cases.js';
import {
  PROFESSIONAL_EVAL_MANIFEST,
  professionalEvalDriftIssues,
} from './professional-evals.js';
import { createProfessionalEvalNodeAcquirer } from './professional-eval-node-acquirer.js';
import {
  runProfessionalEvalCases,
  summarizeProfessionalEvalResults,
} from './professional-eval-runner.js';

const rendered =
  process.env['FRAMEPILOT_RENDERED_PROFESSIONAL_EVALS'] === '1' ? describe : describe.skip;

rendered('rendered professional capability scorecard', () => {
  it(
    'renders and reviews every advertised editable capability',
    async () => {
      const results = await runProfessionalEvalCases(PROFESSIONAL_EVAL_CASES, {
        acquireEvidence: createProfessionalEvalNodeAcquirer(),
      });
      const scorecard = summarizeProfessionalEvalResults(results);
      expect(
        scorecard.failed,
        JSON.stringify(
          scorecard.rows.filter((row) => row.status === 'failed'),
          null,
          2,
        ),
      ).toBe(0);
      expect(scorecard.verified).toBe(scorecard.total);
      expect(scorecard.rows.every((row) => row.review === 'reviewed')).toBe(true);
      // `verified === total` alone would pass if a registered capability simply
      // had no case at all. Release mode requires the stronger statement: every
      // capability the product says is *available* was rendered and verified, so
      // one cannot be advertised and quietly left unproven.
      expect(professionalEvalDriftIssues(PROFESSIONAL_EVAL_MANIFEST)).toEqual([]);
      const available = PROFESSIONAL_EVAL_MANIFEST.filter(
        (row) => row.availability !== 'unsupported',
      );
      expect(scorecard.verified).toBe(available.length);
      // The escape hatch is closed from the other side too: a row may only be
      // exempt by being openly unsupported, and it must say why.
      for (const row of PROFESSIONAL_EVAL_MANIFEST) {
        if (row.availability !== 'unsupported') continue;
        expect(row.unsupportedReason, `${row.capabilityId} is unsupported without a reason`)
          .toBeTruthy();
      }
    },
    10 * 60_000,
  );
});
