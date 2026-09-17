/**
 * BR5.1: the preview's FFV1 + Matroska reader produces exactly the frames ffmpeg decodes from a
 * matte artifact (`tests/fixtures/matte-ffv1`, written by its `make_fixtures.py`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { Ffv1DecodeError, Ffv1Decoder } from './ffv1-decoder';
import { MatroskaError, MatroskaVideoIndex } from '../matroska-demuxer';
import type { ByteRangeReader } from '../../demux/mp4-demuxer';

const FIXTURES = path.resolve(__dirname, '../../../../../../tests/fixtures/matte-ffv1');

interface FixtureCase {
  id: string;
  file: string;
  width: number;
  height: number;
  frames: number;
  format: 'gray8' | 'gray16' | 'rgb24';
  sha256: string[];
}

const cases = (
  JSON.parse(readFileSync(path.join(FIXTURES, 'cases.json'), 'utf8')) as { cases: FixtureCase[] }
).cases;

function memoryReader(bytes: Uint8Array): ByteRangeReader & { reads: number } {
  const reader = {
    size: bytes.length,
    reads: 0,
    read(start: number, end: number): Promise<ArrayBuffer> {
      reader.reads++;
      return Promise.resolve(bytes.slice(start, end).buffer);
    },
  };
  return reader;
}

const digest = (data: Uint8Array | Uint16Array): string =>
  createHash('sha256')
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex');

describe('FFV1 in Matroska (byte-exact vs ffmpeg)', () => {
  it.each(cases.map((c) => [c.id, c] as const))('%s', async (_id, fixture) => {
    const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, fixture.file)));
    for (const expectedFrames of [fixture.frames, null]) {
      const index = await MatroskaVideoIndex.open(memoryReader(bytes), expectedFrames);
      expect(index.track.codecId).toBe('V_FFV1');
      expect([index.track.width, index.track.height]).toEqual([fixture.width, fixture.height]);
      expect(index.frameCount).toBe(fixture.frames);
      const decoder = new Ffv1Decoder(
        index.track.width,
        index.track.height,
        index.track.codecPrivate!,
      );
      expect(decoder.format).toBe(fixture.format);
      for (let i = 0; i < fixture.frames; i++) {
        const picture = decoder.decode(await index.readFrame(i));
        expect(digest(picture.data), `${fixture.id} frame ${i}`).toBe(fixture.sha256[i]);
      }
    }
  });

  it('refuses a non-key frame without its key frame, and decodes it after', async () => {
    const fixture = cases.find((c) => c.id === 'gray-gop')!;
    const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, fixture.file)));
    const index = await MatroskaVideoIndex.open(memoryReader(bytes), fixture.frames);
    expect(index.keyframeAtOrBefore(5)).toBe(0);
    expect(index.keyframeAtOrBefore(13)).toBe(12);
    const decoder = new Ffv1Decoder(fixture.width, fixture.height, index.track.codecPrivate!);
    expect(() => decoder.decode(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toThrow(Ffv1DecodeError);
  });

  it('refuses a slice whose CRC does not match', async () => {
    const fixture = cases.find((c) => c.id === 'gray-pack')!;
    const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, fixture.file)));
    const index = await MatroskaVideoIndex.open(memoryReader(bytes), fixture.frames);
    const packet = (await index.readFrame(1)).slice();
    const middle = Math.floor(packet.length / 2);
    packet[middle] = packet[middle]! ^ 0x55;
    const decoder = new Ffv1Decoder(fixture.width, fixture.height, index.track.codecPrivate!);
    expect(() => decoder.decode(packet)).toThrow(Ffv1DecodeError);
  });

  it('refuses a file that is not Matroska', async () => {
    await expect(
      MatroskaVideoIndex.open(memoryReader(new Uint8Array(64)), null),
    ).rejects.toBeInstanceOf(MatroskaError);
  });
});
