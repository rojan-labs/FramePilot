/**
 * Unit tests for the planned-edit run driver (P3.1) — every branch of `executePlannedEdit`
 * not already exercised by the happy-path integration test (`planned-edit-stream.test.ts`):
 * `propose_edit` argument/tool validation, the bounded retry (including a rejected proposal
 * that self-corrects on retry, and exhausting all attempts), an unrecognised model step,
 * an unknown leaf name, a leaf that throws, and the terminal fold (cancelled/no-edit-
 * produced).
 */
import { describe, expect, it } from 'vitest';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from '../providers/types.js';
import type { HostExecutionContext, HostToolExecutor, HostToolOutcome } from '../tool-executor.js';
import { createTurnEmitter, type AiEvent } from '../events.js';
import { makeProject } from '../__fixtures__/project.js';
import { assembleEdit } from '../assemble.js';
import type { Sleep } from '../reliability/retry.js';
import { estimateUsd } from './cost/cost-meter.js';
import { createEffectRuntime } from './effect-runtime.js';
import { RECIPE_LEAVES } from './recipe-leaves.js';
import { MAX_MODEL_RETRIES, RETRY_BACKOFF_BASE_MS } from './recovery/recovery.js';
import { schedulerConfig } from './scheduler.js';
import { buildTaskGraph, type TaskGraph, type TaskNode } from './task-graph.js';
import { executePlannedEdit, type PlannedEditRunResult } from './plan-driver.js';

/** A provider that replays canned responses in call order. */
class SequencedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public calls = 0;
  public constructor(private readonly responses: readonly string[]) {}
  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    const text = this.responses[this.calls];
    this.calls += 1;
    if (text === undefined) throw new Error(`unexpected model call #${String(this.calls)}`);
    return { text };
  }
}

/** Always throws a NON-Error value — exercises the `String(error)` defensive fallbacks. */
class NonErrorThrowProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public async complete(): Promise<AiResponse> {
    // Deliberately a bare string, not an Error, so `error instanceof Error` is false.
    throw 'model transport exploded (non-Error)';
  }
}

/** Like {@link SequencedProvider}, but also records every request it was asked to complete. */
class RecordingProvider extends SequencedProvider {
  public readonly requests: AiCompletionRequest[] = [];
  public override async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    return super.complete(request);
  }
}

/**
 * Parse the `Context: {...}` line `edit-proposer.ts#renderInput` embeds in a `propose_edit`
 * request's user turn (P4.1/P4.2) — the bare Semantic Index Slice when no `sliceFrom` arg
 * was given, or `{ upstream, semanticIndex }` when one was.
 */
function sliceContextOf(request: AiCompletionRequest | undefined): Record<string, unknown> {
  const userTurn = request?.messages[1]?.content ?? '';
  const contextLine = userTurn.split('\n').find((line) => line.startsWith('Context: '));
  const parsed: Record<string, unknown> = JSON.parse(
    contextLine?.slice('Context: '.length) ?? '{}',
  );
  return (parsed.semanticIndex as Record<string, unknown> | undefined) ?? parsed;
}

const failingHostTool: HostToolExecutor = {
  async run(call: ToolCall, _ctx: HostExecutionContext): Promise<HostToolOutcome> {
    return { status: 'failed', summary: `no host tool wired for "${call.name}"` };
  },
};

const emitter = () => createTurnEmitter({ conversationId: 'c', turnId: 't', now: () => 1000 });

function node(over: Partial<TaskNode> & Pick<TaskNode, 'id' | 'label' | 'effect'>): TaskNode {
  return { resource: 'pure', priority: 'edit', deps: [], ...over };
}

function graphOf(nodes: readonly TaskNode[]): TaskGraph {
  return buildTaskGraph(nodes);
}

async function drive(
  gen: AsyncGenerator<AiEvent, PlannedEditRunResult>,
): Promise<{ events: AiEvent[]; result: PlannedEditRunResult }> {
  const events: AiEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

describe('executePlannedEdit — task-local assembled edit selection', () => {
  it('verifies each parallel branch against its own ancestor assembly', async () => {
    const project = makeProject();
    const editA = assembleEdit(
      project,
      [{ type: 'trim_clip', clipId: 'clip_a', start: 0, end: 5 }],
      'branch A',
    );
    const editB = assembleEdit(
      project,
      [{ type: 'trim_clip', clipId: 'clip_b', start: 7, end: 10 }],
      'branch B',
    );
    let verifiedA: string | undefined;
    let verifiedB: string | undefined;
    const graph = graphOf([
      node({ id: 'assemble_a', label: 'assemble A', effect: { kind: 'patch', name: 'branch_a' } }),
      node({ id: 'assemble_b', label: 'assemble B', effect: { kind: 'patch', name: 'branch_b' } }),
      node({
        id: 'verify_a',
        label: 'verify A',
        effect: { kind: 'verify', name: 'capture_a' },
        deps: ['assemble_a'],
      }),
      node({
        id: 'verify_b',
        label: 'verify B',
        effect: { kind: 'verify', name: 'capture_b' },
        deps: ['assemble_b'],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: failingHostTool,
    });

    await drive(
      executePlannedEdit(graph, {
        project,
        runtime,
        emit: emitter(),
        reason: 'parallel branches',
        leaves: {
          ...RECIPE_LEAVES,
          branch_a: () => ({ edit: editA, operations: editA.patch.operations }),
          branch_b: () => ({ edit: editB, operations: editB.patch.operations }),
          capture_a: (ctx) => {
            verifiedA = ctx.runEdit?.patch.patchId;
            return { verdict: { ok: true, summary: 'A verified' } };
          },
          capture_b: (ctx) => {
            verifiedB = ctx.runEdit?.patch.patchId;
            return { verdict: { ok: true, summary: 'B verified' } };
          },
        },
      }),
    );

    expect(verifiedA).toBe(editA.patch.patchId);
    expect(verifiedB).toBe(editB.patch.patchId);
    expect(verifiedA).not.toBe(verifiedB);
  });

  it('throws when two individually-valid ancestor edits cannot be combined into one working project', async () => {
    // Each branch splits `clip_a` on its OWN — individually valid — but splitting it a
    // second time at a point the first split already moved outside `clip_a`'s new bounds
    // is not a combination any project can represent: this must surface as a thrown
    // error naming the conflict, not a silently wrong "working" project handed to verify.
    const project = makeProject();
    const editA = assembleEdit(
      project,
      [{ type: 'ripple_delete', trackId: 'video_1', start: 0, end: 6 }],
      'A',
    );
    const editB = assembleEdit(
      project,
      [{ type: 'trim_clip', clipId: 'clip_a', start: 1, end: 5 }],
      'B',
    );
    const graph = graphOf([
      node({ id: 'assemble_a', label: 'assemble A', effect: { kind: 'patch', name: 'branch_a' } }),
      node({ id: 'assemble_b', label: 'assemble B', effect: { kind: 'patch', name: 'branch_b' } }),
      node({
        id: 'verify_it',
        label: 'verify',
        effect: { kind: 'verify', name: 'capture' },
        deps: ['assemble_a', 'assemble_b'],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: failingHostTool,
    });

    const { result } = await drive(
      executePlannedEdit(graph, {
        project,
        runtime,
        emit: emitter(),
        reason: 'conflicting branches',
        leaves: {
          ...RECIPE_LEAVES,
          branch_a: () => ({ edit: editA, operations: editA.patch.operations }),
          branch_b: () => ({ edit: editB, operations: editB.patch.operations }),
          capture: () => ({ verdict: { ok: true, summary: 'unreachable' } }),
        },
      }),
    );

    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toContain(
      'validated ancestor edits could not form a working project',
    );
  });

  it('fails a host_tool task honestly when its own ancestor edits cannot be combined', async () => {
    const project = makeProject();
    const editA = assembleEdit(
      project,
      [{ type: 'ripple_delete', trackId: 'video_1', start: 0, end: 6 }],
      'A',
    );
    const editB = assembleEdit(
      project,
      [{ type: 'trim_clip', clipId: 'clip_a', start: 1, end: 5 }],
      'B',
    );
    const graph = graphOf([
      node({ id: 'assemble_a', label: 'assemble A', effect: { kind: 'patch', name: 'branch_a' } }),
      node({ id: 'assemble_b', label: 'assemble B', effect: { kind: 'patch', name: 'branch_b' } }),
      node({
        id: 'analyze_it',
        label: 'analyze',
        effect: { kind: 'host_tool', name: 'analyze_silence', args: {} },
        deps: ['assemble_a', 'assemble_b'],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, {
        project,
        runtime,
        emit: emitter(),
        reason: 'conflicting branches',
        leaves: {
          ...RECIPE_LEAVES,
          branch_a: () => ({ edit: editA, operations: editA.patch.operations }),
          branch_b: () => ({ edit: editB, operations: editB.patch.operations }),
        },
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toContain(
      'validated ancestor edits could not form a working project',
    );
  });

  it('fails a propose_edit task honestly when its own ancestor edits cannot be combined', async () => {
    const project = makeProject();
    const editA = assembleEdit(
      project,
      [{ type: 'ripple_delete', trackId: 'video_1', start: 0, end: 6 }],
      'A',
    );
    const editB = assembleEdit(
      project,
      [{ type: 'trim_clip', clipId: 'clip_a', start: 1, end: 5 }],
      'B',
    );
    const graph = graphOf([
      node({ id: 'assemble_a', label: 'assemble A', effect: { kind: 'patch', name: 'branch_a' } }),
      node({ id: 'assemble_b', label: 'assemble B', effect: { kind: 'patch', name: 'branch_b' } }),
      node({
        id: 'propose_it',
        label: 'propose',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
        deps: ['assemble_a', 'assemble_b'],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, {
        project,
        runtime,
        emit: emitter(),
        reason: 'conflicting branches',
        leaves: {
          ...RECIPE_LEAVES,
          branch_a: () => ({ edit: editA, operations: editA.patch.operations }),
          branch_b: () => ({ edit: editB, operations: editB.patch.operations }),
        },
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toContain(
      'validated ancestor edits could not form a working project',
    );
  });
});

describe('executePlannedEdit — routed-around analysis reaches the proposer as a stated gap', () => {
  it('tells the proposer which analysis returned nothing instead of leaving a hole', async () => {
    // The reported failure end to end: `detect_beats` was killed by a client timeout,
    // the run routed around it, and the proposer — given no beat grid and no word that
    // one was missing — emitted evenly spaced cuts through the assets in library order
    // and called it beat-synced. Routing around is right; doing it silently is not.
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'detect beats',
        effect: { kind: 'host_tool', name: 'detect_beats', args: {} },
      }),
      node({
        id: 'T2',
        label: 'cut the montage to the beat',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
        deps: ['T1'],
      }),
    ]);
    const timingOut: HostToolExecutor = {
      async run(call: ToolCall): Promise<HostToolOutcome> {
        return { status: 'failed', summary: `"${call.name}" timed out after 120s` };
      },
    };
    const provider = new RecordingProvider([
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ]);
    const runtime = createEffectRuntime({ provider, executor: timingOut });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    // The plan still completes — one dead analysis must not discard the rest.
    expect(result.status).not.toBe('failed');
    const userTurn = provider.requests[0]?.messages[1]?.content ?? '';
    expect(userTurn).toContain('MISSING EVIDENCE');
    expect(userTurn).toContain('detect_beats');
    expect(userTurn).toContain('timed out');
  });
});

describe('executePlannedEdit — propose_edit (P3.2 general-purpose model task)', () => {
  it('proposes and applies a real mutate-tool edit, threading upstream slice data', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'analyze silence',
        effect: { kind: 'host_tool', name: 'analyze_silence', args: {} },
      }),
      node({
        id: 'T2',
        label: 'tighten the start',
        effect: {
          kind: 'model',
          name: 'propose_edit',
          args: { toolNames: ['ripple_delete'], sliceFrom: 'T1' },
        },
        deps: ['T1'],
      }),
    ]);
    const provider = new SequencedProvider([
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ]);
    const silenceExecutor: HostToolExecutor = {
      async run(call: ToolCall): Promise<HostToolOutcome> {
        if (call.name !== 'analyze_silence') return { status: 'failed', summary: 'unexpected' };
        return { status: 'completed', summary: 'ok', data: { ranges: [{ start: 2, end: 3 }] } };
      },
    };
    const runtime = createEffectRuntime({
      provider: provider,
      executor: silenceExecutor,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(provider.calls).toBe(1);
    expect(result.status).toBe('completed');
    // No assemble_patch/verify tail in this graph, so no edit is folded — this test only
    // proves the task itself resolved a real operation from a real mutate tool.
  });

  it('threads an upstream leaf\'s "value" (not "data") as the slice', async () => {
    // `diagnose_pacing` is a pure analysis leaf that returns a `value` (no host `data`), so
    // this exercises the `upstream?.data ?? upstream?.value` legacy-slice branch.
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'diagnose',
        effect: { kind: 'analysis', name: 'diagnose_pacing', args: {} },
      }),
      node({
        id: 'T2',
        label: 'tighten',
        effect: {
          kind: 'model',
          name: 'propose_edit',
          args: { toolNames: ['ripple_delete'], sliceFrom: 'T1' },
        },
        deps: ['T1'],
      }),
    ]);
    const provider = new SequencedProvider([
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).toBe('completed');
  });

  it('runs without a "sliceFrom" arg (undefined slice is honest, not fabricated)', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'tighten',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
    ]);
    const provider = new SequencedProvider([
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).toBe('completed');
  });

  it('omits durationSeconds from an asset identity that never carried one, rather than fabricating 0', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'tighten',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
    ]);
    const provider = new SequencedProvider([
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const project = makeProject({
      assets: [{ id: 'asset_1', path: 'media/a.mp4', kind: 'video' }],
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project, runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).toBe('completed');
  });

  it('fails honestly when the task is missing a "toolNames" arg', async () => {
    const graph = graphOf([
      node({ id: 'T1', label: 'x', effect: { kind: 'model', name: 'propose_edit', args: {} } }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
    expect(provider.calls).toBe(0);
    // The step and its reason ride out with the result: a `model` task emits no tool
    // result, so without this the run could only say "could not complete".
    expect(result.failure).toEqual({
      taskId: 'T1',
      label: 'x',
      reason: 'propose_edit requires a non-empty "toolNames" arg',
    });
  });

  it('reports the FIRST failing step, not a later consequence of it', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'Survey on-screen content',
        effect: { kind: 'host_tool', name: 'search_visual', args: { query: 'shots' } },
      }),
      node({
        id: 'T2',
        label: 'Compose the montage',
        effect: { kind: 'model', name: 'propose_edit', args: {} },
        deps: ['T1'],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    // T1 (analysis) is routed around, so the run reaches T2 — and T2's own failure is what
    // is reported, since T1 never ended the run.
    expect(result.failure?.label).toBe('Compose the montage');
  });

  it('fails honestly when a requested tool is unknown', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'x',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['no_such_tool'] } },
      }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
    expect(provider.calls).toBe(0);
  });

  it('fails honestly when a requested tool is not a mutate tool', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'x',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['detect_beats'] } },
      }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
    expect(provider.calls).toBe(0);
  });

  it('does not re-walk a shared host-tool ancestor reached via two dependency branches (diamond deps)', async () => {
    // A propose_edit task whose two upstream branches reconverge on the same host-tool
    // ancestor before either resolves — the beat-grid dependency check (`detect_beats`)
    // must not loop or double-count that shared ancestor while confirming this plan has
    // no beat dependency at all (an ordinary, non-beat-synced edit).
    const silenceExecutor: HostToolExecutor = {
      async run(call: ToolCall): Promise<HostToolOutcome> {
        if (call.name !== 'analyze_silence') return { status: 'failed', summary: 'unexpected' };
        return { status: 'completed', summary: 'ok', data: { ranges: [] } };
      },
    };
    const graph = graphOf([
      node({
        id: 'mid',
        label: 'mid',
        effect: { kind: 'host_tool', name: 'analyze_silence', args: {} },
      }),
      node({
        id: 'branchB',
        label: 'branch b',
        effect: { kind: 'host_tool', name: 'analyze_silence', args: {} },
        deps: ['mid'],
      }),
      node({
        id: 'branchC',
        label: 'branch c',
        effect: { kind: 'host_tool', name: 'analyze_silence', args: {} },
        deps: ['mid'],
      }),
      node({
        id: 'propose',
        label: 'propose',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
        deps: ['branchB', 'branchC'],
      }),
    ]);
    const provider = new SequencedProvider([
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ]);
    const runtime = createEffectRuntime({ provider, executor: silenceExecutor });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).toBe('completed');
  });

  it('exhausts the bounded correction budget and fails honestly on repeated bad JSON', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'x',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
    ]);
    const provider = new SequencedProvider(['not json', 'still not json', 'still invalid']);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(provider.calls).toBe(3);
    expect(result).toMatchObject({
      status: 'failed',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
  });

  it('feeds an empty mutation proposal back once and accepts a grounded correction', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'compose montage',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
    ]);
    const provider = new RecordingProvider([
      JSON.stringify({ toolCalls: [] }),
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ]);
    const runtime = createEffectRuntime({ provider, executor: failingHostTool });

    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );

    expect(result.status).toBe('completed');
    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain(
      'proposal returned no tool calls',
    );
  });

  it('fails the mutation task after the bounded empty proposals instead of running its patch tail', async () => {
    const graph = graphOf([
      node({
        id: 'proposal',
        label: 'compose montage',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
      node({
        id: 'patch',
        label: 'assemble montage',
        effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'proposal' } },
        deps: ['proposal'],
      }),
    ]);
    const provider = new SequencedProvider([
      JSON.stringify({ toolCalls: [] }),
      JSON.stringify({ toolCalls: [] }),
      JSON.stringify({ toolCalls: [] }),
    ]);
    const runtime = createEffectRuntime({ provider, executor: failingHostTool });

    const { events, result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );

    expect(result.status).toBe('failed');
    expect(result.failure).toMatchObject({
      taskId: 'proposal',
      reason: expect.stringContaining('returned no tool calls'),
    });
    expect(events.some((event) => event.type === 'task_started' && event.taskId === 'patch')).toBe(
      false,
    );
  });

  it('repairs an empty proposal and then a track id used as assetId before accepting it', async () => {
    const graph = graphOf([
      node({
        id: 'proposal',
        label: 'compose montage',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['add_clip'] } },
      }),
    ]);
    const provider = new RecordingProvider([
      JSON.stringify({ toolCalls: [] }),
      JSON.stringify({
        toolCalls: [
          {
            name: 'add_clip',
            arguments: { trackId: 'audio_1', assetId: 'audio_1', start: 10, end: 12 },
          },
        ],
      }),
      JSON.stringify({
        toolCalls: [
          {
            name: 'add_clip',
            arguments: { trackId: 'audio_1', assetId: 'asset_1', start: 10, end: 12 },
          },
        ],
      }),
    ]);
    const runtime = createEffectRuntime({ provider, executor: failingHostTool });

    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );

    expect(result.status).toBe('completed');
    expect(provider.calls).toBe(3);
    expect(provider.requests[0]?.messages[1]?.content).toContain('"assetId":"asset_1"');
    expect(provider.requests[0]?.messages[1]?.content).toContain('"trackId":"audio_1"');
    expect(provider.requests[2]?.messages.at(-1)?.content).toContain("Unknown asset 'audio_1'");
  });

  it('bounds semantic-validator feedback when a large proposal has many bad references', async () => {
    const graph = graphOf([
      node({
        id: 'proposal',
        label: 'compose montage',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['add_clip'] } },
      }),
    ]);
    const invalidCalls = Array.from({ length: 9 }, (_, index) => ({
      name: 'add_clip',
      arguments: {
        trackId: 'audio_1',
        assetId: `missing_${String(index)}`,
        start: index * 2,
        end: index * 2 + 1,
      },
    }));
    const provider = new RecordingProvider([
      JSON.stringify({ toolCalls: invalidCalls }),
      JSON.stringify({
        toolCalls: [
          {
            name: 'add_clip',
            arguments: { trackId: 'audio_1', assetId: 'asset_1', start: 10, end: 12 },
          },
        ],
      }),
    ]);
    const runtime = createEffectRuntime({ provider, executor: failingHostTool });

    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );

    expect(result.status).toBe('completed');
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain('plus 1 more error(s)');
  });

  it('rejects a hallucinated tool name at the registry boundary and self-corrects on retry', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'x',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
    ]);
    const provider = new SequencedProvider([
      JSON.stringify({ toolCalls: [{ name: 'hallucinated_tool', arguments: {} }] }),
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(provider.calls).toBe(2);
    expect(result.status).toBe('completed');
  });

  it('ignores a completed host_tool task whose name is not an analysis-bag kind (P4.1)', async () => {
    const graph = graphOf([
      // `get_transcript` isn't shots/silences/beats — collectAnalysisBag must skip it (no
      // bag key for it), not crash or misattribute its payload.
      node({
        id: 'T0',
        label: 'transcript',
        effect: { kind: 'host_tool', name: 'get_transcript', args: {} },
      }),
      node({
        id: 'T1',
        label: 'analyze silence',
        effect: { kind: 'host_tool', name: 'analyze_silence', args: { assetId: 'asset_1' } },
      }),
      node({
        id: 'T2',
        label: 'propose an edit',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
        deps: ['T0', 'T1'],
      }),
    ]);
    const proposeEditResponse = JSON.stringify({
      toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
    });
    const provider = new RecordingProvider([proposeEditResponse]);
    const executor: HostToolExecutor = {
      async run(call: ToolCall): Promise<HostToolOutcome> {
        if (call.name === 'get_transcript')
          return { status: 'completed', summary: 'ok', data: { words: [] } };
        if (call.name === 'analyze_silence') {
          return {
            status: 'completed',
            summary: 'ok',
            data: { assetId: 'asset_1', ranges: [{ start: 2, end: 3 }] },
          };
        }
        return { status: 'failed', summary: 'unexpected' };
      },
    };
    const runtime = createEffectRuntime({ provider: provider, executor });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).toBe('completed');

    // `asset_1` is placed 1:1 on `video_1` (clip_a: timeline [0,6), source [0,6)), so
    // `analyze_silence`'s [2,3) survives translation; `get_transcript`'s payload never
    // reaches the bag at all (there's no key for it).
    const context = sliceContextOf(provider.requests[0]);
    expect(context.silences).toEqual([{ start: 2, end: 3 }]);
  });

  it("doesn't reach into a same-batch host_tool task that hasn't completed yet (P4.1)", async () => {
    // T1 and T2 share no dep edge, so the scheduler dispatches both in the SAME batch —
    // `runGraph` only publishes a batch's outputs after the WHOLE batch settles, so T2's
    // `collectAnalysisBag` call (synchronous, before its own model round-trip) can never
    // observe T1's output, no matter which finishes its own async work first.
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'detect scenes (never wired as a dep of T2)',
        effect: { kind: 'host_tool', name: 'detect_scenes', args: { assetId: 'asset_1' } },
      }),
      node({
        id: 'T2',
        label: 'propose an edit',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
    ]);
    const proposeEditResponse = JSON.stringify({
      toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
    });
    const provider = new RecordingProvider([proposeEditResponse]);
    const executor: HostToolExecutor = {
      async run(call: ToolCall): Promise<HostToolOutcome> {
        if (call.name !== 'detect_scenes') return { status: 'failed', summary: 'unexpected' };
        return {
          status: 'completed',
          summary: 'ok',
          data: { assetId: 'asset_1', cuts: [{ time: 1 }, { time: 2 }] },
        };
      },
    };
    const runtime = createEffectRuntime({ provider: provider, executor });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).toBe('completed');

    const context = sliceContextOf(provider.requests[0]);
    expect(context.shots).toEqual([]); // honestly empty — T1 hadn't completed when T2 ran
  });

  it(
    'scopes the semantic slice to args.timeRange/layerId/kinds (P4.2 — a Planner-authored ' +
      'step can ask for just "dialogue 0-2s on video_1")',
    async () => {
      const graph = graphOf([
        node({
          id: 'T1',
          label: 'propose an edit',
          effect: {
            kind: 'model',
            name: 'propose_edit',
            args: {
              toolNames: ['ripple_delete'],
              timeRange: { start: 0, end: 2 },
              layerId: 'video_1',
              kinds: ['dialogue', 'layers'],
            },
          },
        }),
      ]);
      const proposeEditResponse = JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      });
      const provider = new RecordingProvider([proposeEditResponse]);
      const runtime = createEffectRuntime({
        provider: provider,
        executor: failingHostTool,
      });
      const { result } = await drive(
        executePlannedEdit(graph, {
          project: makeProject(),
          runtime,
          emit: emitter(),
          reason: 'r',
        }),
      );
      expect(result.status).toBe('completed');

      const context = sliceContextOf(provider.requests[0]);
      // `makeProject()`'s transcript ("hello"@0-0.5, "world"@0.5-1) -> one dialogue segment.
      expect(context.dialogue).toEqual([{ start: 0, end: 1, text: 'hello world' }]);
      expect((context.layers as { trackId: string }[]).map((l) => l.trackId)).toEqual(['video_1']);
      // Excluded by `kinds` regardless of overlap.
      expect(context.captions).toEqual([]);
      expect(context.effects).toEqual([]);
    },
  );

  it('widens to an unrestricted slice when every requested kind is unrecognised (honest default, not a rejection)', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'propose an edit',
        effect: {
          kind: 'model',
          name: 'propose_edit',
          args: { toolNames: ['ripple_delete'], kinds: ['not_a_real_kind'] },
        },
      }),
    ]);
    const proposeEditResponse = JSON.stringify({
      toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
    });
    const provider = new RecordingProvider([proposeEditResponse]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).toBe('completed');

    const context = sliceContextOf(provider.requests[0]);
    expect(context.dialogue).toEqual([{ start: 0, end: 1, text: 'hello world' }]);
    expect((context.layers as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('executePlannedEdit — unrecognised task shapes', () => {
  it('degrades honestly on a model step other than propose_edit', async () => {
    const graph = graphOf([
      node({ id: 'T1', label: 'x', effect: { kind: 'model', name: 'some_other_step', args: {} } }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      unsupported: true,
      cost: { tokens: 0, usd: 0 },
    });
    expect(provider.calls).toBe(0);
  });

  it('degrades honestly on an unknown leaf name', async () => {
    const graph = graphOf([
      node({ id: 'T1', label: 'x', effect: { kind: 'analysis', name: 'no_such_leaf', args: {} } }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      unsupported: true,
      cost: { tokens: 0, usd: 0 },
    });
  });

  it('catches a leaf that throws RecipeLeafError and fails the task honestly', async () => {
    const graph = graphOf([
      // synth_ripple_deletes throws when its "from" upstream produced no result.
      node({
        id: 'T1',
        label: 'ripple',
        effect: { kind: 'analysis', name: 'synth_ripple_deletes', args: { from: 'ghost' } },
      }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
  });
});

describe('executePlannedEdit — terminal fold', () => {
  it('settles cancelled when a host tool is stopped mid-run', async () => {
    const graph = graphOf([
      node({ id: 'T1', label: 'x', effect: { kind: 'host_tool', name: 'detect_beats', args: {} } }),
    ]);
    const provider = new SequencedProvider([]);
    const cancelExecutor: HostToolExecutor = {
      async run(): Promise<HostToolOutcome> {
        return { status: 'cancelled', summary: 'stopped' };
      },
    };
    const runtime = createEffectRuntime({
      provider: provider,
      executor: cancelExecutor,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result).toEqual({
      status: 'cancelled',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
  });

  it('completes with no edit when the graph produces none (and no args at all)', async () => {
    const graph = graphOf([
      // No `args` field — exercises the leaf's `task.effect.args ?? {}` default.
      node({ id: 'T1', label: 'verify', effect: { kind: 'verify', name: 'verify' } }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result).toEqual({
      status: 'completed',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
  });

  it('fails the task when a leaf assembles a structurally invalid patch', async () => {
    // A leaf that synthesizes an op on a track that does not exist — assemble_patch's
    // validator catches it (an OperationError), so the run fails honestly, never a
    // fabricated edit.
    const graph = graphOf([
      node({ id: 'T1', label: 'synth', effect: { kind: 'analysis', name: 'bad_ops', args: {} } }),
      node({
        id: 'T2',
        label: 'assemble',
        effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'T1' } },
        deps: ['T1'],
      }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, {
        project: makeProject(),
        runtime,
        emit: emitter(),
        reason: 'r',
        leaves: {
          ...RECIPE_LEAVES,
          bad_ops: () => ({
            operations: [
              {
                type: 'add_clip',
                trackId: 'no_such_track',
                assetId: 'asset_1',
                start: 0,
                end: 1,
                sourceStart: 0,
                sourceEnd: 1,
                clipId: 'c_bad',
              },
            ],
            summary: 'one op on a nonexistent track',
          }),
        },
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
  });
});

describe('executePlannedEdit — leaf error handling', () => {
  it('settles as failed when a leaf throws a plain Error (not RecipeLeafError)', async () => {
    const graph = graphOf([
      node({ id: 'T1', label: 'boom', effect: { kind: 'analysis', name: 'boom', args: {} } }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, {
        project: makeProject(),
        runtime,
        emit: emitter(),
        reason: 'r',
        leaves: {
          boom: () => {
            throw new Error('boom');
          },
        },
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
  });

  it('reports "empty" when the assembled patch is valid but changes nothing', async () => {
    const graph = graphOf([
      node({ id: 'T1', label: 'noop', effect: { kind: 'analysis', name: 'noop', args: {} } }),
      node({
        id: 'T2',
        label: 'assemble',
        effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'T1' } },
        deps: ['T1'],
      }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, {
        project: makeProject(),
        runtime,
        emit: emitter(),
        reason: 'r',
        leaves: { ...RECIPE_LEAVES, noop: () => ({ summary: 'did nothing' }) },
      }),
    );
    expect(result.status).toBe('empty');
    expect(result.edit?.validation.valid).toBe(true);
    expect(result.edit?.patch.operations).toHaveLength(0);
  });
});

describe('executePlannedEdit — caller-supplied scheduler config', () => {
  it('honors a budget-capped config (no task runs)', async () => {
    const graph = graphOf([
      node({ id: 'T1', label: 'x', effect: { kind: 'host_tool', name: 'detect_beats', args: {} } }),
    ]);
    const provider = new SequencedProvider([]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, {
        project: makeProject(),
        runtime,
        emit: emitter(),
        reason: 'r',
        config: schedulerConfig({ budget: { maxTasks: 0 } }),
      }),
    );
    expect(result).toEqual({
      status: 'completed',
      unsupported: false,
      cost: { tokens: 0, usd: 0 },
    });
  });
});

describe('executePlannedEdit — cost (P7.1)', () => {
  /** A {@link SequencedProvider} that also reports real token usage on every response. */
  class UsageProvider extends SequencedProvider {
    public override async complete(request: AiCompletionRequest): Promise<AiResponse> {
      const res = await super.complete(request);
      return { ...res, usage: { inputTokens: 100, outputTokens: 20 } };
    }
  }

  it('accumulates cost across every propose_edit attempt, including a rejected one', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'x',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
    ]);
    const provider = new UsageProvider([
      'not json', // first attempt rejected…
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }), // …second attempt wins
    ]);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(provider.calls).toBe(2);
    expect(result.status).toBe('completed');
    // Both attempts — the rejected one AND the winning one — burned real tokens (P7.1:
    // every attempt is priced, not just the winner).
    expect(result.cost).toEqual({
      tokens: 240,
      usd: estimateUsd('mid', { input: 200, output: 40 }),
    });
  });

  it('prices an exhausted-retries model failure too (a failed task still cost real money)', async () => {
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'x',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
    ]);
    const provider = new UsageProvider(['not json', 'still not json', 'still invalid']);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(provider.calls).toBe(3);
    expect(result.status).toBe('failed');
    expect(result.cost).toEqual({
      tokens: 360,
      usd: estimateUsd('mid', { input: 300, output: 60 }),
    });
  });
});

describe('executePlannedEdit — recoveryFor consultation (P7.4)', () => {
  /** A provider whose `complete()` throws for its first `throwCount` calls, then answers. */
  class FlakyProvider implements AiProvider {
    public readonly name = 'mock' as const;
    public invocations = 0;
    public constructor(
      private readonly throwCount: number,
      private readonly onSuccess: string = 'not json',
    ) {}
    public async complete(): Promise<AiResponse> {
      this.invocations += 1;
      if (this.invocations <= this.throwCount) {
        throw new Error(`transient failure #${String(this.invocations)}`);
      }
      return { text: this.onSuccess };
    }
  }

  const proposeEditGraph = (): TaskGraph =>
    graphOf([
      node({
        id: 'T1',
        label: 'x',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
      }),
    ]);

  it("retries a thrown model error per recoveryFor's prescribed backoff, then succeeds (a live driver actually consulting the table)", async () => {
    const successResponse = JSON.stringify({
      toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
    });
    const provider = new FlakyProvider(1, successResponse);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const sleeps: number[] = [];
    const fakeSleep: Sleep = async (ms) => {
      sleeps.push(ms);
    };
    const { result } = await drive(
      executePlannedEdit(proposeEditGraph(), {
        project: makeProject(),
        runtime,
        emit: emitter(),
        reason: 'r',
        sleep: fakeSleep,
      }),
    );
    // One thrown attempt, then a real answer: exactly `recoveryFor({class:'model_error',
    // attempt:1,...})`'s prescribed backoff (RETRY_BACKOFF_BASE_MS * 2^0), not a
    // hardcoded/ad-hoc constant.
    expect(provider.invocations).toBe(2);
    expect(sleeps).toEqual([RETRY_BACKOFF_BASE_MS]);
    expect(result.status).toBe('completed');
  });

  it("exhausts recoveryFor's own retry budget and reports an honest failure naming the recovery reason (no fabricated tier/recipe fallback)", async () => {
    const provider = new FlakyProvider(Number.POSITIVE_INFINITY);
    const runtime = createEffectRuntime({
      provider: provider,
      executor: failingHostTool,
    });
    const sleeps: number[] = [];
    const fakeSleep: Sleep = async (ms) => {
      sleeps.push(ms);
    };
    const { result } = await drive(
      executePlannedEdit(proposeEditGraph(), {
        project: makeProject(),
        runtime,
        emit: emitter(),
        reason: 'r',
        sleep: fakeSleep,
      }),
    );
    // MAX_MODEL_RETRIES attempts retry (backoff doubling each time); the next attempt is
    // where the table's own budget is exhausted and it prescribes a tier fallback this
    // driver does not implement (P7.4 scope note) — an honest failure, never a fabricated
    // success.
    expect(provider.invocations).toBe(MAX_MODEL_RETRIES + 1);
    expect(sleeps).toEqual(
      Array.from({ length: MAX_MODEL_RETRIES }, (_, i) => RETRY_BACKOFF_BASE_MS * 2 ** i),
    );
    expect(result.status).toBe('failed');
    expect(result.edit).toBeUndefined();
  });

  it('reports an honest failure when propose_edit throws a NON-Error value (String(error) fallback)', async () => {
    const runtime = createEffectRuntime({
      provider: new NonErrorThrowProvider(),
      executor: failingHostTool,
    });
    const fakeSleep: Sleep = async () => {};
    const { result } = await drive(
      executePlannedEdit(proposeEditGraph(), {
        project: makeProject(),
        runtime,
        emit: emitter(),
        reason: 'r',
        sleep: fakeSleep,
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.edit).toBeUndefined();
  });
});

describe('executePlannedEdit — tool_failed recovery (B5.5)', () => {
  it('fails the subgraph when a lone failing host tool has no alternative', async () => {
    // One host_tool node, no dependants, no other work → recoveryFor prescribes
    // fail_subgraph; the run stops and reports failed (never a fabricated success).
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'scenes',
        effect: { kind: 'host_tool', name: 'detect_scenes', args: {} },
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).toBe('failed');
  });

  it('routes around a failed host tool that nothing depends on when other work exists', async () => {
    // T1 (detect_scenes) fails but has NO dependants and T2 is independent → route_around:
    // the run continues and settles honestly instead of terminating on T1's failure.
    const twoToolExecutor: HostToolExecutor = {
      async run(call: ToolCall): Promise<HostToolOutcome> {
        if (call.name === 'detect_scenes')
          return { status: 'failed', summary: 'scenes engine down' };
        return { status: 'completed', summary: 'ok', data: { beats: [] } };
      },
    };
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'scenes',
        effect: { kind: 'host_tool', name: 'detect_scenes', args: {} },
      }),
      node({
        id: 'T2',
        label: 'beats',
        effect: { kind: 'host_tool', name: 'detect_beats', args: {} },
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: twoToolExecutor,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    // Neither task produced an edit, but the run did NOT fail — T1 was routed around.
    expect(result.status).not.toBe('failed');
  });

  it('fails the subgraph when a failed NON-analysis host tool has a dependant', async () => {
    // T1 (render_preview, an action) fails and T2 depends on it → fail_subgraph: a step
    // built on a render that never happened cannot run honestly. Analysis is the exception
    // (see below) precisely because missing evidence is survivable and a missing action is not.
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'preview',
        effect: { kind: 'host_tool', name: 'render_preview', args: {} },
      }),
      node({
        id: 'T2',
        label: 'ripple',
        effect: { kind: 'analysis', name: 'synth_ripple_deletes', args: { from: 'T1' } },
        deps: ['T1'],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: failingHostTool,
    });
    const { result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).toBe('failed');
  });

  it('routes around a FAILED analysis with a dependant instead of abandoning the plan', async () => {
    // The reported failure: `describe_footage` errored, and the run reported "the planned
    // edit could not complete" — throwing away the grade and the pacing, which never needed
    // that footage read. Analysis is evidence: the dependant runs with less of it.
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'walk footage',
        effect: { kind: 'host_tool', name: 'describe_footage', args: { assetId: 'a1' } },
      }),
      node({
        id: 'T2',
        label: 'ripple',
        effect: { kind: 'analysis', name: 'synth_ripple_deletes', args: { from: 'T1' } },
        deps: ['T1'],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: failingHostTool,
    });
    const { events, result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).not.toBe('failed');
    expect(events.some((e) => e.type === 'task_finished' && e.taskId === 'T2')).toBe(true);
  });

  it('continues past an analysis that had nothing to analyse, even with a dependant', async () => {
    // The reported bug: a beat-synced plan over silent footage. `detect_beats` cannot
    // answer — but that is a fact about the media, not a fault, so the engine settles it
    // `warning` and the dependant step must still run. Failing here terminated whole runs
    // ("The planned edit could not complete") over one video-only asset.
    const silentBeats: HostToolExecutor = {
      async run(call: ToolCall): Promise<HostToolOutcome> {
        if (call.name === 'detect_beats') {
          return {
            status: 'warning',
            summary: '"detect_beats": clip.mp4 has no audio track, so there are no beats.',
          };
        }
        return { status: 'completed', summary: 'ok', data: {} };
      },
    };
    const graph = graphOf([
      node({
        id: 'T1',
        label: 'beats',
        effect: { kind: 'host_tool', name: 'detect_beats', args: {} },
      }),
      node({
        id: 'T2',
        label: 'ripple',
        effect: { kind: 'analysis', name: 'synth_ripple_deletes', args: { from: 'T1' } },
        deps: ['T1'],
      }),
    ]);
    const runtime = createEffectRuntime({
      provider: new SequencedProvider([]),
      executor: silentBeats,
    });
    const { events, result } = await drive(
      executePlannedEdit(graph, { project: makeProject(), runtime, emit: emitter(), reason: 'r' }),
    );
    expect(result.status).not.toBe('failed');
    // The dependant really ran — the graph was not cut short at T1.
    expect(events.some((e) => e.type === 'task_finished' && e.taskId === 'T2')).toBe(true);
    // And the empty analysis is reported, not silently swallowed.
    expect(
      events.some((e) => e.type === 'tool_result' && /no audio track/.test(e.summary ?? '')),
    ).toBe(true);
  });
});
