/** Provider-backed semantic emphasis for professional captions. */
import { autoEmphasisKeywords } from '@framepilot/editor-core';
import { createLogger } from '@framepilot/shared-types';
import type { TranscriptWord } from '@framepilot/timeline-schema';
import { z } from 'zod/v4';
import type { AiProvider } from './providers/types.js';

const log = createLogger('ai-sdk:caption-emphasis');

export const CaptionEmphasisResponseSchema = z
  .object({
    keywords: z.array(z.string().trim().min(1)).min(1).max(12),
    rationale: z.string().trim().max(500).optional(),
  })
  .strict();

export interface CaptionEmphasisAnalysis {
  readonly keywords: readonly string[];
  readonly source: 'ai' | 'fallback';
  readonly rationale?: string;
}

const normalizedWord = (word: string): string =>
  word
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

function keywordLimit(transcript: readonly TranscriptWord[]): number {
  return Math.max(1, Math.min(12, Math.ceil(transcript.length * 0.16)));
}

/** Compact structured prompt; transcript timing preserves delivery evidence. */
export function buildCaptionEmphasisPrompt(transcript: readonly TranscriptWord[]): string {
  const words = transcript.map(({ word, start, end, confidence }) => ({
    word,
    start,
    end,
    ...(confidence === undefined ? {} : { confidence }),
  }));
  return [
    'Act as a professional short-form caption editor.',
    'Select only the sparse anchor words that deserve visual emphasis.',
    'Use sentence meaning, emotional weight, contrast, novelty, spoken duration, pauses, numbers, and payoff words.',
    'Avoid filler, repeated function words, adjacent highlights, and highlighting more than about 16% of the transcript.',
    'Return strict JSON only: {"keywords":["exact transcript word"],"rationale":"one short sentence"}.',
    'Every keyword must exactly occur in the transcript. Do not rewrite the transcript.',
    `Transcript words with seconds: ${JSON.stringify(words)}`,
  ].join('\n');
}

function jsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Validate and constrain untrusted model output to words in the transcript. */
export function parseCaptionEmphasisResponse(
  text: string,
  transcript: readonly TranscriptWord[],
): CaptionEmphasisAnalysis | null {
  const parsed = CaptionEmphasisResponseSchema.safeParse(jsonObject(text));
  if (!parsed.success) return null;
  const vocabulary = new Map<string, string>();
  for (const entry of transcript) {
    const key = normalizedWord(entry.word);
    if (key !== '' && !vocabulary.has(key)) {
      vocabulary.set(key, entry.word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    }
  }
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed.data.keywords) {
    const key = normalizedWord(candidate);
    const exact = vocabulary.get(key);
    if (!exact || seen.has(key)) continue;
    seen.add(key);
    keywords.push(exact);
    if (keywords.length >= keywordLimit(transcript)) break;
  }
  if (keywords.length === 0) return null;
  return {
    keywords,
    source: 'ai',
    ...(parsed.data.rationale ? { rationale: parsed.data.rationale } : {}),
  };
}

export function fallbackCaptionEmphasis(
  transcript: readonly TranscriptWord[],
): CaptionEmphasisAnalysis {
  return {
    keywords: autoEmphasisKeywords(transcript),
    source: 'fallback',
    rationale: 'Used local delivery and readability analysis because AI analysis was unavailable.',
  };
}

/** Call the configured model; malformed or failed output degrades truthfully. */
export async function analyzeCaptionEmphasis(
  provider: AiProvider,
  transcript: readonly TranscriptWord[],
  signal?: AbortSignal,
): Promise<CaptionEmphasisAnalysis> {
  if (transcript.length === 0) return fallbackCaptionEmphasis(transcript);
  try {
    log.action('analyzeCaptionEmphasis', { provider: provider.name, words: transcript.length });
    const response = await provider.complete(
      {
        messages: [
          { role: 'system', content: 'You produce schema-constrained caption emphasis decisions.' },
          { role: 'user', content: buildCaptionEmphasisPrompt(transcript) },
        ],
        temperature: 0.1,
        maxTokens: 512,
      },
      signal,
    );
    const result = parseCaptionEmphasisResponse(response.text, transcript);
    if (result) return result;
    log.warn('Caption emphasis model response failed validation; using local fallback.');
  } catch (error) {
    log.warn('Caption emphasis provider failed; using local fallback.', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return fallbackCaptionEmphasis(transcript);
}
