/**
 * Durable effect records must stay bounded.
 *
 * The regression these guard: recording the raw {@link RuntimeEffect} put the whole
 * project — including its unbounded `history` of inverse patches — into the WAL, the
 * main-process cache, and every renderer's IPC inbox, once per tool call.
 */
import { describe, expect, it } from 'vitest';
import type { EffectResult, RuntimeEffect } from '@framepilot/ai-sdk';
import { JsonValueSchema, createAnalysisBudget } from '@framepilot/ai-sdk';
import {
  MAX_DURABLE_EFFECT_FIELD_CHARS,
  boundedJson,
  describeEffectResult,
  describeRuntimeEffect,
} from './effect-record.js';

/** A project whose history dwarfs its content, exactly as a long editing session builds. */
function hugeProject(historyBytes: number): Record<string, unknown> {
  return {
    id: 'project_1',
    name: 'Demo',
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video' }],
    timeline: { revision: 42, tracks: [] },
    transcript: [],
    history: [{ patch: { operations: ['x'.repeat(historyBytes)] }, inverse: {}, committedAt: 1 }],
  };
}

const hostTool = (historyBytes: number): RuntimeEffect =>
  ({
    kind: 'host_tool',
    call: { id: 'call_1', name: 'analyze_silence', arguments: { track: 'video_1' } },
    project: hugeProject(historyBytes),
  }) as unknown as RuntimeEffect;

describe('describeRuntimeEffect', () => {
  it('records a host tool by identity and revision, never the project document', () => {
    const described = describeRuntimeEffect(hostTool(5_000_000)) as Record<string, unknown>;

    expect(described['kind']).toBe('host_tool');
    expect(described['call']).toEqual({
      id: 'call_1',
      name: 'analyze_silence',
      arguments: { track: 'video_1' },
    });
    expect(described['project']).toEqual({ id: 'project_1', revision: 42 });
    // The whole point: a 5 MB history cannot reach the durable log through this record.
    expect(JSON.stringify(described)).not.toContain('xxxx');
    expect(JSON.stringify(described).length).toBeLessThan(1_000);
  });

  it('records the analysis budget as plain JSON, never the stateful handle', () => {
    const effect = {
      ...(hostTool(10) as unknown as Record<string, unknown>),
      analysisBudget: createAnalysisBudget({ maxTranscriptionMinutes: 5 }),
    } as unknown as RuntimeEffect;

    const described = describeRuntimeEffect(effect);

    // The regression: `spend`/`check`/`record` are FUNCTIONS. Recording the handle put
    // them in the durable record and `JsonValueSchema.parse` then aborted the run.
    expect(() => JsonValueSchema.parse(described)).not.toThrow();
    expect((described as Record<string, unknown>)['analysisBudget']).toEqual({
      caps: { maxFfmpegSeconds: 900, maxTranscriptionMinutes: 5 },
      spend: { ffmpegSeconds: 0, transcriptionMinutes: 0 },
    });
  });

  it('bounds tool arguments that are themselves oversized', () => {
    const effect = {
      kind: 'host_tool',
      call: { id: 'c', name: 'add_captions', arguments: { words: 'w'.repeat(200_000) } },
      project: hugeProject(10),
    } as unknown as RuntimeEffect;

    const call = (describeRuntimeEffect(effect) as Record<string, Record<string, unknown>>)[
      'call'
    ]!;
    expect(call['arguments']).toMatchObject({ omitted: true });
  });

  it('records a model call by shape, never by prompt content', () => {
    const effect = {
      kind: 'model',
      tier: 'mid',
      request: {
        model: 'claude-opus-5',
        messages: [
          { role: 'system', content: 'SECRET-SYSTEM-PROMPT' },
          { role: 'user', content: 'hello' },
        ],
        tools: [{ name: 'a' }, { name: 'b' }],
      },
    } as unknown as RuntimeEffect;

    const described = describeRuntimeEffect(effect) as Record<string, unknown>;
    expect(described).toEqual({
      kind: 'model',
      tier: 'mid',
      request: { messageCount: 2, toolCount: 2, promptChars: 25, model: 'claude-opus-5' },
    });
    expect(JSON.stringify(described)).not.toContain('SECRET-SYSTEM-PROMPT');
  });

  it('keeps a structured effect’s control block verbatim and bounds its payload', () => {
    const control = {
      effectId: 'e1',
      taskId: 't1',
      idempotencyKey: 'k1',
      resourceClass: 'cpu',
      timeoutMs: 1_000,
      retryClass: 'never',
      sideEffectClass: 'pure',
    };
    const effect = {
      kind: 'patch_validate',
      control,
      projectId: 'project_1',
      patch: { operations: Array.from({ length: 20_000 }, () => 'op') },
    } as unknown as RuntimeEffect;

    const described = describeRuntimeEffect(effect) as Record<string, unknown>;
    expect(described['control']).toEqual(control);
    expect(described['projectId']).toBe('project_1');
    expect(described['patch']).toMatchObject({ omitted: true });
  });
});

describe('describeEffectResult', () => {
  it('summarises a host tool outcome and counts images instead of carrying them', () => {
    const result = {
      kind: 'host_tool',
      cached: false,
      outcome: {
        status: 'completed',
        summary: 'Found 12 silences',
        data: { silences: 12 },
        images: [{ mediaType: 'image/png', base64: 'A'.repeat(4_000_000), label: 'frame' }],
      },
    } as unknown as EffectResult;

    const described = describeEffectResult(result) as Record<string, unknown>;
    expect(described).toEqual({
      kind: 'host_tool',
      cached: false,
      status: 'completed',
      summary: 'Found 12 silences',
      imageCount: 1,
      data: { silences: 12 },
    });
    expect(JSON.stringify(described)).not.toContain('AAAA');
  });

  it('records WHY a host refused, when the host said why', () => {
    // `refusalCause` is the discriminator the orchestrator's repeat guard keys on, so a WAL
    // that drops it shows only THAT a call was refused twice and never that the second was
    // recognised as the first. Run `369e8c82` was diagnosed from records of this kind — a
    // run nobody watched — and every behaviour has to be readable from the logs alone.
    const result = {
      kind: 'host_tool',
      cached: false,
      outcome: {
        status: 'failed',
        summary: 'That span (2.0s–6.0s) is already picture on the timeline.',
        refusalCause: 'picture_over_picture',
      },
    } as unknown as EffectResult;

    expect(describeEffectResult(result)).toEqual({
      kind: 'host_tool',
      cached: false,
      status: 'failed',
      summary: 'That span (2.0s–6.0s) is already picture on the timeline.',
      refusalCause: 'picture_over_picture',
    });
  });

  it('omits the cause entirely when the host declared none', () => {
    // An undeclared host failure is never keyed, and the record must not imply it was.
    const result = {
      kind: 'host_tool',
      cached: false,
      outcome: { status: 'failed', summary: 'Stock provider is unreachable right now.' },
    } as unknown as EffectResult;

    expect(describeEffectResult(result)).not.toHaveProperty('refusalCause');
  });

  it('records a streamed model result by chunk count, not by its chunks', () => {
    const result = {
      kind: 'model_stream',
      cached: false,
      chunks: Array.from({ length: 5_000 }, (_, index) => ({
        type: 'text-delta',
        text: `token ${String(index)}`,
      })),
    } as unknown as EffectResult;

    expect(describeEffectResult(result)).toEqual({
      kind: 'model_stream',
      cached: false,
      chunkCount: 5_000,
    });
  });
});

describe('boundedJson', () => {
  it('passes a value through untouched when it fits', () => {
    expect(boundedJson({ a: 1 }, 'Field')).toEqual({ a: 1 });
  });

  it('replaces an over-budget value with an explicit, self-describing marker', () => {
    const bounded = boundedJson('x'.repeat(MAX_DURABLE_EFFECT_FIELD_CHARS + 1), 'Field') as {
      omitted: boolean;
      reason: string;
    };
    expect(bounded.omitted).toBe(true);
    expect(bounded.reason).toContain('Field');
  });

  it('maps an absent value to null rather than dropping the key', () => {
    expect(boundedJson(undefined, 'Field')).toBeNull();
  });
});
