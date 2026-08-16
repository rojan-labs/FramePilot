import { describe, expect, it } from 'vitest';
import type { AssembledSection } from '../../context-builder.js';
import {
  type ContextManifest,
  type ManifestInput,
  buildManifest,
  buildRequestManifest,
  diffManifests,
  effectiveInputTokens,
  withProviderUsage,
} from './manifest.js';

const sections: AssembledSection[] = [
  { tier: 'system', label: 'system contract', tokenEstimate: 1_200, included: true },
  { tier: 'timeline', label: 'timeline summary', tokenEstimate: 800, included: true },
  { tier: 'transcript', label: 'transcript slice', tokenEstimate: 5_000, included: false },
  { tier: 'prompt', label: 'user request', tokenEstimate: 40, included: true },
];

function input(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    requestId: 'req_1',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    contextWindow: 1_000_000,
    windowSource: 'known_model',
    reservedOutputTokens: 128_000,
    sections,
    estimatedInputTokens: 2_040,
    droppedTokenEstimate: 5_000,
    ...overrides,
  };
}

describe('buildManifest', () => {
  it('itemises every section and marks a dropped one with its reason', () => {
    const manifest = buildManifest(input());
    const transcript = manifest.sections.find((s) => s.label === 'transcript slice');
    expect(transcript).toMatchObject({
      included: false,
      type: 'retrieved_evidence',
      omittedReason: 'trimmed to fit the model context budget',
    });
    expect(manifest.sections.find((s) => s.label === 'user request')).toMatchObject({
      included: true,
      type: 'latest_user_message',
    });
  });

  it('records compaction as a specific list of what went, not just a flag', () => {
    expect(buildManifest(input()).compaction).toEqual({
      occurred: true,
      removedTokenEstimate: 5_000,
      removedSections: ['transcript slice'],
    });
  });

  it('reports no compaction when nothing was trimmed', () => {
    const clean = buildManifest(
      input({
        sections: sections.map((s) => ({ ...s, included: true })),
        droppedTokenEstimate: 0,
      }),
    );
    expect(clean.compaction).toEqual({
      occurred: false,
      removedTokenEstimate: 0,
      removedSections: [],
    });
  });

  it('subtracts the output reservation from remaining capacity', () => {
    const manifest = buildManifest(input());
    // 1,000,000 window − 2,040 input − 128,000 reserved.
    expect(manifest.usage.estimatedRemainingCapacity).toBe(869_960);
  });

  it('never reports negative remaining capacity when the prompt overflows', () => {
    const manifest = buildManifest(
      input({ contextWindow: 8_000, reservedOutputTokens: 4_000, estimatedInputTokens: 9_000 }),
    );
    expect(manifest.usage.estimatedRemainingCapacity).toBe(0);
  });

  it('flags an assumed limit so the UI never presents a floor as the real window', () => {
    expect(buildManifest(input({ windowSource: 'provider_default' })).usage.limitAssumed).toBe(
      true,
    );
    expect(buildManifest(input()).usage.limitAssumed).toBe(false);
  });

  it('starts as a local estimate with no provider-reported figures', () => {
    const usage = buildManifest(input()).usage;
    expect(usage.calculationSource).toBe('local_estimate');
    expect(usage.providerReportedInputTokens).toBeUndefined();
  });

  it('adds tool schemas as their own section — real prompt cost the assembler cannot see', () => {
    const manifest = buildManifest(input({ toolSchemaTokens: 3_500 }));
    expect(manifest.sections.at(-1)).toMatchObject({
      type: 'tool_schemas',
      label: 'tool definitions',
      tokenEstimate: 3_500,
      included: true,
    });
  });

  it('omits a zero-cost tool-schema section rather than showing an empty row', () => {
    const manifest = buildManifest(input({ toolSchemaTokens: 0 }));
    expect(manifest.sections.some((s) => s.type === 'tool_schemas')).toBe(false);
  });

  it('carries durable memory status so the UI can say memory survived a smaller prompt', () => {
    const manifest = buildManifest(
      input({
        memory: {
          runId: 'run_1',
          stage: 'apply',
          projectRevision: 4,
          objectiveKnown: true,
          committedDecisions: 3,
          facts: 11,
          evidenceHandles: 6,
          remainingObjectives: 1,
          nextAction: 'apply the committed cut list',
        },
      }),
    );
    expect(manifest.memory).toMatchObject({ stage: 'apply', committedDecisions: 3 });
  });

  it('omits memory entirely for a call made outside a run rather than faking one', () => {
    expect(buildManifest(input()).memory).toBeUndefined();
  });

  it('labels an unresolved provider and model on a payload-derived manifest too', () => {
    const manifest = buildRequestManifest({
      requestId: 'req_1',
      contextWindow: 32_768,
      windowSource: 'provider_default',
      reservedOutputTokens: 4_096,
      request: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(manifest.provider).toBe('unknown');
    expect(manifest.model).toBe('unknown');
    expect(manifest.usage.limitAssumed).toBe(true);
  });

  it('labels an unresolved provider and model rather than guessing', () => {
    const manifest = buildManifest(input({ provider: undefined, model: undefined }));
    expect(manifest.provider).toBe('unknown');
    expect(manifest.model).toBe('unknown');
  });
});

describe('withProviderUsage', () => {
  it('promotes the figure to provider-reported and keeps the estimate for comparison', () => {
    const settled = withProviderUsage(buildManifest(input()), { inputTokens: 2_310 });
    expect(settled.usage).toMatchObject({
      calculationSource: 'provider_reported',
      providerReportedInputTokens: 2_310,
      estimatedInputTokensBeforeSend: 2_040,
    });
  });

  it('re-derives remaining capacity from the reported input, not the estimate', () => {
    const settled = withProviderUsage(buildManifest(input()), { inputTokens: 2_310 });
    expect(settled.usage.estimatedRemainingCapacity).toBe(1_000_000 - 2_310 - 128_000);
  });

  it('stays an estimate when the provider reports no input usage', () => {
    const settled = withProviderUsage(buildManifest(input()), { outputTokens: 900 });
    expect(settled.usage.calculationSource).toBe('local_estimate');
    expect(settled.usage.providerReportedOutputTokens).toBe(900);
  });

  it('records cached and reasoning tokens when the provider reports them', () => {
    const settled = withProviderUsage(buildManifest(input()), {
      inputTokens: 2_310,
      cachedInputTokens: 1_800,
      reasoningTokens: 400,
    });
    expect(settled.usage).toMatchObject({ cachedInputTokens: 1_800, reasoningTokens: 400 });
  });

  it('does not mutate the manifest it was given', () => {
    const before = buildManifest(input());
    withProviderUsage(before, { inputTokens: 2_310 });
    expect(before.usage.calculationSource).toBe('local_estimate');
  });
});

describe('effectiveInputTokens', () => {
  it('prefers the reported figure and falls back to the estimate', () => {
    const estimateOnly = buildManifest(input());
    expect(effectiveInputTokens(estimateOnly)).toBe(2_040);
    expect(effectiveInputTokens(withProviderUsage(estimateOnly, { inputTokens: 2_310 }))).toBe(
      2_310,
    );
  });
});

describe('diffManifests', () => {
  const before = buildManifest(input());
  const after: ContextManifest = buildManifest(
    input({
      requestId: 'req_2',
      estimatedInputTokens: 9_040,
      droppedTokenEstimate: 0,
      sections: [
        { tier: 'system', label: 'system contract', tokenEstimate: 1_200, included: true },
        { tier: 'timeline', label: 'timeline summary', tokenEstimate: 2_000, included: true },
        { tier: 'transcript', label: 'transcript slice', tokenEstimate: 5_000, included: true },
        { tier: 'skills', label: 'skills manifest', tokenEstimate: 800, included: true },
        { tier: 'prompt', label: 'user request', tokenEstimate: 40, included: true },
      ],
    }),
  );

  it('attributes the movement section by section', () => {
    const diff = diffManifests(before, after);
    const byLabel = new Map(diff.sections.map((s) => [s.label, s]));
    expect(byLabel.get('transcript slice')?.change).toBe('added');
    expect(byLabel.get('skills manifest')?.change).toBe('added');
    expect(byLabel.get('timeline summary')?.change).toBe('grew');
    expect(byLabel.get('system contract')?.change).toBe('unchanged');
  });

  it('reports a section that disappeared as removed', () => {
    const diff = diffManifests(after, before);
    expect(diff.sections.find((s) => s.label === 'skills manifest')?.change).toBe('removed');
  });

  it('pairs sections by label so an earlier drop does not shift every later one', () => {
    // `before` omits the transcript, so positional ids differ; pairing must still line
    // `user request` up with itself rather than with the section that took its slot.
    const diff = diffManifests(before, after);
    expect(diff.sections.find((s) => s.label === 'user request')).toMatchObject({
      change: 'unchanged',
      beforeTokens: 40,
      afterTokens: 40,
    });
  });

  it('reports the total input delta and whether the model changed', () => {
    const diff = diffManifests(before, after);
    expect(diff.inputTokenDelta).toBe(7_000);
    expect(diff.modelChanged).toBe(false);
    expect(
      diffManifests(before, buildManifest(input({ model: 'claude-haiku-4-5' }))).modelChanged,
    ).toBe(true);
  });
});

describe('buildRequestManifest', () => {
  const request = {
    messages: [
      { role: 'system' as const, content: 'x'.repeat(400) }, // 100 tokens
      { role: 'user' as const, content: 'y'.repeat(200) }, // 50
      { role: 'assistant' as const, content: 'z'.repeat(80) }, // 20
      { role: 'user' as const, content: 'w'.repeat(40) }, // 10
    ],
    tools: [{ name: 'trim', description: 'trim a clip', parameters: {} }],
  };
  const base = {
    requestId: 'req_1',
    provider: 'anthropic' as const,
    model: 'claude-opus-4-8',
    contextWindow: 1_000_000,
    windowSource: 'known_model' as const,
    reservedOutputTokens: 128_000,
    request,
  };

  it('itemises a payload the assembler never produced, so agent calls are accounted for', () => {
    const manifest = buildRequestManifest(base);
    expect(manifest.sections.map((s) => ({ label: s.label, type: s.type }))).toEqual([
      { label: 'system contract', type: 'system' },
      { label: 'user turn 1', type: 'conversation' },
      { label: 'assistant turn 2', type: 'conversation' },
      { label: 'user request', type: 'latest_user_message' },
      { label: 'tool definitions', type: 'tool_schemas' },
    ]);
  });

  it('counts tool schemas as real prompt cost', () => {
    const withTools = buildRequestManifest(base);
    const withoutTools = buildRequestManifest({ ...base, request: { messages: request.messages } });
    expect(withTools.usage.estimatedInputTokensBeforeSend).toBeGreaterThan(
      withoutTools.usage.estimatedInputTokensBeforeSend,
    );
    expect(withoutTools.sections.some((s) => s.type === 'tool_schemas')).toBe(false);
  });

  it('estimates input from the payload, so the total matches what is actually sent', () => {
    const manifest = buildRequestManifest(base);
    const expected = 100 + 50 + 20 + 10 + Math.ceil(JSON.stringify(request.tools).length / 4);
    expect(manifest.usage.estimatedInputTokensBeforeSend).toBe(expected);
  });

  it('reports no compaction for a payload-derived manifest — a trim leaves no trace', () => {
    expect(buildRequestManifest(base).compaction.occurred).toBe(false);
  });

  it('prefers the assembler account and can then report what compaction removed', () => {
    const manifest = buildRequestManifest({
      ...base,
      assembled: {
        sections: [
          { tier: 'system', label: 'system contract', tokenEstimate: 100, included: true },
          { tier: 'transcript', label: 'transcript slice', tokenEstimate: 900, included: false },
          { tier: 'prompt', label: 'user request', tokenEstimate: 80, included: true },
        ],
        droppedTokenEstimate: 900,
      },
    });
    expect(manifest.compaction).toMatchObject({
      occurred: true,
      removedTokenEstimate: 900,
      removedSections: ['transcript slice'],
    });
  });

  it('shows the unaccounted payload as its own row so the breakdown adds up', () => {
    // The caller assembled 180 tokens of blocks but sent 180 tokens of messages, so a
    // caller that appended tool turns afterwards must not silently under-report.
    const manifest = buildRequestManifest({
      ...base,
      assembled: {
        sections: [
          { tier: 'system', label: 'system contract', tokenEstimate: 100, included: true },
          { tier: 'prompt', label: 'user request', tokenEstimate: 10, included: true },
        ],
        droppedTokenEstimate: 0,
      },
    });
    const remainder = manifest.sections.find((s) => s.label === 'additional request content');
    // 180 message tokens − (100 + 10) already accounted for.
    expect(remainder?.tokenEstimate).toBe(70);
    const included = manifest.sections
      .filter((s) => s.included)
      .reduce((sum, s) => sum + s.tokenEstimate, 0);
    expect(included).toBe(manifest.usage.estimatedInputTokensBeforeSend);
  });

  it('adds no remainder row when the account already covers the payload', () => {
    const manifest = buildRequestManifest({
      ...base,
      assembled: {
        sections: [
          { tier: 'system', label: 'system contract', tokenEstimate: 500, included: true },
        ],
        droppedTokenEstimate: 0,
      },
    });
    expect(manifest.sections.some((s) => s.label === 'additional request content')).toBe(false);
  });

  it('skips empty messages rather than drawing a zero-token row', () => {
    const manifest = buildRequestManifest({
      ...base,
      request: { messages: [{ role: 'user' as const, content: '' }, ...request.messages] },
    });
    expect(manifest.sections.every((s) => s.tokenEstimate > 0)).toBe(true);
  });
});

describe('section taxonomy', () => {
  it('groups by kind of memory, not by the budgeter’s drop order', () => {
    const manifest = buildManifest(
      input({
        sections: [
          { tier: 'history', label: 'conversation history', tokenEstimate: 10, included: true },
          { tier: 'memory', label: 'project memory', tokenEstimate: 10, included: true },
          { tier: 'skills', label: 'skills manifest', tokenEstimate: 10, included: true },
          { tier: 'timeline', label: 'timeline summary', tokenEstimate: 10, included: true },
          { tier: 'transcript', label: 'transcript slice', tokenEstimate: 10, included: true },
          { tier: 'selection', label: 'selected range', tokenEstimate: 10, included: true },
          { tier: 'pinned', label: 'pinned context', tokenEstimate: 10, included: true },
          { tier: 'prompt', label: 'project header', tokenEstimate: 10, included: true },
          { tier: 'prompt', label: 'user request', tokenEstimate: 10, included: true },
          { tier: 'system', label: 'system contract', tokenEstimate: 10, included: true },
        ],
      }),
    );
    expect(manifest.sections.map((s) => [s.label, s.type])).toEqual([
      ['conversation history', 'conversation'],
      ['project memory', 'project_memory'],
      ['skills manifest', 'skill'],
      ['timeline summary', 'retrieved_evidence'],
      ['transcript slice', 'retrieved_evidence'],
      // A selection and a pin are the creator pointing at something in this request.
      ['selected range', 'latest_user_message'],
      ['pinned context', 'latest_user_message'],
      // A prompt-tier block that is NOT the request itself is scaffolding, not the ask.
      ['project header', 'system'],
      ['user request', 'latest_user_message'],
      ['system contract', 'system'],
    ]);
  });
});
