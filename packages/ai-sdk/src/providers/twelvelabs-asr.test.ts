import { describe, expect, it } from 'vitest';
import { ProviderError } from '../reliability/types.js';
import { TwelveLabsTranscriptionProvider } from './twelvelabs-asr.js';
import type { FetchLike } from './types.js';

function response(
  raw: string,
  options: { ok?: boolean; status?: number } = {},
): Awaited<ReturnType<FetchLike>> {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: async () => raw,
  };
}

describe('TwelveLabsTranscriptionProvider', () => {
  const request = {
    projectPath: '/projects/demo/project.fp.json',
    projectId: 'project-1',
    assetId: 'asset-1',
  };

  it('uses the sidecar contract and returns native word timestamps', async () => {
    const calls: Array<{ url: string; body: unknown; signal: AbortSignal | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({
        url,
        body: JSON.parse(init.body) as unknown,
        signal: init.signal,
      });
      return response(
        JSON.stringify({ words: [{ word: 'Hello', start: 0.93, end: 1.24, assetId: 'asset-1' }] }),
      );
    };
    const provider = new TwelveLabsTranscriptionProvider(
      { apiKey: 'tl-key', baseUrl: 'http://engine.test' },
      fetchImpl,
    );
    const controller = new AbortController();

    await expect(provider.transcribe(request, controller.signal)).resolves.toEqual({
      available: true,
      words: [{ word: 'Hello', start: 0.93, end: 1.24, assetId: 'asset-1' }],
    });
    expect(calls).toEqual([
      {
        url: 'http://engine.test/transcribe',
        body: {
          project_path: request.projectPath,
          projectId: request.projectId,
          asset_id: request.assetId,
          provider: 'twelvelabs',
          twelveLabsKey: 'tl-key',
        },
        signal: controller.signal,
      },
    ]);
  });

  it('is honestly unavailable without the shared TwelveLabs key', async () => {
    const provider = new TwelveLabsTranscriptionProvider({});
    await expect(provider.transcribe(request)).resolves.toEqual({
      available: false,
      reason: 'Add a TwelveLabs API key in Media intelligence.',
    });
  });

  it('maps a sidecar-unavailable response to the unified unavailable result', async () => {
    const fetchImpl: FetchLike = async () =>
      response('TwelveLabs is temporarily unavailable.', { ok: false, status: 503 });
    const provider = new TwelveLabsTranscriptionProvider({ apiKey: 'tl-key' }, fetchImpl);
    await expect(provider.transcribe(request)).resolves.toEqual({
      available: false,
      reason: 'TwelveLabs is temporarily unavailable.',
    });
  });

  it('falls back to a default reason when a 503 body is empty', async () => {
    const fetchImpl: FetchLike = async () => response('', { ok: false, status: 503 });
    const provider = new TwelveLabsTranscriptionProvider({ apiKey: 'tl-key' }, fetchImpl);
    await expect(provider.transcribe(request)).resolves.toEqual({
      available: false,
      reason: 'TwelveLabs is unavailable.',
    });
  });

  it('classifies provider and transport failures', async () => {
    const rejected: FetchLike = async () => response('bad key', { ok: false, status: 401 });
    const disconnected: FetchLike = async () => {
      throw new Error('socket closed');
    };
    await expect(
      new TwelveLabsTranscriptionProvider({ apiKey: 'tl-key' }, rejected).transcribe(request),
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(
      new TwelveLabsTranscriptionProvider({ apiKey: 'tl-key' }, disconnected).transcribe(request),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
