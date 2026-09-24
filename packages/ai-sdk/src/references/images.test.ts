import { describe, expect, it } from 'vitest';
import {
  createReferenceStillLoader,
  estimateImageTokens,
  referenceImagesBlock,
  referenceImagesFor,
} from './images.js';
import { buildReferenceProfile, type ReferenceProfile } from './profile.js';

function profile(
  id: string,
  kind: 'image' | 'video',
  role: ReferenceProfile['role'] = 'style',
): ReferenceProfile {
  return buildReferenceProfile({
    id,
    role,
    kind,
    fileName: `${id}.${kind === 'image' ? 'png' : 'mp4'}`,
    contentHash: id.padEnd(16, '0'),
    analyzedAt: '2026-09-24T00:00:00.000Z',
    ...(kind === 'image'
      ? { image: { width: 10, height: 10 } }
      : { video: { durationS: 5, shotCount: 1 } }),
  });
}

const png = (base64: string) => ({ mediaType: 'image/png' as const, base64 });

describe('referenceImagesFor', () => {
  it('attaches pictures in reference order, labelled, only for image references in force', () => {
    const images = referenceImagesFor(
      [profile('b', 'image', 'brand-logo'), profile('v', 'video'), profile('a', 'image', 'color')],
      [
        { referenceId: 'a', image: png('AAA') },
        { referenceId: 'v', image: png('VVV') },
        { referenceId: 'b', image: png('BBB') },
        { referenceId: 'gone', image: png('GGG') },
      ],
    );
    expect(images.map((i) => i.base64)).toEqual(['BBB', 'AAA']);
    expect(images.map((i) => i.label)).toEqual([
      'reference b · b.png (brand-logo)',
      'reference a · a.png (color)',
    ]);
  });

  it('attaches one picture per reference even if the host sent two', () => {
    const images = referenceImagesFor(
      [profile('a', 'image')],
      [
        { referenceId: 'a', image: png('ONE') },
        { referenceId: 'a', image: png('TWO') },
      ],
    );
    expect(images).toHaveLength(1);
  });

  it('is empty with no pictures or no references', () => {
    expect(referenceImagesFor([profile('a', 'image')], undefined)).toEqual([]);
    expect(referenceImagesFor([], [{ referenceId: 'a', image: png('A') }])).toEqual([]);
  });
});

describe('referenceImagesBlock', () => {
  it('names each picture in order and says they are the editor’s files', () => {
    const block = referenceImagesBlock([
      { ...png('A'), label: 'reference a · a.png (color)' },
      { ...png('B'), label: 'reference b · b.png (design)' },
    ]);
    expect(block).toContain('are 2 reference images');
    expect(block).toContain('1. reference a · a.png (color)\n2. reference b · b.png (design)');
    expect(block).toContain('not frames of the timeline');
    expect(referenceImagesBlock([png('A')])).toContain('is the reference image');
    expect(referenceImagesBlock([])).toBe('');
  });
});

describe('estimateImageTokens', () => {
  it('prices a sized image by its pixels and an unsized one conservatively', () => {
    expect(estimateImageTokens({ ...png('A'), width: 1024, height: 1024 })).toBe(1399);
    expect(estimateImageTokens(png('A'))).toBe(1600);
    expect(estimateImageTokens({ ...png('A'), width: 0, height: 10 })).toBe(1600);
  });
});

describe('createReferenceStillLoader', () => {
  const input = { referenceId: 'ref_1', inputPath: '/p/media/x/logo.png', fileName: 'logo.png' };

  it('posts the sandboxed path and returns the picture with its size', async () => {
    let seen: { url: string; body: unknown } | undefined;
    const load = createReferenceStillLoader({
      baseUrl: 'http://engine',
      fetchFn: (async (url: string, init: RequestInit) => {
        seen = { url, body: JSON.parse(String(init.body)) };
        return new Response(
          JSON.stringify({ media_type: 'image/png', base64: 'QUJD', width: 400, height: 160 }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    await expect(load(input)).resolves.toEqual({
      referenceId: 'ref_1',
      image: { mediaType: 'image/png', base64: 'QUJD', width: 400, height: 160 },
    });
    expect(seen).toEqual({
      url: 'http://engine/references/still',
      body: { input_path: '/p/media/x/logo.png' },
    });
  });

  it('fails in a sentence naming the file when the engine refuses', async () => {
    const load = createReferenceStillLoader({
      baseUrl: 'http://engine',
      fetchFn: (async () =>
        new Response('{"detail":"not an image"}', { status: 422 })) as unknown as typeof fetch,
    });
    await expect(load(input)).rejects.toThrow(/Could not load logo\.png .*422.*not an image/);
  });

  it('refuses a payload that is not a picture instead of forwarding it', async () => {
    const load = createReferenceStillLoader({
      baseUrl: 'http://engine',
      fetchFn: (async () =>
        new Response(
          JSON.stringify({ media_type: 'image/gif', base64: 'x', width: 1, height: 1 }),
          {
            status: 200,
          },
        )) as unknown as typeof fetch,
    });
    await expect(load(input)).rejects.toThrow(/unexpected shape/);
  });
});
