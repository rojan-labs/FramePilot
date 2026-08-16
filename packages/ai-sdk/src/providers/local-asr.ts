/**
 * @framepilot/ai-sdk/providers/local-asr — local whisper-cli ASR (default, plan H0.1).
 *
 * The actual transcription work happens in the Python engine (it already owns
 * ffmpeg audio extraction) — this module is a thin HTTP client for the engine
 * sidecar's `/transcribe`, `/asr/status`, and `/asr/setup` routes
 * (`framepilot_engine.audio.asr` + `service.py`). It never touches media or
 * subprocesses itself; it only talks JSON to the already-sandboxed engine.
 *
 * Never fabricates a transcript: a missing binary/model surfaces as a 503 from
 * the engine, which this client turns into a typed `{ available: false }`
 * result (AGENTS.md invariant 6) rather than throwing an opaque HTTP error for
 * that specific, expected case.
 */
import { createLogger } from '@framepilot/shared-types';
import { classifyResponse, classifyThrown } from './errors.js';
import { parseAsrWords, type AsrResult } from './asr-types.js';
import type { FetchLike } from './types.js';

const log = createLogger('ai-sdk:providers:local-asr');

/** Local engine sidecar default (mirrors the desktop shell's default port). */
export const DEFAULT_ENGINE_BASE_URL = 'http://127.0.0.1:8765';

export interface LocalAsrStatus {
  readonly binaryAvailable: boolean;
  readonly binaryPath: string | null;
  readonly model: string;
  readonly modelPresent: boolean;
  readonly modelPath: string;
  /** Published size of the model download, so a UI can warn before committing. */
  readonly downloadSizeBytes: number;
}

/** Lifecycle of the engine's single-slot model-setup job (mirrors `AsrSetupState`). */
export type LocalAsrSetupState = 'idle' | 'downloading' | 'installed' | 'cancelled' | 'error';

/**
 * Live progress of a model download. `totalBytes` is the server's
 * `Content-Length` when it declared one, else the published model size — both
 * real figures, so a determinate bar is honest (never a fabricated percentage).
 */
export interface LocalAsrSetupProgress {
  readonly state: LocalAsrSetupState;
  readonly model: string;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly error: string | null;
}

export interface LocalAsrRequest {
  /** Path to the saved project.fp.json, OR the inline project document — exactly
   * one, mirroring the engine's `AnalysisProjectSource` contract. */
  readonly projectPath?: string;
  readonly project?: Record<string, unknown>;
  readonly assetId?: string;
  readonly model?: string;
  readonly useCache?: boolean;
}

export class LocalWhisperCliClient {
  public readonly name = 'whisper-cli' as const;
  public readonly sendsAudioOffDevice = false;

  public constructor(
    private readonly baseUrl: string = DEFAULT_ENGINE_BASE_URL,
    // Evaluated per-instantiation (a default parameter, not a module-level
    // constant) so a test's `vi.stubGlobal('fetch', ...)` — which runs after
    // this module is imported — is still honoured by a client constructed
    // with no explicit `fetchImpl` (mirrors groq.ts/ollama.ts).
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(
      globalThis,
    ) as unknown as FetchLike,
  ) {}

  /** Report local whisper-cli binary + model readiness (for a settings/status UI). */
  public async status(model?: string, signal?: AbortSignal): Promise<LocalAsrStatus> {
    const url = new URL('/asr/status', this.baseUrl);
    if (model) url.searchParams.set('model', model);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw classifyThrown('LocalASR', error);
    }
    const raw = await response.text();
    if (!response.ok) throw classifyResponse('LocalASR', response.status, raw, response.headers);
    return JSON.parse(raw) as LocalAsrStatus;
  }

  /** Download + SHA256-verify the local model (explicit step — never implicit). */
  public async setup(
    model?: string,
    signal?: AbortSignal,
  ): Promise<{ model: string; path: string }> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/asr/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(model ? { model } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw classifyThrown('LocalASR', error);
    }
    const raw = await response.text();
    if (!response.ok) throw classifyResponse('LocalASR', response.status, raw, response.headers);
    return JSON.parse(raw) as { model: string; path: string };
  }

  /**
   * Poll the live progress of a setup run. WHY a second call rather than a
   * streaming response: `setup()` is a plain awaited POST that cannot report on
   * itself mid-flight, and the model is ~141MB — long enough that a bare
   * spinner is not an acceptable answer. The engine runs the download on a
   * worker thread, so this stays responsive while that request is pending.
   */
  public async setupProgress(signal?: AbortSignal): Promise<LocalAsrSetupProgress> {
    return this.getSetupJson(`${this.baseUrl}/asr/setup/progress`, 'GET', signal);
  }

  /**
   * Abort an in-flight download; the partial file is discarded, nothing is
   * installed. Idempotent — cancelling when idle reports the state, not an error.
   */
  public async cancelSetup(signal?: AbortSignal): Promise<LocalAsrSetupProgress> {
    return this.getSetupJson(`${this.baseUrl}/asr/setup/cancel`, 'POST', signal);
  }

  private async getSetupJson(
    url: string,
    method: 'GET' | 'POST',
    signal?: AbortSignal,
  ): Promise<LocalAsrSetupProgress> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw classifyThrown('LocalASR', error);
    }
    const raw = await response.text();
    if (!response.ok) throw classifyResponse('LocalASR', response.status, raw, response.headers);
    return JSON.parse(raw) as LocalAsrSetupProgress;
  }

  /**
   * Transcribe an asset via the engine sidecar. Honest-unavailable: a 503 from
   * the engine (missing binary/model) becomes `{ available: false, reason }`
   * rather than a thrown error, so callers can render an actionable message —
   * never a fabricated transcript.
   */
  public async transcribe(request: LocalAsrRequest, signal?: AbortSignal): Promise<AsrResult> {
    log.action('transcribe → request', {
      assetId: request.assetId,
      model: request.model,
      useCache: request.useCache,
    });
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          project_path: request.projectPath,
          project: request.project,
          asset_id: request.assetId,
          model: request.model,
          use_cache: request.useCache,
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      log.error('transcribe → fetch threw', { error: String(error) });
      throw classifyThrown('LocalASR', error);
    }
    const raw = await response.text();
    if (response.status === 503) {
      log.warn('transcribe → unavailable (503)', { reason: raw.slice(0, 500) });
      return { available: false, reason: raw || 'Local ASR is unavailable.' };
    }
    if (!response.ok) {
      log.error('transcribe → non-ok response', {
        status: response.status,
        body: raw.slice(0, 500),
      });
      throw classifyResponse('LocalASR', response.status, raw, response.headers);
    }
    const words = parseAsrWords('LocalASR', raw);
    log.action('transcribe ← response', { words: words.length });
    return { available: true, words };
  }
}
