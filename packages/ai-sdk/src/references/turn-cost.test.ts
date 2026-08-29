/**
 * A reference costs no model calls (plan/system-mission P3.4).
 *
 * Half of P3.4's done-when is a rubric row that needs a billed provider and the desktop
 * host. The other half is a claim about cost, and that one is decidable here: "the model
 * call count for a turn with a reference attached is ≤ the same turn without one + 0",
 * because the analysis is a sidecar job and the profile enters the prompt as text.
 *
 * It is worth pinning rather than assuming. The tempting implementations of this feature
 * — ask the model what the reference is for, or send it the frames — would both spend a
 * turn per attachment, and neither would look wrong in a diff. This test fails the moment
 * one of them appears.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import { makeProject } from '../__fixtures__/project.js';
import { buildReferenceProfile } from './profile.js';

const fastCut = buildReferenceProfile({
  id: 'ref_1',
  role: 'pacing',
  kind: 'video',
  fileName: 'fast-cut-vertical.mp4',
  contentHash: 'abcdef0123456789',
  analyzedAt: '2026-08-29T00:00:00Z',
  video: {
    durationS: 20,
    shotCount: 25,
    medianShotS: 0.891667,
    shotLengthP10S: 0.575,
    shotLengthP90S: 0.908,
    cutsPerMinute: 72,
    music: { bpm: 86.1, beatCount: 29 },
  },
});

async function runTurn(withReference: boolean): Promise<{ calls: number; prompt: string }> {
  let calls = 0;
  const messages: string[] = [];
  const provider = {
    name: 'mock' as const,
    async complete(request: { messages: { role: string; content: string }[] }) {
      calls += 1;
      for (const message of request.messages) messages.push(message.content);
      return { text: 'Done.', toolCalls: [] };
    },
  };
  for await (const _event of new Orchestrator(provider as never).streamAgent(
    {
      project: makeProject(),
      userPrompt: 'tighten the middle',
      ...(withReference ? { references: [fastCut] } : {}),
    },
    { conversationId: 'conv_cost', turnId: 'turn_cost', now: () => 1_000 },
    { maxSteps: 1 },
  )) {
    // Drain the stream; the count is what matters.
  }
  return { calls, prompt: messages.join('\n') };
}

describe('attaching a reference does not buy a model call', () => {
  it('spends exactly as many model calls as the same turn with nothing attached', async () => {
    const bare = await runTurn(false);
    const withReference = await runTurn(true);

    expect(withReference.calls).toBe(bare.calls);
    // …and the reference did reach the model, so the equality above is not the equality
    // of two turns that both ignored it.
    expect(withReference.prompt).toContain('fast-cut-vertical.mp4');
    expect(withReference.prompt).toContain('median shot 0.9s');
    expect(bare.prompt).not.toContain('fast-cut-vertical.mp4');
  });
});
