import { describe, expect, it } from 'vitest';
import {
  aggregate,
  aggregateCalls,
  classifyToolKind,
  extractCalls,
  extractTurns,
  fitFixedOverhead,
  summarize,
  TOOL_KINDS,
} from './measure-edit-latency.mjs';

/** Build a minimal but realistic synthetic event. */
function ev(turnId, ts, type, extra = {}) {
  return { id: `${turnId}:${type}:${ts}`, conversationId: 'c1', turnId, ts, type, ...extra };
}

describe('classifyToolKind', () => {
  it('buckets known host-tool names', () => {
    expect(classifyToolKind('transcribe')).toBe('transcribe');
    expect(classifyToolKind('get_transcript')).toBe('transcribe');
    expect(classifyToolKind('index_media')).toBe('index_media');
    expect(classifyToolKind('map_footage')).toBe('index_media');
    expect(classifyToolKind('render_preview')).toBe('render');
    expect(classifyToolKind('export_video')).toBe('render');
    expect(classifyToolKind('get_frame')).toBe('frame_pulls');
    expect(classifyToolKind('extract_frames')).toBe('frame_pulls');
  });

  it('falls back to other for unrecognised or editor-op tool names', () => {
    expect(classifyToolKind('add_clip')).toBe('other');
    expect(classifyToolKind('totally_unknown_tool')).toBe('other');
  });
});

describe('summarize', () => {
  it('reports n=0 with null stats for an empty/absent sample set', () => {
    expect(summarize([])).toEqual({ n: 0, p50: null, p90: null, max: null });
    expect(summarize([null, undefined, NaN])).toEqual({ n: 0, p50: null, p90: null, max: null });
  });

  it('computes p50/p90/max over a known sample, dropping missing values', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const s = summarize([...samples, null, undefined]);
    expect(s.n).toBe(10);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(60); // index floor(0.5*10)=5 -> value 60
    expect(s.p90).toBe(100); // index floor(0.9*10)=9 -> value 100
  });
});

describe('extractTurns', () => {
  it('measures first-output, first-patch and run-end latency for a normal editing turn', () => {
    const turnId = 't1';
    const conversation = {
      id: 'conv1',
      model: 'claude-opus-5',
      events: [
        ev(turnId, 1000, 'user_message', { text: 'add captions' }),
        ev(turnId, 1050, 'status', { status: 'thinking' }),
        ev(turnId, 1200, 'reasoning', { summaries: ['planning'], done: false }),
        ev(turnId, 1500, 'tool_call', {
          id: `${turnId}:call:1`,
          toolName: 'transcribe',
          status: 'running',
        }),
        ev(turnId, 3500, 'tool_call', {
          id: `${turnId}:call:1`,
          toolName: 'transcribe',
          status: 'completed',
          runtimeMs: 2000,
        }),
        ev(turnId, 3600, 'diff', { edit: {}, scope: 'turn', turnIndex: 0 }),
        ev(turnId, 3700, 'usage', { tokens: 500, usd: 0.01, modelCalls: 3 }),
        ev(turnId, 3750, 'status', { status: 'completed' }),
      ],
    };

    const { turns, turnsWithoutUserMessage } = extractTurns(conversation);
    expect(turnsWithoutUserMessage).toBe(0);
    expect(turns).toHaveLength(1);
    const t = turns[0];
    expect(t.timeToFirstOutputMs).toBe(200); // reasoning at 1200 - user at 1000
    expect(t.timeToFirstPatchMs).toBe(2600); // diff at 3600 - user at 1000
    expect(t.timeToRunEndMs).toBe(2750); // completed at 3750 - user at 1000
    expect(t.modelCalls).toBe(3);
    expect(t.hasPatch).toBe(true);
    expect(t.hasTerminalStatus).toBe(true);
    expect(t.toolMsByKind.transcribe).toBe(2000);
    for (const k of TOOL_KINDS) if (k !== 'transcribe') expect(t.toolMsByKind[k]).toBe(0);
  });

  it('excludes event groups with no user_message from turns, but counts them', () => {
    const conversation = {
      id: 'conv2',
      model: 'mock',
      events: [
        ev('t1', 1000, 'user_message'),
        ev('t1', 1100, 'status', { status: 'completed' }),
        ev('t2', 1200, 'notification', { text: 'Instant · no AI needed' }),
      ],
    };
    const { turns, turnsWithoutUserMessage } = extractTurns(conversation);
    expect(turns).toHaveLength(1);
    expect(turnsWithoutUserMessage).toBe(1);
  });

  it('honestly reports missing fields instead of imputing them', () => {
    const conversation = {
      id: 'conv3',
      model: 'gpt-5.5',
      events: [
        ev('t1', 1000, 'user_message'),
        // No model output, no diff, no usage, no terminal status at all.
      ],
    };
    const { turns } = extractTurns(conversation);
    expect(turns).toHaveLength(1);
    const t = turns[0];
    expect(t.timeToFirstOutputMs).toBeNull();
    expect(t.timeToFirstPatchMs).toBeNull();
    expect(t.timeToRunEndMs).toBeNull();
    expect(t.modelCalls).toBeNull();
    expect(t.hasPatch).toBe(false);
    expect(t.hasTerminalStatus).toBe(false);
  });

  it('parses an explicit "timed out after Nms" review-outcome text as the ground-truth wait', () => {
    const conversation = {
      id: 'conv4',
      model: 'inclusionai/ling-3.0-flash-fin:free',
      events: [
        ev('t1', 1000, 'user_message'),
        ev('t1', 1050, 'diff', { scope: 'turn', turnIndex: 0 }),
        ev('t1', 400000, 'warning', {
          text:
            'Review could not run: Temporal evidence acquisition timed out after 307500ms for 5 request(s). ' +
            'The engine serializes one batch at a time, so this may be a queue behind an export or another ' +
            'run rather than a slow render. Your edits are applied and validated, but were not perceptually checked.',
        }),
        ev('t1', 400050, 'status', { status: 'completed' }),
      ],
    };
    const { turns } = extractTurns(conversation);
    expect(turns[0].reviewWaits).toEqual([{ ms: 307500, source: 'explicit' }]);
  });

  it('derives review wait from the preceding event gap when no explicit duration is present', () => {
    const conversation = {
      id: 'conv5',
      model: 'claude-opus-5',
      events: [
        ev('t1', 1000, 'user_message'),
        ev('t1', 1050, 'diff', { scope: 'turn', turnIndex: 0 }),
        ev('t1', 2000, 'tool_call', { toolName: 'add_transition', status: 'failed', runtimeMs: 0 }),
        ev('t1', 8060, 'review_finding', { turnIndex: 0, detail: 'black frame', resolved: false }),
        ev('t1', 8100, 'status', { status: 'completed' }),
      ],
    };
    const { turns } = extractTurns(conversation);
    expect(turns[0].reviewWaits).toEqual([{ ms: 6060, source: 'derived' }]);
  });

  it('dedupes a tool_call event that transitions from running to completed, keeping runtimeMs', () => {
    const conversation = {
      id: 'conv6',
      model: 'claude-opus-5',
      events: [
        ev('t1', 1000, 'user_message'),
        ev('t1', 1010, 'tool_call', {
          id: 'call-a',
          toolName: 'render_preview',
          status: 'running',
        }),
        ev('t1', 5010, 'tool_call', {
          id: 'call-a',
          toolName: 'render_preview',
          status: 'completed',
          runtimeMs: 4000,
        }),
        ev('t1', 5100, 'status', { status: 'completed' }),
      ],
    };
    const { turns } = extractTurns(conversation);
    expect(turns[0].toolMsByKind.render).toBe(4000);
  });
});

describe('aggregate', () => {
  it('rolls up multiple conversations by model and by pre/post 2026-09-13 date split', () => {
    const before = Date.UTC(2026, 7, 1); // 2026-08-01
    const after = Date.UTC(2026, 8, 20); // 2026-09-20
    const conversations = [
      {
        id: 'a',
        model: 'claude-opus-5',
        events: [
          ev('t1', before, 'user_message'),
          ev('t1', before + 500, 'status', { status: 'completed' }),
          ev('t1', before + 400, 'usage', { modelCalls: 4 }),
        ],
      },
      {
        id: 'b',
        model: 'claude-opus-5',
        events: [
          ev('t1', after, 'user_message'),
          ev('t1', after + 900, 'status', { status: 'completed' }),
          ev('t1', after + 800, 'usage', { modelCalls: 6 }),
        ],
      },
      // A conversation with zero events (e.g. abandoned before any turn) is counted, not crashed on.
      { id: 'c', model: 'mock', events: [] },
    ];

    const report = aggregate(conversations);
    expect(report.conversationsProcessed).toBe(3);
    expect(report.conversationsWithNoEvents).toBe(1);
    expect(report.overall.n).toBe(2);
    expect(report.byModel['claude-opus-5'].n).toBe(2);
    expect(report.byPeriod['before-2026-09-13'].n).toBe(1);
    expect(report.byPeriod['from-2026-09-13'].n).toBe(1);
    expect(report.byPeriod['before-2026-09-13'].timeToRunEndMs.p50).toBe(500);
    expect(report.byPeriod['from-2026-09-13'].timeToRunEndMs.p50).toBe(900);
  });

  it('never imputes a missing modelCalls/run-end value into the aggregate stats', () => {
    const conversations = [
      { id: 'a', model: 'x', events: [ev('t1', 1000, 'user_message')] }, // nothing else at all
    ];
    const report = aggregate(conversations);
    expect(report.overall.n).toBe(1);
    expect(report.overall.modelCalls).toEqual({ n: 0, p50: null, p90: null, max: null });
    expect(report.overall.timeToRunEndMs).toEqual({ n: 0, p50: null, p90: null, max: null });
    expect(report.overall.missing.modelCalls).toBe(1);
    expect(report.overall.missing.timeToRunEnd).toBe(1);
  });

  it('decomposes wall time into model/tool/review shares that sum to 1', () => {
    const conversations = [
      {
        id: 'a',
        model: 'claude-opus-5',
        events: [
          ev('t1', 1000, 'user_message'),
          ev('t1', 1100, 'tool_call', {
            id: 'call-1',
            toolName: 'transcribe',
            status: 'completed',
            runtimeMs: 2000,
          }),
          ev('t1', 3200, 'diff', { scope: 'turn', turnIndex: 0 }),
          ev('t1', 3300, 'status', { status: 'completed' }),
        ],
      },
    ];
    const report = aggregate(conversations);
    const d = report.overall.wallTimeDecomposition;
    expect(d.turns).toBe(1);
    expect(d.toolMsTotal).toBe(2000);
    expect(d.modelMsTotal).toBe(300); // 2300 total - 2000 tool - 0 review
    expect(d.modelShare + d.toolShare + d.reviewShare).toBeCloseTo(1, 10);
  });
});

// ---------------------------------------------------------------------------
// Per-call decomposition (§W)
// ---------------------------------------------------------------------------

/** A send/settle `context_usage` pair for one model call. */
function callPair(
  turnId,
  requestId,
  sendTs,
  endTs,
  { stage = 'apply', effort = 'low', out = 1000, provider = 'claude-agent-sdk' } = {},
) {
  const manifest = {
    requestId,
    provider,
    model: 'claude-sonnet-5',
    memory: { stage },
    reasoningEffort: effort,
  };
  return [
    ev(turnId, sendTs, 'context_usage', { estimated: true, usedTokens: 100, manifest }),
    ev(turnId, endTs, 'context_usage', {
      estimated: false,
      usedTokens: 120,
      manifest: {
        ...manifest,
        usage: {
          providerReportedInputTokens: 120,
          providerReportedOutputTokens: out,
          cachedInputTokens: 50,
          cacheWriteInputTokens: 10,
        },
      },
    }),
  ];
}

function toolPair(turnId, id, toolName, ts) {
  return [
    ev(turnId, ts, 'tool_call', { id, toolName, status: 'running' }),
    ev(turnId, ts + 5, 'tool_call', { id, toolName, status: 'completed', runtimeMs: 5 }),
  ];
}

describe('extractCalls', () => {
  const turnId = 't1';
  const conversation = {
    id: 'conv1',
    model: 'claude-sonnet-5',
    events: [
      ev(turnId, 1000, 'user_message', { text: 'tighten the cut' }),
      ev(turnId, 4700, 'context_usage', {
        estimated: false,
        usedTokens: 900,
        manifest: {
          requestId: 'classify',
          provider: 'claude-agent-sdk',
          model: 'claude-sonnet-5',
          usage: { providerReportedOutputTokens: 30 },
        },
      }),
      // call 1: plan, thinks 20 s, issues two trims, one of which lands
      ...callPair(turnId, 'seg-1', 5000, 25000, { stage: 'plan', effort: 'medium', out: 2000 }),
      ev(turnId, 8400, 'reasoning_delta', { text: '…' }),
      ...toolPair(turnId, 'call_a', 'trim_clip', 25100),
      ...toolPair(turnId, 'call_b', 'trim_clip', 25200),
      ev(turnId, 25300, 'timeline_action', { action: 'Trimmed clip', detail: '', refs: [] }),
      // call 2: apply, reads the clips back — nothing else
      ...callPair(turnId, 'seg-2', 26000, 34000, { stage: 'apply', effort: 'low', out: 500 }),
      ev(turnId, 29000, 'assistant_delta', { text: 'Checking…' }),
      ...toolPair(turnId, 'call_c', 'get_clips', 34100),
      // call 3: final text, no tool call
      ...callPair(turnId, 'seg-3', 35000, 40000, { stage: 'apply', effort: 'low', out: 400 }),
    ],
  };

  it('pairs each send with its settled usage and reads the time to first token between them', () => {
    const { calls } = extractCalls(conversation);
    expect(calls.map((c) => c.wallMs)).toEqual([20000, 8000, 5000]);
    expect(calls.map((c) => c.ttftMs)).toEqual([3400, 3000, null]);
    expect(calls.map((c) => c.outputTokens)).toEqual([2000, 500, 400]);
    expect(calls.map((c) => c.stage)).toEqual(['plan', 'apply', 'apply']);
    expect(calls.map((c) => c.reasoningEffort)).toEqual(['medium', 'low', 'low']);
    expect(calls[0]).toMatchObject({
      cachedInputTokens: 50,
      cacheWriteInputTokens: 10,
      provider: 'claude-agent-sdk',
    });
  });

  it('attributes the tool calls issued after a call settles to that call, one per id', () => {
    const { calls } = extractCalls(conversation);
    expect(calls.map((c) => c.toolCalls)).toEqual([2, 1, 0]);
    expect(calls[0].toolNames).toEqual(['trim_clip', 'trim_clip']);
    expect(calls.map((c) => c.applied)).toEqual([true, false, false]);
    expect(calls.map((c) => c.readOnly)).toEqual([false, true, false]);
    expect(calls.map((c) => c.last)).toEqual([false, false, true]);
  });

  it('measures the classifier from the user message to its settled usage', () => {
    const { classifier } = extractCalls(conversation);
    expect(classifier).toEqual([
      {
        conversationId: 'conv1',
        turnId,
        wallMs: 3700,
        outputTokens: 30,
        provider: 'claude-agent-sdk',
        model: 'claude-sonnet-5',
      },
    ]);
  });

  it('drops a send that never settled, since it has no wall time', () => {
    const { calls } = extractCalls({
      id: 'c',
      events: [ev('t', 1, 'context_usage', { estimated: true, manifest: { requestId: 'lost' } })],
    });
    expect(calls).toEqual([]);
  });

  it('leaves stage and effort null when the manifest carries none', () => {
    const [send, end] = callPair('t', 'r', 0, 10);
    delete send.manifest.memory;
    delete send.manifest.reasoningEffort;
    const { calls } = extractCalls({ id: 'c', events: [send, end] });
    expect(calls[0]).toMatchObject({ stage: null, reasoningEffort: null });
  });
});

describe('fitFixedOverhead', () => {
  it('recovers the intercept and the token rate from an exact line', () => {
    const calls = [100, 500, 2000, 8000].map((outputTokens) => ({
      outputTokens,
      wallMs: 3000 + 10 * outputTokens,
    }));
    const fit = fitFixedOverhead(calls);
    expect(fit.n).toBe(4);
    expect(fit.interceptMs).toBeCloseTo(3000, 6);
    expect(fit.msPerToken).toBeCloseTo(10, 6);
    expect(fit.tokensPerSecond).toBeCloseTo(100, 6);
  });

  it('refuses to fit fewer than three points or a flat token axis', () => {
    expect(fitFixedOverhead([{ outputTokens: 1, wallMs: 1 }]).interceptMs).toBeNull();
    expect(
      fitFixedOverhead([1, 2, 3].map(() => ({ outputTokens: 5, wallMs: 5 }))).interceptMs,
    ).toBeNull();
  });
});

describe('aggregateCalls', () => {
  const turnId = 't1';
  const conversation = {
    id: 'conv1',
    events: [
      ...callPair(turnId, 'seg-1', 0, 10000, { stage: 'plan', effort: 'medium', out: 1000 }),
      ...toolPair(turnId, 'a', 'add_clip', 10100),
      ev(turnId, 10200, 'timeline_action', { action: 'Added clip', detail: '', refs: [] }),
      ...callPair(turnId, 'seg-2', 11000, 16000, { stage: 'apply', effort: 'low', out: 200 }),
      ...toolPair(turnId, 'b', 'get_clips', 16100),
      ...callPair(turnId, 'seg-3', 17000, 21000, { stage: 'apply', effort: 'low', out: 300 }),
      ...toolPair(turnId, 'c', 'get_timeline', 21100),
      ...callPair(turnId, 'seg-4', 22000, 25000, { stage: 'apply', effort: 'low', out: 100 }),
      ...callPair(turnId, 'seg-5', 26000, 28000, {
        stage: 'apply',
        effort: 'low',
        out: 100,
        provider: 'openrouter',
      }),
    ],
  };

  it('counts a read-only step only when the step before it applied an edit', () => {
    const report = aggregateCalls([conversation]);
    // seg-2 reads after seg-1 applied; seg-3 reads after a read, which is not the same waste.
    expect(report.readOnlyAfterApply).toEqual({ n: 1, wallMsTotal: 5000, shareOfCalls: 0.2 });
  });

  it("counts a tool-less step only before the turn's last call", () => {
    const report = aggregateCalls([conversation]);
    // seg-4 made no tool call and is not last; seg-5 made none and IS last (the reply).
    expect(report.zeroToolNonFinal).toEqual({ n: 1, wallMsTotal: 3000 });
  });

  it('groups by stage and by the effort the call was sent at', () => {
    const report = aggregateCalls([conversation]);
    expect(report.byStage.plan.n).toBe(1);
    expect(report.byStage.apply.n).toBe(4);
    expect(report.byEffort.low.n).toBe(4);
    expect(report.byEffort.medium.wallMsTotal).toBe(10000);
    expect(report.byStageAndEffort['apply · low'].n).toBe(4);
  });

  it('narrows to one provider on request', () => {
    const report = aggregateCalls([conversation], { provider: 'openrouter' });
    expect(report.calls.n).toBe(1);
    expect(report.byProvider).toEqual({ openrouter: expect.objectContaining({ n: 1 }) });
  });
});
