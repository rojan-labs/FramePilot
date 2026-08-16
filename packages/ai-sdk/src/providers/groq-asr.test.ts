/**
 * Tests for the hosted Groq ASR provider: multipart request shape, bearer auth,
 * word-level response parsing, and the honest-unavailable/error-classification
 * contract — all with an injected `AudioFetchLike`, no network.
 */
import { describe, expect, it } from 'vitest';
import { GROQ_BASE_URL } from './provider-defaults.js';
import { GroqTranscriptionProvider, type AudioFetchLike } from './groq-asr.js';
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

describe('GroqTranscriptionProvider', () => {
  it('POSTs a multipart request with the bearer key, model, and word granularity', async () => {
    const wordsJson = JSON.stringify({
      words: [
        { word: 'hello', start: 0, end: 0.4 },
        { word: 'world', start: 0.4, end: 0.9 },
      ],
    });
    const { fetchImpl, calls } = routedFetch({ [GROQ_BASE_URL]: { raw: wordsJson } });
    const provider = new GroqTranscriptionProvider({ apiKey: 'gsk-x' }, fetchImpl);
    const result = await provider.transcribe(audio);

    expect(result).toEqual({
      available: true,
      words: [
        { word: 'hello', start: 0, end: 0.4 },
        { word: 'world', start: 0.4, end: 0.9 },
      ],
    });
    const call = calls[0]!;
    expect(call.url).toBe(`${GROQ_BASE_URL}/audio/transcriptions`);
    expect(call.headers['authorization']).toBe('Bearer gsk-x');
    expect(call.body.get('model')).toBe('whisper-large-v3');
    expect(call.body.get('response_format')).toBe('verbose_json');
    expect(call.body.get('timestamp_granularities[]')).toBe('word');
    expect(call.body.get('file')).toBeInstanceOf(Blob);
  });

  it('honours a configured model and base URL', async () => {
    const { fetchImpl, calls } = routedFetch({
      'https://custom.groq.example': { raw: JSON.stringify({ words: [] }) },
    });
    const provider = new GroqTranscriptionProvider(
      { apiKey: 'k', model: 'whisper-large-v3-turbo', baseUrl: 'https://custom.groq.example' },
      fetchImpl,
    );
    await provider.transcribe(audio);
    expect(calls[0]!.url).toBe('https://custom.groq.example/audio/transcriptions');
    expect(calls[0]!.body.get('model')).toBe('whisper-large-v3-turbo');
  });

  it('reports a missing API key as honest-unavailable, not a throw', async () => {
    const { fetchImpl, calls } = routedFetch({ [GROQ_BASE_URL]: { raw: '{}' } });
    const provider = new GroqTranscriptionProvider({}, fetchImpl);
    const result = await provider.transcribe(audio);
    expect(result).toEqual({
      available: false,
      reason: expect.stringContaining('GROQ_API_KEY is not configured'),
    });
    expect(calls).toHaveLength(0); // never even attempts the request
  });

  it('throws a classified ProviderError on a non-ok response', async () => {
    const { fetchImpl } = routedFetch({
      [GROQ_BASE_URL]: { ok: false, status: 401, raw: 'bad key' },
    });
    const provider = new GroqTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    await expect(provider.transcribe(audio)).rejects.toBeInstanceOf(ProviderError);
  });

  it('classifies a thrown transport error', async () => {
    const { fetchImpl } = routedFetch({ [GROQ_BASE_URL]: { throws: new Error('socket hang up') } });
    const provider = new GroqTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    await expect(provider.transcribe(audio)).rejects.toBeInstanceOf(ProviderError);
  });

  it('handles a response with no words gracefully (returns an empty transcript)', async () => {
    const { fetchImpl } = routedFetch({ [GROQ_BASE_URL]: { raw: JSON.stringify({}) } });
    const provider = new GroqTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    const result = await provider.transcribe(audio);
    expect(result).toEqual({ available: true, words: [] });
  });

  it('falls back to a generic mime type when none is given', async () => {
    const { fetchImpl, calls } = routedFetch({
      [GROQ_BASE_URL]: { raw: JSON.stringify({ words: [] }) },
    });
    const provider = new GroqTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    await provider.transcribe({ bytes: new Uint8Array([1]), filename: 'x.bin' });
    const file = calls[0]!.body.get('file') as Blob;
    expect(file.type).toBe('application/octet-stream');
  });

  it('threads an AbortSignal into fetch when given', async () => {
    const { fetchImpl } = routedFetch({ [GROQ_BASE_URL]: { raw: JSON.stringify({ words: [] }) } });
    const provider = new GroqTranscriptionProvider({ apiKey: 'k' }, fetchImpl);
    const controller = new AbortController();
    await provider.transcribe(audio, controller.signal);
  });

  it('sendsAudioOffDevice is true (hosted, opt-in disclosure)', () => {
    const provider = new GroqTranscriptionProvider({ apiKey: 'k' });
    expect(provider.sendsAudioOffDevice).toBe(true);
    expect(provider.name).toBe('groq');
  });
});
