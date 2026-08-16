/** Tests for the pure PCM-WAV time-slicer used to chunk hosted transcription. */
import { describe, expect, it } from 'vitest';
import { sliceWavIntoChunks } from './wav-chunks.js';

/** Build a canonical mono PCM WAV with `sampleCount` samples of 16-bit silence. */
function makeWav(sampleRate: number, sampleCount: number, bitsPerSample = 16): Uint8Array {
  const blockAlign = bitsPerSample / 8; // mono
  const dataLen = sampleCount * blockAlign;
  const out = new Uint8Array(44 + dataLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x52494646, false); // RIFF
  view.setUint32(4, 36 + dataLen, true);
  view.setUint32(8, 0x57415645, false); // WAVE
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataLen, true);
  // Fill data with a ramp so we can assert slices carry the right samples.
  for (let i = 0; i < sampleCount; i += 1) view.setInt16(44 + i * 2, i % 32000, true);
  return out;
}

/** Read a WAV chunk's declared data length (bytes 40-43). */
function dataLen(wav: Uint8Array): number {
  return new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(40, true);
}

describe('sliceWavIntoChunks', () => {
  it('returns a single chunk when the audio is at or under the limit', () => {
    const wav = makeWav(16000, 16000); // 1s
    const chunks = sliceWavIntoChunks(wav, 30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startSeconds).toBe(0);
    expect(dataLen(chunks[0]!.bytes)).toBe(16000 * 2);
  });

  it('splits long audio into ≤maxSeconds chunks with exact start offsets', () => {
    // 70s at 16kHz mono → 30s + 30s + 10s.
    const wav = makeWav(16000, 16000 * 70);
    const chunks = sliceWavIntoChunks(wav, 30);
    expect(chunks.map((c) => c.startSeconds)).toEqual([0, 30, 60]);
    expect(dataLen(chunks[0]!.bytes)).toBe(16000 * 30 * 2);
    expect(dataLen(chunks[1]!.bytes)).toBe(16000 * 30 * 2);
    expect(dataLen(chunks[2]!.bytes)).toBe(16000 * 10 * 2); // remainder
  });

  it('produces valid, independently-parseable WAV chunks (round-trips)', () => {
    const wav = makeWav(16000, 16000 * 65);
    const chunks = sliceWavIntoChunks(wav, 30);
    // Each chunk must itself slice into exactly one chunk (it's ≤30s and valid).
    for (const chunk of chunks) {
      const reparsed = sliceWavIntoChunks(chunk.bytes, 30);
      expect(reparsed).toHaveLength(1);
    }
    // Total samples across chunks equals the original.
    const total = chunks.reduce((sum, c) => sum + dataLen(c.bytes), 0);
    expect(total).toBe(16000 * 65 * 2);
  });

  it('slices on sample-frame boundaries (never a half sample)', () => {
    const wav = makeWav(44100, 44100 * 3); // 3s @ 44.1kHz
    const chunks = sliceWavIntoChunks(wav, 1);
    for (const chunk of chunks) expect(dataLen(chunk.bytes) % 2).toBe(0);
    expect(chunks.map((c) => c.startSeconds)).toEqual([0, 1, 2]);
  });

  it('tolerates a "data" chunk that overruns the buffer (clamps to real bytes)', () => {
    const wav = makeWav(16000, 16000);
    // Lie: declare a huge data length. The slicer must clamp to the real buffer.
    new DataView(wav.buffer).setUint32(40, 0xffffff, true);
    const chunks = sliceWavIntoChunks(wav, 30);
    expect(dataLen(chunks[0]!.bytes)).toBe(16000 * 2);
  });

  it('rejects non-WAV input and non-positive limits', () => {
    expect(() => sliceWavIntoChunks(new Uint8Array([1, 2, 3]), 30)).toThrow();
    expect(() => sliceWavIntoChunks(makeWav(16000, 100), 0)).toThrow(/positive/);
  });

  it('rejects a WAV whose bits-per-sample is not a whole number of bytes', () => {
    // Same header shape as `makeWav`, but with a data chunk sized independently
    // of the (fractional) block-align so the buffer stays a whole number of bytes.
    const dataLen = 100;
    const out = new Uint8Array(44 + dataLen);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x52494646, false); // RIFF
    view.setUint32(4, 36 + dataLen, true);
    view.setUint32(8, 0x57415645, false); // WAVE
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, 16000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 12, true); // bitsPerSample: not a whole number of bytes
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, dataLen, true);
    expect(() => sliceWavIntoChunks(out, 30)).toThrow(/Unsupported bits-per-sample/);
  });

  it('rejects a non-PCM audio format', () => {
    const wav = makeWav(16000, 100);
    new DataView(wav.buffer).setUint16(20, 3, true); // 3 = IEEE float, not PCM
    expect(() => sliceWavIntoChunks(wav, 30)).toThrow(/Unsupported WAV format 3/);
  });

  it('rejects a WAV missing its "fmt " chunk', () => {
    const dataOnly = new Uint8Array(20);
    const view = new DataView(dataOnly.buffer);
    view.setUint32(0, 0x52494646, false); // RIFF
    view.setUint32(4, 12, true);
    view.setUint32(8, 0x57415645, false); // WAVE
    view.setUint32(12, 0x64617461, false); // "data"
    view.setUint32(16, 0, true);
    expect(() => sliceWavIntoChunks(dataOnly, 30)).toThrow(/missing its "fmt " chunk/);
  });

  it('rejects a WAV missing its "data" chunk', () => {
    const fmtOnly = new Uint8Array(36);
    const view = new DataView(fmtOnly.buffer);
    view.setUint32(0, 0x52494646, false); // RIFF
    view.setUint32(4, 28, true);
    view.setUint32(8, 0x57415645, false); // WAVE
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    expect(() => sliceWavIntoChunks(fmtOnly, 30)).toThrow(/missing its "data" chunk/);
  });

  it('yields one stable (silent) chunk for a WAV with an empty data chunk', () => {
    const wav = makeWav(16000, 0);
    const chunks = sliceWavIntoChunks(wav, 30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startSeconds: 0 });
    expect(dataLen(chunks[0]!.bytes)).toBe(0);
  });
});
