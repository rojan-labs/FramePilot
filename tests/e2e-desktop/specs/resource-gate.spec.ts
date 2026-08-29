import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import { REPO } from './launch.js';
import { resourceGateViolations, type GateSample } from './resource-gate.js';

/**
 * Proof that the P6.6 resource gate can fail (plan/system-mission P9.5).
 *
 * A gate nobody has ever seen go red is a decoration. These rows launch nothing and need
 * no media: they replay the committed 2026-08-29 desktop baseline — the real measured
 * session the bounds were drawn from — and then re-run the same arithmetic over that
 * baseline with one number seeded to look like a leak. Green on the real trace, red on
 * each seeded one, is the whole claim.
 */

const BASELINE = join(REPO, 'reports', 'system-mission', 'baseline-resources.json');

function committedBaseline(): { warm: GateSample; last: GateSample } | null {
  if (!existsSync(BASELINE)) return null;
  const parsed = JSON.parse(readFileSync(BASELINE, 'utf8')) as { snapshots: GateSample[] };
  const warm = parsed.snapshots.find((s) => s.label.startsWith('session-loop-'));
  const last = parsed.snapshots.find((s) => s.label.startsWith('after-session'));
  return warm && last ? { warm, last } : null;
}

/** Copy a sample with one measurement replaced — the seed. */
function seeded(sample: GateSample, patch: Partial<GateSample['renderer']>): GateSample {
  return { ...sample, renderer: { ...sample.renderer, ...patch } };
}

test.describe('P6.6 resource gate', () => {
  const baseline = committedBaseline();
  test.skip(
    baseline === null,
    'no committed reports/system-mission/baseline-resources.json to replay',
  );

  test('holds on the real measured session', () => {
    const { warm, last } = baseline!;
    expect(resourceGateViolations(warm, last)).toEqual([]);
  });

  test('fails on a seeded heap leak', () => {
    const { warm, last } = baseline!;
    const violations = resourceGateViolations(
      warm,
      seeded(last, { jsHeapUsedMb: warm.renderer.jsHeapUsedMb * 2 + 20 }),
    );
    expect(violations.join('; ')).toMatch(/renderer heap/);
  });

  test('fails on seeded listener and node growth', () => {
    const { warm, last } = baseline!;
    expect(
      resourceGateViolations(warm, seeded(last, { listeners: warm.renderer.listeners * 2 })).join(
        '; ',
      ),
    ).toMatch(/event listeners/);
    expect(
      resourceGateViolations(warm, seeded(last, { nodes: warm.renderer.nodes * 2 })).join('; '),
    ).toMatch(/DOM nodes/);
    expect(
      resourceGateViolations(warm, seeded(last, { documents: warm.renderer.documents + 2 })).join(
        '; ',
      ),
    ).toMatch(/documents/);
  });

  test('fails on a seeded file-handle leak and on an orphan encoder', () => {
    const { warm, last } = baseline!;
    expect(
      resourceGateViolations(warm, {
        ...last,
        main: { ...last.main, openFiles: warm.main.openFiles * 3 },
      }).join('; '),
    ).toMatch(/open files/);
    expect(resourceGateViolations(warm, { ...last, ffmpegCount: 1 }).join('; ')).toMatch(
      /outlived the session/,
    );
  });

  test('tolerates the ordinary variance the bounds were drawn for', () => {
    const { warm } = baseline!;
    // +20% heap, +5% listeners, +10% nodes: real GC and render churn, not a leak.
    expect(
      resourceGateViolations(warm, {
        ...warm,
        label: 'after-session-noise',
        renderer: {
          ...warm.renderer,
          jsHeapUsedMb: warm.renderer.jsHeapUsedMb * 1.2,
          listeners: Math.round(warm.renderer.listeners * 1.05),
          nodes: Math.round(warm.renderer.nodes * 1.1),
        },
      }),
    ).toEqual([]);
  });
});
