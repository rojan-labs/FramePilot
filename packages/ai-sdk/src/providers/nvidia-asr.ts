/**
 * @framepilot/ai-sdk/providers/nvidia-asr — hosted speech-to-text via NVIDIA
 * (plan H0.1, alternative to the default local whisper-cli provider).
 *
 * NVIDIA serves its `nemotron-asr` speech models on `integrate.api.nvidia.com`
 * behind the same OpenAI-compatible surface already used for chat + visual
 * embeddings (see `nvidia.ts` / `brain/visual_embed.py`): an
 * `/audio/transcriptions` multipart endpoint that, with
 * `response_format: verbose_json` + `timestamp_granularities: ["word"]`, returns
 * word-level timestamps directly — no client-side token merging, unlike the
 * local whisper.cpp path. The request shape therefore mirrors {@link
 * GroqTranscriptionProvider}; only the base URL, default model, and error label
 * differ, so this reuses the shared error-classification plumbing rather than
 * reinventing it.
 *
 * **Sends audio off-device** — this provider is opt-in, never the default
 * (`asrSendsAudioOffDevice('nvidia') === true`); the caller/UI must disclose
 * this before use (plan invariant 11). It authenticates with its OWN pasteable
 * ASR key (Settings → AI → Speech-to-text), NOT the chat `nvidia` provider key.
 */
import { createLogger } from '@framepilot/shared-types';
import { classifyResponse, classifyThrown } from './errors.js';
import { DEFAULT_NVIDIA_ASR_MODEL, parseAsrWords, type AsrResult } from './asr-types.js';
import { parseAsrKeyRing, transcribeWithKeyRing } from './asr-keyring.js';
import type { AudioFetchLike, AudioInput } from './groq-asr.js';

const log = createLogger('ai-sdk:providers:nvidia-asr');

/** NVIDIA's OpenAI-compatible base URL (shared with chat + embeddings). */
export const NVIDIA_ASR_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export interface NvidiaAsrConfig {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

export class NvidiaTranscriptionProvider {
  public readonly name = 'nvidia' as const;
  public readonly sendsAudioOffDevice = true;

  public constructor(
    private readonly config: NvidiaAsrConfig,
    private readonly fetchImpl: AudioFetchLike = globalThis.fetch.bind(
      globalThis,
    ) as unknown as AudioFetchLike,
  ) {}

  private url(): string {
    return `${this.config.baseUrl ?? NVIDIA_ASR_BASE_URL}/audio/transcriptions`;
  }

  /**
   * Transcribe `audio` and return word-level timestamps. Honest-unavailable:
   * missing configuration (no API key) is reported as `{ available: false }`
   * rather than thrown, matching the local + Groq providers' contract so callers
   * can branch on one shape regardless of which provider is configured.
   */
  public async transcribe(audio: AudioInput, signal?: AbortSignal): Promise<AsrResult> {
    // The key setting may be a comma-separated ring; roll over to the next on failure.
    const keys = parseAsrKeyRing(this.config.apiKey);
    if (keys.length === 0) {
      log.warn('transcribe → unavailable, NVIDIA ASR API key not configured');
      return {
        available: false,
        reason: 'NvidiaTranscriptionProvider: no NVIDIA speech-to-text API key is configured.',
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
      // `Uint8Array<ArrayBufferLike>` vs. lib.dom's `BlobPart` (which wants a
      // concrete `ArrayBuffer`) is a known TS lib mismatch, not a real runtime
      // issue — `Blob` accepts any `ArrayBufferView` at runtime.
      'file',
      new Blob([audio.bytes as BlobPart], { type: audio.mimeType ?? 'application/octet-stream' }),
      audio.filename,
    );
    form.append('model', this.config.model ?? DEFAULT_NVIDIA_ASR_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');

    log.action('transcribe → request', {
      model: this.config.model ?? DEFAULT_NVIDIA_ASR_MODEL,
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
      throw classifyThrown('NVIDIA', error);
    }
    const raw = await response.text();
    if (!response.ok) {
      log.error('transcribe → non-ok response', {
        status: response.status,
        body: raw.slice(0, 500),
      });
      throw classifyResponse('NVIDIA', response.status, raw, response.headers);
    }
    const words = parseAsrWords('NVIDIA', raw);
    log.action('transcribe ← response', { words: words.length });
    return { available: true, words };
  }
}
