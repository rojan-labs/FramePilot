import { describe, expect, it } from 'vitest';
import { makeProject } from './__fixtures__/project.js';
import type { ContextInput } from './context-builder.js';
import type { AiEvent } from './events.js';
import type { EditorRunStageEvent } from './kernel/editor-run-lifecycle.js';
import { Orchestrator, type EditorRunRequest, type StreamOptions } from './orchestrator.js';
import { createSteeringQueue } from './run-controls.js';
import { MockProvider } from './providers/mock.js';
import type { AiCompletionRequest, AiProvider, AiResponse } from './providers/types.js';
import type { TemporalEvidenceRequest, TemporalEvidenceResult } from './temporal-review.js';

const input: ContextInput = { project: makeProject(), userPrompt: 'tighten the intro' };
const options: StreamOptions = {
  conversationId: 'conv_editor_run',
  turnId: 'turn_editor_run',
  now: () => 1000,
};

class ScriptedProvider implements AiProvider {
  public readonly name = 'mock' as const;
  public readonly modelId = 'mock';
  private index = 0;
  public callCount = 0;

  public constructor(private readonly responses: readonly AiResponse[]) {}

  public async complete(_request: AiCompletionRequest): Promise<AiResponse> {
    this.callCount += 1;
    const response = this.responses[Math.min(this.index, this.responses.length - 1)]!;
    this.index += 1;
    return response;
  }
}

async function collect(stream: AsyncIterable<AiEvent>): Promise<readonly AiEvent[]> {
  const events: AiEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function direct(request: EditorRunRequest): AsyncGenerator<AiEvent> {
  const orchestrator = new Orchestrator(new MockProvider());
  switch (request.route) {
    case 'edit':
      return orchestrator.streamEdit(
        input,
        options,
        request.variations ? { variations: true } : {},
      );
    case 'planned_edit':
      return orchestrator.streamPlannedEdit(input, options);
    case 'agent':
      return orchestrator.streamAgent(input, options, request.agentOptions ?? {});
  }
}

function passingEvidence(
  requests: readonly TemporalEvidenceRequest[],
): readonly TemporalEvidenceResult[] {
  return requests.map((request): TemporalEvidenceResult => {
    const base = {
      schemaVersion: 1 as const,
      requestId: request.requestId,
      projectRevision: request.projectRevision,
    };
    if (request.kind === 'frame') {
      return {
        ...base,
        kind: 'frame',
        sample: { frame: request.atFrame, luma: 0.4, blackRatio: 0 },
      };
    }
    if (request.kind === 'range') {
      const samples = [];
      for (
        let frame = request.startFrame;
        frame < request.endFrame;
        frame += request.sampleEveryFrames
      ) {
        samples.push({ frame, luma: 0.4, blackRatio: 0 });
      }
      return { ...base, kind: 'range', samples };
    }
    if (request.kind === 'audio') {
      return {
        ...base,
        kind: 'audio',
        samples: [
          {
            startFrame: request.startFrame,
            endFrame: request.endFrame,
            peakDbfs: -1,
            rmsDbfs: -18,
            boundaryJumpDb: 1,
          },
        ],
      };
    }
    throw new Error(`Unexpected automatic evidence request: ${request.kind}`);
  });
}

describe('streamEditorRun route adapters', () => {
  it.each([
    { route: 'edit' },
    { route: 'planned_edit' },
    { route: 'agent', agentOptions: { maxSteps: 1, autoRepair: false } },
  ] satisfies readonly EditorRunRequest[])(
    'preserves the exact legacy event stream for $route',
    async (request) => {
      const legacyEvents = await collect(direct(request));
      const unifiedEvents = await collect(
        new Orchestrator(new MockProvider()).streamEditorRun(input, options, request),
      );
      expect(unifiedEvents).toEqual(legacyEvents);
    },
  );

  it('publishes serialisable lifecycle events without adding them to the UI stream', async () => {
    const lifecycle: EditorRunStageEvent[] = [];
    const orchestrator = new Orchestrator(new MockProvider());
    const events = await collect(
      orchestrator.streamEditorRun(
        input,
        { ...options, runId: 'durable_run' },
        { route: 'edit' },
        {
          onLifecycleEvent: (event) => lifecycle.push(event),
        },
      ),
    );

    expect(events).toEqual(
      await collect(new Orchestrator(new MockProvider()).streamEdit(input, options)),
    );
    expect(lifecycle[0]).toMatchObject({
      runId: 'durable_run',
      route: 'edit',
      stage: 'understand',
      state: 'entered',
    });
    expect(lifecycle.at(-1)).toMatchObject({ stage: 'finalize', state: 'completed' });
    expect(JSON.parse(JSON.stringify(lifecycle))).toEqual(lifecycle);
  });

  // ---------------------------------------------------------------------------
  // Instant apply: the edit reaches the timeline first, review reports afterwards.
  //
  // These tests replace a suite that pinned the opposite contract — diffs staged and
  // withheld until a perceptual gate cleared them, a bounded repair driven BY the review,
  // and a run that failed whenever the gate did not clear. That design made review the
  // run's second writer, which forced every turn to wait for the review of the turn before
  // it and put a 30s–4min render in front of the user seeing any edit at all. Review is now
  // a reader: it produces findings, the agent repairs them in an ordinary turn, and the turn
  // loop is the only writer. The reversal is deliberate and is reasoned here so it is not
  // silently re-reverted. See plan/INSTANT-APPLY.md.
  // ---------------------------------------------------------------------------

  const renderSettings = {
    identity: 'temporal-evidence:1920x1080@30:captions=true',
    presetId: 'temporal-evidence',
    width: 1920,
    height: 1080,
    fps: 30,
    burnCaptions: true,
  } as const;

  it('emits the edit before review has even been consulted', async () => {
    // The load-bearing property of the whole change. The acquirer never settles, so if the
    // diff still arrives, nothing about the edit's delivery is downstream of review.
    let acquisitionStarted = false;
    const events: AiEvent[] = [];
    const stream = new Orchestrator(new MockProvider()).streamEditorRun(
      input,
      { ...options, runId: 'instant_apply' },
      { route: 'edit' },
      {
        temporalEvidence: async () => {
          acquisitionStarted = true;
          return new Promise(() => undefined);
        },
      },
    );

    for await (const event of stream) {
      events.push(event);
      if (event.type === 'diff') break;
    }

    expect(events.at(-1)).toMatchObject({ type: 'diff' });
    expect(acquisitionStarted).toBe(true);
    // Nothing withheld the diff, so no verification verdict could possibly be attached yet.
    expect(events.find((event) => event.type === 'diff')).not.toHaveProperty(
      'verification',
      'verified',
    );
  });

  it('reports no finding and completes when review passes', async () => {
    const lifecycle: EditorRunStageEvent[] = [];
    let reviewedRevision: number | undefined;
    const events = await collect(
      new Orchestrator(new MockProvider()).streamEditorRun(
        input,
        { ...options, runId: 'reviewed_run' },
        { route: 'edit' },
        {
          onLifecycleEvent: (event) => lifecycle.push(event),
          temporalEvidence: async (project, requests) => {
            reviewedRevision = project.timeline.revision ?? 0;
            return { renderSettings, results: passingEvidence(requests) };
          },
        },
      ),
    );

    // Review looks at the project WITH the edit applied — it reviews what landed.
    expect(reviewedRevision).toBe(1);
    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(events.some((event) => event.type === 'review_finding')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('reports an unresolved finding and still completes when review fails', async () => {
    // The clearest reversal. A perceptual complaint about an applied, validated edit is a
    // quality observation, not a reason to declare the user's work a failed run.
    const events = await collect(
      new Orchestrator(new MockProvider()).streamEditorRun(
        input,
        { ...options, runId: 'failed_review' },
        { route: 'edit' },
        {
          temporalEvidence: async () => ({ renderSettings, results: [] }),
        },
      ),
    );

    const finding = events.find((event) => event.type === 'review_finding');
    expect(finding).toMatchObject({ type: 'review_finding', resolved: false, turnIndex: 0 });
    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
    // The finding must arrive before the run is declared over, or the sidebar settles the
    // turn and the user never sees it.
    expect(events.findIndex((event) => event.type === 'review_finding')).toBeLessThan(
      events.length - 1,
    );
  });

  it('never proposes a patch of its own from a failing review', async () => {
    // Review used to call back into streamEdit for a bounded repair. That second writer is
    // what made ordering between turns a problem at all; it must not come back.
    const provider = new ScriptedProvider([
      {
        text: 'Initial edit',
        toolCalls: [
          {
            id: 'initial',
            name: 'delete_range',
            arguments: { trackId: 'video_1', start: 0, end: 3.2 },
          },
        ],
      },
    ]);
    const events = await collect(
      new Orchestrator(provider).streamEditorRun(
        input,
        { ...options, runId: 'no_repair_writer' },
        { route: 'edit' },
        { temporalEvidence: async () => ({ renderSettings, results: [] }) },
      ),
    );

    expect(events.filter((event) => event.type === 'diff')).toHaveLength(1);
    expect(provider.callCount).toBe(1);
  });

  it('hands a finding to the agent through the steering queue', async () => {
    // Findings reach the agent on the same channel a human's mid-run steering uses, so a
    // repair is an ordinary turn rather than a privileged second writer.
    const steering = createSteeringQueue();
    const provider = new ScriptedProvider([
      {
        text: 'Trim the intro',
        toolCalls: [
          {
            id: 'first',
            name: 'delete_range',
            arguments: { trackId: 'video_1', start: 0, end: 1 },
          },
        ],
      },
      { text: 'Done.' },
    ]);
    await collect(
      new Orchestrator(provider).streamEditorRun(
        input,
        { ...options, runId: 'steered_finding' },
        { route: 'agent', agentOptions: { maxSteps: 2, autoRepair: false } },
        {
          agent: { steering },
          temporalEvidence: async () => ({ renderSettings, results: [] }),
        },
      ),
    );

    // Either the agent already consumed it (the repair path worked end to end) or it is
    // still queued; what must never happen is the finding being computed and dropped.
    const queued = steering.take();
    const reachedModel = provider.callCount > 1;
    expect(queued !== undefined || reachedModel).toBe(true);
  });

  it('neither fails the run nor claims verification when the reviewer is unreachable', async () => {
    // An unreachable reviewer is not a verdict about the edit. It must not destroy the work
    // (the bug ADR 0120 fixed), must not fail the run, and must not be mistaken for a clean
    // review — so it is stated plainly instead.
    const events = await collect(
      new Orchestrator(new MockProvider()).streamEditorRun(
        input,
        { ...options, runId: 'unreachable_review' },
        { route: 'edit' },
        {
          temporalEvidence: async () => {
            throw new Error('sidecar unreachable');
          },
        },
      ),
    );

    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'warning' &&
          /sidecar unreachable/i.test(event.text) &&
          /not perceptually checked/i.test(event.text),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'review_finding')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'status', status: 'completed' });
  });

  it('settles as cancelled when the run is aborted during acquisition', async () => {
    const controller = new AbortController();
    const events = await collect(
      new Orchestrator(new MockProvider()).streamEditorRun(
        input,
        { ...options, runId: 'cancelled_review', signal: controller.signal },
        { route: 'edit' },
        {
          temporalEvidence: async () => {
            controller.abort();
            throw new Error('Temporal evidence acquisition was cancelled.');
          },
        },
      ),
    );

    // The edit still reached the user — it was applied and validated before the abort.
    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(events.some((event) => event.type === 'review_finding')).toBe(false);
  });

  it('records a finding from a real adverse semantic verdict', async () => {
    const provider = new ScriptedProvider([
      {
        text: 'Reframe the speaker',
        toolCalls: [
          {
            id: 'motion',
            name: 'add_keyframes',
            arguments: {
              clipId: 'clip_a',
              keyframes: [
                { id: 'x0', property: 'x', time: 0, value: 0, easing: 'linear' },
                { id: 'x1', property: 'x', time: 5, value: 0.2, easing: 'linear' },
              ],
            },
          },
        ],
      },
    ]);
    const events = await collect(
      new Orchestrator(provider).streamEditorRun(
        input,
        { ...options, runId: 'vision_adverse' },
        { route: 'edit' },
        {
          visionReview: {
            reviewer: {
              transport: 'local_pack',
              provider: 'framepilot-subject-intelligence',
              model: 'subject-reviewer',
              promptVersion: 'vision-objective-v1',
              packVersion: '1.0.0+sha256:abc',
            },
            acquire: async (_project, request) =>
              request.frames.map((frame) => ({
                frame,
                imageBase64: 'AAEC',
                mediaType: 'image/jpeg' as const,
              })),
            judge: async () => ({
              verdict: 'fail',
              reason: 'The speaker leaves frame after the move.',
            }),
          },
        },
      ),
    );

    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(events.find((event) => event.type === 'review_finding')).toMatchObject({
      type: 'review_finding',
      resolved: false,
    });
  });

  it('records no finding when semantic review refuses rather than disapproves', async () => {
    // A cloud reviewer without media-egress consent REFUSES to look. That is not an opinion
    // about the edit, and reporting it as one would quietly convert a privacy default into a
    // quality complaint the user cannot act on (ADR 0120's `judged` distinction).
    const provider = new ScriptedProvider([
      {
        text: 'Reframe the speaker',
        toolCalls: [
          {
            id: 'motion',
            name: 'add_keyframes',
            arguments: {
              clipId: 'clip_a',
              keyframes: [
                { id: 'x0', property: 'x', time: 0, value: 0, easing: 'linear' },
                { id: 'x1', property: 'x', time: 5, value: 0.2, easing: 'linear' },
              ],
            },
          },
        ],
      },
    ]);
    let acquired = false;
    const events = await collect(
      new Orchestrator(provider).streamEditorRun(
        input,
        { ...options, runId: 'vision_no_consent' },
        { route: 'edit' },
        {
          visionReview: {
            reviewer: {
              transport: 'cloud',
              provider: 'anthropic',
              model: 'claude',
              promptVersion: 'vision-objective-v1',
            },
            acquire: async (_project, request) => {
              acquired = true;
              return request.frames.map((frame) => ({
                frame,
                imageBase64: 'AAEC',
                mediaType: 'image/jpeg' as const,
              }));
            },
            judge: async () => ({ verdict: 'pass', reason: 'unused' }),
          },
        },
      ),
    );

    // Frames must never leave the machine without consent, so acquisition never runs.
    expect(acquired).toBe(false);
    expect(events.some((event) => event.type === 'review_finding')).toBe(false);
    expect(events.some((event) => event.type === 'diff')).toBe(true);
  });
});
