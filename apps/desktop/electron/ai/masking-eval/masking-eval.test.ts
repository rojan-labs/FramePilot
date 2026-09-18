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

  it('never picks the wrong thing with confidence, and never invents geometry', async () => {
    const { summary } = await measured();
    expect(summary.confidentWrong).toBe(0);
    expect(summary.inventedGeometry).toBe(0);
    expect(summary.adversarialHeld.passed).toBe(summary.adversarialHeld.total);
  }, 120_000);

  it('asks on ambiguous requests at or above the plan 06 gate', async () => {
    expect((await measured()).summary.gates.ambiguousAskRate.pass).toBe(true);
  }, 120_000);

  it('picks every target the shipped detector can name', async () => {
    // Objects are reported as a generic `object`, so their targets ask by design until the pack
    // reports classes; those misses stay in the report against the unlowered gate.
    const { none } = (await measured()).summary.targetAccuracyByRequirement;
    expect(none?.passed).toBe(none?.total);
  }, 120_000);
});
