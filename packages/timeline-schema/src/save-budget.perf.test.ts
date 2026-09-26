/**
 * MK4.6 save budget (plan 06): a project with 1,000 path keyframes of 200 vertices saves in
 * ≤ 250 ms and the file stays within its measured size budget.
 *
 * Measures what the desktop autosave does with the document in the main process
 * (`projectSaveDefault`): validate the IPC payload, serialise it (fingerprint, watcher mark and
 * the atomic write share one serialisation of the same object), fsync + rename, and the recovery
 * snapshot that reuses that text. Best of several runs, so a runner hiccup is not the number;
 * the file layout (binary path arrays) is asserted as well, because that is what makes the
 * budget reachable at all.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, parseProject, presetShapeParams } from './index.js';
import { writeProjectFile } from './project-file.js';
import { deserializeProject, serializeProject } from './serialization.js';

const SAVE_BUDGET_MS = 250;
/** Measured 13.44 MB on the reference document; the file must not grow past this. */
const FILE_SIZE_BUDGET_BYTES = 14_000_000;
const KEYFRAMES = 1000;
const VERTICES = 200;

/**
 * Coverage instrumentation multiplies this CPU-bound path ~10× (CI measured 1.8 s), so a coverage
 * run cannot measure the budget. It still checks the file layout, size and losslessness, and a
 * catastrophic-regression ceiling; the 250 ms budget itself is asserted by the uninstrumented CI
 * step "MK4.6 budgets" (`.github/workflows/ci.yml`), which runs this file on its own.
 */
const INSTRUMENTED =
  (globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } })
    .__vitest_worker__?.config?.coverage?.enabled === true;
const INSTRUMENTED_CEILING_MS = 10_000;
/** One run under coverage: its timing is not measured, and five runs starve parallel packages. */
const RUNS = INSTRUMENTED ? 1 : 5;

function rotoscopeDocument(): Record<string, unknown> {
  let seed = 1;
  const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pathKeyframes = Array.from({ length: KEYFRAMES }, (_, keyframe) => {
    const points: number[] = [];
    for (let vertex = 0; vertex < VERTICES; vertex += 1) {
      const angle = (vertex / VERTICES) * 2 * Math.PI;
      points.push(
        1920 + 900 * Math.cos(angle) + random() * 3,
        1080 + 700 * Math.sin(angle) + random() * 3,
        random() * 20 - 10,
        random() * 20 - 10,
        random() * 20 - 10,
        random() * 20 - 10,
      );
    }
    return {
      id: `p${String(keyframe)}`,
      sourceTime: keyframe / 24,
      easing: 'linear',
      points,
      vertexTypes: new Array<number>(VERTICES).fill(1),
    };
  });
  return {
    id: 'budget',
    name: 'Save budget',
    version: 1,
    fps: 24,
    resolution: { width: 3840, height: 2160 },
    assets: [
      {
        id: 'a',
        path: 'media/a.mov',
        kind: 'video',
        durationSeconds: 60,
        media: { width: 3840, height: 2160 },
      },
    ],
    timeline: {
      tracks: [
        {
          id: 'v',
          type: 'video',
          clips: [
            {
              id: 'c',
              assetId: 'a',
              trackId: 'v',
              start: 0,
              end: 60,
              sourceStart: 0,
              sourceEnd: 60,
              effects: [],
              keyframes: [],
              masks: [{ kind: 'path', id: 'm', pathKeyframes }],
            },
          ],
        },
      ],
    },
  };
}

describe('save budget with 1,000 path keyframes × 200 vertices (MK4.6)', () => {
  it(`saves within ${String(SAVE_BUDGET_MS)} ms and ${String(FILE_SIZE_BUDGET_BYTES)} bytes, losslessly`, async () => {
    const document = rotoscopeDocument();
    const directory = mkdtempSync(join(tmpdir(), 'fp-save-budget-'));
    try {
      const timings: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const payload = structuredClone(document);
        const started = performance.now();
        const project = parseProject(payload);
        serializeProject(project); // revision fingerprint and watcher self-write mark
        const target = join(directory, 'project.fp.json');
        await writeProjectFile(target, project);
        writeFileSync(
          join(directory, 'recovery.json'),
          `{"path":"${target}","savedAt":1,"project":${serializeProject(project)}}`,
        );
        timings.push(performance.now() - started);
      }
      const best = Math.min(...timings);
      const size = statSync(join(directory, 'project.fp.json')).size;
      console.log(
        `MK4.6 save budget: best ${best.toFixed(1)} ms of [${timings.map((t) => t.toFixed(0)).join(', ')}], file ${String(size)} bytes`,
      );
      expect(size).toBeLessThanOrEqual(FILE_SIZE_BUDGET_BYTES);
      expect(best).toBeLessThanOrEqual(INSTRUMENTED ? INSTRUMENTED_CEILING_MS : SAVE_BUDGET_MS);

      const text = readFileSync(join(directory, 'project.fp.json'), 'utf8');
      expect(text).toContain('"points": "f64le:');
      const reloaded = deserializeProject(text);
      expect(reloaded.timeline).toEqual(parseProject(document).timeline);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('holds with 50 shape clips on top of the same document (plan/elements EL4a)', async () => {
    const document = rotoscopeDocument() as { timeline: { tracks: Record<string, unknown>[] } };
    const params = presetShapeParams('rounded-rect/highlight')!;
    document.timeline.tracks.unshift({
      id: 'shapes',
      type: 'overlay',
      clips: Array.from({ length: 50 }, (_, index) => ({
        id: `shape_${String(index)}`,
        assetId: '__shape__',
        trackId: 'shapes',
        start: index,
        end: index + 1,
        sourceStart: 0,
        sourceEnd: 1,
        effects: [{ id: `shape_${String(index)}__shape`, type: 'shape', params, keyframes: [] }],
        keyframes: [],
      })),
    });
    const directory = mkdtempSync(join(tmpdir(), 'fp-save-budget-shapes-'));
    try {
      const timings: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        const project = parseProject(structuredClone(document));
        await writeProjectFile(join(directory, 'project.fp.json'), project);
        timings.push(performance.now() - started);
      }
      const best = Math.min(...timings);
      console.log(`EL4a save budget with 50 shapes: best ${best.toFixed(1)} ms`);
      expect(best).toBeLessThanOrEqual(INSTRUMENTED ? INSTRUMENTED_CEILING_MS : SAVE_BUDGET_MS);
      const reloaded = deserializeProject(readFileSync(join(directory, 'project.fp.json'), 'utf8'));
      expect(reloaded.timeline.tracks[0]?.clips).toHaveLength(50);
      expect(reloaded.timeline.tracks[0]?.clips[7]?.effects[0]?.params).toEqual(params);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps short arrays as readable decimals and ordinary projects byte-identical in layout', () => {
    const project = parseProject({
      id: 'p',
      name: 'Small',
      version: 1,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      timeline: { tracks: [] },
    });
    expect(serializeProject(project)).toBe(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...project }, null, 2),
    );
  });
});
