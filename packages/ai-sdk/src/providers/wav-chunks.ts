/**
 * @framepilot/ai-sdk/providers/wav-chunks — split a PCM WAV into fixed-duration
 * chunks for hosted transcription.
 *
 * WHY: hosted ASR APIs cap request size/duration, and sending a whole long file in
 * one shot is slow and can be rejected. The desktop host decodes an asset to a canonical
 * mono-16k PCM WAV (via the Python engine — the only place ffmpeg lives), then this
 * pure function slices that WAV **by time** into ≤`maxSeconds` pieces. Each piece is a
 * standalone, valid WAV the provider can transcribe independently; the caller offsets
 * every chunk's word timestamps by {@link WavChunk.startSeconds} and concatenates.
 *
 * Pure and deterministic (no I/O) so it is unit-tested exhaustively. PCM only — the
 * engine always produces linear PCM, which is the only format sliceable on a sample
 * boundary without re-encoding.
 */

/** One time-sliced WAV chunk plus where it starts in the original audio. */
export interface WavChunk {
  /** A complete, valid WAV file (canonical 44-byte header + this slice's samples). */
  readonly bytes: Uint8Array;
  /** Seconds from the start of the original audio to this chunk's first sample. */
  readonly startSeconds: number;
}

interface WavFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  /** Byte offset of the PCM samples within the source buffer. */
  readonly dataOffset: number;
  /** Length in bytes of the PCM samples. */
  readonly dataLength: number;
}

const RIFF = 0x52494646; // "RIFF"
const WAVE = 0x57415645; // "WAVE"

function fourCC(view: DataView, offset: number): number {
  return view.getUint32(offset, false);
}

/**
 * Parse a canonical PCM WAV header, tolerating extra sub-chunks (LIST/fact) that
 * ffmpeg may write before `data`. Throws on anything that isn't PCM WAV.
 */
function parseWav(bytes: Uint8Array): WavFormat {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || fourCC(view, 0) !== RIFF || fourCC(view, 8) !== WAVE) {
    throw new Error('Not a RIFF/WAVE file.');
  }
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | undefined;
  let data: { offset: number; length: number } | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420 /* "fmt " */) {
      const audioFormat = view.getUint16(body, true);
      if (audioFormat !== 1) throw new Error(`Unsupported WAV format ${audioFormat} (PCM only).`);
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 0x64617461 /* "data" */) {
      // Clamp to the real buffer end — a streamed/truncated file can report more.
      data = { offset: body, length: Math.min(size, bytes.byteLength - body) };
      break; // samples follow; nothing after matters for slicing
    }
    // Chunks are word-aligned: an odd size carries a pad byte.
    offset = body + size + (size % 2);
  }
  if (!fmt) throw new Error('WAV is missing its "fmt " chunk.');
  if (!data) throw new Error('WAV is missing its "data" chunk.');
  if (fmt.bitsPerSample % 8 !== 0 || fmt.bitsPerSample === 0) {
    throw new Error(`Unsupported bits-per-sample ${fmt.bitsPerSample}.`);
  }
  return { ...fmt, dataOffset: data.offset, dataLength: data.length };
}

/** Write a canonical 44-byte PCM WAV header + `samples` into a fresh buffer. */
function buildWav(fmt: WavFormat, samples: Uint8Array): Uint8Array {
  const blockAlign = (fmt.channels * fmt.bitsPerSample) / 8;
  const byteRate = fmt.sampleRate * blockAlign;
  const out = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, RIFF, false);
  view.setUint32(4, 36 + samples.byteLength, true); // RIFF chunk size
  view.setUint32(8, WAVE, false);
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, fmt.channels, true);
  view.setUint32(24, fmt.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, fmt.bitsPerSample, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, samples.byteLength, true);
  out.set(samples, 44);
  return out;
}

/**
 * Split `wav` (a PCM WAV) into chunks of at most `maxSeconds` each. Audio at or under
 * the limit yields a single chunk. Slices land on sample-frame boundaries so no chunk
 * splits a sample. `startSeconds` is exact (derived from the byte offset ÷ byte rate).
 *
 * @throws if `wav` isn't parseable PCM WAV, or `maxSeconds` isn't positive.
 */
export function sliceWavIntoChunks(wav: Uint8Array, maxSeconds: number): WavChunk[] {
  if (!(maxSeconds > 0)) throw new Error('maxSeconds must be positive.');
  const fmt = parseWav(wav);
  const blockAlign = (fmt.channels * fmt.bitsPerSample) / 8;
  const byteRate = fmt.sampleRate * blockAlign;
  // Whole frames per chunk (never split a sample), at least one frame.
  const framesPerChunk = Math.max(1, Math.floor(maxSeconds * fmt.sampleRate));
  const chunkBytes = framesPerChunk * blockAlign;
  const pcm = wav.subarray(fmt.dataOffset, fmt.dataOffset + fmt.dataLength);

  const chunks: WavChunk[] = [];
  for (let start = 0; start < pcm.byteLength; start += chunkBytes) {
    const slice = pcm.subarray(start, Math.min(start + chunkBytes, pcm.byteLength));
    chunks.push({ bytes: buildWav(fmt, slice), startSeconds: start / byteRate });
  }
  // An empty data chunk still yields one (silent) chunk so callers get a stable shape.
  if (chunks.length === 0)
    chunks.push({ bytes: buildWav(fmt, new Uint8Array(0)), startSeconds: 0 });
  return chunks;
}
