/**
 * The analyzer must be able to parse what the engine actually sends.
 *
 * ## The incident
 *
 * Attaching an image failed, and the reference chip showed the editor this:
 *
 *     [{"expected":"object","code":"invalid_type","path":["video"],
 *       "message":"Invalid input: expected object, received null"}]
 *
 * `/references/analyze` is declared `response_model=ReferenceAnalysisResponse`, whose
 * `video` field is `dict | None = None`. FastAPI serialises an unset optional as an
 * explicit `null`, so an IMAGE result carries `"video": null` — and Zod's `.optional()`
 * accepts `undefined` while refusing `null`. The whole profile was rejected over a field
 * that means nothing for an image, and the raw issue list went to the screen above a
 * Re-analyze button that was deterministically going to fail the same way.
 *
 * This is the SECOND time this exact mismatch has cost a feature; `/review/temporal-
 * evidence` lost all seven of run `137d8fd0`'s perceptual reviews to it. The rule now
 * lives in `engine-optional.ts` rather than being rediscovered per route.
 *
 * ## Why no test caught it
 *
 * `analyze-client.test.ts` builds its route responses in TypeScript, where an absent
 * optional is `undefined`. No fixture written that way can express the shape the engine
 * emits, so all of them passed while the feature was broken.
 *
 * The payloads below are **not hand-written**. Each is
 * `ReferenceAnalysisResponse(...).model_dump_json(by_alias=True)` from
 * `framepilot_engine.service` — which is what `response_model` serialisation produces,
 * `exclude_none` being off by default. Regenerate them the same way if the route's
 * contract changes. **Deleting the nulls to make this pass defeats the test.**
 */
import { describe, expect, it, vi } from 'vitest';
import { createReferenceAnalyzer } from './analyze-client.js';

/** Verbatim engine output for an image — see the note above before editing. */
const ENGINE_IMAGE_RESPONSE = {
  kind: 'image',
  contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  video: null,
  image: {
    width: 1179,
    height: 2556,
    hasAlpha: false,
    dominantColors: ['#1e2430', '#e5670a'],
  },
  cached: false,
};

/** The mirror case: a video result carries `"image": null`. */
const ENGINE_VIDEO_RESPONSE = {
  kind: 'video',
  contentHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  video: { durationS: 42.5, shotCount: 18, medianShotS: 2.1 },
  image: null,
  cached: false,
};

const routeReturning = (payload: unknown): typeof fetch =>
  vi.fn(async () =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
  ) as unknown as typeof fetch;

const analyzerFor = (payload: unknown) =>
  createReferenceAnalyzer({ baseUrl: 'http://engine', fetchFn: routeReturning(payload) });

const input = {
  id: 'ref_1',
  inputPath: '/projects/p/media/whatsapp.jpg',
  fileName: 'WhatsApp Image 2026-09-05.jpg',
  kind: 'image' as const,
  role: 'style' as const,
};

describe('the analyzer parses the engine wire shape', () => {
  it('accepts an image result whose absent video is an explicit null', async () => {
    const { profile } = await analyzerFor(ENGINE_IMAGE_RESPONSE)(input);
    expect(profile.kind).toBe('image');
    expect(profile.image?.width).toBe(1179);
    // Normalised away, so nothing downstream has to learn a third state.
    expect(profile.video).toBeUndefined();
  });

  it('accepts a video result whose absent image is an explicit null', async () => {
    const { profile } = await analyzerFor(ENGINE_VIDEO_RESPONSE)({
      ...input,
      kind: 'video',
      fileName: 'clip.mp4',
    });
    expect(profile.kind).toBe('video');
    expect(profile.video?.durationS).toBe(42.5);
    expect(profile.image).toBeUndefined();
  });

  it('still builds the constraints the model reads, not just the raw numbers', async () => {
    // The point of analysing at all. A profile that parses but renders nothing would
    // satisfy the two tests above and be just as useless to the run.
    const { profile } = await analyzerFor(ENGINE_IMAGE_RESPONSE)(input);
    expect(profile.constraints.length).toBeGreaterThan(0);
  });
});

describe('a shape the analyzer cannot read is not dumped on the editor', () => {
  const brokenPayload = { kind: 'image', contentHash: 'short', image: null, video: null };

  it('explains the failure instead of printing the issue list', async () => {
    const failure = await analyzerFor(brokenPayload)(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('WhatsApp Image 2026-09-05.jpg');
    // The exact strings that reached the chip in the incident.
    expect(message).not.toContain('invalid_type');
    expect(message).not.toContain('expected object');
    expect(message).not.toContain('[{');
  });

  it('says re-analyzing will not help, because it will not', async () => {
    // The chip renders a Re-analyze button beside the reason. A deterministic contract
    // mismatch answers it identically every time, so the reason has to say so.
    const failure = await analyzerFor(brokenPayload)(input).catch((error: unknown) => error);
    expect((failure as Error).message).toContain('re-analyzing will not');
  });

  it('names the field, so the fault is chaseable from a bug report', async () => {
    const failure = await analyzerFor(brokenPayload)(input).catch((error: unknown) => error);
    expect((failure as Error).message).toContain('contentHash');
  });
});
