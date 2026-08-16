/** Tests for the chunk-and-merge hosted transcription driver. */
import { describe, expect, it, vi } from 'vitest';
import { transcribeWavInChunks, type ChunkTranscriber } from './chunked-transcribe.js';
import type { AsrResult } from './asr-types.js';
import type { AudioInput } from './groq-asr.js';

/** A canonical mono-16k PCM WAV with `seconds` of silence. */
function makeWav(seconds: number, sampleRate = 16000): Uint8Array {
  const dataLen = seconds * sampleRate * 2;
  const out = new Uint8Array(44 + dataLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + dataLen, true);
  view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataLen, true);
  return out;
}

describe('transcribeWavInChunks', () => {
  it('sends one request for audio within the window', async () => {
    const provider: ChunkTranscriber = {
      transcribe: vi.fn(
        async (): Promise<AsrResult> => ({
          available: true,
          words: [{ word: 'hi', start: 0.1, end: 0.3 }],
        }),
      ),
    };
    const result = await transcribeWavInChunks(provider, makeWav(10), {
      chunkSeconds: 30,
      filenameBase: 'clip',
    });
    expect(provider.transcribe).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ available: true, words: [{ word: 'hi', start: 0.1, end: 0.3 }] });
  });

  it('splits >window audio into windows and offsets each chunk onto the clip timeline', async () => {
    const perChunk: Record<number, AsrResult> = {
      0: { available: true, words: [{ word: 'a', start: 1, end: 1.5 }] },
      1: { available: true, words: [{ word: 'b', start: 2, end: 2.5 }] },
      2: { available: true, words: [{ word: 'c', start: 0.5, end: 1 }] },
    };
    let call = 0;
    const seen: string[] = [];
    const provider: ChunkTranscriber = {
      transcribe: async (audio: AudioInput) => {
        seen.push(audio.filename);
        return perChunk[call++]!;
      },
    };
    // 65s → 30 + 30 + 5.
    const result = await transcribeWavInChunks(provider, makeWav(65), {
      chunkSeconds: 30,
      filenameBase: 'clip',
    });
    expect(seen).toEqual(['clip.part0.wav', 'clip.part1.wav', 'clip.part2.wav']);
    expect(result).toEqual({
      available: true,
      words: [
        { word: 'a', start: 1, end: 1.5 }, // chunk 0, +0s
        { word: 'b', start: 32, end: 32.5 }, // chunk 1, +30s
        { word: 'c', start: 60.5, end: 61 }, // chunk 2, +60s
      ],
    });
  });

  it('propagates an honest-unavailable chunk instead of a partial transcript', async () => {
    const provider: ChunkTranscriber = {
      transcribe: async (): Promise<AsrResult> => ({ available: false, reason: 'no key' }),
    };
    const result = await transcribeWavInChunks(provider, makeWav(65), {
      chunkSeconds: 30,
      filenameBase: 'clip',
    });
    expect(result).toEqual({ available: false, reason: 'no key' });
  });

  it('surfaces a chunk request failure (thrown) to the caller', async () => {
    const provider: ChunkTranscriber = {
      transcribe: async () => {
        throw new Error('boom');
      },
    };
    await expect(
      transcribeWavInChunks(provider, makeWav(65), { chunkSeconds: 30, filenameBase: 'clip' }),
    ).rejects.toThrow('boom');
  });
});
