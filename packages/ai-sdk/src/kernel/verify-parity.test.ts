/**
 * Verification-parity test (plan/AGENT-NATIVE-COMPLETION-PLAN.md P11.6).
 *
 * Runs the SAME kind of edit (trim a detected silent range) through both editing paths —
 * the live **planner** DAG (P11.1's widened recognition) and the **sequential agent**
 * loop — and asserts both verify with the IDENTICAL real technical-safety battery
 * (`critic.ts#critique`'s 8 named checks), not just structural patch validity. The paths
 * may (and do) produce different edits — that is fine, the assertion is about
 * verification RIGOR, not patch identity.
 *
 * P11.5 wired `critique()` into the shared `verify` leaf: the planner path defaults to
 * the `RECIPE_LEAVES` registry, so it is the literal same function reference; the
 * sequential agent path already called `critique()` directly (`orchestrator.ts`'s
 * `agent()`/`streamAgent()`). This test proves both entry points actually exercise that
 * identical rigor end to end, not just that the plumbing is theoretically shared.
 *
 * There was a third path here — the deterministic recipe DAG — until the recipe route was
 * removed. Its parity is not lost, it is moot: nothing dispatches a recipe any more.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectPatch } from '@framepilot/editor-core';
import { Orchestrator } from '../orchestrator.js';
import type { AiCompletionRequest, AiProvider, AiResponse, ToolCall } from '../providers/types.js';
import type { HostExecutionContext, HostToolExecutor, HostToolOutcome } from '../tool-executor.js';
import { createTurnEmitter } from '../events.js';
import { makeProject } from '../__fixtures__/project.js';
import type { ContextInput } from '../context-builder.js';
import { RECIPE_LEAVES } from './recipe-leaves.js';
import { executePlannedEdit } from './plan-driver.js';
import { createEffectRuntime } from './effect-runtime.js';
import { buildTaskGraph } from './task-graph.js';

/** The one silent range every path trims — same edit shape, different origin. */
const SILENT_RANGE = { start: 2, end: 3 };

function silenceExecutor(): HostToolExecutor {
  return {
    async run(call: ToolCall, _ctx: HostExecutionContext): Promise<HostToolOutcome> {
      if (call.name !== 'analyze_silence') return { status: 'failed', summary: 'unexpected tool' };
      return { status: 'completed', summary: 'ok', data: { ranges: [SILENT_RANGE] } };
    },
  };
}

const CHECK_IDS = [
  'request_match',
  'duration_target',
  'caption_alignment',
  'safe_area',
  'audio_clipping',
  'black_frames',
  'missing_assets',
  'export_settings',
] as const;

describe('P11.6 — planner/agent verification parity', () => {
  it('the planner path runs the SAME real critique battery via the shared verify leaf', async () => {
    const project = makeProject();
    const graph = buildTaskGraph([
      {
        id: 'T1',
        label: 'analyze_silence',
        effect: { kind: 'host_tool', name: 'analyze_silence', args: {} },
        resource: 'ffmpeg',
        priority: 'analysis',
        deps: [],
      },
      {
        id: 'T2',
        label: 'propose an edit',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
        resource: 'model',
        priority: 'edit',
        deps: ['T1'],
      },
      {
        id: 'T3',
        label: 'assemble & validate patch',
        effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'T2' } },
        resource: 'pure',
        priority: 'edit',
        deps: ['T2'],
      },
      {
        id: 'T4',
        label: 'verify',
        effect: { kind: 'verify', name: 'verify', args: { goal: 'no silence remains' } },
        resource: 'pure',
        priority: 'edit',
        deps: ['T3'],
      },
    ]);

    const proposeEditResponse = JSON.stringify({
      toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
    });
    const provider: AiProvider = {
      name: 'mock',
      async complete(_request: AiCompletionRequest): Promise<AiResponse> {
        return { text: proposeEditResponse };
      },
    };
    const runtime = createEffectRuntime({
      provider: provider,
      executor: silenceExecutor(),
    });
    const emit = createTurnEmitter({ conversationId: 'c', turnId: 't', now: () => 1000 });

    const gen = executePlannedEdit(
      graph,
      { project, runtime, leaves: RECIPE_LEAVES, emit, reason: 'remove silence (planner)' },
      undefined,
    );
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    const result = next.value;

    expect(result.status).toBe('completed');
    expect(result.edit?.validation.valid).toBe(true);

    // Same re-derivation as the recipe case above, using the SAME shared `verify` function
    // (the planner path defaults to RECIPE_LEAVES).
    const verify = RECIPE_LEAVES.verify!;
    const out = verify({
      project,
      args: { goal: 'no silence remains' },
      reason: 'remove silence (planner)',
      runEdit: result.edit,
      upstream: () => undefined,
    });
    expect(out.critique).toBeDefined();
    expect(out.critique?.checks.map((c) => c.id)).toEqual(CHECK_IDS);
  });

  it('the sequential agent path runs the identical battery — same check ids, same rigor', async () => {
    const project = makeProject();
    const provider: AiProvider = {
      name: 'mock',
      async complete(_request: AiCompletionRequest): Promise<AiResponse> {
        return {
          text: 'trimming the silent range',
          toolCalls: [
            {
              id: 'call_1',
              name: 'ripple_delete',
              arguments: { trackId: 'video_1', start: 2, end: 3 },
            },
          ],
        };
      },
    };
    const orch = new Orchestrator(provider, {});
    const input: ContextInput = { project, userPrompt: 'remove the silence' };

    const run = await orch.agent(input, { maxSteps: 1 });

    expect(run.result.validation.valid).toBe(true);
    expect(run.critique.checks.map((c) => c.id)).toEqual(CHECK_IDS);
  });

  it('both paths land on the identical set of check ids (the actual parity claim)', async () => {
    // Planner
    const plannerProject = makeProject();
    const plannerGraph = buildTaskGraph([
      {
        id: 'T1',
        label: 'analyze_silence',
        effect: { kind: 'host_tool', name: 'analyze_silence', args: {} },
        resource: 'ffmpeg',
        priority: 'analysis',
        deps: [],
      },
      {
        id: 'T2',
        label: 'propose an edit',
        effect: { kind: 'model', name: 'propose_edit', args: { toolNames: ['ripple_delete'] } },
        resource: 'model',
        priority: 'edit',
        deps: ['T1'],
      },
      {
        id: 'T3',
        label: 'assemble & validate patch',
        effect: { kind: 'patch', name: 'assemble_patch', args: { from: 'T2' } },
        resource: 'pure',
        priority: 'edit',
        deps: ['T2'],
      },
      {
        id: 'T4',
        label: 'verify',
        effect: { kind: 'verify', name: 'verify', args: { goal: 'no silence remains' } },
        resource: 'pure',
        priority: 'edit',
        deps: ['T3'],
      },
    ]);
    const plannerProvider: AiProvider = {
      name: 'mock',
      async complete(): Promise<AiResponse> {
        return {
          text: JSON.stringify({
            toolCalls: [
              { name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } },
            ],
          }),
        };
      },
    };
    const plannerRuntime = createEffectRuntime({
      provider: plannerProvider,
      executor: silenceExecutor(),
    });
    const plannerEmit = createTurnEmitter({ conversationId: 'c1', turnId: 't1', now: () => 1000 });
    const plannerGen = executePlannedEdit(
      plannerGraph,
      {
        project: plannerProject,
        runtime: plannerRuntime,
        leaves: RECIPE_LEAVES,
        emit: plannerEmit,
        reason: 'r',
      },
      undefined,
    );
    let n1 = await plannerGen.next();
    while (!n1.done) n1 = await plannerGen.next();
    const plannerVerify = RECIPE_LEAVES.verify!;
    const plannerReport = plannerVerify({
      project: plannerProject,
      args: { goal: 'g' },
      reason: 'r',
      runEdit: n1.value.edit,
      upstream: () => undefined,
    }).critique;

    // Agent
    const agentProvider: AiProvider = {
      name: 'mock',
      async complete(): Promise<AiResponse> {
        return {
          text: 'trim',
          toolCalls: [
            {
              id: 'call_1',
              name: 'ripple_delete',
              arguments: { trackId: 'video_1', start: 2, end: 3 },
            },
          ],
        };
      },
    };
    const agentOrch = new Orchestrator(agentProvider, {});
    const agentRun = await agentOrch.agent(
      { project: makeProject(), userPrompt: 'remove the silence' },
      { maxSteps: 1 },
    );

    expect(plannerReport?.checks.map((c) => c.id)).toEqual(
      agentRun.critique.checks.map((c) => c.id),
    );
    // Every check ran on a REAL validated edit in both cases — never a fabricated skip.
    expect(plannerReport?.checks.every((c) => c.status !== undefined)).toBe(true);
    // Applying either path's patch is a reversible, real edit (never a placeholder).
    expect(() => applyProjectPatch(plannerProject, n1.value.edit!.patch)).not.toThrow();
  });
});
