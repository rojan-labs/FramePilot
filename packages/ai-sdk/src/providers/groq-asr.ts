/**
 * @framepilot/ai-sdk/providers/groq-asr — hosted Whisper transcription via Groq
 * (plan H0.1, alternative to the default local whisper-cli provider).
 *
 * Groq serves an OpenAI-compatible `/audio/transcriptions` endpoint on top of
 * `whisper-large-v3` with **word-level timestamps** available directly from the
 * API (`timestamp_granularities: ["word"]`) — no client-side token-merging
 * needed, unlike the local whisper.cpp CLI path. Reuses the auth/error-
 * classification plumbing {@link GROQ_BASE_URL}/`classifyResponse`/
 * `classifyThrown` from `groq.ts`/`errors.ts` rather than reinventing it; only
 * the request shape (multipart audio upload, not a chat completion) differs.
 *
 * **Sends audio off-device** — this provider is opt-in, never the default
 * (`asrSendsAudioOffDevice('groq') === true`); the caller/UI must disclose
 * this before use (plan invariant 11).
 */
import { createLogger } from '@framepilot/shared-types';
import { GROQ_BASE_URL } from './provider-defaults.js';
import { classifyResponse, classifyThrown } from './errors.js';
import { DEFAULT_GROQ_ASR_MODEL, parseAsrWords, type AsrResult } from './asr-types.js';
import { parseAsrKeyRing, transcribeWithKeyRing } from './asr-keyring.js';

const log = createLogger('ai-sdk:providers:groq-asr');

/** Audio payload to transcribe: raw bytes + a filename Groq uses to sniff format. */
export interface AudioInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType?: string;
}

/**
 * The subset of `fetch` this provider depends on. Distinct from the chat
 * {@link import('./types.js').FetchLike} because the request body is
 * `FormData` (multipart upload), not a JSON string — injectable so tests never
 * hit the network.
 */
export type AudioFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData; signal?: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  readonly headers?: { get(name: string): string | null };
}>;

export interface GroqAsrConfig {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

export class GroqTranscriptionProvider {
  public readonly name = 'groq' as const;
  public readonly sendsAudioOffDevice = true;

  public constructor(
    private readonly config: GroqAsrConfig,
    private readonly fetchImpl: AudioFetchLike = globalThis.fetch.bind(
      globalThis,
    ) as unknown as AudioFetchLike,
  ) {}

  private url(): string {
    return `${this.config.baseUrl ?? GROQ_BASE_URL}/audio/transcriptions`;
  }

  /**
   * Transcribe `audio` and return word-level timestamps. Honest-unavailable:
   * missing configuration (no API key) is reported as `{ available: false }`
   * rather than thrown, matching the local provider's contract so callers can
   * branch on one shape regardless of which provider is configured.
   */
  public async transcribe(audio: AudioInput, signal?: AbortSignal): Promise<AsrResult> {
    // The key setting may be a comma-separated ring; roll over to the next on failure.
    const keys = parseAsrKeyRing(this.config.apiKey);
    if (keys.length === 0) {
      log.warn('transcribe → unavailable, GROQ_API_KEY not configured');
      return {
        available: false,
        reason: 'GroqTranscriptionProvider: GROQ_API_KEY is not configured.',
      };
    }
    return transcribeWithKeyRing(keys, (apiKey) => this.transcribeOnce(audio, apiKey, signal), log);
  }

  /** One transcription attempt with a single API key (the key-ring drives failover). */
  private async transcribeOnce(
    audio: AudioInput,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<AsrResult> {
    const form = new FormData();
    form.append(
      'file',
      // `Uint8Array<ArrayBufferLike>` vs. lib.dom's `BlobPart` (which wants a
      // concrete `ArrayBuffer`) is a known TS lib mismatch, not a real runtime
      // issue — `Blob` accepts any `ArrayBufferView` at runtime.
      new Blob([audio.bytes as BlobPart], { type: audio.mimeType ?? 'application/octet-stream' }),
      audio.filename,
    );
    form.append('model', this.config.model ?? DEFAULT_GROQ_ASR_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');

    log.action('transcribe → request', {
      model: this.config.model ?? DEFAULT_GROQ_ASR_MODEL,
      filename: audio.filename,
      bytes: audio.bytes.length,
    });
    let response: Awaited<ReturnType<AudioFetchLike>>;
    try {
      response = await this.fetchImpl(this.url(), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      log.error('transcribe → fetch threw', { error: String(error) });
      throw classifyThrown('Groq', error);
    }
    const raw = await response.text();
    if (!response.ok) {
      log.error('transcribe → non-ok response', {
        status: response.status,
        body: raw.slice(0, 500),
      });
      throw classifyResponse('Groq', response.status, raw, response.headers);
    }
    const words = parseAsrWords('Groq', raw);
    log.action('transcribe ← response', { words: words.length });
    return { available: true, words };
  }
}
