import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOUR_WORDS, type MaskCandidate } from '@framepilot/ai-sdk';
import type { CapabilityPackWorkerRequest } from '@framepilot/capability-packs';
import { parseProject, type Project } from '@framepilot/timeline-schema';
import type {
  CapabilityPackTrackingService,
  TrackingRunOptions,
} from '../capability-packs/tracking.js';
import { PromptVectorCache, createCropReranker } from './crop-reranker.js';
import { packFp16 } from './packed-vector.js';

const FPS = 24;
const project: Project = parseProject({
  id: 'rerank',
  name: 'Crop re-rank',
  version: 1,
  fps: FPS,
  resolution: { width: 1920, height: 1080 },
  assets: [
    {
      id: 'asset',
      path: path.join(path.sep, 'media', 'street.mp4'),
      kind: 'video',
      durationSeconds: 10,
      media: { width: 1920, height: 1080, fps: FPS },
    },
  ],
  timeline: { revision: 4, tracks: [] },
  transcript: [],
  aiMemory: {},
  history: [],
});

const LEFT = { x: 0.05, y: 0.4, width: 0.4, height: 0.35 };
const RIGHT = { x: 0.55, y: 0.4, width: 0.4, height: 0.35 };
const car = (candidateId: string, box: MaskCandidate['box'], frame = 24): MaskCandidate => ({
  candidateId,
  label: 'object',
  objectClass: 'car',
  score: 0.8,
  box,
  sourceTime: frame / FPS,
  persistence: 1,
});
const axis = (colour: string): number[] => COLOUR_WORDS.map((each) => (each === colour ? 1 : 0));

type Answer = (request: CapabilityPackWorkerRequest) => unknown;

/** A pack authority that answers visual.embed with one vector per crop, and visual.text per prompt. */
function packs(
  colourOf: (box: MaskCandidate['box']) => string,
  seen: unknown[] = [],
  release: (request: CapabilityPackWorkerRequest) => string = () => 'a'.repeat(64),
): Answer {
  return (request) => {
    seen.push(request);
    if (request.capability === 'visual.embed') {
      return {
        status: 'completed',
        identity: {
          id: 'framepilot.visual-embed',
          version: '1.1.0',
          releaseDigest: release(request),
        },
        result: {
          capability: 'visual.embed',
          shots: request.parameters.shots.map((shot) => ({
            shotIndex: shot.shotIndex,
            vector: packFp16(axis(colourOf(shot.region!))),
          })),
        },
      };
    }
    if (request.capability === 'visual.text') {
      return {
        status: 'completed',
        identity: {
          id: 'framepilot.visual-embed',
          version: '1.1.0',
          releaseDigest: release(request),
        },
        result: {
          capability: 'visual.text',
          vectors: request.parameters.texts.map((text) =>
            packFp16(axis(COLOUR_WORDS.find((colour) => text.includes(` ${colour} `))!)),
          ),
        },
      };
    }
    throw new Error(`unexpected ${request.capability}`);
  };
}

const service =
  (answer: Answer, options: TrackingRunOptions[] = []) =>
  async () =>
    ({
      run: async (request: CapabilityPackWorkerRequest, runOptions: TrackingRunOptions) => {
        options.push(runOptions);
        return answer(request);
      },
    }) as unknown as CapabilityPackTrackingService;

const rerankFor = (answer: Answer, options?: TrackingRunOptions[]) =>
  createCropReranker({ tracking: service(answer, options) });

describe('createCropReranker', () => {
  const cars = [car('o24_red', LEFT), car('o24_grey', RIGHT)];
  const colours = (box: MaskCandidate['box']): string => (box.x < 0.5 ? 'red' : 'grey');

  it('scores each classed car’s crop by the named colour, and asks for nothing to be installed', async () => {
    const seen: unknown[] = [];
    const options: TrackingRunOptions[] = [];
    const scores = await rerankFor(
      packs(colours, seen),
      options,
    )({
      project,
      assetId: 'asset',
      description: 'the red car',
      candidates: cars,
    });
    expect(scores?.get('o24_red')).toBeGreaterThan(0.99);
    expect(scores?.get('o24_grey')).toBeLessThan(0.01);
    const [embed, text] = seen as CapabilityPackWorkerRequest[];
    expect(embed).toMatchObject({
      capability: 'visual.embed',
      projectRevision: 4,
      parameters: {
        promptBankVersion: 1,
        shots: [
          { shotIndex: 0, keyframeT: 1, region: LEFT },
          { shotIndex: 1, keyframeT: 1, region: RIGHT },
        ],
      },
    });
    expect(text).toMatchObject({ capability: 'visual.text' });
    expect(options.every((each) => each.whenMissing === 'skip')).toBe(true);
  });

  it('runs nothing when there is nothing a colour could decide', async () => {
    const seen: unknown[] = [];
    const rerank = rerankFor(packs(colours, seen));
    const base = { project, assetId: 'asset', candidates: cars };
    expect(await rerank({ ...base, description: 'the car' })).toBeUndefined();
    expect(await rerank({ ...base, description: 'the shiny car' })).toBeUndefined();
    expect(
      await rerank({ ...base, description: 'the red car', candidates: [cars[0]!] }),
    ).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('answers nothing when Visual Embed is absent, outdated or fails — the resolver then asks', async () => {
    const failing =
      (code: string): Answer =>
      () => ({
        status: 'failed',
        code,
        detail: `${code} for the test`,
        retryable: false,
      });
    const request = { project, assetId: 'asset', description: 'the red car', candidates: cars };
    expect(await rerankFor(failing('pack_absent'))(request)).toBeUndefined();
    expect(await rerankFor(failing('pack_outdated'))(request)).toBeUndefined();
    expect(await rerankFor(failing('worker_failed'))(request)).toBeUndefined();
  });

  it('answers nothing when the pack’s answer does not fit the question', async () => {
    const missingShot: Answer = (request) => {
      const answer = packs(colours)(request) as { result: { shots?: unknown[] } };
      if (answer.result.shots !== undefined) answer.result.shots = answer.result.shots.slice(0, 1);
      return answer;
    };
    expect(
      await rerankFor(missingShot)({
        project,
        assetId: 'asset',
        description: 'the red car',
        candidates: cars,
      }),
    ).toBeUndefined();
  });

  describe('the prompt vectors are embedded once per noun and pack release (AM2.6)', () => {
    const request = { project, assetId: 'asset', description: 'the red car', candidates: cars };
    const capabilities = (seen: unknown[]): string[] =>
      (seen as CapabilityPackWorkerRequest[]).map((each) => each.capability);

    it('runs one process per request once the prompts are known', async () => {
      const seen: unknown[] = [];
      const rerank = rerankFor(packs(colours, seen));
      const first = await rerank(request);
      const second = await rerank(request);
      expect(capabilities(seen)).toEqual(['visual.embed', 'visual.text', 'visual.embed']);
      expect([...second!]).toEqual([...first!]);
      await rerank({ ...request, description: 'the grey car' });
      // The palette sentences name the noun, not the colour asked: still cached.
      expect(capabilities(seen)).toHaveLength(4);
    });

    it('embeds them again for another noun or another pack release', async () => {
      const seen: unknown[] = [];
      let digest = 'a'.repeat(64);
      const rerank = rerankFor(packs(colours, seen, () => digest));
      await rerank(request);
      digest = 'b'.repeat(64);
      await rerank(request);
      expect(capabilities(seen)).toEqual([
        'visual.embed',
        'visual.text',
        'visual.embed',
        'visual.text',
      ]);
    });

    it('scores nothing when the release changes between the crop and prompt runs', async () => {
      const seen: unknown[] = [];
      const answer = packs(colours, seen, (each) =>
        each.capability === 'visual.embed' ? 'a'.repeat(64) : 'b'.repeat(64),
      );
      expect(await rerankFor(answer)(request)).toBeUndefined();
    });

    it('keeps at most its bound, dropping the oldest first', () => {
      const cache = new PromptVectorCache(2);
      cache.remember('r', ['a', 'b'], [[1], [2]]);
      cache.remember('r', ['c'], [[3]]);
      expect(cache.all('r', ['a'])).toBeUndefined();
      expect(cache.all('r', ['b', 'c'])).toEqual([[2], [3]]);
      expect(cache.all('other', ['b'])).toBeUndefined();
    });
  });
});
