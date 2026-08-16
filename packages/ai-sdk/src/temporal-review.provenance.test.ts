import { describe, expect, it } from 'vitest';
import { TemporalEvidenceBatchSchema, TemporalEvidenceResultSchema } from './temporal-review.js';

const ordinary = {
  identity: 'temporal-evidence:540x960@30:captions=true',
  presetId: 'temporal-evidence',
  width: 540,
  height: 960,
  fps: 30,
  burnCaptions: true,
} as const;

const scope = {
  identity: 'temporal-scope:2160x3840@30:captions=false',
  presetId: 'temporal-scope',
  width: 2160,
  height: 3840,
  fps: 30,
  burnCaptions: false,
} as const;

describe('temporal evidence render provenance', () => {
  it('preserves distinct render settings for frame and scope results in one batch', () => {
    const parsed = TemporalEvidenceBatchSchema.parse({
      renderSettings: ordinary,
      results: [
        {
          schemaVersion: 1,
          requestId: 'frame_1',
          projectRevision: 3,
          kind: 'frame',
          renderSettings: ordinary,
          sample: { frame: 1, luma: 0.5, blackRatio: 0.1, perceptualHash: 'abc' },
        },
        {
          schemaVersion: 1,
          requestId: 'scope_1',
          projectRevision: 3,
          kind: 'scope',
          renderSettings: scope,
          samples: [
            {
              frame: 1,
              channel: 'luma',
              min: 0,
              max: 1,
              mean: 0.5,
              p10: 0.1,
              p50: 0.5,
              p90: 0.9,
            },
          ],
        },
      ],
    });

    expect(parsed.results[0]?.renderSettings.identity).toBe(ordinary.identity);
    expect(parsed.results[1]?.renderSettings.identity).toBe(scope.identity);
    expect(parsed.results[0]?.renderSettings.identity).not.toBe(
      parsed.results[1]?.renderSettings.identity,
    );
  });

  it('requires non-null render settings on every rendered or audio evidence kind', () => {
    const renderedResults = [
      {
        schemaVersion: 1,
        requestId: 'frame_1',
        projectRevision: 3,
        kind: 'frame',
        renderSettings: ordinary,
        sample: { frame: 1, luma: 0.5, blackRatio: 0.1 },
      },
      {
        schemaVersion: 1,
        requestId: 'range_1',
        projectRevision: 3,
        kind: 'range',
        renderSettings: ordinary,
        samples: [{ frame: 1, luma: 0.5, blackRatio: 0.1 }],
      },
      {
        schemaVersion: 1,
        requestId: 'comparison_1',
        projectRevision: 3,
        kind: 'comparison',
        renderSettings: ordinary,
        leftFrame: 1,
        rightFrame: 2,
        difference: 0.2,
      },
      {
        schemaVersion: 1,
        requestId: 'scope_1',
        projectRevision: 3,
        kind: 'scope',
        renderSettings: scope,
        samples: [{ frame: 1, channel: 'luma', min: 0, max: 1 }],
      },
      {
        schemaVersion: 1,
        requestId: 'loudness_1',
        projectRevision: 3,
        kind: 'loudness',
        renderSettings: ordinary,
        sample: { integratedLufs: -14 },
      },
      {
        schemaVersion: 1,
        requestId: 'audio_1',
        projectRevision: 3,
        kind: 'audio',
        renderSettings: ordinary,
        samples: [{ startFrame: 0, endFrame: 2, peakDbfs: -1, rmsDbfs: -12 }],
      },
    ] as const;

    for (const result of renderedResults) {
      expect(TemporalEvidenceResultSchema.safeParse(result).success).toBe(true);
      expect(
        TemporalEvidenceResultSchema.safeParse({ ...result, renderSettings: undefined }).success,
      ).toBe(false);
      expect(
        TemporalEvidenceResultSchema.safeParse({ ...result, renderSettings: null }).success,
      ).toBe(false);
    }
  });

  it('requires explicit null provenance for motion evidence', () => {
    const motion = {
      schemaVersion: 1,
      requestId: 'motion_1',
      projectRevision: 3,
      kind: 'motion',
      renderSettings: null,
      samples: [
        { frame: 1, value: 0 },
        { frame: 2, value: 0.1 },
      ],
    } as const;

    expect(TemporalEvidenceResultSchema.safeParse(motion).success).toBe(true);
    expect(
      TemporalEvidenceResultSchema.safeParse({ ...motion, renderSettings: undefined }).success,
    ).toBe(false);
    expect(
      TemporalEvidenceResultSchema.safeParse({ ...motion, renderSettings: ordinary }).success,
    ).toBe(false);
  });
});
