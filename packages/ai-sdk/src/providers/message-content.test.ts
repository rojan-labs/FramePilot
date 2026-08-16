/**
 * Tests for multimodal message serialization (`message-content.ts`).
 *
 * The invariant worth guarding is the DEGRADE rule: a message with no images must
 * serialize byte-identically to how it did before images existed (a plain string on the
 * shapes that accept one), because every existing prompt-cache key, fixture and golden
 * snapshot depends on that. The second is that `content` always carries the text, so a
 * text-only model answers from the description rather than receiving an empty message.
 */
import { describe, expect, it } from 'vitest';
import { anthropicContent, googleParts, openAiContent } from './message-content.js';
import type { AiImage, AiMessage } from './types.js';

const frame: AiImage = {
  mediaType: 'image/jpeg',
  base64: 'AAECAw==',
  label: 'the timeline at 12.40s',
};

const text: AiMessage = { role: 'user', content: 'Check the captions.' };
const withImage: AiMessage = { ...text, images: [frame] };

describe('anthropicContent', () => {
  it('returns a plain string when there are no images', () => {
    expect(anthropicContent(text)).toBe('Check the captions.');
    // An EMPTY array must not turn a string body into a one-element block array.
    expect(anthropicContent({ ...text, images: [] })).toBe('Check the captions.');
  });

  it('puts the text first, then a base64 image block per image', () => {
    expect(anthropicContent(withImage)).toEqual([
      { type: 'text', text: 'Check the captions.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAECAw==' } },
    ]);
  });

  it('never attaches images to a system message', () => {
    // No provider accepts image content in a system prompt.
    expect(anthropicContent({ role: 'system', content: 'rules', images: [frame] })).toBe('rules');
  });
});

describe('openAiContent', () => {
  it('returns a plain string when there are no images', () => {
    expect(openAiContent(text)).toBe('Check the captions.');
  });

  it('sends the bytes inline as a data: URI, never a hosted URL', () => {
    // The frames are rendered from the user's own local media — there is no public URL
    // for them, and inventing one would mean uploading their footage.
    expect(openAiContent(withImage)).toEqual([
      { type: 'text', text: 'Check the captions.' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAECAw==' } },
    ]);
  });
});

describe('googleParts', () => {
  it('is always an array — Gemini has no string shorthand', () => {
    expect(googleParts(text)).toEqual([{ text: 'Check the captions.' }]);
  });

  it('appends an inlineData part per image', () => {
    expect(googleParts(withImage)).toEqual([
      { text: 'Check the captions.' },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAECAw==' } },
    ]);
  });
});

describe('every shape', () => {
  it('always carries the text, so a model that ignores images still has the question', () => {
    const multi: AiMessage = {
      role: 'user',
      content: 'Two frames attached.',
      images: [frame, { mediaType: 'image/png', base64: 'BBBB' }],
    };
    for (const parts of [
      anthropicContent(multi),
      openAiContent(multi),
      googleParts(multi),
    ] as readonly (string | readonly unknown[])[]) {
      expect(Array.isArray(parts)).toBe(true);
      expect(JSON.stringify(parts)).toContain('Two frames attached.');
      // One text part plus one part per image, in order.
      expect((parts as readonly unknown[]).length).toBe(3);
    }
  });
});
