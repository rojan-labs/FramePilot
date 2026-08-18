/**
 * The canonical Phase-1 route-parity scenario set
 * (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §6.1).
 *
 * Each row is a user goal that the `planned_edit` route was built to serve, expressed twice:
 * once as the planner's intent/plan/propose script, once as the agent's tool-calling turns.
 * The scripts are the ONLY difference — same project, same host evidence, same goal — so a
 * difference in the resulting {@link RouteParityRecord} is a difference in the runtime.
 *
 * The set is deliberately small and load-bearing rather than broad. Every row exists to
 * discharge a specific §6.3 retirement condition; a row that proves nothing new is noise in
 * a gate that has to be read by a human before a deletion.
 */
import { makeProject } from './__fixtures__/project.js';
import type { RouteParityScenario } from './route-parity.js';
import type { HostExecutionContext, HostToolExecutor, HostToolOutcome } from './tool-executor.js';
import type { ToolCall } from './providers/types.js';

/** A three-track fixture with music and B-roll, so montage rows have something to cut with. */
function parityProject(): ReturnType<typeof makeProject> {
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

/** Reports one silent range [2,3] — the real `analyze_silence` host payload shape. */
const silenceExecutor = (): HostToolExecutor => ({
  async run(call: ToolCall, _ctx: HostExecutionContext): Promise<HostToolOutcome> {
    if (call.name !== 'analyze_silence') {
      return { status: 'failed', summary: `unexpected tool "${call.name}"` };
    }
    return {
      status: 'completed',
      summary: 'Found 1 silent range',
      data: { ranges: [{ start: 2, end: 3 }] },
    };
  },
});

/** Reports a steady 120 BPM grid — the analysis `planned_edit` exists to acquire. */
const beatExecutor = (): HostToolExecutor => ({
  async run(call: ToolCall, _ctx: HostExecutionContext): Promise<HostToolOutcome> {
    if (call.name !== 'detect_beats') {
      return { status: 'failed', summary: `unexpected tool "${call.name}"` };
    }
    return {
      status: 'completed',
      summary: 'Detected 4 beats at 120 BPM',
      data: { beats: [0, 0.5, 1, 1.5], bpm: 120 },
    };
  },
});

/**
 * Aborts the run from inside the first tool call — a faithful "user pressed Stop while
 * analysis was in flight" without a sleep. Both routes get the same behavior.
 */
const cancellingExecutor = (controller: AbortController): HostToolExecutor => ({
  async run(call: ToolCall): Promise<HostToolOutcome> {
    controller.abort();
    return { status: 'cancelled', summary: `Stopped "${call.name}" — run cancelled` };
  },
});

/** Fails every call with a typed host failure, so both routes must report it honestly. */
const failingExecutor = (): HostToolExecutor => ({
  async run(call: ToolCall): Promise<HostToolOutcome> {
    return { status: 'failed', summary: `The media engine is not running (${call.name}).` };
  },
});

const intent = (goal: string, targets: readonly string[]): string =>
  JSON.stringify({ goal, targets, constraints: [] });

const proposeStep = (id: string, toolNames: readonly string[], sliceFrom: string, deps: string[]) => ({
  id,
  label: 'propose the edit',
  effect: { kind: 'model', name: 'propose_edit', args: { toolNames, sliceFrom } },
  deps,
});

const tailSteps = (goal: string, after: string) => [
  { id: 'T3', label: 'assemble & validate patch', effect: { kind: 'patch', name: 'assemble_patch' }, deps: [after] },
  { id: 'T4', label: `verify(${goal})`, effect: { kind: 'verify', name: 'verify', args: { goal } }, deps: ['T3'] },
];

const analysisPlan = (tool: string, args: Record<string, unknown>, toolNames: readonly string[], goal: string): string =>
  JSON.stringify({
    steps: [
      {
        id: 'T1',
        label: `${tool}()`,
        effect: { kind: 'host_tool', name: tool, args },
        resource: 'ffmpeg',
        priority: 'analysis',
      },
      proposeStep('T2', toolNames, 'T1', ['T1']),
      ...tailSteps(goal, 'T2'),
    ],
  });

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (...calls: ToolCall[]) => ({ text: '', toolCalls: calls });
const finished = { text: 'Done.', toolCalls: [] };

export const ROUTE_PARITY_SCENARIOS: readonly RouteParityScenario[] = [
  {
    // The plainest analysis-dependent edit: find dead air, then ripple it out. If the agent
    // cannot match this, nothing else in the gate matters.
    id: 'silence-tighten',
    tier: 'B',
    goal: 'tighten the pacing at the start',
    project: parityProject,
    plannedEditScript: [
      intent('tighten the pacing at the start', ['video_1']),
      analysisPlan('analyze_silence', { assetId: 'asset_1' }, ['ripple_delete'], 'pacing tightened'),
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ],
    agentScript: [
      turn(call('c1', 'analyze_silence', { assetId: 'asset_1' })),
      turn(call('c2', 'ripple_delete', { trackId: 'video_1', start: 2, end: 3 })),
      finished,
    ],
    executor: silenceExecutor,
    proves: ['capability', 'cost', 'durability', 'activity_ux', 'review', 'undo', 'failure_honesty'],
  },
  {
    // Beat synchronisation is the capability the classifier's `planned_edit` route was
    // written for (see `kernel/command-classifier.ts`). This row is the direct test of
    // "no planned-edit-only capability remains".
    id: 'beat-sync-montage',
    tier: 'C',
    goal: 'cut a short montage on the music beats',
    project: parityProject,
    plannedEditScript: [
      intent('cut a short montage on the music beats', ['video_2']),
      analysisPlan('detect_beats', { assetId: 'music' }, ['add_clip'], 'montage cut to the beat'),
      JSON.stringify({
        toolCalls: [
          { name: 'add_clip', arguments: { trackId: 'video_2', assetId: 'broll', start: 0, end: 0.5, sourceStart: 0 } },
          { name: 'add_clip', arguments: { trackId: 'video_2', assetId: 'broll', start: 0.5, end: 1, sourceStart: 2 } },
        ],
      }),
    ],
    agentScript: [
      turn(call('c1', 'detect_beats', { assetId: 'music' })),
      turn(
        call('c2', 'add_clip', { trackId: 'video_2', assetId: 'broll', start: 0, end: 0.5, sourceStart: 0 }),
        call('c3', 'add_clip', { trackId: 'video_2', assetId: 'broll', start: 0.5, end: 1, sourceStart: 2 }),
      ),
      finished,
    ],
    executor: beatExecutor,
    proves: ['capability', 'cost', 'durability', 'activity_ux', 'review', 'undo', 'failure_honesty'],
  },
  {
    // Tier E: cancel during analysis. Both routes must settle `cancelled` and neither may
    // present post-cancel work as a completed edit.
    id: 'cancel-during-analysis',
    tier: 'E',
    goal: 'tighten the pacing at the start',
    project: parityProject,
    plannedEditScript: [
      intent('tighten the pacing at the start', ['video_1']),
      analysisPlan('analyze_silence', { assetId: 'asset_1' }, ['ripple_delete'], 'pacing tightened'),
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 2, end: 3 } }],
      }),
    ],
    agentScript: [
      turn(call('c1', 'analyze_silence', { assetId: 'asset_1' })),
      turn(call('c2', 'ripple_delete', { trackId: 'video_1', start: 2, end: 3 })),
      finished,
    ],
    cancels: true,
    executor: cancellingExecutor,
    proves: ['cancellation', 'durability', 'review', 'failure_honesty'],
  },
  {
    // Tier E: the host analysis backend is down. A route that turns an engine outage into a
    // quiet "completed, nothing changed" is dishonest; both must surface it.
    id: 'analysis-backend-unavailable',
    tier: 'E',
    goal: 'tighten the pacing at the start',
    project: parityProject,
    plannedEditScript: [
      intent('tighten the pacing at the start', ['video_1']),
      analysisPlan('analyze_silence', { assetId: 'asset_1' }, ['ripple_delete'], 'pacing tightened'),
      JSON.stringify({ toolCalls: [] }),
    ],
    agentScript: [turn(call('c1', 'analyze_silence', { assetId: 'asset_1' })), finished],
    executor: failingExecutor,
    proves: ['durability', 'review', 'failure_honesty', 'activity_ux'],
  },
  {
    // Tier E: the model emits arguments no tool accepts. The gate cares that a malformed
    // call never becomes a mutation and never becomes a fabricated success.
    id: 'invalid-tool-arguments',
    tier: 'E',
    goal: 'remove the silence',
    project: parityProject,
    plannedEditScript: [
      intent('remove the silence', ['video_1']),
      analysisPlan('analyze_silence', { assetId: 'asset_1' }, ['ripple_delete'], 'silence removed'),
      JSON.stringify({
        toolCalls: [{ name: 'ripple_delete', arguments: { trackId: 'video_1', start: 'two', end: null } }],
      }),
    ],
    agentScript: [
      turn(call('c1', 'analyze_silence', { assetId: 'asset_1' })),
      turn(call('c2', 'ripple_delete', { trackId: 'video_1', start: 'two', end: null })),
      finished,
    ],
    executor: silenceExecutor,
    proves: ['capability', 'durability', 'review', 'undo', 'failure_honesty'],
  },
];
