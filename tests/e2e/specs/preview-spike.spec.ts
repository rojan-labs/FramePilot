/**
 * P0 WebCodecs feasibility spike (plan PREVIEW-WEBCODECS-COMPOSITOR.md) —
 * real-Chrome go/no-go evidence for the 5 gates the finalized plan requires
 * before any P1 work starts. Runs against `preview-spike.html`, a standalone
 * entry not wired into the real editor (see harness.ts/main.ts).
 *
 * Uses the `preview-spike` Playwright project (real Google Chrome via
 * `channel: 'chrome'`, autoplay policy disabled, background throttling
 * disabled — see playwright.config.ts for why each matters).
 *
 * Correctness gates (#1, #5) assert unconditionally. Latency gates (#2, #3)
 * log their p95s but do not hard-fail here — this machine is not a
 * min-spec target, and CI/dev-machine numbers are a lower bound, not the
 * min-spec evidence the plan's gate requires. That run is a follow-up on
 * the actual target hardware; see the printed evidence in the report.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __framepilotSpike: {
      ready: boolean;
      load(sources: { id: string; url: string }[]): Promise<void>;
      startAudio(): Promise<void>;
      runCutTest(spec: { cuts: number; segmentFrames: number }): Promise<{
        totalCuts: number;
        totalFramesExpected: number;
        totalFramesPresented: number;
        violations: string[];
        presentedSequenceMonotonic: boolean;
      }>;
      runSeekTest(spec: { seeks: number; sourceId: string }): Promise<{
        samples: { targetChunkIndex: number; latencyMs: number; reconfigured: boolean }[];
        p95LatencyMs: number;
      }>;
      runScrubTest(spec: { sourceId: string; durationMs: number; hz: number }): Promise<{
        samples: { latencyMs: number }[];
        p95LatencyMs: number;
      }>;
      runAvSyncTest(spec: { seconds: number; cuts: number; sourceUrls: Record<string, string> }): Promise<{
        samples: { ctxNowSec: number; driftUs: number }[];
        maxAbsDriftUs: number;
        frameDurationUs: number;
        watermarkViolations: string[];
        visibilityInvalidated: boolean;
      }>;
      resourceStats(): Promise<{
        inFlightPeak: number;
        framesCreatedTotal: number;
        framesClosedTotal: number;
        reconfigureCounts: Record<string, number>;
      }>;
    };
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN_SCRIPT = join(HERE, '..', 'fixtures', 'preview-spike', 'gen-proxy.mjs');
const FIXTURE_DIR = join(HERE, '..', '.tmp-preview-spike-fixtures');
const PROXY_A = join(FIXTURE_DIR, 'proxy-a-720p30.mp4');
const PROXY_B = join(FIXTURE_DIR, 'proxy-b-720p30.mp4');

const SOURCE_URLS: Record<string, string> = {
  a: '/spike-fixtures/proxy-a.mp4',
  b: '/spike-fixtures/proxy-b.mp4',
};
const SOURCES = Object.entries(SOURCE_URLS).map(([id, url]) => ({ id, url }));

test.beforeAll(() => {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  // Idempotent — matches the derive_proxy_path / media_factory reuse-if-exists
  // pattern elsewhere in this repo rather than regenerating every run.
  if (!existsSync(PROXY_A)) {
    execFileSync('node', [GEN_SCRIPT, PROXY_A, '300', '1280', '720', '440', '20,20,60'], {
      stdio: 'inherit',
    });
  }
  if (!existsSync(PROXY_B)) {
    execFileSync('node', [GEN_SCRIPT, PROXY_B, '300', '1280', '720', '880', '60,20,20'], {
      stdio: 'inherit',
    });
  }
});

async function gotoSpikeAndLoad(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/spike-fixtures/proxy-a.mp4', (route) => route.fulfill({ path: PROXY_A }));
  await page.route('**/spike-fixtures/proxy-b.mp4', (route) => route.fulfill({ path: PROXY_B }));
  await page.goto('/preview-spike.html');
  await page.waitForFunction(() => Boolean(window.__framepilotSpike));
  await page.evaluate((sources) => window.__framepilotSpike.load(sources), SOURCES);
}

test.describe('P0 WebCodecs feasibility spike', () => {
  test('gate #1 — cut continuity: zero dropped/repeated/misordered frames across 100 cuts', async ({
    page,
  }) => {
    await gotoSpikeAndLoad(page);
    const report = await page.evaluate(() =>
      window.__framepilotSpike.runCutTest({ cuts: 100, segmentFrames: 10 })
    );

    await test.info().attach('cut-report', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    expect(report.violations).toEqual([]);
    expect(report.presentedSequenceMonotonic).toBe(true);
    expect(report.totalFramesPresented).toBe(report.totalFramesExpected);
    expect(report.totalCuts).toBe(100);
  });

  test('gate #2 — cold seek-to-frame latency', async ({ page }) => {
    await gotoSpikeAndLoad(page);
    const report = await page.evaluate(() => window.__framepilotSpike.runSeekTest({ seeks: 20, sourceId: 'a' }));

    await test.info().attach('seek-report', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    // Every sample must be a genuine cold seek (decoder reset+reconfigure) —
    // if this ever goes false the sample is measuring something else.
    expect(report.samples.every((s) => s.reconfigured)).toBe(true);
    console.log(
      `[gate #2] p95 cold-seek latency: ${report.p95LatencyMs.toFixed(1)}ms ` +
        `(plan gate: <=100ms p95 @720p30 on MIN-SPEC hardware — this run is dev-machine evidence, not that gate)`
    );
  });

  test('gate #3 — scrub responsiveness', async ({ page }) => {
    await gotoSpikeAndLoad(page);
    const report = await page.evaluate(() =>
      window.__framepilotSpike.runScrubTest({ sourceId: 'a', durationMs: 2000, hz: 10 })
    );

    await test.info().attach('scrub-report', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    expect(report.samples.length).toBeGreaterThan(0);
    console.log(
      `[gate #3] p95 scrub latency: ${report.p95LatencyMs.toFixed(1)}ms ` +
        `(plan gate: <=50ms p95, >= parity with the re-baselined <video> pool — not asserted here)`
    );
  });

  test('gate #4 — A/V sync: audio-master clock drift + gapless cuts over real playback', async ({
    page,
  }) => {
    // Real wall-clock playback at the plan's exact spec (60s across 10 cuts) —
    // longer than Playwright's default 30s test timeout.
    test.setTimeout(120_000);
    await gotoSpikeAndLoad(page);
    await page.evaluate(() => window.__framepilotSpike.startAudio());

    const report = await page.evaluate(
      (sourceUrls) => window.__framepilotSpike.runAvSyncTest({ seconds: 60, cuts: 10, sourceUrls }),
      SOURCE_URLS
    );

    await test.info().attach('av-sync-report', {
      body: JSON.stringify({ ...report, samples: report.samples.slice(0, 50) }, null, 2),
      contentType: 'application/json',
    });

    console.log(
      `[gate #4] max abs drift: ${report.maxAbsDriftUs.toFixed(1)}us over ${report.samples.length} samples ` +
        `(1 frame = ${report.frameDurationUs}us)`
    );

    expect(report.visibilityInvalidated).toBe(false);
    expect(report.watermarkViolations).toEqual([]);
    expect(report.samples.length).toBeGreaterThan(0);
    // Plan gate #4: holds ±1 frame over the run — this is the hard, real gate.
    expect(report.maxAbsDriftUs).toBeLessThanOrEqual(report.frameDurationUs);
  });

  test('gate #5 — resource hygiene: no leaked VideoFrames, bounded in-flight peak', async ({ page }) => {
    await gotoSpikeAndLoad(page);
    // Generate real decode/seek activity (including reconfigures) before
    // snapshotting — an all-zero report would prove nothing.
    await page.evaluate(() => window.__framepilotSpike.runSeekTest({ seeks: 10, sourceId: 'a' }));
    await page.evaluate(() => window.__framepilotSpike.runCutTest({ cuts: 20, segmentFrames: 8 }));

    const stats = await page.evaluate(() => window.__framepilotSpike.resourceStats());

    await test.info().attach('resource-stats', {
      body: JSON.stringify(stats, null, 2),
      contentType: 'application/json',
    });

    expect(stats.framesCreatedTotal).toBeGreaterThan(0);
    expect(stats.framesClosedTotal).toBe(stats.framesCreatedTotal);
    expect(stats.inFlightPeak).toBeLessThanOrEqual(24);
    expect(stats.reconfigureCounts.a).toBeGreaterThan(0);
  });
});
