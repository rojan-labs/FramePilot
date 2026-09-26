/**
 * Cross-language parity: `framePlanAt` must reproduce the plans the ENGINE wrote into
 * `tests/fixtures/frame-plan/*.json` (PX1.3), field by field.
 *
 * The engine is the export, so its plan is the expected value. Numbers agree to 1e-6,
 * except the source frame identity (`source.time`, `source.frame`), which must be exact —
 * an off-by-one source frame is a wrong picture, not a tolerance. The Python half,
 * `engine/python/tests/test_frame_plan_vectors.py`, fails when the stored vectors no longer
 * match the engine; this file fails when they no longer match TypeScript. Regenerate with
 * `pnpm frame-plan:vectors` after changing either implementation deliberately.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProjectSchema } from '@framepilot/timeline-schema';
import { framePlanAt } from './frame-plan.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../../tests/fixtures/frame-plan/', import.meta.url));
const FLOAT_TOLERANCE = 1e-6;
/** Paths whose numbers are frame identity and must match exactly. */
const EXACT_PATHS = [/\.source\.time$/, /\.source\.frame$/];

interface VectorCase {
  readonly id: string;
  readonly row: string;
  readonly burnCaptions: boolean;
  readonly probe: {
    readonly fps: Readonly<Record<string, number>>;
    readonly frameTimes?: Readonly<Record<string, readonly number[]>>;
  };
  readonly project: unknown;
  readonly samples: readonly number[];
  readonly expected?: readonly unknown[];
}

interface VectorFile {
  readonly name: string;
  readonly area: string;
  readonly cases: readonly VectorCase[];
}

function loadVectors(): readonly VectorFile[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const parsed = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, 'utf8')) as Omit<
        VectorFile,
        'name'
      >;
      return { name, ...parsed };
    });
}

/** Every difference between `actual` and `expected`, as `path: detail` lines. */
function differences(actual: unknown, expected: unknown, path: string): string[] {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const exact = EXACT_PATHS.some((pattern) => pattern.test(path));
    const equal = exact ? actual === expected : Math.abs(actual - expected) <= FLOAT_TOLERANCE;
    return equal
      ? []
      : [`${path}: ${String(actual)} !== ${String(expected)}${exact ? ' (exact)' : ''}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual))
      return [`${path}: expected an array, got ${JSON.stringify(actual)}`];
    if (actual.length !== expected.length) {
      return [`${path}: length ${actual.length} !== ${expected.length}`];
    }
    return expected.flatMap((item, index) => differences(actual[index], item, `${path}[${index}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return [`${path}: expected an object, got ${JSON.stringify(actual)}`];
    }
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]);
    return [...keys].flatMap((key) =>
      differences(actualRecord[key], expectedRecord[key], `${path}.${key}`),
    );
  }
  return actual === expected
    ? []
    : [`${path}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`];
}

const VECTORS = loadVectors();

describe('frame plan parity vectors', () => {
  it('cover every feature-matrix area with engine-written expectations', () => {
    expect(VECTORS.map((file) => file.area).sort()).toEqual(
      [
        'Alpha',
        'Colour',
        'Effects',
        'Geometry',
        'Layering',
        // Elements' shapes (schema v25, ADR 0190) and stickers (plan/elements EL6a).
        'Shapes',
        'Stickers',
        'Text',
        'Time',
        'Transitions',
      ].sort(),
    );
    const cases = VECTORS.flatMap((file) => file.cases);
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const vector of cases) {
      expect(
        vector.expected,
        `${vector.id} has no expected plans; run pnpm frame-plan:vectors`,
      ).toHaveLength(vector.samples.length);
    }
  });

  for (const file of VECTORS) {
    describe(file.name, () => {
      for (const vector of file.cases) {
        it(`${vector.id} matches the engine at every sample`, () => {
          const project = ProjectSchema.parse(vector.project);
          const found = vector.samples.flatMap((t, index) =>
            differences(
              framePlanAt(project.timeline, project.assets, t, project.resolution, {
                burnCaptions: vector.burnCaptions,
                sourceFps: vector.probe.fps,
                sourceFrameTimes: vector.probe.frameTimes ?? {},
                transcript: project.transcript,
              }),
              vector.expected?.[index],
              `t=${t}`,
            ),
          );
          expect(found).toEqual([]);
        });
      }
    });
  }
});
