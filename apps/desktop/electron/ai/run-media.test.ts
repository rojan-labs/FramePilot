import { describe, expect, it } from 'vitest';
import { buildReferenceProfile, type AiEvent, type ReferenceProfile } from '@framepilot/ai-sdk';
import { loadReferenceImages, storeToolImages, type ReferenceStillLoader } from './run-media.js';

function profile(id: string, kind: 'image' | 'video'): ReferenceProfile {
  return buildReferenceProfile({
    id,
    role: 'style',
    kind,
    fileName: `${id}.${kind === 'image' ? 'png' : 'mp4'}`,
    contentHash: id.padEnd(16, '0'),
    analyzedAt: '2026-09-24T00:00:00.000Z',
    ...(kind === 'image'
      ? { image: { width: 10, height: 10 } }
      : { video: { durationS: 5, shotCount: 1 } }),
  });
}

const loader =
  (failing: ReadonlySet<string> = new Set(), seen: string[] = []): ReferenceStillLoader =>
  async (file) => {
    seen.push(file.referenceId);
    if (failing.has(file.referenceId)) throw new Error('engine down');
    return {
      referenceId: file.referenceId,
      image: { mediaType: 'image/png', base64: file.referenceId },
    };
  };

describe('loadReferenceImages', () => {
  const files = [
    { id: 'a', path: 'media/p/attachments/a.png' },
    { id: 'v', path: 'media/p/attachments/v.mp4' },
    { id: 'b', path: 'media/p/attachments/b.png' },
  ];
  const refs = [profile('a', 'image'), profile('v', 'video'), profile('b', 'image')];

  it('loads image references with a file, skipping video and those that fail', async () => {
    const seen: string[] = [];
    const images = await loadReferenceImages(loader(new Set(['b']), seen), refs, files, true);
    expect(seen).toEqual(['a', 'b']);
    expect(images.map((i) => i.referenceId)).toEqual(['a']);
  });

  it('loads nothing for a model that cannot see, or without a loader or files', async () => {
    const seen: string[] = [];
    expect(await loadReferenceImages(loader(new Set(), seen), refs, files, false)).toEqual([]);
    expect(seen).toEqual([]);
    expect(await loadReferenceImages(undefined, refs, files, true)).toEqual([]);
    expect(await loadReferenceImages(loader(), refs, undefined, true)).toEqual([]);
  });
});

describe('storeToolImages', () => {
  const event: AiEvent = {
    id: 'r1',
    conversationId: 'c',
    turnId: 't',
    ts: 1,
    type: 'tool_result',
    toolCallId: 'c1',
    images: [
      { mediaType: 'image/jpeg', base64: 'QQ==', label: 'first', width: 2, height: 1 },
      { mediaType: 'image/jpeg', base64: 'Qg==', label: 'second' },
    ],
  };

  it('replaces the bytes with the stored path and keeps what the picture shows', async () => {
    const stored = await storeToolImages(event, 'p', async (_project, _type, bytes) =>
      bytes[0] === 0x41 ? 'media/p/attachments/frame-a.jpg' : 'media/p/attachments/frame-b.jpg',
    );
    expect(stored).toMatchObject({
      images: [
        {
          mediaType: 'image/jpeg',
          label: 'first',
          width: 2,
          height: 1,
          path: 'media/p/attachments/frame-a.jpg',
        },
        { mediaType: 'image/jpeg', label: 'second', path: 'media/p/attachments/frame-b.jpg' },
      ],
    });
    expect(JSON.stringify(stored)).not.toContain('QQ==');
  });

  it('drops a picture that fails to store, and the field when none survive', async () => {
    const stored = await storeToolImages(event, 'p', async () => {
      throw new Error('disk full');
    });
    expect(stored).not.toHaveProperty('images');
    expect(stored).toMatchObject({ type: 'tool_result', toolCallId: 'c1' });
  });

  it('passes other events, and every event without a store, through untouched', async () => {
    const status: AiEvent = {
      id: 's',
      conversationId: 'c',
      turnId: 't',
      ts: 1,
      type: 'status',
      status: 'thinking',
    };
    const save = async (): Promise<string> => 'x';
    expect(await storeToolImages(status, 'p', save)).toBe(status);
    expect(await storeToolImages(event, 'p', undefined)).toBe(event);
  });
});
