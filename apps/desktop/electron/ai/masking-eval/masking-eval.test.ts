/**
 * AM5.2/AM5.3 — the AI masking eval, run in CI with every other desktop test.
 *
 * The report at `reports/ai-masking/eval.json` is a file snapshot: CI recomputes it from the
 * fixture and fails on any difference, so the committed numbers are the numbers CI measured.
 * Regenerate after a deliberate change with `-u` and review the diff like a golden.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRequestSet } from './fixture.js';
import { runMaskingEval, type MaskingEvalReport } from './harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const FIXTURE = 'tests/fixtures/ai-masking/request-set.json';
const REPORT = path.join(repoRoot, 'reports/ai-masking/eval.json');

describe('AI masking eval (AM5)', () => {
  let report: MaskingEvalReport | undefined;
  const measured = async (): Promise<MaskingEvalReport> => {
    report ??= await runMaskingEval(loadRequestSet(path.join(repoRoot, FIXTURE)), FIXTURE);
    return report;
  };

  it('matches the committed report exactly', async () => {
    await expect(`${JSON.stringify(await measured(), null, 2)}\n`).toMatchFileSnapshot(REPORT);
  }, 120_000);
});
