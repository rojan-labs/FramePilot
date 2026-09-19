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

/** The frame's coded bytes, copied out of the reader's window. */
const index0 = async (index: MatroskaVideoIndex, frame: number): Promise<Uint8Array> =>
  (await index.readFrame(frame)).slice();

/** An EBML element: its id bytes as written, a 4-byte size and the payload. */
function element(id: number, payload: Uint8Array): Uint8Array {
  const idBytes: number[] = [];
  for (let shift = 24; shift >= 0; shift -= 8) {
    const byte = (id >>> shift) & 0xff;
    if (byte !== 0 || idBytes.length > 0) idBytes.push(byte);
  }
  // Four-byte size vint (marker 0x10 in the top byte), the same width for every element.
  const size = [0x10 | ((payload.length >>> 24) & 0x0f), 0, 0, 0];
  for (let i = 1; i < 4; i++) size[i] = (payload.length >>> ((3 - i) * 8)) & 0xff;
  return new Uint8Array([...idBytes, ...size, ...payload]);
}

const uintElement = (id: number, value: number): Uint8Array =>
  element(id, new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])); // prettier-ignore

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * A Matroska file carrying `frames` as one FFV1 track wrapped the Video-for-Windows way:
 * `CodecID` is `V_MS/VFW/FOURCC` and `CodecPrivate` is a `BITMAPINFOHEADER` whose FourCC is
 * `FFV1`, followed by the codec's global header. No Cues, so the reader walks the cluster.
 */
function vfwMatroska(
  extradata: Uint8Array,
  frames: Uint8Array[],
  width: number,
  height: number,
): Uint8Array {
  const bitmapInfo = new Uint8Array(40);
  new DataView(bitmapInfo.buffer).setUint32(0, 40, true);
  bitmapInfo.set(new TextEncoder().encode('FFV1'), 16);
  const track = element(
    0xae,
    concat([
      uintElement(0xd7, 1),
      uintElement(0x83, 1),
      element(0x86, new TextEncoder().encode('V_MS/VFW/FOURCC')),
      element(0x63a2, concat([bitmapInfo, extradata])),
      element(0xe0, concat([uintElement(0xb0, width), uintElement(0xba, height)])),
    ]),
  );
  const blocks = frames.map((frame) =>
    element(0xa3, concat([new Uint8Array([0x81, 0x00, 0x00, 0x80]), frame])),
  );
  const cluster = element(0x1f43b675, concat([uintElement(0xe7, 0), ...blocks]));
  return concat([
    element(0x1a45dfa3, element(0x4282, new TextEncoder().encode('matroska'))),
    element(0x18538067, concat([element(0x1654ae6b, track), cluster])),
  ]);
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

  it('reads the same frames when the muxer wrapped FFV1 in a VFW header', async () => {
    // FFmpeg only writes the native `V_FFV1` CodecID in recent releases; an older one (the CI
    // runner's) writes the same encode as `V_MS/VFW/FOURCC`. Both must decode identically.
    const fixture = cases.find((c) => c.id === 'gray-pack')!;
    const native = await MatroskaVideoIndex.open(
      memoryReader(new Uint8Array(readFileSync(path.join(FIXTURES, fixture.file)))),
      fixture.frames,
    );
    const frames: Uint8Array[] = [];
    for (let i = 0; i < fixture.frames; i++) frames.push(await index0(native, i));
    const wrapped = await MatroskaVideoIndex.open(
      memoryReader(vfwMatroska(native.track.codecPrivate!, frames, fixture.width, fixture.height)),
      fixture.frames,
    );
    expect(wrapped.track.codecId).toBe('V_FFV1');
    expect(wrapped.track.codecPrivate).toEqual(native.track.codecPrivate);
    expect([wrapped.track.width, wrapped.track.height]).toEqual([fixture.width, fixture.height]);
    expect(wrapped.frameCount).toBe(fixture.frames);
    const decoder = new Ffv1Decoder(fixture.width, fixture.height, wrapped.track.codecPrivate!);
    for (let i = 0; i < fixture.frames; i++) {
      expect(digest(decoder.decode(await wrapped.readFrame(i)).data)).toBe(fixture.sha256[i]);
    }
  });

  it('refuses a file that is not Matroska', async () => {
    await expect(
      MatroskaVideoIndex.open(memoryReader(new Uint8Array(64)), null),
    ).rejects.toBeInstanceOf(MatroskaError);
  });
});
