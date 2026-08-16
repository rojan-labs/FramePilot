/**
 * @framepilot/ai-sdk/providers/chunked-transcribe — transcribe a long PCM WAV by
 * slicing it into fixed windows and stitching the results back together.
 *
 * WHY: hosted ASR APIs cap request size/duration, so a minutes-long clip must be sent
 * in pieces. {@link sliceWavIntoChunks} cuts the decoded audio into ≤`chunkSeconds`
 * windows; this drives the provider once per window and offsets every word timestamp
 * by its window's start so the merged transcript is on the original clip's timeline.
 * Each `provider.transcribe` call carries the provider's own comma-separated key
 * failover, so a chunk that hits a rate-limited key still rolls over transparently.
 */
import type { TranscriptWord } from '@framepilot/timeline-schema';
import type { AsrResult } from './asr-types.js';
import type { AudioInput } from './groq-asr.js';
import { sliceWavIntoChunks } from './wav-chunks.js';

/** The minimal provider surface the chunker drives (both hosted providers satisfy it). */
export interface ChunkTranscriber {
  transcribe(audio: AudioInput, signal?: AbortSignal): Promise<AsrResult>;
}

export interface ChunkedTranscribeOptions {
  /** Maximum seconds of audio per request (the hosted-ASR window, e.g. 30). */
  readonly chunkSeconds: number;
  /** Base filename for each uploaded chunk; the part index + `.wav` are appended. */
  readonly filenameBase: string;
  readonly signal?: AbortSignal;
}

/** Round to whole milliseconds so offset arithmetic never leaves float noise. */
function roundMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Transcribe `wav` (a PCM WAV) in ≤`chunkSeconds` windows and return one merged
 * word-level transcript on the original timeline. A single-window clip is one request
 * (no overhead). If any window is honest-unavailable (e.g. no key), that is returned
 * as-is; a request failure propagates as the provider's thrown error (the caller
 * turns it into a failed outcome), matching the single-shot path's contract.
 */
export async function transcribeWavInChunks(
  provider: ChunkTranscriber,
  wav: Uint8Array,
  options: ChunkedTranscribeOptions,
): Promise<AsrResult> {
  const chunks = sliceWavIntoChunks(wav, options.chunkSeconds);
  const words: TranscriptWord[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    const result = await provider.transcribe(
      {
        bytes: chunk.bytes,
        filename: `${options.filenameBase}.part${index}.wav`,
        mimeType: 'audio/wav',
      },
      options.signal,
    );
    if (!result.available) return result;
    for (const word of result.words) {
      words.push({
        ...word,
        start: roundMs(word.start + chunk.startSeconds),
        end: roundMs(word.end + chunk.startSeconds),
      });
    }
  }
  return { available: true, words };
}
