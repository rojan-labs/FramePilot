import { describe, expect, it } from 'vitest';
import { aggregate, classifyToolKind, extractTurns, summarize, TOOL_KINDS } from './measure-edit-latency.mjs';

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
        ev(turnId, 1500, 'tool_call', { id: `${turnId}:call:1`, toolName: 'transcribe', status: 'running' }),
        ev(turnId, 3500, 'tool_call', { id: `${turnId}:call:1`, toolName: 'transcribe', status: 'completed', runtimeMs: 2000 }),
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
        ev('t1', 1010, 'tool_call', { id: 'call-a', toolName: 'render_preview', status: 'running' }),
        ev('t1', 5010, 'tool_call', { id: 'call-a', toolName: 'render_preview', status: 'completed', runtimeMs: 4000 }),
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
        events: [ev('t1', before, 'user_message'), ev('t1', before + 500, 'status', { status: 'completed' }), ev('t1', before + 400, 'usage', { modelCalls: 4 })],
      },
      {
        id: 'b',
        model: 'claude-opus-5',
        events: [ev('t1', after, 'user_message'), ev('t1', after + 900, 'status', { status: 'completed' }), ev('t1', after + 800, 'usage', { modelCalls: 6 })],
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
          ev('t1', 1100, 'tool_call', { id: 'call-1', toolName: 'transcribe', status: 'completed', runtimeMs: 2000 }),
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
