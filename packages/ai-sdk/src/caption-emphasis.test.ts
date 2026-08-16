import type { TranscriptWord } from '@framepilot/timeline-schema';
import { describe, expect, it } from 'vitest';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import {
  analyzeCaptionEmphasis,
  buildCaptionEmphasisPrompt,
  parseCaptionEmphasisResponse,
} from './caption-emphasis.js';

const transcript: readonly TranscriptWord[] = [
  { word: 'This', start: 0, end: 0.2 },
  { word: 'changes', start: 0.2, end: 0.55 },
  { word: 'everything!', start: 0.7, end: 1.5 },
  { word: 'in', start: 1.5, end: 1.65 },
  { word: '2026', start: 1.65, end: 2.1 },
];

class FakeProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public request: AiCompletionRequest | null = null;
  public constructor(private readonly response: AiResponse | Error) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.request = request;
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}

describe('caption emphasis AI contract', () => {
  it('builds a timing-aware, no-rewrite prompt', () => {
    const prompt = buildCaptionEmphasisPrompt(transcript);
    expect(prompt).toContain('emotional weight');
    expect(prompt).toContain('"start":0.7');
    expect(prompt).toContain('Do not rewrite');
  });

  it('includes ASR confidence in the prompt when the transcript reports it', () => {
    const withConfidence: readonly TranscriptWord[] = [
      { word: 'certain', start: 0, end: 0.3, confidence: 0.42 },
    ];
    expect(buildCaptionEmphasisPrompt(withConfidence)).toContain('"confidence":0.42');
  });

  it('skips an invalid candidate and a duplicate before accepting later unique matches', () => {
    // A longer transcript raises the density cap above 1 so the loop keeps
    // going past the first candidate instead of breaking immediately.
    const longer: readonly TranscriptWord[] = Array.from({ length: 20 }, (_, i) => ({
      word: `word${i}`,
      start: i,
      end: i + 0.5,
    }));
    const result = parseCaptionEmphasisResponse(
      JSON.stringify({ keywords: ['invented', 'word1', 'WORD1', 'word2'] }),
      longer,
    );
    expect(result).toEqual({ keywords: ['word1', 'word2'], source: 'ai' });
  });

  it('returns null when every requested keyword is invented or a duplicate', () => {
    expect(
      parseCaptionEmphasisResponse(JSON.stringify({ keywords: ['invented'] }), transcript),
    ).toBeNull();
  });

  it('accepts JSON fences/prose but keeps only unique transcript words within the density cap', () => {
    expect(
      parseCaptionEmphasisResponse(
        '```json\n{"keywords":["everything","invented","EVERYTHING","2026"],"rationale":"Payoff"}\n```',
        transcript,
      ),
    ).toEqual({ keywords: ['everything'], source: 'ai', rationale: 'Payoff' });
  });

  it('returns null for text with brace delimiters but invalid JSON inside', () => {
    expect(parseCaptionEmphasisResponse('{keywords: not valid json}', transcript)).toBeNull();
  });

  it('calls the provider with a low-temperature validated contract', async () => {
    const provider = new FakeProvider({
      text: '{"keywords":["everything"],"rationale":"The core payoff."}',
    });
    await expect(analyzeCaptionEmphasis(provider, transcript)).resolves.toEqual({
      keywords: ['everything'],
      source: 'ai',
      rationale: 'The core payoff.',
    });
    expect(provider.request?.temperature).toBe(0.1);
    expect(provider.request?.maxTokens).toBe(512);
  });

  it('falls back deterministically on malformed output or provider failure', async () => {
    const malformed = await analyzeCaptionEmphasis(
      new FakeProvider({ text: 'not json' }),
      transcript,
    );
    const failed = await analyzeCaptionEmphasis(new FakeProvider(new Error('offline')), transcript);
    expect(malformed.source).toBe('fallback');
    expect(failed).toEqual(malformed);
    expect(malformed.keywords.length).toBeGreaterThan(0);
  });

  it('skips the provider call entirely for an empty transcript', async () => {
    const provider = new FakeProvider({ text: '{"keywords":["x"]}' });
    const result = await analyzeCaptionEmphasis(provider, []);
    expect(result).toEqual({ keywords: [], source: 'fallback', rationale: expect.any(String) });
    expect(provider.request).toBeNull();
  });

  it('stringifies a thrown non-Error value from the provider', async () => {
    const throwsString: AiProvider = {
      name: 'mock',
      complete: () => Promise.reject('offline string'),
    };
    await expect(analyzeCaptionEmphasis(throwsString, transcript)).resolves.toMatchObject({
      source: 'fallback',
    });
  });
});
