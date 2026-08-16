/**
 * Integration test for the live planner path (plan/AGENT-NATIVE-COMPLETION-PLAN.md P3.1,
 * widened by P11.1): `Orchestrator.streamPlannedEdit` drives a plan end to end through the
 * REAL IntentParser + Planner proposers, the real `compilePlan` + scheduler, the real
 * `EffectRuntime`, and the real patch assembly. The model is consulted a bounded number of
 * times (IntentParser + Planner + one `propose_edit` step) — never once per turn of a
 * sequential agent loop. The driver's leaves default to `RECIPE_LEAVES`, so any plan built
 * from proven recipe primitives runs live; anything else falls back honestly.
 */
import { describe, expect, it, vi } from 'vitest';
import { applyProjectPatch, diffProject, invertProjectPatch } from '@framepilot/editor-core';
import {
  Orchestrator,
  PLANNED_EDIT_UNSUPPORTED_NOTICE,
  type StreamOptions,
} from '../orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from '../providers/types.js';
import type { HostExecutionContext, HostToolExecutor, HostToolOutcome } from '../tool-executor.js';
import { reduceEvents, type AiEvent } from '../events.js';
import { makeProject } from '../__fixtures__/project.js';
import type { ContextInput } from '../context-builder.js';
import * as effectRuntimeModule from './effect-runtime.js';
import type { RuntimeEffect } from './effects.js';

/** Canned, schema-valid responses for one happy-path run: intent → plan → propose_edit. */
const INTENT_RESPONSE = JSON.stringify({
  goal: 'tighten the pacing at the start',
  targets: ['video_1'],
  constraints: [],
});

/** analyze_silence → propose_edit(ripple_delete) → assemble_patch → verify. */
const PACING_PLAN_RESPONSE = JSON.stringify({
  steps: [
    {
      id: 'T1',
      label: 'analyze_silence(video_1)',
      effect: { kind: 'host_tool', name: 'analyze_silence', args: { trackId: 'video_1' } },
      resource: 'ffmpeg',
      priority: 'analysis',
    },
    {
      id: 'T2',
      label: 'tighten the start',
      effect: {
        kind: 'model',
        name: 'propose_edit',
        args: { toolNames: ['ripple_delete'], sliceFrom: 'T1' },
      },
      deps: ['T1'],
    },
    {
      id: 'T3',
      label: 'assemble & validate patch',
      // The Planner only needs to declare the DAG edge. compilePlan binds `from` from
      // this validated dependency, so execution cannot drift from scheduling.
      effect: { kind: 'patch', name: 'assemble_patch' },
      deps: ['T2'],
    },
    {
      id: 'T4',
      label: 'verify(pacing tightened)',
      effect: { kind: 'verify', name: 'verify', args: { goal: 'pacing tightened' } },
      deps: ['T3'],
    },
  ],
});

const PROPOSE_EDIT_RESPONSE = JSON.stringify({
  toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
});

/** A provider that replays canned responses in call order and counts how many it served. */
class SequencedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public calls = 0;
  public readonly requests: AiCompletionRequest[] = [];
  public constructor(private readonly responses: readonly string[]) {}
  public async complete(request: AiCompletionRequest): Promise<AiResponse> {
    this.requests.push(request);
    const text = this.responses[this.calls];
    this.calls += 1;
    if (text === undefined) throw new Error(`unexpected model call #${String(this.calls)}`);
    return { text };
  }
}

/** `analyze_silence` reporting one silent range [2,3] (real host shape). */
const silenceExecutor: HostToolExecutor = {
  async run(call: ToolCall, _ctx: HostExecutionContext): Promise<HostToolOutcome> {
    if (call.name !== 'analyze_silence')
      return { status: 'failed', summary: `unexpected tool "${call.name}"` };
    return {
      status: 'completed',
      summary: 'Found 1 silent range',
      data: { ranges: [{ start: 2, end: 3 }] },
    };
  },
};

/** Like {@link silenceExecutor}, but reports every call as cancelled (a stopped run). */
const cancellingExecutor: HostToolExecutor = {
  async run(call: ToolCall): Promise<HostToolOutcome> {
    return { status: 'cancelled', summary: `Stopped "${call.name}" — run cancelled` };
  },
};

/** The fixture project: a placed video clip, plus spare empty tracks. */
function plannedEditProject() {
  return makeProject({
    assets: [
      { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 },
      { id: 'music', path: 'media/music.mp3', kind: 'audio', durationSeconds: 10 },
      { id: 'broll', path: 'media/broll.mp4', kind: 'video', durationSeconds: 8 },
    ],
    timeline: {
      tracks: [
        {
          id: 'video_1',
          type: 'video',
          clips: [
            {
              id: 'clip_a',
              assetId: 'asset_1',
              trackId: 'video_1',
              start: 0,
              end: 6,
              sourceStart: 0,
              sourceEnd: 6,
              effects: [],
              keyframes: [],
            },
          ],
        },
        { id: 'video_2', type: 'video', clips: [] },
        { id: 'audio_1', type: 'audio', clips: [] },
      ],
    },
  });
}

const opts: StreamOptions = { conversationId: 'conv_1', turnId: 'turn_1', now: () => 1000 };

async function collect(gen: AsyncGenerator<AiEvent>): Promise<AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

/**
 * Parse the `Context: {...}` line `edit-proposer.ts#renderInput` embeds in a
 * `propose_edit` request's user turn back into the Semantic Index Slice it carries
 * (P4.1/P4.2) — whichever shape `plan-driver.ts#runProposeEdit` sent (the bare slice when
 * no `sliceFrom` arg was given, or `{ upstream, semanticIndex }` when one was).
 */
function parseSliceContext(request: AiCompletionRequest | undefined): {
  shots: unknown[];
  beats: { times: number[]; bpm?: number } | null;
} {
  const userTurn = request?.messages[1]?.content ?? '';
  const contextLine = userTurn.split('\n').find((line) => line.startsWith('Context: '));
  const parsed: Record<string, unknown> = JSON.parse(
    contextLine?.slice('Context: '.length) ?? '{}',
  );
  const semantic = (parsed.semanticIndex ?? parsed) as {
    shots?: unknown[];
    beats?: { times: number[]; bpm?: number } | null;
  };
  return { shots: semantic.shots ?? [], beats: semantic.beats ?? null };
}

describe('Orchestrator.streamPlannedEdit — propose_edit plan end to end', () => {
  it('assembles a valid, reversible edit with a bounded 3 model calls', async () => {
    const provider = new SequencedProvider([
      INTENT_RESPONSE,
      PACING_PLAN_RESPONSE,
      PROPOSE_EDIT_RESPONSE,
    ]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const project = plannedEditProject();
    const input: ContextInput = { project, userPrompt: 'tighten the pacing at the start' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    // Bounded model calls — IntentParser, Planner, propose_edit. Never once per turn.
    expect(provider.calls).toBe(3);

    const diffEvent = events.find((e) => e.type === 'diff');
    expect(diffEvent).toBeDefined();
    expect(events.some((e) => e.type === 'timeline_action')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });

    const view = reduceEvents(events);
    expect(view.status).toBe('completed');
    expect(view.nodes.some((n) => n.kind === 'diff')).toBe(true);

    const edit = (
      diffEvent as {
        edit: { patch: { operations: readonly unknown[] }; validation: { valid: boolean } };
      }
    ).edit;
    expect(edit.validation.valid).toBe(true);
    expect(edit.patch.operations.length).toBeGreaterThan(0);

    // Reversible: applying the inverse restores the original project exactly.
    const after = applyProjectPatch(project, edit.patch as never);
    const inverse = invertProjectPatch(project, edit.patch as never);
    const restored = applyProjectPatch(after, inverse);
    expect(diffProject(project, restored).summary).toEqual(['no changes']);
  });

  it('settles cancelled with no diff when stopped mid-analysis', async () => {
    const provider = new SequencedProvider([INTENT_RESPONSE, PACING_PLAN_RESPONSE]);
    const orch = new Orchestrator(provider, { executor: cancellingExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  it('settles cancelled when the runtime itself throws an AbortError, even with no signal tripped', async () => {
    // The IntentParser call can fail with a named AbortError from underneath the runtime
    // (e.g. a provider that self-aborts) without `options.signal.aborted` ever having
    // been set — this must still read as a cancellation, not an unhandled failure.
    const realCreateEffectRuntime = effectRuntimeModule.createEffectRuntime;
    const spy = vi.spyOn(effectRuntimeModule, 'createEffectRuntime').mockImplementation((deps) => {
      const runtime = realCreateEffectRuntime(deps);
      let first = true;
      return {
        run: (effect: RuntimeEffect, signal?: AbortSignal) => {
          if (effect.kind === 'model' && first) {
            first = false;
            const abort = new Error('aborted underneath');
            abort.name = 'AbortError';
            throw abort;
          }
          return runtime.run(effect, signal);
        },
      };
    });

    try {
      const provider = new SequencedProvider([INTENT_RESPONSE]);
      const orch = new Orchestrator(provider, { executor: silenceExecutor });
      const input: ContextInput = {
        project: plannedEditProject(),
        userPrompt: 'tighten the pacing',
      };

      const events = await collect(orch.streamPlannedEdit(input, opts));

      expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports "completed" (not a diff) when the assembled edit changes nothing', async () => {
    // A trim to the clip's OWN existing bounds validates and assembles, but its diff is
    // literally "no changes" — `executePlannedEdit` reports that as `empty`, and this
    // streaming layer must still settle honestly as completed with no diff event, not
    // treat `empty` as if it were `failed`/`cancelled`.
    const noOpPlan = JSON.stringify({
      steps: [
        {
          id: 'T1',
          label: 'trim to the same bounds',
          effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['trim_clip'] } },
        },
        {
          id: 'T2',
          label: 'assemble & validate patch',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['T1'],
        },
        {
          id: 'T3',
          label: 'verify(no-op)',
          effect: { kind: 'verify', name: 'verify', args: { goal: 'no-op' } },
          deps: ['T2'],
        },
      ],
    });
    const noOpProposal = JSON.stringify({
      toolCalls: [{ name: 'trim_clip', arguments: { clipId: 'clip_a', start: 0, end: 6 } }],
    });
    const provider = new SequencedProvider([INTENT_RESPONSE, noOpPlan, noOpProposal]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('settles cancelled when the signal trips right as the IntentParser call resolves', async () => {
    // The FIRST `options.signal?.aborted` check after a successful model response — a
    // creator-initiated Stop landing between IntentParser resolving and the Planner call
    // being built must still end the run cleanly, without ever reaching the Planner.
    const controller = new AbortController();
    const provider: AiProvider = {
      name: 'mock',
      async complete() {
        controller.abort();
        return { text: INTENT_RESPONSE };
      },
    };
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(
      orch.streamPlannedEdit(input, { ...opts, signal: controller.signal }),
    );

    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1);
  });

  it('rethrows a genuine (non-abort) IntentParser failure rather than swallowing it as a cancellation', async () => {
    const provider: AiProvider = {
      name: 'mock',
      async complete() {
        throw new Error('network exploded');
      },
    };
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    await expect(collect(orch.streamPlannedEdit(input, opts))).rejects.toThrow('network exploded');
  });

  it('settles cancelled when the IntentParser call throws while the signal is already aborted (not an AbortError itself)', async () => {
    // The catch's `options.signal?.aborted || isAbortError(error)` guard has two
    // independent ways to read as an abort: a named AbortError from underneath, OR the
    // creator's own signal already having tripped — even if the thrown error itself is a
    // plain, unnamed failure (e.g. the transport rejecting outstanding work generically
    // once cancelled). Exercise the SIGNAL side specifically, with a non-AbortError throw.
    const controller = new AbortController();
    controller.abort();
    const provider: AiProvider = {
      name: 'mock',
      async complete() {
        throw new Error('transport rejected — cancelled');
      },
    };
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(
      orch.streamPlannedEdit(input, { ...opts, signal: controller.signal }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  it('rethrows a genuine (non-abort) Planner failure rather than swallowing it as a cancellation', async () => {
    let calls = 0;
    const provider: AiProvider = {
      name: 'mock',
      async complete() {
        calls += 1;
        if (calls === 1) return { text: INTENT_RESPONSE };
        throw new Error('planner transport exploded');
      },
    };
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    await expect(collect(orch.streamPlannedEdit(input, opts))).rejects.toThrow(
      'planner transport exploded',
    );
  });

  it('settles cancelled when the Planner call itself throws an AbortError', async () => {
    // Mirrors the IntentParser AbortError test above, but for the SECOND model call
    // (Planner) — its own catch/abort-check pairing must degrade the same way.
    const realCreateEffectRuntime = effectRuntimeModule.createEffectRuntime;
    const spy = vi.spyOn(effectRuntimeModule, 'createEffectRuntime').mockImplementation((deps) => {
      const runtime = realCreateEffectRuntime(deps);
      let modelCalls = 0;
      return {
        run: (effect: RuntimeEffect, signal?: AbortSignal) => {
          if (effect.kind === 'model') {
            modelCalls += 1;
            if (modelCalls === 2) {
              const abort = new Error('aborted underneath');
              abort.name = 'AbortError';
              throw abort;
            }
          }
          return runtime.run(effect, signal);
        },
      };
    });

    try {
      const provider = new SequencedProvider([INTENT_RESPONSE]);
      const orch = new Orchestrator(provider, { executor: silenceExecutor });
      const input: ContextInput = {
        project: plannedEditProject(),
        userPrompt: 'tighten the pacing',
      };

      const events = await collect(orch.streamPlannedEdit(input, opts));

      expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
    } finally {
      spy.mockRestore();
    }
  });

  it('settles cancelled when the Planner call throws while the signal is already aborted (not an AbortError itself)', async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider: AiProvider = {
      name: 'mock',
      async complete() {
        calls += 1;
        if (calls === 1) return { text: INTENT_RESPONSE };
        controller.abort();
        throw new Error('transport rejected — cancelled');
      },
    };
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(
      orch.streamPlannedEdit(input, { ...opts, signal: controller.signal }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  it('settles cancelled when the signal trips right as the Planner call resolves', async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider: AiProvider = {
      name: 'mock',
      async complete() {
        calls += 1;
        if (calls === 2) controller.abort();
        return { text: calls === 1 ? INTENT_RESPONSE : 'must never be reached' };
      },
    };
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(
      orch.streamPlannedEdit(input, { ...opts, signal: controller.signal }),
    );

    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'cancelled' });
    expect(calls).toBe(2);
  });

  it('stamps IntentParser (small), Planner (mid) and propose_edit (mid) with their proposer tier', async () => {
    // Spy on the runtime construction itself (rather than re-deriving the tier from
    // response content, which never carries it): wrap the REAL createEffectRuntime so
    // every dispatched effect is observed before it's handed to the real runtime.
    const seenTiers: (string | undefined)[] = [];
    const realCreateEffectRuntime = effectRuntimeModule.createEffectRuntime;
    const spy = vi.spyOn(effectRuntimeModule, 'createEffectRuntime').mockImplementation((deps) => {
      const runtime = realCreateEffectRuntime(deps);
      return {
        run: (effect: RuntimeEffect, signal?: AbortSignal) => {
          if (effect.kind === 'model') seenTiers.push(effect.tier);
          return runtime.run(effect, signal);
        },
      };
    });

    try {
      const provider = new SequencedProvider([
        INTENT_RESPONSE,
        PACING_PLAN_RESPONSE,
        PROPOSE_EDIT_RESPONSE,
      ]);
      const orch = new Orchestrator(provider, { executor: silenceExecutor });
      const input: ContextInput = {
        project: plannedEditProject(),
        userPrompt: 'tighten the pacing at the start',
      };

      await collect(orch.streamPlannedEdit(input, opts));

      // IntentParser first (small), then Planner (mid); the `propose_edit` (EditProposer-
      // class) call is also mid — the roster's tier assignment (§6).
      expect(seenTiers).toEqual(['small', 'mid', 'mid']);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back honestly when the proposed plan names an unrecognised task', async () => {
    const unrecognizedPlan = JSON.stringify({
      steps: [
        { label: 'mystery', effect: { kind: 'analysis', name: 'totally_unknown_leaf', args: {} } },
      ],
    });
    const provider = new SequencedProvider([INTENT_RESPONSE, unrecognizedPlan]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = {
      project: plannedEditProject(),
      userPrompt: 'do something creative',
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    // Only intent + planner were consulted — no attempt to run an unsupported shape.
    expect(provider.calls).toBe(2);
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    const notice = events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({ text: PLANNED_EDIT_UNSUPPORTED_NOTICE });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('falls back honestly when IntentParser returns unparseable JSON', async () => {
    const provider = new SequencedProvider(['not json at all']);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = {
      project: plannedEditProject(),
      userPrompt: 'do something creative',
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(provider.calls).toBe(1);
    const notice = events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({ text: PLANNED_EDIT_UNSUPPORTED_NOTICE });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('falls back honestly when the Planner returns unparseable JSON', async () => {
    const provider = new SequencedProvider([INTENT_RESPONSE, 'not json at all']);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = {
      project: plannedEditProject(),
      userPrompt: 'do something creative',
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(provider.calls).toBe(2);
    const notice = events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({ text: PLANNED_EDIT_UNSUPPORTED_NOTICE });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('falls back honestly when the proposed plan does not compile to a valid graph', async () => {
    // A dangling dep — `buildTaskGraph` rejects it, so `compilePlan` throws.
    const uncompilablePlan = JSON.stringify({
      steps: [
        {
          label: 'edit',
          effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
          deps: ['ghost'],
        },
      ],
    });
    const provider = new SequencedProvider([INTENT_RESPONSE, uncompilablePlan]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = {
      project: plannedEditProject(),
      userPrompt: 'do something creative',
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(provider.calls).toBe(2);
    const notice = events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({ text: PLANNED_EDIT_UNSUPPORTED_NOTICE });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('reports a genuine failure (not "unsupported") when propose_edit exhausts its retries', async () => {
    const provider = new SequencedProvider([
      INTENT_RESPONSE,
      PACING_PLAN_RESPONSE,
      'not json',
      'still not json',
      'still invalid',
    ]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(provider.calls).toBe(5);
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
    // The failure names the step that stopped and why. "The planned edit could not
    // complete" was the same sentence for a rejected proposal, a missing argument and an
    // engine that was not running — nothing anyone could act on, and a `model` step
    // publishes no tool result to read the reason off instead.
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    const message = (error as { message?: string; text?: string }).message ?? '';
    expect(message).toMatch(/stopped at "/);
    expect(message).toMatch(/propose_edit/);
  });

  it('fails an explicit edit after the bounded empty proposals without assembling or verifying it', async () => {
    const provider = new SequencedProvider([
      INTENT_RESPONSE,
      PACING_PLAN_RESPONSE,
      JSON.stringify({ toolCalls: [] }),
      JSON.stringify({ toolCalls: [] }),
      JSON.stringify({ toolCalls: [] }),
    ]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(provider.calls).toBe(5);
    expect(events.some((event) => event.type === 'diff')).toBe(false);
    expect(events.some((event) => event.type === 'task_started' && event.taskId === 'T3')).toBe(
      false,
    );
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
    const error = events.find((event) => event.type === 'error');
    expect((error as { message?: string } | undefined)?.message).toContain(
      'proposal returned no tool calls',
    );
  });

  it('repairs asset/track identity confusion before assembly in the full streaming run', async () => {
    const montagePlan = JSON.stringify({
      steps: [
        {
          id: 'T1',
          label: 'place montage clip',
          effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['add_clip'] } },
        },
        {
          id: 'T2',
          label: 'assemble montage',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['T1'],
        },
        {
          id: 'T3',
          label: 'verify montage',
          effect: { kind: 'verify', name: 'verify', args: { goal: 'clip placed' } },
          deps: ['T2'],
        },
      ],
    });
    const provider = new SequencedProvider([
      INTENT_RESPONSE,
      montagePlan,
      JSON.stringify({ toolCalls: [] }),
      JSON.stringify({
        toolCalls: [
          {
            name: 'add_clip',
            arguments: { trackId: 'video_2', assetId: 'video_2', start: 0, end: 2 },
          },
        ],
      }),
      JSON.stringify({
        toolCalls: [
          {
            name: 'add_clip',
            arguments: { trackId: 'video_2', assetId: 'broll', start: 0, end: 2 },
          },
        ],
      }),
    ]);
    const project = plannedEditProject();
    const orch = new Orchestrator(provider, { executor: silenceExecutor });

    const events = await collect(
      orch.streamPlannedEdit({ project, userPrompt: 'place a montage clip from b-roll' }, opts),
    );

    expect(provider.calls).toBe(5);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
    const diff = events.find((event) => event.type === 'diff') as
      | { edit?: { validation: { valid: boolean }; patch: { operations: unknown[] } } }
      | undefined;
    expect(diff?.edit?.validation.valid).toBe(true);
    expect(diff?.edit?.patch.operations).toEqual([
      expect.objectContaining({ type: 'add_clip', trackId: 'video_2', assetId: 'broll' }),
    ]);
  });

  it('automatically assembles and verifies a plan that incorrectly ends on propose_edit', async () => {
    const noPatchPlan = JSON.stringify({
      steps: [
        {
          id: 'T1',
          label: 'analyze_silence(video_1)',
          effect: { kind: 'host_tool', name: 'analyze_silence', args: { trackId: 'video_1' } },
        },
        {
          id: 'T2',
          label: 'tighten the start',
          effect: {
            kind: 'model',
            name: 'propose_edit',
            args: { toolNames: ['ripple_delete'], sliceFrom: 'T1' },
          },
          deps: ['T1'],
        },
      ],
    });
    const provider = new SequencedProvider([INTENT_RESPONSE, noPatchPlan, PROPOSE_EDIT_RESPONSE]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(provider.calls).toBe(3);
    expect(events.some((e) => e.type === 'diff')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('projects an assembled cut into a later polish proposal and returns one combined patch', async () => {
    const multiStagePlan = JSON.stringify({
      steps: [
        {
          id: 'build',
          label: 'Build the montage',
          effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['add_clip'] } },
        },
        {
          id: 'assembly',
          label: 'Assemble the montage',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['build'],
        },
        {
          id: 'assembly_check',
          label: 'Verify the montage',
          effect: { kind: 'verify', name: 'verify', args: { goal: 'montage assembled' } },
          deps: ['assembly'],
        },
        {
          id: 'polish',
          label: 'Add transitions, grade, and motion accents',
          effect: {
            kind: 'model',
            name: 'propose_edit',
            args: { toolNames: ['add_transition', 'apply_color_grade', 'add_keyframes'] },
          },
          deps: ['assembly_check'],
        },
      ],
    });
    const firstClipId = 'clip__video_2_broll_0';
    const secondClipId = 'clip__video_2_broll_2000';
    const buildResponse = JSON.stringify({
      toolCalls: [
        {
          name: 'add_clip',
          arguments: { trackId: 'video_2', assetId: 'broll', start: 0, end: 2 },
        },
        {
          name: 'add_clip',
          arguments: { trackId: 'video_2', assetId: 'broll', start: 2, end: 4, sourceStart: 2 },
        },
      ],
    });
    const polishResponse = JSON.stringify({
      toolCalls: [
        {
          name: 'add_transition',
          arguments: {
            trackId: 'video_2',
            fromClipId: firstClipId,
            toClipId: secondClipId,
            kind: 'cross-dissolve',
            durationSeconds: 0.2,
          },
        },
        {
          name: 'apply_color_grade',
          arguments: { clipId: firstClipId, params: { contrast: 0.8 } },
        },
        {
          name: 'add_keyframes',
          arguments: {
            clipId: secondClipId,
            keyframes: [
              { time: 0, property: 'scale', value: 1 },
              { time: 2, property: 'scale', value: 1.08 },
            ],
          },
        },
      ],
    });
    const provider = new SequencedProvider([
      INTENT_RESPONSE,
      multiStagePlan,
      buildResponse,
      polishResponse,
    ]);
    const project = plannedEditProject();
    const orch = new Orchestrator(provider, { executor: silenceExecutor });

    const events = await collect(
      orch.streamPlannedEdit({ project, userPrompt: 'build and polish a montage' }, opts),
    );

    expect(provider.calls).toBe(4);
    expect(provider.requests[3]?.messages[1]?.content).toContain(`"clipId":"${firstClipId}"`);
    expect(provider.requests[3]?.messages[1]?.content).toContain(`"clipId":"${secondClipId}"`);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
    const diff = events.find((event) => event.type === 'diff') as
      | { edit?: { validation: { valid: boolean }; patch: { operations: unknown[] } } }
      | undefined;
    expect(diff?.edit?.validation.valid).toBe(true);
    expect(diff?.edit?.patch.operations).toHaveLength(5);
    expect(diff?.edit?.patch.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'add_clip', assetId: 'broll' }),
        expect.objectContaining({ type: 'add_transition', fromClipId: firstClipId }),
        expect.objectContaining({ type: 'apply_color_grade', clipId: firstClipId }),
        expect.objectContaining({ type: 'add_keyframes', clipId: secondClipId }),
      ]),
    );
  });

  it('preserves a validated assembled cut when a later refinement exhausts its retries', async () => {
    const multiStagePlan = JSON.stringify({
      steps: [
        {
          id: 'build',
          label: 'Build the montage',
          effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['add_clip'] } },
        },
        {
          id: 'assembly',
          label: 'Assemble the montage',
          effect: { kind: 'patch', name: 'assemble_patch' },
          deps: ['build'],
        },
        {
          id: 'assembly_check',
          label: 'Verify the montage',
          effect: { kind: 'verify', name: 'verify', args: { goal: 'montage assembled' } },
          deps: ['assembly'],
        },
        {
          id: 'polish',
          label: 'Add transitions, grade, and motion accents',
          effect: {
            kind: 'model',
            name: 'propose_edit',
            args: { toolNames: ['add_transition', 'apply_color_grade', 'add_keyframes'] },
          },
          deps: ['assembly_check'],
        },
      ],
    });
    const buildResponse = JSON.stringify({
      toolCalls: [
        {
          name: 'add_clip',
          arguments: { trackId: 'video_2', assetId: 'broll', start: 0, end: 2 },
        },
        {
          name: 'add_clip',
          arguments: { trackId: 'video_2', assetId: 'broll', start: 2, end: 4, sourceStart: 2 },
        },
      ],
    });
    const provider = new SequencedProvider([
      INTENT_RESPONSE,
      multiStagePlan,
      buildResponse,
      JSON.stringify({ toolCalls: [] }),
      'I cannot produce that edit right now.',
      JSON.stringify({ toolCalls: [] }),
    ]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });

    const events = await collect(
      orch.streamPlannedEdit(
        { project: plannedEditProject(), userPrompt: 'build a montage' },
        opts,
      ),
    );

    expect(provider.calls).toBe(6);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'task_finished', taskId: 'polish', status: 'warning' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notification',
        text: expect.stringContaining('Preserving the validated earlier edit'),
      }),
    );
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
    const diff = events.find((event) => event.type === 'diff') as
      | { edit?: { validation: { valid: boolean }; patch: { operations: unknown[] } } }
      | undefined;
    expect(diff?.edit?.validation.valid).toBe(true);
    expect(diff?.edit?.patch.operations).toHaveLength(2);
    expect(diff?.edit?.patch.operations).toEqual([
      expect.objectContaining({ type: 'add_clip', assetId: 'broll', start: 0, end: 2 }),
      expect.objectContaining({ type: 'add_clip', assetId: 'broll', start: 2, end: 4 }),
    ]);
  });

  it('rejects at the gate a plan that mixes recognised tasks with an unknown leaf', async () => {
    // isRecognizedPlan (P3.2) checks every node, so one bad leaf name among otherwise
    // recognised tasks still fails the whole gate — never a partial run.
    const planWithUnknownLeaf = JSON.stringify({
      steps: [
        { id: 'T0', label: 'bogus', effect: { kind: 'analysis', name: 'no_such_leaf', args: {} } },
        {
          id: 'T1',
          label: 'analyze_silence(video_1)',
          effect: { kind: 'host_tool', name: 'analyze_silence', args: { trackId: 'video_1' } },
        },
        {
          id: 'T2',
          label: 'tighten the start',
          effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
        },
      ],
    });
    const provider = new SequencedProvider([INTENT_RESPONSE, planWithUnknownLeaf]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    // Only intent + planner were consulted — the gate rejected the plan before any task ran.
    expect(provider.calls).toBe(2);
    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const notice = events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({ text: PLANNED_EDIT_UNSUPPORTED_NOTICE });
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('threads a selection into IntentParser and degrades honestly with no executor wired', async () => {
    const provider = new SequencedProvider([INTENT_RESPONSE, PACING_PLAN_RESPONSE]);
    const orch = new Orchestrator(provider); // no executor — host tools can't run
    const input: ContextInput = {
      project: plannedEditProject(),
      userPrompt: 'tighten the pacing',
      selection: { start: 0, end: 2 },
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });

  it('still rejects an unknown/non-mutate tool name at run time for a recognised plan shape', async () => {
    const badPlan = JSON.stringify({
      steps: [
        {
          id: 'T1',
          label: 'x',
          effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['detect_beats'] } },
        },
      ],
    });
    // This gate check is structural (task effect kinds/names), so a `model`/`propose_edit`
    // task always passes it — the "not a mutate tool" rejection happens inside the task
    // itself, at run time, which this asserts end to end.
    const provider = new SequencedProvider([INTENT_RESPONSE, badPlan]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = { project: plannedEditProject(), userPrompt: 'tighten the pacing' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(events.some((e) => e.type === 'diff')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'failed' });
  });
});

describe('Orchestrator.streamPlannedEdit — a RECIPE_LEAVES-composed plan shape (P11.1)', () => {
  // Proves the P11.1 widening live: a Planner-authored plan naming `find_hook`/
  // `synth_hook_restructure` (leaves in `RECIPE_LEAVES`) passes `isRecognizedPlan`'s gate
  // and actually runs through `executePlannedEdit`'s default `RECIPE_LEAVES` registry. No
  // `host_tool`/`model` step at all: the transcript is already in the project doc, so this
  // plan needs no further model call beyond IntentParser + Planner.
  const HOOK_INTENT_RESPONSE = JSON.stringify({
    goal: 'open on the hook',
    targets: ['video_1'],
    constraints: [],
  });

  const HOOK_PLAN_RESPONSE = JSON.stringify({
    steps: [
      {
        id: 'T1',
        label: 'find the hook',
        effect: { kind: 'analysis', name: 'find_hook', args: {} },
      },
      {
        id: 'T2',
        label: 'trim the dead lead-in',
        effect: { kind: 'analysis', name: 'synth_hook_restructure', args: { from: 'T1' } },
        deps: ['T1'],
      },
      {
        id: 'T3',
        label: 'assemble & validate patch',
        effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'T2' } },
        deps: ['T2'],
      },
      {
        id: 'T4',
        label: 'verify(opens on the hook)',
        effect: { kind: 'verify', name: 'verify', args: { goal: 'opens on the hook' } },
        deps: ['T3'],
      },
    ],
  });

  /** A project whose first spoken word starts well past the hook threshold, so
   *  `synth_hook_restructure` has real dead lead-in to trim (not a no-op). */
  function hookProject() {
    return makeProject({
      transcript: [
        { word: 'hello', start: 1.2, end: 1.5 },
        { word: 'world', start: 1.5, end: 2 },
      ],
    });
  }

  it('runs a RECIPE_LEAVES-only plan live, through the same gate/registry as any other plan', async () => {
    const provider = new SequencedProvider([HOOK_INTENT_RESPONSE, HOOK_PLAN_RESPONSE]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const project = hookProject();
    const input: ContextInput = { project, userPrompt: 'open on the hook' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    // Only IntentParser + Planner were consulted — this plan needed no further model call.
    expect(provider.calls).toBe(2);
    const diffEvent = events.find((e) => e.type === 'diff');
    expect(diffEvent).toBeDefined();
    const edit = (
      diffEvent as {
        edit: { patch: { operations: readonly unknown[] }; validation: { valid: boolean } };
      }
    ).edit;
    expect(edit.validation.valid).toBe(true);
    expect(edit.patch.operations).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });

    const after = applyProjectPatch(project, (edit as { patch: never }).patch);
    const inverse = invertProjectPatch(project, (edit as { patch: never }).patch);
    const restored = applyProjectPatch(after, inverse);
    expect(diffProject(project, restored).summary).toEqual(['no changes']);
  });
});

describe('Orchestrator.streamPlannedEdit — honest fallback reason (P11.2)', () => {
  // The `notification` event that ends an unsupported run now carries a machine-
  // inspectable `reason` + specific `detail`, in addition to the unchanged `text` constant
  // existing string-matching callers (e.g. `AiSidebar`) already rely on.
  it('tags an unparseable IntentParser response with reason "intent_unparseable"', async () => {
    const provider = new SequencedProvider(['not json at all']);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = {
      project: plannedEditProject(),
      userPrompt: 'do something creative',
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    const notice = events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({
      text: PLANNED_EDIT_UNSUPPORTED_NOTICE,
      reason: 'intent_unparseable',
    });
    expect((notice as { detail?: string }).detail).toBeTruthy();
  });

  it('tags an unparseable Planner response with reason "plan_unparseable"', async () => {
    const provider = new SequencedProvider([INTENT_RESPONSE, 'not json at all']);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = {
      project: plannedEditProject(),
      userPrompt: 'do something creative',
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    const notice = events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({
      text: PLANNED_EDIT_UNSUPPORTED_NOTICE,
      reason: 'plan_unparseable',
    });
  });

  it('warms the semantic index from the brain hook and survives a failing hook (B1.4)', async () => {
    // A hook that returns a warmed bag: the run completes and the hook was
    // consulted with the project's id, before the Planner request was built.
    const provider = new SequencedProvider([
      INTENT_RESPONSE,
      PACING_PLAN_RESPONSE,
      PROPOSE_EDIT_RESPONSE,
    ]);
    const warmAnalysis = vi.fn().mockResolvedValue(undefined);
    const orch = new Orchestrator(provider, { executor: silenceExecutor, warmAnalysis });
    const project = plannedEditProject();
    const input: ContextInput = { project, userPrompt: 'tighten the pacing' };
    const events = await collect(orch.streamPlannedEdit(input, opts));
    expect(warmAnalysis).toHaveBeenCalledWith(project.id);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });

    // A REJECTING hook degrades to the bag-less pre-B1.4 behavior — never a broken run.
    const failing = new Orchestrator(
      new SequencedProvider([INTENT_RESPONSE, PACING_PLAN_RESPONSE, PROPOSE_EDIT_RESPONSE]),
      { executor: silenceExecutor, warmAnalysis: () => Promise.reject(new Error('brain down')) },
    );
    const survived = await collect(failing.streamPlannedEdit(input, opts));
    expect(survived.at(-1)).toMatchObject({ type: 'status', status: 'completed' });

    // A hook that rejects with a non-Error value still degrades honestly (stringified).
    const failingNonError = new Orchestrator(
      new SequencedProvider([INTENT_RESPONSE, PACING_PLAN_RESPONSE, PROPOSE_EDIT_RESPONSE]),
      { executor: silenceExecutor, warmAnalysis: () => Promise.reject('brain down') },
    );
    const survivedNonError = await collect(failingNonError.streamPlannedEdit(input, opts));
    expect(survivedNonError.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('logs when the brain hook returns an actual warmed bag (B1.4)', async () => {
    const provider = new SequencedProvider([
      INTENT_RESPONSE,
      PACING_PLAN_RESPONSE,
      PROPOSE_EDIT_RESPONSE,
    ]);
    const warmAnalysis = vi.fn().mockResolvedValue({ shots: { assetId: 'broll', cuts: [] } });
    const orch = new Orchestrator(provider, { executor: silenceExecutor, warmAnalysis });
    const project = plannedEditProject();
    const input: ContextInput = { project, userPrompt: 'tighten the pacing' };
    const events = await collect(orch.streamPlannedEdit(input, opts));
    expect(warmAnalysis).toHaveBeenCalledWith(project.id);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('tags a dangling-dep (non-compiling) plan with reason "plan_uncompilable"', async () => {
    const uncompilablePlan = JSON.stringify({
      steps: [
        {
          label: 'edit',
          effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
          deps: ['ghost'],
        },
      ],
    });
    const provider = new SequencedProvider([INTENT_RESPONSE, uncompilablePlan]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = {
      project: plannedEditProject(),
      userPrompt: 'do something creative',
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    const notice = events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({
      text: PLANNED_EDIT_UNSUPPORTED_NOTICE,
      reason: 'plan_uncompilable',
    });
    expect((notice as { detail?: string }).detail).toMatch(/ghost/);
  });

  it('tags a structurally-unrecognised plan with reason "unrecognized_task_shape"', async () => {
    const unrecognizedPlan = JSON.stringify({
      steps: [
        { label: 'mystery', effect: { kind: 'analysis', name: 'totally_unknown_leaf', args: {} } },
      ],
    });
    const provider = new SequencedProvider([INTENT_RESPONSE, unrecognizedPlan]);
    const orch = new Orchestrator(provider, { executor: silenceExecutor });
    const input: ContextInput = {
      project: plannedEditProject(),
      userPrompt: 'do something creative',
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    const notice = events.find((e) => e.type === 'notification');
    expect(notice).toMatchObject({
      text: PLANNED_EDIT_UNSUPPORTED_NOTICE,
      reason: 'unrecognized_task_shape',
    });
  });
});

describe('Orchestrator.streamPlannedEdit — semantic-index enrichment (P4.1/P4.2)', () => {
  // A provider that also records every request it was asked to complete, so a test can
  // inspect exactly what the model was told for a given call (here: `propose_edit`'s turn).
  class RecordingProvider implements AiProvider {
    public readonly name = 'mock' as const;
    public calls = 0;
    public readonly requests: AiCompletionRequest[] = [];
    public constructor(private readonly responses: readonly string[]) {}
    public async complete(request: AiCompletionRequest): Promise<AiResponse> {
      this.requests.push(request);
      const text = this.responses[this.calls];
      this.calls += 1;
      if (text === undefined) throw new Error(`unexpected model call #${String(this.calls)}`);
      return { text };
    }
  }

  /** `broll`/`music` actually placed on the timeline, so P4.1 ingestion has a clip to
   *  translate the analysis results through. */
  function placedProject() {
    return makeProject({
      assets: [
        { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 },
        { id: 'music', path: 'media/music.mp3', kind: 'audio', durationSeconds: 10 },
        { id: 'broll', path: 'media/broll.mp4', kind: 'video', durationSeconds: 8 },
      ],
      timeline: {
        tracks: [
          {
            id: 'video_1',
            type: 'video',
            clips: [
              {
                id: 'clip_a',
                assetId: 'asset_1',
                trackId: 'video_1',
                start: 0,
                end: 6,
                sourceStart: 0,
                sourceEnd: 6,
                effects: [],
                keyframes: [],
              },
            ],
          },
          {
            id: 'video_2',
            type: 'video',
            clips: [
              {
                id: 'clip_broll',
                assetId: 'broll',
                trackId: 'video_2',
                start: 6,
                end: 14,
                sourceStart: 0,
                sourceEnd: 8,
                effects: [],
                keyframes: [],
              },
            ],
          },
          {
            id: 'audio_1',
            type: 'audio',
            clips: [
              {
                id: 'clip_music',
                assetId: 'music',
                trackId: 'audio_1',
                start: 0,
                end: 10,
                sourceStart: 0,
                sourceEnd: 10,
                effects: [],
                keyframes: [],
              },
            ],
          },
        ],
      },
    });
  }

  /** broll/music as bare assets (not placed) — P4.1 must not fabricate a placement. */
  function bareAssetsProject() {
    return makeProject({
      assets: [
        { id: 'asset_1', path: 'media/a.mp4', kind: 'video', durationSeconds: 30 },
        { id: 'music', path: 'media/music.mp3', kind: 'audio', durationSeconds: 10 },
        { id: 'broll', path: 'media/broll.mp4', kind: 'video', durationSeconds: 8 },
      ],
    });
  }

  const ENRICHMENT_PLAN_RESPONSE = JSON.stringify({
    steps: [
      {
        id: 'T1',
        label: 'detect_scenes(broll)',
        effect: { kind: 'host_tool', name: 'detect_scenes', args: { assetId: 'broll' } },
        resource: 'ffmpeg',
        priority: 'analysis',
      },
      {
        id: 'T2',
        label: 'detect_beats(music)',
        effect: { kind: 'host_tool', name: 'detect_beats', args: { assetId: 'music' } },
        resource: 'ffmpeg',
        priority: 'analysis',
      },
      {
        id: 'T3',
        label: 'propose an edit',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
        deps: ['T1', 'T2'],
      },
    ],
  });

  const enrichmentExecutor: HostToolExecutor = {
    async run(call: ToolCall): Promise<HostToolOutcome> {
      if (call.name === 'detect_scenes') {
        return {
          status: 'completed',
          summary: 'Found 2 scene cuts',
          data: { assetId: 'broll', cuts: [{ time: 2 }, { time: 5 }] },
        };
      }
      if (call.name === 'detect_beats') {
        return {
          status: 'completed',
          summary: 'Found 4 beats',
          data: {
            assetId: 'music',
            beats: [
              { time: 0, strength: 1 },
              { time: 1, strength: 1 },
              { time: 2, strength: 1 },
              { time: 3, strength: 1 },
            ],
            bpm: 120,
          },
        };
      }
      return { status: 'failed', summary: `unexpected tool "${call.name}"` };
    },
  };

  it('announces the pre-plan phases so the wait before the plan exists is visible', async () => {
    // Understanding and planning are two model calls that precede the plan, so
    // there is nothing in the transcript to attach their progress to. Measured on
    // a real session they took 38 seconds together, during which the sidebar
    // showed no step at all and the run read as hung. They are announced as tasks
    // — the same vocabulary the step list already renders — and settled, so
    // neither can sit spinning after the run moves on.
    const proposeEditResponse = JSON.stringify({
      toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
    });
    const provider = new RecordingProvider([
      INTENT_RESPONSE,
      ENRICHMENT_PLAN_RESPONSE,
      proposeEditResponse,
    ]);
    const orch = new Orchestrator(provider, { executor: enrichmentExecutor });
    const input: ContextInput = { project: placedProject(), userPrompt: 'cut this to the beat' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    const started = events
      .filter((e) => e.type === 'task_started')
      .map((e) => (e as { taskId: string; label: string }).taskId);
    // First, and in order: you cannot plan before you have understood.
    expect(started.slice(0, 2)).toEqual(['understand', 'plan']);

    for (const phase of ['understand', 'plan']) {
      const startedAt = events.findIndex(
        (e) => e.type === 'task_started' && (e as { taskId: string }).taskId === phase,
      );
      const finishedAt = events.findIndex(
        (e) => e.type === 'task_finished' && (e as { taskId: string }).taskId === phase,
      );
      expect(finishedAt).toBeGreaterThan(startedAt);
      expect(events[finishedAt]).toMatchObject({ status: 'completed' });
    }
    // Both phases settle before the DAG's own first task starts — the phases are
    // what produce that DAG, so a still-running "plan" alongside a running step
    // would be describing work that has already finished.
    const planDone = events.findIndex(
      (e) => e.type === 'task_finished' && (e as { taskId: string }).taskId === 'plan',
    );
    const firstDagTask = events.findIndex(
      (e) =>
        e.type === 'task_started' &&
        !['understand', 'plan'].includes((e as { taskId: string }).taskId),
    );
    expect(firstDagTask).toBeGreaterThan(planDone);
  });

  it('dispatches the two independent analyses (detect_scenes ∥ detect_beats) in one batch', async () => {
    const proposeEditResponse = JSON.stringify({
      toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
    });
    const provider = new RecordingProvider([
      INTENT_RESPONSE,
      ENRICHMENT_PLAN_RESPONSE,
      proposeEditResponse,
    ]);
    const orch = new Orchestrator(provider, { executor: enrichmentExecutor });
    const input: ContextInput = { project: placedProject(), userPrompt: 'cut this to the beat' };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    // The two analyses share no dep edge, so the scheduler dispatches them together.
    // Filtered to the DAG's own nodes: the run also announces its pre-plan phases
    // ("understand", "plan") as tasks so the sidebar can show that wait, and those
    // legitimately arrive first — they are what produces this plan.
    const PHASES = new Set(['understand', 'plan']);
    const started = events
      .filter((e) => e.type === 'task_started')
      .map((e) => (e as { taskId: string }).taskId)
      .filter((taskId) => !PHASES.has(taskId));
    expect(new Set(started.slice(0, 2))).toEqual(new Set(['T1', 'T2']));
  });

  it("feeds propose_edit's request real, non-empty shots/beats from this run's own completed analyses", async () => {
    const proposeEditResponse = JSON.stringify({
      toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
    });
    const provider = new RecordingProvider([
      INTENT_RESPONSE,
      ENRICHMENT_PLAN_RESPONSE,
      proposeEditResponse,
    ]);
    const orch = new Orchestrator(provider, { executor: enrichmentExecutor });
    const input: ContextInput = {
      project: placedProject(),
      userPrompt: 'cut this to the beat',
    };

    const events = await collect(orch.streamPlannedEdit(input, opts));

    expect(provider.calls).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });

    // The third call is `propose_edit`'s — assert its user turn actually carries populated
    // shots/beats (translated into timeline time), not the honest-empty `[]`/`null` a
    // caller would see with no analysis bag at all.
    const proposeEditRequest = provider.requests[2];
    expect(proposeEditRequest).toBeDefined();
    const context = parseSliceContext(proposeEditRequest);
    // detect_scenes cuts [2,5] on `broll` (placed at timeline offset +6) -> one shot [8,11).
    expect(context.shots).toEqual([{ start: 8, end: 11, sourceClipId: 'clip_broll' }]);
    // detect_beats [0,1,2,3] on `music` (placed 1:1 at timeline 0) -> the same beat grid.
    expect(context.beats).toEqual({ times: [0, 1, 2, 3], bpm: 120 });
  });

  it("stays honestly empty when the analyzed asset isn't placed on the timeline", async () => {
    // Same plan/executor, but against bare assets (broll/music exist as assets, not as
    // timeline clips) — P4.1 must not fabricate a placement for unplaced media.
    const proposeEditResponse = JSON.stringify({
      toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
    });
    const provider = new RecordingProvider([
      INTENT_RESPONSE,
      ENRICHMENT_PLAN_RESPONSE,
      proposeEditResponse,
    ]);
    const orch = new Orchestrator(provider, { executor: enrichmentExecutor });
    const input: ContextInput = {
      project: bareAssetsProject(),
      userPrompt: 'cut this to the beat',
    };

    await collect(orch.streamPlannedEdit(input, opts));

    const context = parseSliceContext(provider.requests[2]);
    expect(context.shots).toEqual([]);
    expect(context.beats).toBeNull();
  });
});
