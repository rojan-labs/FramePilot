import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPresentationTables,
  demuxAllVideoSamples,
  nearestKeyframeIndexAtOrBefore,
  presentationIndexAtOrBefore,
  type RawChunkInit,
} from './mp4-demuxer.js';

// --- pure presentation-table + time-mapping helpers ---------------------------

describe('buildPresentationTables', () => {
  it('is identity for decode order == presentation order (-bf 0)', () => {
    const tables = buildPresentationTables([
      { ctsUs: 0, isSync: true },
      { ctsUs: 33_333, isSync: false },
      { ctsUs: 66_667, isSync: false },
    ]);
    expect(tables.presentationTimestampsUs).toEqual([0, 33_333, 66_667]);
    expect(tables.decodeIndexByPresentation).toEqual([0, 1, 2]);
    expect(tables.decodeThroughByPresentation).toEqual([0, 1, 2]);
    expect(tables.keyframePresentationIndices).toEqual([0]);
  });

  it('reorders a B-frame GOP (IPB decode order → IBP presentation order)', () => {
    // Decode order: I(0µs) P(66_667µs) B(33_333µs) — the classic pattern where
    // the B frame displays between the two frames it depends on.
    const tables = buildPresentationTables([
      { ctsUs: 0, isSync: true },
      { ctsUs: 66_667, isSync: false },
      { ctsUs: 33_333, isSync: false },
    ]);
    expect(tables.presentationTimestampsUs).toEqual([0, 33_333, 66_667]);
    // Presentation frame 1 (the B) is decode chunk 2; presentation 2 (the P) is decode chunk 1.
    expect(tables.decodeIndexByPresentation).toEqual([0, 2, 1]);
    // Presenting frame 1 requires decoding THROUGH chunk 2; frame 2 likewise.
    expect(tables.decodeThroughByPresentation).toEqual([0, 2, 2]);
  });

  it('handles VFR timestamps (non-uniform spacing) without assuming CFR', () => {
    const tables = buildPresentationTables([
      { ctsUs: 0, isSync: true },
      { ctsUs: 20_000, isSync: false },
      { ctsUs: 70_000, isSync: false }, // long frame — VFR
    ]);
    expect(tables.presentationTimestampsUs).toEqual([0, 20_000, 70_000]);
  });
});

describe('presentationIndexAtOrBefore', () => {
  const timestamps = [0, 20_000, 70_000, 100_000];

  it('returns the exact frame at a matching timestamp', () => {
    expect(presentationIndexAtOrBefore(timestamps, 70_000)).toBe(2);
  });

  it('returns the frame showing mid-interval (floor semantics)', () => {
    expect(presentationIndexAtOrBefore(timestamps, 69_999)).toBe(1);
    expect(presentationIndexAtOrBefore(timestamps, 20_001)).toBe(1);
  });

  it('clamps before the first frame and after the last', () => {
    expect(presentationIndexAtOrBefore(timestamps, -5)).toBe(0);
    expect(presentationIndexAtOrBefore(timestamps, 999_999)).toBe(3);
  });
});

// --- pure keyframe-search helper ---------------------------------------------

describe('nearestKeyframeIndexAtOrBefore', () => {
  const keyframes = [0, 15, 30, 45, 60];

  it('rejects an empty keyframe list', () => {
    expect(() => nearestKeyframeIndexAtOrBefore([], 10)).toThrow('No keyframes available');
  });

  it('rejects a target before the first keyframe', () => {
    const withGap = [10, 20, 30];
    expect(() => nearestKeyframeIndexAtOrBefore(withGap, 5)).toThrow('before the first keyframe');
  });

  it('finds the exact match when the target is itself a keyframe', () => {
    expect(nearestKeyframeIndexAtOrBefore(keyframes, 30)).toBe(30);
  });

  it('finds the nearest preceding keyframe for a mid-GOP target', () => {
    expect(nearestKeyframeIndexAtOrBefore(keyframes, 44)).toBe(30);
    expect(nearestKeyframeIndexAtOrBefore(keyframes, 0)).toBe(0);
  });

  it('clamps to the last keyframe for a target past the end', () => {
    expect(nearestKeyframeIndexAtOrBefore(keyframes, 999)).toBe(60);
  });
});

// --- real mp4box demux against a real, on-the-fly-generated fixture ---------
// EncodedVideoChunk doesn't exist in plain Node (no WebCodecs globals), so the
// browser-only chunk constructor is replaced with a fake that returns its
// init verbatim — the thing actually under test here is the mp4box-facing
// demux + avcC-extraction logic, run against a REAL encoded file, not the
// (trivial, one-line) EncodedVideoChunk wrapping.
const fakeChunkFactory = (init: RawChunkInit) => init as unknown as EncodedVideoChunk;

function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(ffmpegAvailable())('demuxAllVideoSamples (real mp4box + real fixture)', () => {
  let workDir: string;
  let fixturePath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'fp-mp4-demuxer-test-'));
    fixturePath = join(workDir, 'tiny.mp4');
    // Self-contained (no cross-directory path resolution to the e2e spike's
    // watermark generator — this test only needs a real H.264 file with a
    // known GOP structure, not the watermark itself). 1s @ 30fps, -g 15
    // (matches the P-1 proxy spec) → 30 frames, 2 keyframes.
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1280x720:rate=30:duration=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-g',
        '15',
        '-keyint_min',
        '15',
        '-sc_threshold',
        '0',
        '-bf',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        fixturePath,
      ],
      { stdio: 'ignore' },
    );
  }, 30_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('generated the fixture', () => {
    expect(existsSync(fixturePath)).toBe(true);
  });

  it('extracts every video sample as a chunk, in presentation order', async () => {
    const bytes = readFileSync(fixturePath);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const table = await demuxAllVideoSamples(arrayBuffer, fakeChunkFactory);

    expect(table.chunks).toHaveLength(30);
    const timestamps = table.chunks.map((c) => (c as unknown as RawChunkInit).timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(timestamps[0]).toBe(0);
  });

  it('marks every -g 15 keyframe boundary and only those as sync chunks', async () => {
    const bytes = readFileSync(fixturePath);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const table = await demuxAllVideoSamples(arrayBuffer, fakeChunkFactory);

    expect(table.keyframePresentationIndices).toEqual([0, 15]);
    table.chunks.forEach((chunk, i) => {
      const raw = chunk as unknown as RawChunkInit;
      expect(raw.type).toBe(table.keyframePresentationIndices.includes(i) ? 'key' : 'delta');
    });
  });

  it('derives identity presentation tables for a -bf 0 (no B-frame) file', async () => {
    const bytes = readFileSync(fixturePath);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const table = await demuxAllVideoSamples(arrayBuffer, fakeChunkFactory);

    const identity = table.chunks.map((_, i) => i);
    expect(table.decodeIndexByPresentation).toEqual(identity);
    expect(table.decodeThroughByPresentation).toEqual(identity);
    expect(table.presentationTimestampsUs).toHaveLength(30);
    expect(table.presentationTimestampsUs).toEqual(
      [...table.presentationTimestampsUs].sort((a, b) => a - b),
    );
  });

  it('derives a CFR frame duration matching the 30fps proxy spec', async () => {
    const bytes = readFileSync(fixturePath);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const table = await demuxAllVideoSamples(arrayBuffer, fakeChunkFactory);

    expect(table.frameDurationUs).toBeCloseTo(33_333, -2);
  });

  it('extracts a real, usable avcC description for VideoDecoder', async () => {
    const bytes = readFileSync(fixturePath);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const table = await demuxAllVideoSamples(arrayBuffer, fakeChunkFactory);

    expect(table.config.codec).toMatch(/^avc1\./);
    expect(table.config.codedWidth).toBe(1280);
    expect(table.config.codedHeight).toBe(720);
    const description = table.config.description as Uint8Array;
    expect(description).toBeInstanceOf(Uint8Array);
    // avcC configurationVersion byte must be 1 per ISO/IEC 14496-15.
    expect(description[0]).toBe(1);
  });

  it('rejects a buffer with no video track', async () => {
    await expect(demuxAllVideoSamples(new ArrayBuffer(16), fakeChunkFactory)).rejects.toThrow();
  });

  it('builds consistent presentation tables for a REAL B-frame file (-bf 2)', async () => {
    const bframePath = join(workDir, 'bframes.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x360:rate=30:duration=1',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-g',
        '15',
        '-keyint_min',
        '15',
        '-sc_threshold',
        '0',
        '-bf',
        '2',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        bframePath,
      ],
      { stdio: 'ignore' },
    );
    const bytes = readFileSync(bframePath);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const table = await demuxAllVideoSamples(arrayBuffer, fakeChunkFactory);

    // Presentation timestamps are strictly ascending even though chunk
    // (decode) order is not.
    const presented = table.presentationTimestampsUs;
    expect(presented).toEqual([...presented].sort((a, b) => a - b));
    // Normalized to a 0-based presentation clock: the encoder's B-frame
    // reorder delay (raw first cts = 2 frames) must NOT leak into the table —
    // source time 0 is the first displayed frame.
    expect(presented[0]).toBe(0);
    // Chunk timestamps are normalized identically (the decoder copies them
    // onto output frames, so the output↔table lookup must agree).
    const rawTimestamps = table.chunks.map((c) => (c as unknown as RawChunkInit).timestamp);
    expect(Math.min(...rawTimestamps)).toBe(0);
    // With B-frames, decode order genuinely differs from presentation order.
    const identity = table.chunks.map((_, i) => i);
    expect(table.decodeIndexByPresentation).not.toEqual(identity);
    // Every presentation index maps to a real decode chunk, exactly once.
    expect([...table.decodeIndexByPresentation].sort((a, b) => a - b)).toEqual(identity);
    // decodeThrough is monotone and ≥ its own decode index.
    table.decodeThroughByPresentation.forEach((through, p) => {
      expect(through).toBeGreaterThanOrEqual(table.decodeIndexByPresentation[p] ?? 0);
      if (p > 0)
        expect(through).toBeGreaterThanOrEqual(table.decodeThroughByPresentation[p - 1] ?? 0);
    });
    // Keyframes are where the encoder put them: presentation 0 and 15.
    expect(table.keyframePresentationIndices).toEqual([0, 15]);
  }, 30_000);
});
