/**
 * The canonical conformance scenario set for FramePilot's single mutating AI runtime
 * (`plan/FRAMEPILOT-95-CONVERGENCE-ROADMAP.md` §6).
 *
 * Each row is a user goal the retired `planned_edit` route existed to serve, now expressed
 * once — as the agent's tool-calling turns — with a hard expectation. Together they hold the
 * line the Phase-1 parity gate proved: the one runtime covers the analysis-then-mutate work,
 * cancels honestly, never lets a malformed call reach the timeline, and keeps every patch
 * reversible.
 *
 * The set is deliberately small and load-bearing rather than broad. A row that asserts
 * nothing another row does not is noise in a suite whose job is to make a break obvious.
 */
import { makeProject } from './__fixtures__/project.js';
import type { RuntimeConformanceScenario } from './mutating-runtime-conformance.js';
import type { HostExecutionContext, HostToolExecutor, HostToolOutcome } from './tool-executor.js';
import type { ToolCall } from './providers/types.js';

/** A three-track fixture with music and B-roll, so montage rows have something to cut with. */
function conformanceProject(): ReturnType<typeof makeProject> {
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

/** Reports a steady 120 BPM grid — the analysis `planned_edit` existed to acquire. */
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
 * analysis was in flight" without a sleep.
 */
const cancellingExecutor = (controller: AbortController): HostToolExecutor => ({
  async run(call: ToolCall): Promise<HostToolOutcome> {
    controller.abort();
    return { status: 'cancelled', summary: `Stopped "${call.name}" — run cancelled` };
  },
});

/** Fails every call with a typed host failure, so the run must report it honestly. */
const failingExecutor = (): HostToolExecutor => ({
  async run(call: ToolCall): Promise<HostToolOutcome> {
    return { status: 'failed', summary: `The media engine is not running (${call.name}).` };
  },
});

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (...calls: ToolCall[]) => ({ text: '', toolCalls: calls });
const finished = { text: 'Done.', toolCalls: [] };

export const RUNTIME_CONFORMANCE_SCENARIOS: readonly RuntimeConformanceScenario[] = [
  {
    id: 'silence-tighten',
    tier: 'B',
    goal: 'tighten the pacing at the start',
    rationale: 'the plainest analysis-dependent edit: find dead air, then ripple it out',
    project: conformanceProject,
    agentScript: [
      turn(call('c1', 'analyze_silence', { assetId: 'asset_1' })),
      turn(call('c2', 'ripple_delete', { trackId: 'video_1', start: 2, end: 3 })),
      finished,
    ],
    executor: silenceExecutor,
    expect: { terminalStatus: 'completed', operationKinds: ['ripple_delete'], maxModelCalls: 4 },
  },
  {
    id: 'beat-sync-montage',
    tier: 'C',
    goal: 'cut a short montage on the music beats',
    rationale:
      'beat synchronisation is the capability `planned_edit` was written for; the one ' +
      'runtime must reach it through detect_beats + add_clip. The model names `video_2`, ' +
      'which sits BEHIND `video_1` and its 0–6s clip, so the shots would be invisible there: ' +
      'under ADR 0169 the runtime lifts them to a front layer opened in the same patch, ' +
      'one `add_layer` for the whole montage, never one per shot',
    project: conformanceProject,
    agentScript: [
      turn(call('c1', 'detect_beats', { assetId: 'music' })),
      turn(
        call('c2', 'add_clip', {
          trackId: 'video_2',
          assetId: 'broll',
          start: 0,
          end: 0.5,
          sourceStart: 0,
        }),
        call('c3', 'add_clip', {
          trackId: 'video_2',
          assetId: 'broll',
          start: 0.5,
          end: 1,
          sourceStart: 2,
        }),
      ),
      finished,
    ],
    executor: beatExecutor,
    expect: {
      terminalStatus: 'completed',
      operationKinds: ['add_layer', 'add_clip', 'add_clip'],
      maxModelCalls: 4,
    },
  },
  {
    id: 'cancel-during-analysis',
    tier: 'E',
    goal: 'tighten the pacing at the start',
    rationale:
      'Stop pressed mid-analysis must settle cancelled with nothing proposed — a run that ' +
      'carries on and reports completed would present post-cancel work as a finished edit',
    project: conformanceProject,
    agentScript: [
      turn(call('c1', 'analyze_silence', { assetId: 'asset_1' })),
      turn(call('c2', 'ripple_delete', { trackId: 'video_1', start: 2, end: 3 })),
      finished,
    ],
    cancels: true,
    executor: cancellingExecutor,
    expect: { terminalStatus: 'cancelled', operationKinds: [], maxModelCalls: 2 },
  },
  {
    id: 'analysis-backend-unavailable',
    tier: 'E',
    goal: 'tighten the pacing at the start',
    rationale:
      'a media engine outage must not read as a quiet "completed, nothing changed"',
    project: conformanceProject,
    agentScript: [turn(call('c1', 'analyze_silence', { assetId: 'asset_1' })), finished],
    executor: failingExecutor,
    expect: { terminalStatus: 'failed', operationKinds: [], maxModelCalls: 3 },
  },
  {
    id: 'invalid-tool-arguments',
    tier: 'E',
    goal: 'remove the silence',
    rationale:
      'arguments no tool accepts must be rejected at the trust boundary — never dispatched ' +
      'to the host and never turned into a mutation',
    project: conformanceProject,
    agentScript: [
      turn(call('c1', 'analyze_silence', { assetId: 'asset_1' })),
      turn(call('c2', 'ripple_delete', { trackId: 'video_1', start: 'two', end: null })),
      finished,
    ],
    executor: silenceExecutor,
    expect: { terminalStatus: 'failed', operationKinds: [], maxModelCalls: 4 },
  },
];
