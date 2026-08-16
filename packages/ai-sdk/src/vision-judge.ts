/** One-shot multimodal judge for declared semantic edit objectives. */
import type { AiProvider } from './providers/types.js';
import type { VisionJudge } from './vision-review.js';

export const VISION_JUDGE_PROMPT_VERSION = 'vision-objective-v1' as const;

const SYSTEM_PROMPT = `You are FramePilot's bounded semantic edit reviewer.
Judge only the declared visual objective from the attached composited timeline frames.
Do not override measurements, infer unseen moments, or assume intent not stated in the objective.
Return exactly one JSON object: {"verdict":"pass"|"fail"|"cannot_tell","reason":"one concrete sentence","frame":optional integer}.
Use cannot_tell when the frames do not visibly settle the question.`;

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  return JSON.parse(unfenced);
}

/** Create a single-call judge; reviewVisionObjectives validates the returned verdict strictly. */
export function createProviderVisionJudge(
  provider: AiProvider,
  signal?: AbortSignal,
): VisionJudge {
  return async ({ objective, frames }) => {
    const response = await provider.complete(
      {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              `Objective: ${objective}`,
              ...frames.map((frame) => `Attached frame ${frame.frame}.`),
            ].join('\n'),
            images: frames.map((frame) => ({
              mediaType: frame.mediaType,
              base64: frame.imageBase64,
              label: `composited timeline frame ${frame.frame}`,
            })),
          },
        ],
        temperature: 0,
        maxTokens: 300,
      },
      signal,
    );
    return parseJsonObject(response.text);
  };
}
