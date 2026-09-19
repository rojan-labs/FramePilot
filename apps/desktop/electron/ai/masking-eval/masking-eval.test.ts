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
import { LEGACY_PACK_VERSION, runMaskingEval, type MaskingEvalReport } from './harness.js';

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

  it('picks unambiguous targets and does not ask needlessly, at the plan 06 gates (AM2.5)', async () => {
    // With the 1.1 packs objects carry their COCO class and colours are scored on crops.
    const { gates, targetAccuracyByRequirement } = (await measured()).summary;
    expect(gates.targetAccuracy.pass).toBe(true);
    expect(gates.unnecessaryAskRate.pass).toBe(true);
    const { none } = targetAccuracyByRequirement;
    expect(none?.passed).toBe(none?.total);
  }, 120_000);

  it('owes its neutral-colour picks to the measured colour: SigLIP alone asks (AM2.7)', async () => {
    // An engine that cannot measure: the re-ranker falls back to SigLIP's evidence alone, which
    // on these real held-out crops separates chromatic colours but not white, grey, silver, black.
    const siglipOnly = await runMaskingEval(
      loadRequestSet(path.join(repoRoot, FIXTURE)),
      FIXTURE,
      undefined,
      false,
    );
    const { summary } = siglipOnly;
    expect(summary.confidentWrong).toBe(0);
    expect(summary.inventedGeometry).toBe(0);
    const appearance = summary.targetAccuracyByRequirement.appearance!;
    const withMeasurement = (await measured()).summary.targetAccuracyByRequirement.appearance!;
    expect(withMeasurement.passed).toBe(withMeasurement.total);
    expect(appearance.passed).toBeLessThan(withMeasurement.passed);
  }, 120_000);

  it('with the installed 1.0 packs (no classes, no crops) still never guesses', async () => {
    // What users have until the AM2.5 releases are signed: every request passes through the real
    // negotiation, so classes are dropped and crops refused, and objects ask instead.
    const legacy = await runMaskingEval(
      loadRequestSet(path.join(repoRoot, FIXTURE)),
      FIXTURE,
      LEGACY_PACK_VERSION,
    );
    const { summary } = legacy;
    expect(summary.confidentWrong).toBe(0);
    expect(summary.inventedGeometry).toBe(0);
    expect(summary.gates.ambiguousAskRate.pass).toBe(true);
    expect(summary.adversarialHeld.passed).toBe(summary.adversarialHeld.total);
    expect(summary.targetAccuracyByRequirement.none?.passed).toBe(
      summary.targetAccuracyByRequirement.none?.total,
    );
    expect(summary.targetAccuracyByRequirement.object_class?.passed).toBe(0);
  }, 120_000);
});
