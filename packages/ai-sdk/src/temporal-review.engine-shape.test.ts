/**
 * The reviewer must be able to parse what the engine actually sends.
 *
 * ## The incident
 *
 * `/review/temporal-evidence` is declared `response_model=TemporalEvidenceBatch`, and
 * FastAPI serialises every unset optional as an explicit `null` — `"perceptualHash":
 * null`, `"value": null`, `"point": null`, `"mean": null`. Zod's `.optional()` accepts
 * `undefined` and refuses `null`, and a batch is an array of a `.strict()` discriminated
 * union, so **one null rejected the whole batch**. The reviewer failed closed exactly as
 * designed and every run reported "your edits are applied and validated, but were not
 * perceptually checked". Run `137d8fd0` lost all seven of its reviews this way.
 *
 * ## Why no test caught it
 *
 * Every other fixture on this path is written in TypeScript, where an absent optional is
 * `undefined`. None of them can express the shape the engine emits, so all of them passed.
 *
 * The batch below is **not hand-written**: it is `TemporalEvidenceBatch.model_dump_json(
 * by_alias=True)` from `framepilot_engine.validation.temporal_evidence`, one result of
 * every kind, with each optional left unset so it serialises as null. Regenerate it the
 * same way if the engine contract changes — an edit that makes this parse by deleting the
 * nulls defeats the test.
 */
import { describe, expect, it } from 'vitest';
import { TemporalEvidenceBatchSchema } from './temporal-review.js';

/** Verbatim engine output — see the note above before editing. */
const ENGINE_BATCH = {
  renderSettings: {
    identity: 'preset_reel:1080x1920@30:captions=true',
    presetId: 'preset_reel',
    width: 1080,
    height: 1920,
    fps: 30.0,
    burnCaptions: true,
  },
  results: [
    {
      schemaVersion: 1,
      requestId: 'f1',
      projectRevision: 7,
      renderSettings: {
        identity: 'preset_reel:1080x1920@30:captions=true',
        presetId: 'preset_reel',
        width: 1080,
        height: 1920,
        fps: 30.0,
        burnCaptions: true,
      },
      kind: 'frame',
      sample: {
        frame: 0,
        luma: 0.4,
        blackRatio: 0.0,
        perceptualHash: null,
      },
    },
    {
      schemaVersion: 1,
      requestId: 'r1',
      projectRevision: 7,
      renderSettings: {
        identity: 'preset_reel:1080x1920@30:captions=true',
        presetId: 'preset_reel',
        width: 1080,
        height: 1920,
        fps: 30.0,
        burnCaptions: true,
      },
      kind: 'range',
      samples: [
        {
          frame: 1,
          luma: 0.5,
          blackRatio: 0.0,
          perceptualHash: null,
        },
        {
          frame: 2,
          luma: 0.5,
          blackRatio: 0.0,
          perceptualHash: null,
        },
      ],
    },
    {
      schemaVersion: 1,
      requestId: 'c1',
      projectRevision: 7,
      renderSettings: {
        identity: 'preset_reel:1080x1920@30:captions=true',
        presetId: 'preset_reel',
        width: 1080,
        height: 1920,
        fps: 30.0,
        burnCaptions: true,
      },
      kind: 'comparison',
      leftFrame: 1,
      rightFrame: 2,
      difference: 0.2,
    },
    {
      schemaVersion: 1,
      requestId: 's1',
      projectRevision: 7,
      renderSettings: {
        identity: 'preset_reel:1080x1920@30:captions=true',
        presetId: 'preset_reel',
        width: 1080,
        height: 1920,
        fps: 30.0,
        burnCaptions: true,
      },
      kind: 'scope',
      samples: [
        {
          frame: 1,
          channel: 'luma',
          min: 0.0,
          max: 1.0,
          mean: null,
          p10: null,
          p50: null,
          p90: null,
          nearBlackRatio: null,
          nearWhiteRatio: null,
          coverageRatio: null,
        },
      ],
    },
    {
      schemaVersion: 1,
      requestId: 'm1',
      projectRevision: 7,
      renderSettings: null,
      kind: 'motion',
      samples: [
        {
          frame: 1,
          value: null,
          point: null,
          bounds: null,
        },
        {
          frame: 2,
          value: null,
          point: null,
          bounds: null,
        },
      ],
    },
    {
      schemaVersion: 1,
      requestId: 'a1',
      projectRevision: 7,
      renderSettings: {
        identity: 'preset_reel:1080x1920@30:captions=true',
        presetId: 'preset_reel',
        width: 1080,
        height: 1920,
        fps: 30.0,
        burnCaptions: true,
      },
      kind: 'audio',
      samples: [
        {
          startFrame: 0,
          endFrame: 30,
          peakDbfs: -3.0,
          rmsDbfs: -18.0,
          boundaryJumpDb: null,
        },
      ],
    },
    {
      schemaVersion: 1,
      requestId: 'l1',
      projectRevision: 7,
      renderSettings: {
        identity: 'preset_reel:1080x1920@30:captions=true',
        presetId: 'preset_reel',
        width: 1080,
        height: 1920,
        fps: 30.0,
        burnCaptions: true,
      },
      kind: 'loudness',
      sample: {
        integratedLufs: -14.2,
        loudnessRangeLu: null,
        truePeakDbfs: null,
      },
    },
  ],
};

describe('the temporal evidence contract, as the engine serialises it', () => {
  it('parses a batch carrying one result of every kind', () => {
    const parsed = TemporalEvidenceBatchSchema.safeParse(ENGINE_BATCH);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it('reads an explicit null as an absent optional, not as a value', () => {
    const parsed = TemporalEvidenceBatchSchema.parse(ENGINE_BATCH);
    const range = parsed.results.find((result) => result.kind === 'range');
    expect(range?.kind).toBe('range');
    if (range?.kind !== 'range') throw new Error('unreachable');
    // Null in, undefined out — no consumer has to learn a third state.
    expect(range.samples[0]).not.toHaveProperty('perceptualHash', null);
    expect(range.samples[0]?.perceptualHash).toBeUndefined();
  });

  it('still keeps a null out of a field the engine never leaves unset', () => {
    const broken = structuredClone(ENGINE_BATCH) as { results: { kind: string }[] };
    const frame = broken.results.find((result) => result.kind === 'frame') as unknown as {
      sample: { luma: number | null };
    };
    frame.sample.luma = null;
    expect(TemporalEvidenceBatchSchema.safeParse(broken).success).toBe(false);
  });
});
