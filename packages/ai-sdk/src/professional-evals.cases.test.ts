import { describe, expect, it } from 'vitest';
import { PROFESSIONAL_EVAL_CASES } from './professional-eval-cases.js';
import {
  runProfessionalEvalCase,
  runProfessionalEvalCases,
  summarizeProfessionalEvalResults,
  type TemporalEvidenceRequest,
} from './professional-eval-runner.js';
import type { TemporalEvidenceBatch } from './temporal-review.js';

/** Stages provable without a renderer; `verify` is only earned by reviewed rendered evidence. */
const DETERMINISTIC_STAGES = [
  'resolve',
  'compile',
  'validate',
  'apply',
  'invert',
  'persist_reload',
  'cross_host',
];

describe('professional capability outcome evals', () => {
  it.each(PROFESSIONAL_EVAL_CASES.map((evalCase) => [evalCase.fixtureId, evalCase] as const))(
    '%s resolves, compiles, round-trips, persists, and plans review',
    async (_fixtureId, evalCase) => {
      const result = await runProfessionalEvalCase(evalCase);
      expect(result.failures).toEqual([]);
      expect(result.status).toBe('passed');
      expect(result.stages).toEqual(DETERMINISTIC_STAGES);
      expect(result.requests.length).toBeGreaterThan(0);
      // Without an acquirer the row must say so rather than implying a rendered check happened.
      expect(result.review.status).toBe('not_acquired');
    },
  );

  it('runs one case per registered scorecard fixture', () => {
    const fixtureIds = PROFESSIONAL_EVAL_CASES.map((evalCase) => evalCase.fixtureId);
    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
  });

  it('records a machine-readable scorecard of what actually executed', async () => {
    const scorecard = summarizeProfessionalEvalResults(
      await runProfessionalEvalCases(PROFESSIONAL_EVAL_CASES),
    );
    expect(scorecard.total).toBe(PROFESSIONAL_EVAL_CASES.length);
    expect(scorecard.passed).toBe(scorecard.total);
    expect(scorecard.failed).toBe(0);
    // Honest today: no row is render-verified until evidence acquisition lands.
    expect(scorecard.verified).toBe(0);
    expect(scorecard.rows.every((row) => row.review === 'not_acquired')).toBe(true);
    expect(
      scorecard.rows.map((row) => `${row.fixtureId} ${row.status} ${row.review}`),
    ).toMatchSnapshot();
  });
});

describe('professional eval evidence review', () => {
  const firstCase = PROFESSIONAL_EVAL_CASES[0]!;

  it('earns the verify stage only when acquired evidence reviews green', async () => {
    const result = await runProfessionalEvalCase(firstCase, {
      acquireEvidence: (project, requests) => {
        expect(project.timeline.revision).toBeGreaterThan(
          firstCase.setup().project.timeline.revision ?? 0,
        );
        expect(
          requests.every((request) => request.projectRevision === project.timeline.revision),
        ).toBe(true);
        return batchOf(requests.map(satisfyingResult));
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.stages).toContain('verify');
    expect(result.review.status).toBe('reviewed');
  });

  it('fails the case when acquisition throws instead of silently passing', async () => {
    const result = await runProfessionalEvalCase(firstCase, {
      acquireEvidence: () => Promise.reject(new Error('sidecar unavailable')),
    });
    expect(result.status).toBe('failed');
    expect(result.stages).not.toContain('verify');
    expect(result.failures.join(' ')).toContain('sidecar unavailable');
  });

  it('fails the case when returned evidence violates the requested objective', async () => {
    const result = await runProfessionalEvalCase(firstCase, {
      acquireEvidence: (_project, requests) =>
        batchOf(
          requests.map((request) => {
            const evidence = satisfyingResult(request) as { samples?: { blackRatio?: number }[] };
            // Black frames across a sampled window are exactly what the reviewer must catch.
            if (request.kind === 'range' && evidence.samples) {
              return {
                ...evidence,
                samples: evidence.samples.map((sample) => ({ ...sample, luma: 0, blackRatio: 1 })),
              };
            }
            return evidence;
          }),
        ),
    });
    expect(result.status).toBe('failed');
    expect(result.stages).not.toContain('verify');
  });
});

function batchOf(results: readonly unknown[]): Promise<TemporalEvidenceBatch> {
  return Promise.resolve({
    renderSettings: {
      identity: 'professional-eval:1920x1080@30:captions=false',
      presetId: 'professional_eval',
      width: 1920,
      height: 1080,
      fps: 30,
      burnCaptions: false,
    },
    results,
  } as TemporalEvidenceBatch);
}

/** Matches `batchOf`'s top-level settings — the per-result lineage every non-motion kind needs. */
const SATISFYING_RENDER_SETTINGS = {
  identity: 'professional_eval:1920x1080@30:captions=false',
  presetId: 'professional_eval',
  width: 1920,
  height: 1080,
  fps: 30,
  burnCaptions: false,
};

/** Shaped, schema-valid evidence used only to exercise review wiring, never as a release gate. */
function satisfyingResult(request: TemporalEvidenceRequest): unknown {
  const base = {
    schemaVersion: request.schemaVersion,
    requestId: request.requestId,
    projectRevision: request.projectRevision,
    // Motion has no rendered lineage (derived from authored keyframes/tracking, not a render);
    // every other kind is judged against a specific render and must carry its settings.
    renderSettings: request.kind === 'motion' ? null : SATISFYING_RENDER_SETTINGS,
  };
  const sample = (frame: number) => ({ frame, luma: 0.5, blackRatio: 0 });
  switch (request.kind) {
    case 'frame':
      return { ...base, kind: 'frame', sample: sample(request.atFrame) };
    case 'range': {
      const samples = [];
      // The reviewer's range window is end-exclusive.
      for (
        let frame = request.startFrame;
        frame < request.endFrame;
        frame += request.sampleEveryFrames
      ) {
        samples.push(sample(frame));
      }
      return { ...base, kind: 'range', samples };
    }
    case 'comparison':
      return {
        ...base,
        kind: 'comparison',
        leftFrame: request.leftFrame,
        rightFrame: request.rightFrame,
        difference: 0.5,
      };
    case 'scope':
      return {
        ...base,
        kind: 'scope',
        samples: [{ frame: request.startFrame, channel: 'luma', min: 0.05, max: 0.9 }],
      };
    case 'motion':
      return {
        ...base,
        kind: 'motion',
        samples: [
          {
            frame: request.startFrame,
            value: 0,
            bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          },
          {
            frame: request.endFrame,
            value: 0,
            bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          },
        ],
      };
    case 'audio':
      return {
        ...base,
        kind: 'audio',
        samples: [
          {
            startFrame: request.startFrame,
            endFrame: request.endFrame,
            peakDbfs: -6,
            rmsDbfs: -18,
            boundaryJumpDb: 0,
          },
        ],
      };
  }
}
