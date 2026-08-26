/**
 * Generate the TS↔Python frame-grid parity fixture (ADR 0146).
 *
 * The TypeScript side OWNS the grid; the Python render engine asserts it. A fixture
 * generated from the TS implementation and read by a Python test is what keeps "asserts"
 * from quietly becoming "re-implements, slightly differently" — the failure mode where a
 * preview and an export disagree about which frame a cut is on.
 *
 * Same pattern as `generate-tool-parity-fixture.mjs`: the fixture is a build artefact, so
 * a change to the grid that anyone forgets to mirror fails the Python suite rather than
 * shipping.
 *
 * Usage: node scripts/generate-frame-grid-parity.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { rationalFrameRate, secondsToFrame, frameToSeconds, snapSecondsToFrame } = await import(
  join(HERE, '..', 'dist', 'frame-grid.js')
);

/** Every rate the product plausibly meets, NTSC pull-downs included. */
const RATES = [23.976, 24, 25, 29.97, 30, 47.952, 50, 59.94, 60, 120];

/**
 * Times chosen to hit the cases that actually break: exact frames, values a hair either
 * side of a frame, the .5 tie, and a long timeline where a float rate would have drifted.
 */
const TIMES = [
  0, 0.0001, 0.5, 1, 1.5, 12.3874, 12.5, 21.87, 59.999, 60, 61.041_666_666, 600, 3600.5,
  14_399.9999,
];

const out = {
  generatedBy: 'packages/editor-core/scripts/generate-frame-grid-parity.mjs',
  rule: 'nearest frame, ties away from zero; rational frame rates',
  rates: RATES.map((fps) => {
    const rate = rationalFrameRate(fps);
    return {
      fps,
      numerator: rate.numerator,
      denominator: rate.denominator,
      samples: TIMES.map((seconds) => ({
        seconds,
        frame: secondsToFrame(seconds, fps),
        snapped: snapSecondsToFrame(seconds, fps),
      })),
      frameRoundTrip: [0, 1, 2, 47, 1000, 100_000].map((frame) => ({
        frame,
        seconds: frameToSeconds(frame, fps),
      })),
    };
  }),
};

const target = join(HERE, '..', '..', '..', 'engine', 'python', 'tests', 'fixtures');
mkdirSync(target, { recursive: true });
const path = join(target, 'frame_grid_parity.json');
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`generate-frame-grid-parity: ${RATES.length} rate(s) → ${path}`);
