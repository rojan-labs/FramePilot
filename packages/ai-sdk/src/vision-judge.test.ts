import { describe, expect, it } from 'vitest';
import type { AiCompletionRequest, AiProvider } from './providers/types.js';
import { createProviderVisionJudge } from './vision-judge.js';

describe('createProviderVisionJudge', () => {
  it('sends one bounded multimodal request and parses a fenced verdict', async () => {
    let request: AiCompletionRequest | undefined;
    const provider: AiProvider = {
      name: 'mock',
      modelId: 'vision-test',
      complete: async (value) => {
        request = value;
        return {
          text: '```json\n{"verdict":"pass","reason":"The subject remains visible."}\n```',
        };
      },
    };
    const judge = createProviderVisionJudge(provider);
    await expect(
      judge({
        objective: 'Does the subject remain framed?',
        frames: [{ frame: 12, imageBase64: 'AAEC', mediaType: 'image/jpeg' }],
      }),
    ).resolves.toEqual({ verdict: 'pass', reason: 'The subject remains visible.' });
    expect(request?.tools).toBeUndefined();
    expect(request?.maxTokens).toBe(300);
    expect(request?.messages[1]?.images).toEqual([
      {
        mediaType: 'image/jpeg',
        base64: 'AAEC',
        label: 'composited timeline frame 12',
      },
    ]);
  });

  it('does not repair malformed model output', async () => {
    const provider: AiProvider = {
      name: 'mock',
      complete: async () => ({ text: 'looks good' }),
    };
    await expect(
      createProviderVisionJudge(provider)({
        objective: 'Question',
        frames: [{ frame: 0, imageBase64: 'AAEC', mediaType: 'image/png' }],
      }),
    ).rejects.toThrow();
  });
});
