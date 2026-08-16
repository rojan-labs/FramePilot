/**
 * Engine-side TwelveLabs transcription client.
 *
 * TwelveLabs transcribes audio while an asset is indexed. FramePilot therefore
 * sends only saved project/asset identity to the local sidecar; the sidecar reads
 * the already-indexed word timings. Media bytes and the API key never enter the
 * renderer, and this client never silently falls back to another provider.
 */
import { createLogger } from '@framepilot/shared-types';
import { classifyResponse, classifyThrown } from './errors.js';
import { parseAsrWords, type AsrResult } from './asr-types.js';
import { DEFAULT_ENGINE_BASE_URL } from './local-asr.js';
import type { FetchLike } from './types.js';

const log = createLogger('ai-sdk:providers:twelvelabs-asr');

export interface TwelveLabsAsrConfig {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface TwelveLabsAsrRequest {
  readonly projectPath: string;
  readonly projectId: string;
  readonly assetId: string;
}

export class TwelveLabsTranscriptionProvider {
  public readonly name = 'twelvelabs' as const;
  public readonly sendsAudioOffDevice = true;

  public constructor(
    private readonly config: TwelveLabsAsrConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(
      globalThis,
    ) as unknown as FetchLike,
  ) {}

  public async transcribe(request: TwelveLabsAsrRequest, signal?: AbortSignal): Promise<AsrResult> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) {
      return { available: false, reason: 'Add a TwelveLabs API key in Media intelligence.' };
    }

    log.action('transcribe → request', {
      projectId: request.projectId,
      assetId: request.assetId,
    });
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl ?? DEFAULT_ENGINE_BASE_URL}/transcribe`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            project_path: request.projectPath,
            projectId: request.projectId,
            asset_id: request.assetId,
            provider: 'twelvelabs',
            twelveLabsKey: apiKey,
          }),
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      throw classifyThrown('TwelveLabs', error);
    }

    const raw = await response.text();
    if (response.status === 503) {
      return { available: false, reason: raw || 'TwelveLabs is unavailable.' };
    }
    if (!response.ok) {
      throw classifyResponse('TwelveLabs', response.status, raw, response.headers);
    }
    const words = parseAsrWords('TwelveLabs', raw);
    log.action('transcribe ← response', { words: words.length });
    return { available: true, words };
  }
}
