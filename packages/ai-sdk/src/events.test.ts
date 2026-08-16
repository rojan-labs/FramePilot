/**
 * Tests for the streaming event model (Phase 11 M1): the {@link reduceEvents}
 * reducer (in-place merge of deltas/tool-status by id), the {@link createTurnEmitter}
 * builders, and {@link isTerminalStatus}. Held to 100% coverage — this is the
 * contract every later milestone depends on.
 */
import { describe, expect, it } from 'vitest';
import {
  type AiEvent,
  type AssistantNode,
  type NoticeNode,
  type ReasoningNode,
  type ToolNode,
  createConversationViewBuilder,
  createTurnEmitter,
  isTerminalStatus,
  reduceEvents,
} from './events.js';

const ref = { conversationId: 'conv_1', turnId: 'turn_1', now: () => 1000 };

/** Reduce a list and return its nodes for terse assertions. */
const nodesOf = (events: AiEvent[]) => reduceEvents(events).nodes;

describe('isTerminalStatus', () => {
  it('is true for completed/failed/cancelled and false otherwise', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('thinking')).toBe(false);
    expect(isTerminalStatus('idle')).toBe(false);
  });
});

describe('reduceEvents — assistant streaming', () => {
  it('appends deltas to a streaming node, then finalizes on the terminal message', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.delta('turn_1:assistant', 'Hel'),
      e.delta('turn_1:assistant', 'lo'),
    ]);
    const node = view.nodes[0] as AssistantNode;
    expect(node).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true });

    const finalView = reduceEvents([
      e.delta('turn_1:assistant', 'Hel'),
      e.assistant('turn_1:assistant', 'Hello world'),
    ]);
    const finalNode = finalView.nodes[0] as AssistantNode;
    expect(finalNode).toMatchObject({ text: 'Hello world', streaming: false });
  });

  it('creates the assistant node even if a delta arrives before any other event', () => {
    const e = createTurnEmitter(ref);
    const nodes = nodesOf([e.delta('turn_1:assistant', 'hi')]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'assistant', text: 'hi' });
  });

  it('does not merge a delta into a non-assistant node sharing the id', () => {
    const e = createTurnEmitter(ref);
    // A delta whose parentId collides with a tool id overwrites with an assistant node.
    const nodes = nodesOf([
      e.toolCall('shared', 'get_timeline', 'running'),
      e.delta('shared', 'x'),
    ]);
    expect(nodes[0]).toMatchObject({ kind: 'assistant', text: 'x' });
  });
});

describe('reduceEvents — tool lifecycle', () => {
  it('mutates a tool card in place and attaches its result', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.toolCall('call_1', 'find_silence', 'running'),
      e.toolResult('call_1', { summary: 'found 3 gaps', clips: ['clip_a'] }),
      e.toolCall('call_1', 'find_silence', 'completed', { runtimeMs: 42 }),
    ]);
    expect(view.nodes).toHaveLength(1);
    const tool = view.nodes[0] as ToolNode;
    expect(tool).toMatchObject({ status: 'completed', runtimeMs: 42 });
    expect(tool.result?.summary).toBe('found 3 gaps');
  });

  it('ignores a tool result with no matching tool call', () => {
    const e = createTurnEmitter(ref);
    const nodes = nodesOf([e.toolResult('orphan', { summary: 'nope' })]);
    expect(nodes).toHaveLength(0);
  });

  it('attaches the model’s question to the call that asked it (P12)', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.toolCall('ask_1', 'ask_user', 'running'),
      e.ask('ask_1', 'Which take do you prefer?', [
        { label: 'The second' },
        { label: 'The first' },
      ]),
    ]);
    const tool = view.nodes[0] as ToolNode;
    // One node carries the whole exchange: the question hangs off its call, and the
    // answer will arrive as that call's ordinary result.
    expect(view.nodes).toHaveLength(1);
    expect(tool.ask?.question).toBe('Which take do you prefer?');
    expect(tool.ask?.options?.[0]?.label).toBe('The second');
    expect(tool.status).toBe('running'); // still blocked on the editor
  });

  it('omits options entirely for a free-text question', () => {
    const e = createTurnEmitter(ref);
    const tool = nodesOf([
      e.toolCall('ask_1', 'ask_user', 'running'),
      e.ask('ask_1', 'What is this video for?'),
    ])[0] as ToolNode;
    expect(tool.ask?.options).toBeUndefined();
  });

  it('ignores a question with no matching tool call', () => {
    // An orphan would render as a prompt nobody could ever answer.
    const e = createTurnEmitter(ref);
    expect(nodesOf([e.ask('orphan', 'anyone there?')])).toHaveLength(0);
  });

  it('carries title and omits runtimeMs when not provided', () => {
    const e = createTurnEmitter(ref);
    const tool = nodesOf([
      e.toolCall('c', 'export_video', 'running', { title: 'Export' }),
    ])[0] as ToolNode;
    expect(tool.title).toBe('Export');
    expect(tool.runtimeMs).toBeUndefined();
  });

  it('keeps the running ts and argsSummary across status transitions (U4)', () => {
    // The live elapsed timer measures from when the call STARTED, so the terminal
    // event must not overwrite the node's ts; argsSummary sticks once provided.
    let clock = 1000;
    const e = createTurnEmitter({ ...ref, now: () => clock });
    const running = e.toolCall('c', 'detect_beats', 'running', { argsSummary: 'assetId: "m"' });
    clock = 5000;
    const tool = nodesOf([
      running,
      e.toolCall('c', 'detect_beats', 'completed', { runtimeMs: 4000 }),
    ])[0] as ToolNode;
    expect(tool.ts).toBe(1000);
    expect(tool.argsSummary).toBe('assetId: "m"');
    expect(tool.status).toBe('completed');
  });
});

describe('reduceEvents — reasoning timing (U3)', () => {
  it('derives thoughtMs from the first reasoning event to the settling event', () => {
    let clock = 1000;
    const e = createTurnEmitter({ ...ref, now: () => clock });
    const open = e.reasoning([], false);
    clock = 3500;
    const done = e.reasoning([], true);
    const node = nodesOf([open, done])[0] as ReasoningNode;
    expect(node).toMatchObject({ done: true, ts: 1000, thoughtMs: 2500 });
  });

  it('freezes thoughtMs at the first settle — a later re-settle cannot inflate it', () => {
    // streamAgent settles the shimmer at first output AND re-settles in `finally`;
    // "Thought for Ns" must reflect the first (real) settle, not the run length.
    let clock = 1000;
    const e = createTurnEmitter({ ...ref, now: () => clock });
    const open = e.reasoning([], false);
    clock = 2000;
    const settle = e.reasoning([], true);
    clock = 60_000;
    const resettle = e.reasoning([], true);
    const node = nodesOf([open, settle, resettle])[0] as ReasoningNode;
    expect(node.thoughtMs).toBe(1000);
  });

  it('a done-only reasoning event gets no misleading duration', () => {
    const e = createTurnEmitter(ref);
    const node = nodesOf([e.reasoning(['x'], true)])[0] as ReasoningNode;
    expect(node.thoughtMs).toBe(0);
  });

  it('presents an in-flight reasoning node as settled once the run is terminal', () => {
    // Repro: the user hits Stop while the model is still "thinking". Without this
    // reconciliation the reasoning node stays done:false and shimmers "Thinking…"
    // forever, because a terminal run emits no further reasoning events.
    const e = createTurnEmitter(ref);
    const view = reduceEvents([e.reasoning(['Working'], false), e.status('cancelled')]);
    const node = view.nodes.find((n) => n.kind === 'reasoning') as ReasoningNode;
    expect(view.status).toBe('cancelled');
    expect(node.done).toBe(true);
  });

  it('keeps a reasoning node shimmering while the run is still active', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([e.reasoning(['Working'], false), e.status('thinking')]);
    const node = view.nodes.find((n) => n.kind === 'reasoning') as ReasoningNode;
    expect(node.done).toBe(false);
  });

  it('settles an earlier step whose `done` event never arrived', () => {
    // Repro from a real desktop log: a host auto-commit remounts the editor mid-run and
    // the un-persisted tail of the event log — including step 1's `reasoning done` — is
    // lost. Step 2 then opens its own node, and the transcript showed TWO live
    // "Thinking…" rows at once, the earlier one shimmering for the rest of the session.
    // Only the last reasoning node may be live, whatever the transport dropped.
    let clock = 1000;
    const e = createTurnEmitter({ ...ref, now: () => clock });
    const first = e.reasoning(['Step one'], false, 1);
    clock = 4000;
    const second = e.reasoning(['Step two'], false, 2);
    const view = reduceEvents([first, second, e.status('thinking')]);
    const [a, b] = view.nodes.filter((n) => n.kind === 'reasoning') as ReasoningNode[];
    expect(a?.done).toBe(true);
    // Settled with the elapsed time up to what came next — the number the lost `done`
    // event would have carried, never an invented one.
    expect(a?.thoughtMs).toBe(3000);
    expect(b?.done).toBe(false);
  });

  it('does not invent a duration for a stranded node with nothing after it', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([e.reasoning(['Working'], false, 1), e.status('completed')]);
    const node = view.nodes.find((n) => n.kind === 'reasoning') as ReasoningNode;
    expect(node.done).toBe(true);
    expect(node.thoughtMs).toBeUndefined();
  });

  it('a late `done` event still reconciles a node the view had projected as settled', () => {
    // The projection is pure: it never writes back, so the real settle wins if it lands.
    let clock = 1000;
    const e = createTurnEmitter({ ...ref, now: () => clock });
    const first = e.reasoning(['Step one'], false, 1);
    clock = 4000;
    const second = e.reasoning([], false, 2);
    clock = 5000;
    const lateDone = e.reasoning(['Step one, finished'], true, 1);
    const view = reduceEvents([first, second, lateDone]);
    const node = view.nodes.find(
      (n) => n.kind === 'reasoning' && n.id.endsWith(':1'),
    ) as ReasoningNode;
    expect(node.summaries).toEqual(['Step one, finished']);
    expect(node.thoughtMs).toBe(4000);
  });
});

describe('reduceEvents — thinking blocks never overwrite each other', () => {
  /** A settled block, then a fresh one, on the SAME producer node id. */
  const reusedId = (e: ReturnType<typeof createTurnEmitter>) => [
    e.reasoning(['first thought'], false),
    e.reasoning(['first thought'], true),
    e.toolCall('c1', 'get_timeline', 'completed'),
    e.reasoning(['second thought'], false),
    e.reasoning(['second thought'], true),
  ];

  it('forks a second block that reuses a settled node id instead of replacing it', () => {
    // The reported bug, at the fold: a route whose tool loop makes several model calls
    // reused one reasoning id, so the later block REPLACED the earlier one — and did so
    // at the earlier one's position, above the tool cards it actually followed. Both
    // blocks survive, in the order they were thought.
    const e = createTurnEmitter(ref);
    const view = reduceEvents([...reusedId(e), e.status('completed')]);
    const reasoning = view.nodes.filter((n) => n.kind === 'reasoning') as ReasoningNode[];
    expect(reasoning.map((n) => n.summaries)).toEqual([['first thought'], ['second thought']]);
    expect(new Set(reasoning.map((n) => n.id)).size).toBe(2);
    // …each independently expandable (distinct ids ⇒ distinct React keys ⇒ distinct state).
    expect(reasoning.every((n) => n.done)).toBe(true);
  });

  it('keeps forked blocks interleaved with the tool cards between them', () => {
    const e = createTurnEmitter(ref);
    const kinds = reduceEvents([...reusedId(e), e.status('completed')]).nodes.map((n) => n.kind);
    expect(kinds).toEqual(['reasoning', 'tool', 'reasoning']);
  });

  it('starts a new block when a delta arrives on a settled node', () => {
    // A streamed second block whose opening snapshot was lost in transport still lands in
    // its own accordion rather than re-opening (and appending to) the finished one.
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.reasoning(['done thinking'], false),
      e.reasoning(['done thinking'], true),
      e.reasoningDelta('a fresh '),
      e.reasoningDelta('thought'),
      e.status('completed'),
    ]);
    const reasoning = view.nodes.filter((n) => n.kind === 'reasoning') as ReasoningNode[];
    expect(reasoning.map((n) => n.summaries)).toEqual([['done thinking'], ['a fresh thought']]);
  });

  it('still merges the open→delta→settle lifecycle of ONE block into one node', () => {
    // The fork must not fire on the normal path: an in-flight node keeps accumulating.
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.reasoning([''], false),
      e.reasoningDelta('one '),
      e.reasoningDelta('thought'),
      e.reasoning(['one thought'], true),
      e.status('completed'),
    ]);
    const reasoning = view.nodes.filter((n) => n.kind === 'reasoning') as ReasoningNode[];
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ summaries: ['one thought'], done: true });
  });

  it('a late `done` for a forked block reconciles that block, not the first', () => {
    let clock = 1000;
    const e = createTurnEmitter({ ...ref, now: () => clock });
    const open = e.reasoning(['first'], false);
    const settle = e.reasoning(['first'], true);
    clock = 2000;
    const second = e.reasoning(['second'], false);
    clock = 5000;
    const secondDone = e.reasoning(['second, finished'], true);
    const view = reduceEvents([open, settle, second, secondDone]);
    const reasoning = view.nodes.filter((n) => n.kind === 'reasoning') as ReasoningNode[];
    expect(reasoning.map((n) => n.summaries)).toEqual([['first'], ['second, finished']]);
    expect(reasoning[1]?.thoughtMs).toBe(3000);
  });
});

describe('reduceEvents — other node kinds', () => {
  it('maps user/reasoning/plan/diff/reference/timeline_action and updates status', () => {
    const e = createTurnEmitter(ref);
    const fakeEdit = {
      patch: { patchId: 'p', createdBy: 'agent', reason: 'r', operations: [{ type: 'noop' }] },
      validation: { valid: true, issues: [] },
      text: 'r',
    } as never;
    const view = reduceEvents([
      e.userMessage('do it'),
      e.reasoning(['Analyzing'], false),
      e.plan([{ id: 's1', label: 'Trim', status: 'running' }]),
      e.timelineAction('Trimmed clip', '0s–3s', [{ kind: 'clip', id: 'clip_a', label: 'clip_a' }]),
      e.diff(fakeEdit),
      e.reference([{ kind: 'track', id: 't1', label: 'Track 1' }]),
      e.status('thinking'),
    ]);
    expect(view.nodes.map((n) => n.kind)).toEqual([
      'user',
      'reasoning',
      'plan',
      'timeline_action',
      'diff',
      'reference',
    ]);
    expect(view.status).toBe('thinking');
  });

  it('drops a proposed-edit diff that has zero operations (no phantom review card)', () => {
    const e = createTurnEmitter(ref);
    const emptyEdit = {
      patch: { patchId: 'p', createdBy: 'agent', reason: 'r', operations: [] },
      validation: { valid: true, issues: [] },
      text: 'r',
    } as never;
    const view = reduceEvents([e.userMessage('hi'), e.diff(emptyEdit), e.status('completed')]);
    expect(view.nodes.some((n) => n.kind === 'diff')).toBe(false);
    expect(view.status).toBe('completed');
  });

  it('copies a host-authoritative commit projection onto a diff node', () => {
    const e = createTurnEmitter(ref);
    const edit = {
      patch: { patchId: 'p', createdBy: 'agent', reason: 'r', operations: [{ type: 'noop' }] },
      validation: { valid: true, issues: [] },
      text: 'r',
    } as never;
    const diffEvent = { ...e.diff(edit), commit: { state: 'committed', revision: 3 } };
    const view = reduceEvents([diffEvent]);
    const diff = view.nodes.find((n) => n.kind === 'diff');
    expect(diff?.kind === 'diff' && diff.commit).toEqual({ state: 'committed', revision: 3 });
  });

  it('copies scope + turnIndex onto a turn-scoped diff node; legacy diffs stay untagged (ADR 0056)', () => {
    const e = createTurnEmitter(ref);
    const edit = {
      patch: { patchId: 'p', createdBy: 'agent', reason: 'r', operations: [{ type: 'noop' }] },
      validation: { valid: true, issues: [] },
      text: 'r',
    } as never;
    const view = reduceEvents([
      e.diff(edit, undefined, { scope: 'turn', turnIndex: 2 }),
      e.diff(edit),
    ]);
    const [turnDiff, legacyDiff] = view.nodes.filter((n) => n.kind === 'diff');
    expect(turnDiff).toMatchObject({ scope: 'turn', turnIndex: 2 });
    expect(legacyDiff?.kind === 'diff' && legacyDiff.scope).toBeUndefined();
    expect(legacyDiff?.kind === 'diff' && legacyDiff.turnIndex).toBeUndefined();
  });

  it("copies runId onto a diff node so a run's turns group into one undo step (B5.3)", () => {
    const e = createTurnEmitter(ref);
    const edit = {
      patch: { patchId: 'p', createdBy: 'agent', reason: 'r', operations: [{ type: 'noop' }] },
      validation: { valid: true, issues: [] },
      text: 'r',
    } as never;
    // Two per-turn diffs of the same run share a runId; a legacy diff carries none.
    const view = reduceEvents([
      e.diff(edit, undefined, { scope: 'turn', turnIndex: 1, runId: 'run:turn_1' }),
      e.diff(edit, undefined, { scope: 'turn', turnIndex: 2, runId: 'run:turn_1' }),
      e.diff(edit),
    ]);
    const diffs = view.nodes.filter((n) => n.kind === 'diff');
    const runIds = diffs.map((n) => (n.kind === 'diff' ? n.runId : undefined));
    expect(runIds).toEqual(['run:turn_1', 'run:turn_1', undefined]);
  });

  it('carries A/B variants through onto the diff node (P13.1 variations run)', () => {
    const e = createTurnEmitter(ref);
    const edit = {
      patch: { patchId: 'p', createdBy: 'agent', reason: 'r', operations: [{ type: 'noop' }] },
      validation: { valid: true, issues: [] },
      text: 'variant A',
    } as never;
    const variantB = { ...(edit as object), text: 'variant B' } as never;
    const view = reduceEvents([e.userMessage('two ways'), e.diff(edit, [edit, variantB])]);
    const diff = view.nodes.find((n) => n.kind === 'diff') as { variants?: unknown[] };
    expect(diff.variants).toHaveLength(2);
  });

  it('clamps progress into [0,1]', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.progress('Rendering', -0.5),
      e.progress('Exporting', 1.5),
      e.progress('Analyzing', 0.5),
    ]);
    const values = view.nodes.map((n) => (n.kind === 'progress' ? n.value : null));
    expect(values).toEqual([0, 1, 0.5]);
  });

  it('omits the optional detail of a timeline action when absent', () => {
    const e = createTurnEmitter(ref);
    const node = nodesOf([e.timelineAction('Split clip', '')])[0];
    expect(node).toMatchObject({ kind: 'timeline_action', action: 'Split clip' });
    expect((node as { refs?: unknown }).refs).toBeUndefined();
  });

  it('collapses notification/warning/error into notice nodes with a level', () => {
    const e = createTurnEmitter(ref);
    const nodes = nodesOf([
      e.notification('saved'),
      e.warning('captions overflow'),
      e.error('render failed', { detail: 'ffmpeg exit 1', retryable: true }),
      e.error('plain'),
    ]) as NoticeNode[];
    expect(nodes.map((n) => n.level)).toEqual(['info', 'warning', 'error', 'error']);
    expect(nodes[2]).toMatchObject({ detail: 'ffmpeg exit 1', retryable: true });
    expect(nodes[3].detail).toBeUndefined();
    expect(nodes[3].retryable).toBeUndefined();
  });

  it('defaults status to idle for an empty log', () => {
    expect(reduceEvents([]).status).toBe('idle');
  });

  it("threads a notification's optional reason/detail onto its notice node (P11.2)", () => {
    const e = createTurnEmitter(ref);
    const [plain, tagged] = nodesOf([
      e.notification('plain notice'),
      e.notification('planner declined', { reason: 'unrecognized_task_shape', detail: 'why' }),
    ]) as NoticeNode[];
    expect(plain.reason).toBeUndefined();
    expect(plain.detail).toBeUndefined();
    expect(tagged).toMatchObject({ reason: 'unrecognized_task_shape', detail: 'why' });
  });
});

describe('reduceEvents — resume checkpoint (R3 C2)', () => {
  it('surfaces a checkpoint from an interrupted run and does not render it as a node', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.userMessage('edit it'),
      e.checkpoint({
        goal: 'edit it',
        ops: [{ type: 'delete_range' }],
        log: ['Step 1'],
        stepsCompleted: 1,
      }),
      e.status('cancelled'),
    ]);
    expect(view.status).toBe('cancelled');
    expect(view.checkpoint).toMatchObject({ goal: 'edit it', stepsCompleted: 1 });
    // The checkpoint is a resume signal, not a visible conversation row.
    expect(view.nodes.some((n) => (n as { kind?: string }).kind === 'checkpoint')).toBe(false);
  });

  it('clears the checkpoint once a later run completes successfully', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.checkpoint({ goal: 'g', ops: [], log: [], stepsCompleted: 2 }),
      e.status('cancelled'),
      e.status('completed'),
    ]);
    expect(view.checkpoint).toBeUndefined();
  });

  it('emits a checkpoint event with a stable per-turn id and its detail', () => {
    const e = createTurnEmitter(ref);
    const cp = e.checkpoint({ goal: 'g', ops: [{ type: 'x' }], log: ['l'], stepsCompleted: 3 });
    expect(cp).toMatchObject({
      type: 'checkpoint',
      id: 'turn_1:checkpoint',
      goal: 'g',
      stepsCompleted: 3,
    });
    expect(cp.ops).toEqual([{ type: 'x' }]);
  });
});

describe('createTurnEmitter', () => {
  it('stamps stable base fields and a fixed assistant id', () => {
    const e = createTurnEmitter(ref);
    expect(e.assistantId).toBe('turn_1:assistant');
    const status = e.status('thinking');
    expect(status).toMatchObject({ conversationId: 'conv_1', turnId: 'turn_1', ts: 1000 });
  });

  it('uses Date.now when no clock is injected', () => {
    const before = Date.now();
    const e = createTurnEmitter({ conversationId: 'c', turnId: 't' });
    expect(e.status('idle').ts).toBeGreaterThanOrEqual(before);
  });

  it('gives reasoning/plan/progress stable in-place ids and one-offs unique ids', () => {
    const e = createTurnEmitter(ref);
    expect(e.reasoning([], false).id).toBe('turn_1:reasoning');
    expect(e.plan([]).id).toBe('turn_1:plan');
    expect(e.progress('Render', 0).id).toBe('turn_1:progress:Render');
    expect(e.status('idle').id).not.toBe(e.status('idle').id);
  });

  it('threads the one-off seq from startSeq so ids continue across a split emitter (K1.2)', () => {
    // Two emitters sharing one logical run: the first stamps status:1, the second is
    // seeded at that seq so its next one-off is status:2 — the byte-identical id the
    // single-emitter streamAgent would have produced.
    const first = createTurnEmitter(ref);
    expect(first.status('thinking').id).toBe('turn_1:status:1');
    expect(first.seq()).toBe(1);

    const second = createTurnEmitter(ref, first.seq());
    expect(second.seq()).toBe(1);
    expect(second.notification('n').id).toBe('turn_1:notice:2');
    expect(second.seq()).toBe(2);
  });

  it('defaults startSeq to 0 (first one-off is :1)', () => {
    expect(createTurnEmitter(ref).status('idle').id).toBe('turn_1:status:1');
  });
});

describe('reduceEvents — reasoning streaming (H1)', () => {
  it('appends reasoning deltas to the LAST summary line of the canonical node', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.reasoning(['Earlier line', 'Trim'], false),
      e.reasoningDelta('ming the '),
      e.reasoningDelta('intro'),
    ]);
    const node = view.nodes[0] as ReasoningNode;
    expect(node.kind).toBe('reasoning');
    expect(node.summaries).toEqual(['Earlier line', 'Trimming the intro']);
    expect(node.done).toBe(false);
  });

  it('starts a reasoning node from a bare delta (mirrors assistant_delta)', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([e.reasoningDelta('Thinking about cuts')]);
    const node = view.nodes[0] as ReasoningNode;
    expect(node.kind).toBe('reasoning');
    expect(node.id).toBe('turn_1:reasoning');
    expect(node.summaries).toEqual(['Thinking about cuts']);
    expect(node.done).toBe(false);
  });

  it('a canonical reasoning event replaces the streamed state (terminal snapshot)', () => {
    const e = createTurnEmitter(ref);
    const view = reduceEvents([
      e.reasoning(['Tri'], false),
      e.reasoningDelta('mming'),
      e.reasoning(['Trimming', 'Done'], true),
    ]);
    const node = view.nodes[0] as ReasoningNode;
    expect(node.summaries).toEqual(['Trimming', 'Done']);
    expect(node.done).toBe(true);
  });

  it('emits reasoningDelta with the fixed per-turn reasoning parent id', () => {
    const e = createTurnEmitter(ref);
    const delta = e.reasoningDelta('chunk');
    expect(delta.type).toBe('reasoning_delta');
    expect(delta.parentId).toBe('turn_1:reasoning');
    expect(delta.chunk).toBe('chunk');
    expect(delta.id).not.toBe(e.reasoningDelta('next').id);
  });
});

describe('createConversationViewBuilder — incremental fold (H1)', () => {
  it('produces the same view as reduceEvents when fed incrementally', () => {
    const e = createTurnEmitter(ref);
    const events: AiEvent[] = [
      e.status('thinking'),
      e.reasoning(['Start'], false),
      e.reasoningDelta('…'),
      e.delta('turn_1:assistant', 'Hel'),
      e.delta('turn_1:assistant', 'lo'),
      e.assistant('turn_1:assistant', 'Hello'),
      e.status('completed'),
    ];
    const builder = createConversationViewBuilder();
    for (const event of events) builder.push(event);
    expect(builder.view()).toEqual(reduceEvents(events));
  });

  it('view() snapshots are independent across pushes', () => {
    const e = createTurnEmitter(ref);
    const builder = createConversationViewBuilder();
    builder.push(e.reasoning(['One'], false));
    const first = builder.view();
    builder.push(e.reasoningDelta(' more'));
    const second = builder.view();
    expect((first.nodes[0] as ReasoningNode).summaries).toEqual(['One']);
    expect((second.nodes[0] as ReasoningNode).summaries).toEqual(['One more']);
  });
});

// ---------------------------------------------------------------------------
// K0.2 — DAG task lifecycle (folded into view-level `tasks`, not `nodes`)
// ---------------------------------------------------------------------------

describe('task lifecycle events (K0.2)', () => {
  const base = (ts: number, id: string) => ({
    id,
    conversationId: 'conv_1',
    turnId: 'turn_1',
    ts,
  });

  it('omits `tasks` and keeps `nodes` empty when no task events arrive', () => {
    const view = reduceEvents([]);
    expect(view.tasks).toBeUndefined();
    // Task events never appear as visible nodes.
    const withTask = reduceEvents([
      { ...base(1000, 't1'), type: 'task_started', taskId: 'A', label: 'Analyze' },
    ]);
    expect(withTask.nodes).toEqual([]);
  });

  it('folds task_started into a running task (with resourceClass), preserving start ts', () => {
    const view = reduceEvents([
      {
        ...base(1000, 't1'),
        type: 'task_started',
        taskId: 'A',
        label: 'Analyze silence',
        resourceClass: 'ffmpeg',
      },
      // A re-emitted start keeps the ORIGINAL ts (elapsed measured from real start).
      { ...base(1500, 't1b'), type: 'task_started', taskId: 'A', label: 'Analyze silence' },
    ]);
    expect(view.tasks).toEqual([
      {
        taskId: 'A',
        ts: 1000,
        turnId: 'turn_1',
        label: 'Analyze silence',
        status: 'running',
      },
    ]);
  });

  it('derives runtimeMs from the start ts when task_finished omits it', () => {
    const [task] = reduceEvents([
      { ...base(1000, 't1'), type: 'task_started', taskId: 'A', label: 'Analyze' },
      { ...base(1900, 't2'), type: 'task_finished', taskId: 'A', status: 'completed' },
    ]).tasks!;
    expect(task).toMatchObject({
      taskId: 'A',
      status: 'completed',
      runtimeMs: 900,
      label: 'Analyze',
    });
  });

  it('carries the started task’s resourceClass and progress through to finished', () => {
    const [task] = reduceEvents([
      {
        ...base(1000, 't1'),
        type: 'task_started',
        taskId: 'A',
        label: 'Render',
        resourceClass: 'render',
      },
      { ...base(1100, 'p1'), type: 'effect_progress', taskId: 'A', label: 'Render', value: 0.9 },
      { ...base(1300, 't2'), type: 'task_finished', taskId: 'A', status: 'completed' },
    ]).tasks!;
    expect(task).toMatchObject({ resourceClass: 'render', progress: 0.9, runtimeMs: 300 });
  });

  it('honors an explicit runtimeMs on task_finished', () => {
    const [task] = reduceEvents([
      { ...base(1000, 't1'), type: 'task_started', taskId: 'A', label: 'Analyze' },
      { ...base(9999, 't2'), type: 'task_finished', taskId: 'A', status: 'warning', runtimeMs: 42 },
    ]).tasks!;
    expect(task.runtimeMs).toBe(42);
    expect(task.status).toBe('warning');
  });

  it('records a task_finished with no prior start (label falls back to taskId, no runtime)', () => {
    const [task] = reduceEvents([
      { ...base(1000, 't2'), type: 'task_finished', taskId: 'Z', status: 'failed' },
    ]).tasks!;
    expect(task).toEqual({ taskId: 'Z', ts: 1000, turnId: 'turn_1', label: 'Z', status: 'failed' });
  });

  it('folds effect_progress onto the matching task, clamped to [0,1]', () => {
    const [task] = reduceEvents([
      { ...base(1000, 't1'), type: 'task_started', taskId: 'A', label: 'Render' },
      { ...base(1100, 'p1'), type: 'effect_progress', taskId: 'A', label: 'Render', value: 0.4 },
      { ...base(1200, 'p2'), type: 'effect_progress', taskId: 'A', label: 'Render', value: 1.7 },
    ]).tasks!;
    expect(task.progress).toBe(1); // clamped from 1.7
    // A later start preserves the progress already seen.
    const [restarted] = reduceEvents([
      { ...base(1000, 't1'), type: 'task_started', taskId: 'A', label: 'Render' },
      { ...base(1100, 'p1'), type: 'effect_progress', taskId: 'A', label: 'Render', value: 0.4 },
      { ...base(1200, 't1b'), type: 'task_started', taskId: 'A', label: 'Render' },
    ]).tasks!;
    expect(restarted.progress).toBe(0.4);
  });

  it('ignores effect_progress for a task that never started', () => {
    const view = reduceEvents([
      { ...base(1000, 'p1'), type: 'effect_progress', taskId: 'ghost', label: 'x', value: 0.5 },
    ]);
    expect(view.tasks).toBeUndefined();
  });

  it('emitter builds task events with stable per-task ids and optional fields', () => {
    const e = createTurnEmitter(ref);
    expect(e.taskStarted('A', 'Analyze', 'ffmpeg')).toMatchObject({
      id: 'turn_1:task-start:A',
      type: 'task_started',
      taskId: 'A',
      label: 'Analyze',
      resourceClass: 'ffmpeg',
    });
    expect(e.taskStarted('A', 'Analyze')).not.toHaveProperty('resourceClass');
    expect(e.taskFinished('A', 'completed', 120)).toMatchObject({
      id: 'turn_1:task-end:A',
      type: 'task_finished',
      status: 'completed',
      runtimeMs: 120,
    });
    expect(e.taskFinished('A', 'cancelled')).not.toHaveProperty('runtimeMs');
    expect(e.effectProgress('A', 'Render', 0.5)).toMatchObject({
      id: 'turn_1:effect:A',
      type: 'effect_progress',
      taskId: 'A',
      value: 0.5,
    });
  });

  it('emitter builds a usage event carrying the raw cost (P7.1)', () => {
    const e = createTurnEmitter(ref);
    expect(e.usage({ tokens: 240, usd: 0.0042 })).toMatchObject({
      type: 'usage',
      tokens: 240,
      usd: 0.0042,
    });
  });

  it('a usage event is not folded into any visible ConversationView node (raw numbers stay out of the default render)', () => {
    const view = reduceEvents([{ ...base(1000, 'u1'), type: 'usage', tokens: 240, usd: 0.0042 }]);
    expect(view.nodes).toHaveLength(0);
  });

  it('emits clamped per-call context occupancy without adding a transcript node', () => {
    const event = createTurnEmitter(ref).contextUsage({
      usedTokens: 20.4,
      contextWindow: 100,
      estimated: true,
    });
    expect(event).toMatchObject({
      id: 'turn_1:context-usage',
      type: 'context_usage',
      usedTokens: 20,
      contextWindow: 100,
      estimated: true,
    });
    expect(reduceEvents([event]).nodes).toHaveLength(0);
  });
});
