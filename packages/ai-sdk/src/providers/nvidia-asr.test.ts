/**
 * Tests for the hosted NVIDIA ASR provider: multipart request shape, bearer auth,
 * word-level response parsing, and the honest-unavailable/error-classification
 * contract — all with an injected `AudioFetchLike`, no network.
 */
import { describe, expect, it } from 'vitest';
import { NvidiaTranscriptionProvider, NVIDIA_ASR_BASE_URL } from './nvidia-asr.js';
import { type AudioFetchLike } from './groq-asr.js';
import { ProviderError } from '../reliability/types.js';

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
  body: FormData;
}

function routedFetch(routes: Record<string, Route>): {
  fetchImpl: AudioFetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: AudioFetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
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

const audio = { bytes: new Uint8Array([1, 2, 3]), filename: 'clip.wav', mimeType: 'audio/wav' };

describe('NvidiaTranscriptionProvider', () => {
  it('POSTs a multipart request with the bearer key, nemotron model, and word granularity', async () => {
    const wordsJson = JSON.stringify({
      words: [
        { word: 'hello', start: 0, end: 0.4 },
        { word: 'world', start: 0.4, end: 0.9 },
      ],
    });
    const { fetchImpl, calls } = routedFetch({ [NVIDIA_ASR_BASE_URL]: { raw: wordsJson } });
    const provider = new NvidiaTranscriptionProvider({ apiKey: 'nvapi-x' }, fetchImpl);
    const result = await provider.transcribe(audio);

    expect(result).toEqual({
      available: true,
      words: [
        { word: 'hello', start: 0, end: 0.4 },
        { word: 'world', start: 0.4, end: 0.9 },
      ],
    });
    const call = calls[0]!;
    expect(call.url).toBe(`${NVIDIA_ASR_BASE_URL}/audio/transcriptions`);
    expect(call.headers['authorization']).toBe('Bearer nvapi-x');
    expect(call.body.get('model')).toBe('nemotron-asr-streaming');
    expect(call.body.get('response_format')).toBe('verbose_json');
    expect(call.body.get('timestamp_granularities[]')).toBe('word');
    expect(call.body.get('file')).toBeInstanceOf(Blob);
  });

  it('honours a configured model and base URL', async () => {
    const { fetchImpl, calls } = routedFetch({
      'https://custom.nvidia.example': { raw: JSON.stringify({ words: [] }) },
    });
    const provider = new NvidiaTranscriptionProvider(
      { apiKey: 'k', model: 'nemotron-asr', baseUrl: 'https://custom.nvidia.example' },
      fetchImpl,
    );
    await provider.transcribe(audio);
    expect(calls[0]!.url).toBe('https://custom.nvidia.example/audio/transcriptions');
    expect(calls[0]!.body.get('model')).toBe('nemotron-asr');
  });

  it('reports a missing API key as honest-unavailable, not a throw', async () => {
    const { fetchImpl, calls } = routedFetch({ [NVIDIA_ASR_BASE_URL]: { raw: '{}' } });
    const provider = new NvidiaTranscriptionProvider({}, fetchImpl);
    const result = await provider.transcribe(audio);
    expect(result).toEqual({
      available: false,
      reason: expect.stringContaining('no NVIDIA speech-to-text API key is configured'),
    });
    expect(calls).toHaveLength(0); // never even attempts the request
  });

  it('throws a classified ProviderError on a non-ok response', async () => {
    const { fetchImpl } = routedFetch({
      [NVIDIA_ASR_BASE_URL]: { ok: false, status: 401, raw: 'bad key' },
    });
    const provider = new NvidiaTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    await expect(provider.transcribe(audio)).rejects.toBeInstanceOf(ProviderError);
  });

  it('classifies a thrown transport error', async () => {
    const { fetchImpl } = routedFetch({
      [NVIDIA_ASR_BASE_URL]: { throws: new Error('socket hang up') },
    });
    const provider = new NvidiaTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    await expect(provider.transcribe(audio)).rejects.toBeInstanceOf(ProviderError);
  });

  it('handles a response with no words gracefully (returns an empty transcript)', async () => {
    const { fetchImpl } = routedFetch({ [NVIDIA_ASR_BASE_URL]: { raw: JSON.stringify({}) } });
    const provider = new NvidiaTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    const result = await provider.transcribe(audio);
    expect(result).toEqual({ available: true, words: [] });
  });

  it('defaults the file mime type when the audio input has none', async () => {
    const { fetchImpl, calls } = routedFetch({
      [NVIDIA_ASR_BASE_URL]: { raw: JSON.stringify({ words: [] }) },
    });
    const provider = new NvidiaTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    await provider.transcribe({ bytes: new Uint8Array([1]), filename: 'clip.raw' });
    const file = calls[0]!.body.get('file') as Blob;
    expect(file.type).toBe('application/octet-stream');
  });

  it('forwards a caller-supplied abort signal', async () => {
    const seenInit: RequestInit[] = [];
    const fetchImpl: AudioFetchLike = async (_url, init) => {
      seenInit.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ words: [] }) };
    };
    const provider = new NvidiaTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    const controller = new AbortController();
    await provider.transcribe(audio, controller.signal);
    expect(seenInit[0]!.signal).toBe(controller.signal);
  });

  it('sendsAudioOffDevice is true (hosted, opt-in disclosure)', () => {
    const provider = new NvidiaTranscriptionProvider({ apiKey: 'k' });
    expect(provider.sendsAudioOffDevice).toBe(true);
    expect(provider.name).toBe('nvidia');
  });

  describe('comma-separated key failover', () => {
    /** A fetch that fails the first N attempts with `status`, then succeeds. */
    function failingThenOk(failCount: number, status: number) {
      const authHeaders: string[] = [];
      let attempts = 0;
      const fetchImpl: AudioFetchLike = async (_url, init) => {
        authHeaders.push(init.headers['authorization'] ?? '');
        attempts += 1;
        if (attempts <= failCount) {
          return { ok: false, status, text: async () => 'nope' };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ words: [] }) };
      };
      return { fetchImpl, authHeaders };
    }

    it('rotates to the next key when the first is rate-limited (429), then succeeds', async () => {
      const { fetchImpl, authHeaders } = failingThenOk(1, 429);
      const provider = new NvidiaTranscriptionProvider({ apiKey: 'k1, k2' }, fetchImpl);
      const result = await provider.transcribe(audio);
      expect(result.available).toBe(true);
      expect(authHeaders).toEqual(['Bearer k1', 'Bearer k2']);
    });

    it('rotates past a revoked key (401) to a working one', async () => {
      const { fetchImpl, authHeaders } = failingThenOk(1, 401);
      const provider = new NvidiaTranscriptionProvider({ apiKey: 'dead,live' }, fetchImpl);
      await provider.transcribe(audio);
      expect(authHeaders).toEqual(['Bearer dead', 'Bearer live']);
    });

    it('does NOT rotate on a 400 bad request (same result on every key)', async () => {
      let attempts = 0;
      const fetchImpl: AudioFetchLike = async () => {
        attempts += 1;
        return { ok: false, status: 400, text: async () => 'bad' };
      };
      const provider = new NvidiaTranscriptionProvider({ apiKey: 'k1,k2,k3' }, fetchImpl);
      await expect(provider.transcribe(audio)).rejects.toBeInstanceOf(ProviderError);
      expect(attempts).toBe(1); // failed fast, never tried k2/k3
    });

    it('throws the last error when every key fails', async () => {
      const { fetchImpl, authHeaders } = failingThenOk(5, 429);
      const provider = new NvidiaTranscriptionProvider({ apiKey: 'k1,k2' }, fetchImpl);
      await expect(provider.transcribe(audio)).rejects.toBeInstanceOf(ProviderError);
      expect(authHeaders).toEqual(['Bearer k1', 'Bearer k2']); // exhausted the ring
    });

    it('de-duplicates and trims keys before rotating', async () => {
      const { fetchImpl, authHeaders } = failingThenOk(1, 429);
      const provider = new NvidiaTranscriptionProvider({ apiKey: ' k1 , k1 , k2 ' }, fetchImpl);
      await provider.transcribe(audio);
      expect(authHeaders).toEqual(['Bearer k1', 'Bearer k2']);
    });
  });
});
