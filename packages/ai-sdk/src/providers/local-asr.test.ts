/**
 * Tests for the local whisper-cli ASR client — a thin HTTP client for the
 * engine sidecar's /asr/status, /asr/setup, /transcribe routes. Every call
 * routed through an injected `FetchLike`, no network.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_BASE_URL, LocalWhisperCliClient } from './local-asr.js';
import { ProviderError } from '../reliability/types.js';
import type { FetchLike } from './types.js';

interface Route {
  ok?: boolean;
  status?: number;
  raw?: string;
  throws?: Error;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function routedFetch(routes: Record<string, Route>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    });
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`Unrouted url: ${url}`);
    const route = routes[key] as Route;
    if (route.throws) throw route.throws;
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      text: async () => route.raw ?? '{}',
    };
  };
  return { fetchImpl, calls };
}

describe('LocalWhisperCliClient', () => {
  it('status() GETs /asr/status and honours an optional model query param', async () => {
    const statusJson = JSON.stringify({
      binaryAvailable: true,
      binaryPath: '/opt/whisper-cli',
      model: 'base.en',
      modelPresent: false,
      modelPath: '/home/.framepilot/models/ggml-base.en.bin',
    });
    const { fetchImpl, calls } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/status`]: { raw: statusJson },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    const status = await client.status('base.en');
    expect(status.binaryAvailable).toBe(true);
    expect(status.modelPresent).toBe(false);
    expect(calls[0]!.url).toBe(`${DEFAULT_ENGINE_BASE_URL}/asr/status?model=base.en`);
    expect(calls[0]!.method).toBe('GET');
  });

  it('status() throws a classified ProviderError on a non-ok response', async () => {
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/status`]: { ok: false, status: 500, raw: 'boom' },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    await expect(client.status()).rejects.toBeInstanceOf(ProviderError);
  });

  it('status() classifies a thrown transport error', async () => {
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/status`]: { throws: new Error('ECONNREFUSED') },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    await expect(client.status()).rejects.toBeInstanceOf(ProviderError);
  });

  it('setup() POSTs the model and returns the installed path', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup`]: {
        raw: JSON.stringify({
          model: 'base.en',
          path: '/home/.framepilot/models/ggml-base.en.bin',
        }),
      },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    const result = await client.setup('base.en');
    expect(result.model).toBe('base.en');
    expect(calls[0]!.body).toEqual({ model: 'base.en' });
  });

  it('setup() with no model omits the field', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup`]: {
        raw: JSON.stringify({ model: 'base.en', path: '/x' }),
      },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    await client.setup();
    expect(calls[0]!.body).toEqual({});
  });

  it('setup() throws a classified ProviderError on failure', async () => {
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup`]: { ok: false, status: 422, raw: 'checksum failed' },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    await expect(client.setup('base.en')).rejects.toBeInstanceOf(ProviderError);
  });

  it('setup() classifies a thrown transport error', async () => {
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup`]: { throws: new Error('down') },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    await expect(client.setup()).rejects.toBeInstanceOf(ProviderError);
  });

  it('setupProgress() GETs real byte counts for the in-flight download', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup/progress`]: {
        raw: JSON.stringify({
          state: 'downloading',
          model: 'base.en',
          downloadedBytes: 20_971_520,
          totalBytes: 147_964_211,
          error: null,
        }),
      },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    const progress = await client.setupProgress();
    expect(progress.state).toBe('downloading');
    expect(progress.downloadedBytes).toBe(20_971_520);
    expect(progress.totalBytes).toBe(147_964_211);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe(`${DEFAULT_ENGINE_BASE_URL}/asr/setup/progress`);
  });

  it('setupProgress() surfaces the engine’s failure message for a finished run', async () => {
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup/progress`]: {
        raw: JSON.stringify({
          state: 'error',
          model: 'base.en',
          downloadedBytes: 147_964_211,
          totalBytes: 147_964_211,
          error: 'failed checksum verification',
        }),
      },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    const progress = await client.setupProgress();
    expect(progress.state).toBe('error');
    expect(progress.error).toBe('failed checksum verification');
  });

  it('cancelSetup() POSTs the cancel route and returns the resulting state', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup/cancel`]: {
        raw: JSON.stringify({
          state: 'cancelled',
          model: 'base.en',
          downloadedBytes: 4_194_304,
          totalBytes: 147_964_211,
          error: null,
        }),
      },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    expect((await client.cancelSetup()).state).toBe('cancelled');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${DEFAULT_ENGINE_BASE_URL}/asr/setup/cancel`);
  });

  it('setupProgress()/cancelSetup() classify failures and transport errors', async () => {
    const failing = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup/progress`]: { ok: false, status: 500, raw: 'boom' },
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup/cancel`]: { throws: new Error('down') },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, failing.fetchImpl);
    await expect(client.setupProgress()).rejects.toBeInstanceOf(ProviderError);
    await expect(client.cancelSetup()).rejects.toBeInstanceOf(ProviderError);
  });

  it('threads an AbortSignal into setupProgress/cancelSetup', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      seen.push(init.signal);
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    const controller = new AbortController();
    await client.setupProgress(controller.signal);
    await client.cancelSetup(controller.signal);
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it('transcribe() POSTs project/asset fields and returns word-level results', async () => {
    const { fetchImpl, calls } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/transcribe`]: {
        raw: JSON.stringify({
          assetId: 'a1',
          words: [{ word: 'hi', start: 0, end: 0.4 }],
        }),
      },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    const result = await client.transcribe({ projectPath: '/p/project.fp.json', assetId: 'a1' });
    expect(result).toEqual({ available: true, words: [{ word: 'hi', start: 0, end: 0.4 }] });
    expect(calls[0]!.body).toMatchObject({ project_path: '/p/project.fp.json', asset_id: 'a1' });
  });

  it('transcribe() reports a 503 (missing binary/model) as honest-unavailable, not a throw', async () => {
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/transcribe`]: {
        ok: false,
        status: 503,
        raw: 'whisper-cli not found on PATH.',
      },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    const result = await client.transcribe({ projectPath: '/p.fp.json' });
    expect(result).toEqual({ available: false, reason: 'whisper-cli not found on PATH.' });
  });

  it('transcribe() with an empty 503 body falls back to a generic reason', async () => {
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/transcribe`]: { ok: false, status: 503, raw: '' },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    const result = await client.transcribe({ projectPath: '/p.fp.json' });
    expect(result).toEqual({ available: false, reason: 'Local ASR is unavailable.' });
  });

  it('transcribe() throws a classified ProviderError on a non-503 failure', async () => {
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/transcribe`]: { ok: false, status: 422, raw: 'decode failed' },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    await expect(client.transcribe({ projectPath: '/p.fp.json' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('transcribe() classifies a thrown transport error', async () => {
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/transcribe`]: { throws: new Error('down') },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    await expect(client.transcribe({ projectPath: '/p.fp.json' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('threads an AbortSignal into status/setup/transcribe when given', async () => {
    const statusJson = JSON.stringify({
      binaryAvailable: true,
      binaryPath: '/x',
      model: 'base.en',
      modelPresent: true,
      modelPath: '/x/ggml-base.en.bin',
    });
    const { fetchImpl } = routedFetch({
      [`${DEFAULT_ENGINE_BASE_URL}/asr/status`]: { raw: statusJson },
      [`${DEFAULT_ENGINE_BASE_URL}/asr/setup`]: {
        raw: JSON.stringify({ model: 'base.en', path: '/x' }),
      },
      [`${DEFAULT_ENGINE_BASE_URL}/transcribe`]: {
        raw: JSON.stringify({ assetId: 'a1', words: [] }),
      },
    });
    const client = new LocalWhisperCliClient(DEFAULT_ENGINE_BASE_URL, fetchImpl);
    const controller = new AbortController();
    await client.status('base.en', controller.signal);
    await client.setup('base.en', controller.signal);
    await client.transcribe({ projectPath: '/p.fp.json' }, controller.signal);
  });

  it('defaults name/sendsAudioOffDevice/baseUrl', () => {
    const client = new LocalWhisperCliClient();
    expect(client.name).toBe('whisper-cli');
    expect(client.sendsAudioOffDevice).toBe(false);
  });
});
