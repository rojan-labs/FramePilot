import { describe, expect, it } from 'vitest';
import { makeProject } from './__fixtures__/project.js';
import {
  createVisionFrameAcquirer,
  VisionEvidenceClientError,
} from './vision-evidence-client.js';
import { VISION_REVIEW_VERSION, type VisionReviewRequest } from './vision-review.js';

const request: VisionReviewRequest = {
  schemaVersion: VISION_REVIEW_VERSION,
  requestId: 'subject-framing',
  projectRevision: 0,
  objective: 'Does the tracked subject remain fully visible?',
  frames: [0, 30],
};

function response(at: number): Record<string, unknown> {
  return {
    media_type: 'image/jpeg',
    base64: 'AAECAw==',
    width: 512,
    height: 288,
    time_seconds: at,
    duration_seconds: 10,
  };
}

describe('createVisionFrameAcquirer', () => {
  it('renders the bounded frames from the unsaved working project', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const acquire = createVisionFrameAcquirer({
      baseUrl: 'http://engine',
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        seen.push({ url: String(url), body });
        return {
          ok: true,
          status: 200,
          json: async () => response(Number(body.time_seconds)),
          text: async () => '',
        } as Response;
      }) as typeof fetch,
    });

    await expect(acquire(makeProject(), request)).resolves.toEqual([
      { frame: 0, imageBase64: 'AAECAw==', mediaType: 'image/jpeg' },
      { frame: 30, imageBase64: 'AAECAw==', mediaType: 'image/jpeg' },
    ]);
    expect(seen.map((entry) => entry.url)).toEqual([
      'http://engine/render/frame',
      'http://engine/render/frame',
    ]);
    expect(seen[1]?.body).toMatchObject({
      time_seconds: 1,
      max_dimension: 512,
      burn_captions: true,
      project: { id: 'proj_1' },
    });
  });

  it('fails closed when the engine clamps to another moment', async () => {
    const acquire = createVisionFrameAcquirer({
      baseUrl: 'http://engine',
      fetchFn: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => response(8),
          text: async () => '',
        }) as Response) as typeof fetch,
    });
    await expect(acquire(makeProject(), { ...request, frames: [30] })).rejects.toThrow(
      /clamped/i,
    );
  });

  it('surfaces a bounded engine refusal and rejects malformed success', async () => {
    const rejected = createVisionFrameAcquirer({
      baseUrl: 'http://engine',
      fetchFn: (async () =>
        ({
          ok: false,
          status: 422,
          json: async () => ({}),
          text: async () => JSON.stringify({ detail: 'Project media is offline.' }),
        }) as Response) as typeof fetch,
    });
    await expect(rejected(makeProject(), { ...request, frames: [0] })).rejects.toThrow(
      'Project media is offline.',
    );

    const malformed = createVisionFrameAcquirer({
      baseUrl: 'http://engine',
      fetchFn: (async () =>
        ({ ok: true, status: 200, json: async () => ({ base64: '' }), text: async () => '' }) as Response) as typeof fetch,
    });
    await expect(malformed(makeProject(), { ...request, frames: [0] })).rejects.toBeInstanceOf(
      VisionEvidenceClientError,
    );
  });
});
